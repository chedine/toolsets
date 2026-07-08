from __future__ import annotations

import json
import re
import shutil
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import zvec
from zvec import DataType, Doc, FieldSchema, Fts, FtsIndexParam, HnswIndexParam, Query, VectorSchema

from .config import Settings
from .embeddings import EmbeddingProvider
from .pdf import chunk_text, extract_pdf_pages


_TOKEN_RE = re.compile(r"[A-Za-z0-9_]+")
_STOP_WORDS = {
    "a", "about", "above", "after", "again", "against", "all", "am", "an", "and", "any", "are",
    "as", "at", "be", "because", "been", "before", "being", "below", "between", "both", "but",
    "by", "can", "could", "did", "do", "does", "doing", "down", "during", "each", "few", "for",
    "from", "further", "had", "has", "have", "having", "he", "her", "here", "hers", "herself",
    "him", "himself", "his", "how", "i", "if", "in", "into", "is", "it", "its", "itself", "just",
    "me", "more", "most", "my", "myself", "no", "nor", "not", "now", "of", "off", "on", "once",
    "only", "or", "other", "our", "ours", "ourselves", "out", "over", "own", "s", "same", "she",
    "should", "so", "some", "such", "t", "than", "that", "the", "their", "theirs", "them",
    "themselves", "then", "there", "these", "they", "this", "those", "through", "to", "too",
    "under", "until", "up", "very", "was", "we", "were", "what", "when", "where", "which", "while",
    "who", "whom", "why", "will", "with", "you", "your", "yours", "yourself", "yourselves",
}


def _query_terms(text: str) -> list[str]:
    seen: set[str] = set()
    terms: list[str] = []
    for match in _TOKEN_RE.finditer(text.lower()):
        token = match.group(0)
        if len(token) < 3 or token in _STOP_WORDS or token in seen:
            continue
        seen.add(token)
        terms.append(token)
    return terms


def _lexical_score(question_terms: list[str], text: str) -> float:
    if not question_terms:
        return 0.0
    lowered = text.lower()
    text_terms = set(_TOKEN_RE.findall(lowered))
    overlap = sum(1 for term in question_terms if term in text_terms) / len(question_terms)
    phrase_hits = 0
    for left, right in zip(question_terms, question_terms[1:]):
        if f"{left} {right}" in lowered:
            phrase_hits += 1
    phrase_bonus = phrase_hits / max(1, len(question_terms) - 1)
    return overlap + 0.35 * phrase_bonus


class PdfQaStore:
    def __init__(self, settings: Settings, embedder: EmbeddingProvider):
        self.settings = settings
        self.embedder = embedder
        self.data_dir = settings.data_dir
        self.upload_dir = self.data_dir / "uploads"
        self.collection_path = self.data_dir / "zvec_collection"
        self.db_path = self.data_dir / "app.db"
        self.config_path = self.data_dir / "config.json"
        self.lock = threading.RLock()

        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.upload_dir.mkdir(parents=True, exist_ok=True)
        self._validate_or_write_config()
        self.db = sqlite3.connect(self.db_path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self._init_db()
        self.collection = self._open_collection()

    def _validate_or_write_config(self) -> None:
        current = {
            "embedding_provider": self.settings.embedding_provider,
            "embedding_model": self.settings.embedding_model,
            "embedding_dim": self.embedder.dimension,
        }
        collection_exists = self.collection_path.exists() and any(self.collection_path.iterdir())
        if self.config_path.exists():
            saved = json.loads(self.config_path.read_text())
            saved_subset = {k: saved.get(k) for k in current}
            if saved_subset != current and collection_exists:
                raise RuntimeError(
                    "Embedding configuration differs from the existing zvec collection. "
                    f"Saved={saved_subset}, current={current}. Delete {self.collection_path} "
                    "and re-upload PDFs, or restore the old embedding settings."
                )
        self.config_path.write_text(json.dumps(current, indent=2))

    def _init_db(self) -> None:
        with self.db:
            self.db.execute(
                """
                CREATE TABLE IF NOT EXISTS documents (
                    id TEXT PRIMARY KEY,
                    filename TEXT NOT NULL,
                    stored_path TEXT NOT NULL,
                    uploaded_at REAL NOT NULL,
                    chunks INTEGER NOT NULL
                )
                """
            )
            self.db.execute(
                """
                CREATE TABLE IF NOT EXISTS chunks (
                    chunk_id TEXT PRIMARY KEY,
                    doc_id TEXT NOT NULL,
                    page INTEGER NOT NULL,
                    chunk_index INTEGER NOT NULL,
                    text TEXT NOT NULL,
                    FOREIGN KEY(doc_id) REFERENCES documents(id)
                )
                """
            )
            self.db.execute(
                """
                CREATE TABLE IF NOT EXISTS chat_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at REAL NOT NULL
                )
                """
            )

    def _open_collection(self):
        try:
            zvec.init()
        except RuntimeError:
            # zvec can only be initialized once per process.
            pass

        option = zvec.CollectionOption(read_only=False, enable_mmap=True)
        if self.collection_path.exists() and any(self.collection_path.iterdir()):
            return zvec.open(str(self.collection_path), option)

        schema = zvec.CollectionSchema(
            name="pdf_chunks",
            fields=[
                FieldSchema("doc_id", DataType.STRING, nullable=False),
                FieldSchema("filename", DataType.STRING, nullable=False),
                FieldSchema("page", DataType.INT64, nullable=False),
                FieldSchema("chunk_index", DataType.INT64, nullable=False),
                FieldSchema(
                    "text",
                    DataType.STRING,
                    nullable=False,
                    index_param=FtsIndexParam(tokenizer_name="standard", filters=["lowercase"]),
                ),
            ],
            vectors=[
                VectorSchema(
                    "embedding",
                    DataType.VECTOR_FP32,
                    dimension=self.embedder.dimension,
                    index_param=HnswIndexParam(),
                )
            ],
        )
        return zvec.create_and_open(str(self.collection_path), schema=schema, option=option)

    def add_pdf(self, file_bytes: bytes, filename: str) -> dict[str, Any]:
        if not filename.lower().endswith(".pdf"):
            raise ValueError("Only PDF files are supported")
        if len(file_bytes) > self.settings.max_upload_mb * 1024 * 1024:
            raise ValueError(f"File exceeds MAX_UPLOAD_MB={self.settings.max_upload_mb}")

        # zvec primary keys accept a restricted identifier-like character set.
        doc_id = uuid.uuid4().hex
        safe_name = Path(filename).name or f"{doc_id}.pdf"
        stored_path = self.upload_dir / f"{doc_id}.pdf"
        stored_path.write_bytes(file_bytes)

        try:
            pages = extract_pdf_pages(stored_path)
            chunk_records: list[dict[str, Any]] = []
            for page_no, text in pages:
                for text_chunk in chunk_text(text):
                    chunk_records.append(
                        {
                            "chunk_id": f"{doc_id}_{len(chunk_records)}",
                            "doc_id": doc_id,
                            "filename": safe_name,
                            "page": page_no,
                            "chunk_index": len(chunk_records),
                            "text": text_chunk,
                        }
                    )
            if not chunk_records:
                raise ValueError("No extractable text found in this PDF")

            docs: list[Doc] = []
            for batch_start in range(0, len(chunk_records), 32):
                batch = chunk_records[batch_start : batch_start + 32]
                vectors = self.embedder.embed([record["text"] for record in batch])
                for record, vector in zip(batch, vectors):
                    docs.append(
                        Doc(
                            id=record["chunk_id"],
                            fields={
                                "doc_id": record["doc_id"],
                                "filename": record["filename"],
                                "page": record["page"],
                                "chunk_index": record["chunk_index"],
                                "text": record["text"],
                            },
                            vectors={"embedding": vector},
                        )
                    )

            with self.lock:
                statuses = self.collection.upsert(docs)
                failed = [str(status) for status in statuses if not status.ok()]
                if failed:
                    raise RuntimeError(f"zvec upsert failed: {failed[:3]}")
                self.collection.flush()
                with self.db:
                    self.db.execute(
                        "INSERT INTO documents(id, filename, stored_path, uploaded_at, chunks) VALUES (?, ?, ?, ?, ?)",
                        (doc_id, safe_name, str(stored_path), time.time(), len(chunk_records)),
                    )
                    self.db.executemany(
                        "INSERT INTO chunks(chunk_id, doc_id, page, chunk_index, text) VALUES (?, ?, ?, ?, ?)",
                        [
                            (r["chunk_id"], r["doc_id"], r["page"], r["chunk_index"], r["text"])
                            for r in chunk_records
                        ],
                    )
        except Exception:
            stored_path.unlink(missing_ok=True)
            raise

        return {"id": doc_id, "filename": safe_name, "chunks": len(chunk_records)}

    def list_documents(self) -> list[dict[str, Any]]:
        rows = self.db.execute(
            "SELECT id, filename, uploaded_at, chunks FROM documents ORDER BY uploaded_at DESC"
        ).fetchall()
        return [dict(row) for row in rows]

    def delete_document(self, doc_id: str) -> None:
        with self.lock:
            rows = self.db.execute("SELECT chunk_id FROM chunks WHERE doc_id = ?", (doc_id,)).fetchall()
            chunk_ids = [row["chunk_id"] for row in rows]
            if chunk_ids:
                for start in range(0, len(chunk_ids), 500):
                    self.collection.delete(chunk_ids[start : start + 500])
                self.collection.flush()
            row = self.db.execute("SELECT stored_path FROM documents WHERE id = ?", (doc_id,)).fetchone()
            with self.db:
                self.db.execute("DELETE FROM chunks WHERE doc_id = ?", (doc_id,))
                self.db.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
            if row:
                Path(row["stored_path"]).unlink(missing_ok=True)

    def search(self, question: str, top_k: int = 5) -> list[dict[str, Any]]:
        if not self.list_documents():
            return []

        requested_top_k = max(1, min(top_k, 20))
        candidate_k = max(30, requested_top_k * 8)
        output_fields = ["doc_id", "filename", "page", "chunk_index", "text"]
        terms = _query_terms(question)
        fts_text = " ".join(terms) or question
        vector = self.embedder.embed_one(question)
        candidates: dict[str, dict[str, Any]] = {}

        def add_results(route: str, docs) -> None:
            for rank, doc in enumerate(docs, start=1):
                item = candidates.setdefault(
                    doc.id,
                    {
                        "chunk_id": doc.id,
                        "doc_id": doc.field("doc_id"),
                        "filename": doc.field("filename"),
                        "page": doc.field("page"),
                        "chunk_index": doc.field("chunk_index"),
                        "text": doc.field("text") or "",
                        "vector_rank_score": 0.0,
                        "fts_rank_score": 0.0,
                        "zvec_score": 0.0,
                    },
                )
                # Rank-based scores are stable across distance metrics and FTS scoring.
                item[f"{route}_rank_score"] = max(item[f"{route}_rank_score"], 1.0 / rank)
                item["zvec_score"] = max(item["zvec_score"], float(doc.score or 0.0))

        with self.lock:
            # Query vector and FTS independently, then merge/rerank. In the default
            # local hash-embedding mode, vector neighbors can be too similar across
            # questions; native FTS + lexical reranking makes results question-specific.
            try:
                add_results(
                    "vector",
                    self.collection.query(
                        queries=Query(field_name="embedding", vector=vector),
                        topk=candidate_k,
                        include_vector=False,
                        output_fields=output_fields,
                    ),
                )
            except Exception:
                pass
            try:
                add_results(
                    "fts",
                    self.collection.query(
                        queries=Query(field_name="text", fts=Fts(match_string=fts_text)),
                        topk=candidate_k,
                        include_vector=False,
                        output_fields=output_fields,
                    ),
                )
            except Exception:
                pass

        contexts = list(candidates.values())
        for item in contexts:
            lexical = _lexical_score(terms, item["text"])
            item["score"] = (
                lexical
                + 0.35 * item.pop("vector_rank_score")
                + 0.45 * item.pop("fts_rank_score")
            )
            item.pop("zvec_score", None)

        contexts.sort(key=lambda item: item["score"], reverse=True)
        return contexts[:requested_top_k]

    def add_chat_message(self, role: str, content: str) -> None:
        with self.db:
            self.db.execute(
                "INSERT INTO chat_messages(role, content, created_at) VALUES (?, ?, ?)",
                (role, content, time.time()),
            )

    def chat_history(self, limit: int = 100) -> list[dict[str, Any]]:
        rows = self.db.execute(
            "SELECT role, content, created_at FROM chat_messages ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(row) for row in reversed(rows)]

    def reset(self) -> None:
        with self.lock:
            try:
                self.collection.destroy()
            except Exception:
                pass
            self.db.close()
            if self.data_dir.exists():
                shutil.rmtree(self.data_dir)
