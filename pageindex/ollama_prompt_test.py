#!/usr/bin/env python3
"""Test vectorless Cúram document QA against a local Ollama model.

This is a lightweight evaluation harness, not the production retriever. It gives
AGENTS.md/SKILL.md + the master index to a local model, asks it to pick relevant
documents/nodes, then feeds selected page text and asks for a cited answer.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

import requests


DEFAULT_OLLAMA_URL = "http://localhost:11434"


def read_text(path: Path, default: str = "") -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return default


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def compact(text: str, max_chars: int) -> str:
    text = (text or "").strip()
    if len(text) <= max_chars:
        return text
    half = max_chars // 2
    return text[:half].rstrip() + "\n\n[...omitted...]\n\n" + text[-half:].lstrip()


def extract_json(text: str, fallback: Any) -> Any:
    text = text.strip()
    m = re.search(r"```(?:json)?\s*(.*?)```", text, flags=re.S | re.I)
    if m:
        text = m.group(1).strip()
    try:
        return json.loads(text)
    except Exception:
        pass
    start_candidates = [i for i in [text.find("{"), text.find("[")] if i >= 0]
    if not start_candidates:
        return fallback
    start = min(start_candidates)
    end = max(text.rfind("}"), text.rfind("]"))
    if end <= start:
        return fallback
    try:
        return json.loads(text[start : end + 1])
    except Exception:
        return fallback


def ollama_chat(base_url: str, model: str, messages: list[dict[str, str]], temperature: float = 0.0) -> str:
    resp = requests.post(
        f"{base_url.rstrip('/')}/api/chat",
        json={"model": model, "messages": messages, "stream": False, "options": {"temperature": temperature}},
        timeout=300,
    )
    resp.raise_for_status()
    return resp.json()["message"]["content"]


def flatten_nodes(root: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []

    def walk(node: dict[str, Any]) -> None:
        out.append(
            {
                "node_id": node.get("node_id"),
                "level": node.get("level"),
                "title": node.get("title", ""),
                "summary": node.get("summary", ""),
                "range": node.get("range", {}),
            }
        )
        for child in node.get("children", []) or []:
            walk(child)

    walk(root)
    return out


def question_terms(question: str) -> list[str]:
    stop = {
        "the", "and", "for", "with", "what", "how", "why", "when", "where", "does", "do", "is", "are",
        "in", "to", "of", "a", "an", "on", "about", "curam", "cúram", "explain", "tell", "me",
    }
    terms = []
    for term in re.findall(r"[A-Za-z][A-Za-z0-9_-]{2,}", question.lower()):
        if term not in stop and term not in terms:
            terms.append(term)
    return terms[:12]


def score_node(node: dict[str, Any], terms: list[str]) -> int:
    hay = f"{node.get('title','')} {node.get('summary','')}".lower()
    score = 0
    for t in terms:
        if t in hay:
            score += 5 if t in str(node.get("title", "")).lower() else 2
    # Prefer navigable leaves/near-leaves over root-level generic nodes a little.
    level = int(node.get("level") or 0)
    if level >= 2:
        score += 1
    return score


def select_candidate_nodes(nodes: list[dict[str, Any]], terms: list[str], max_candidates: int) -> list[dict[str, Any]]:
    scored = [(score_node(n, terms), n) for n in nodes]
    candidates = [n for s, n in sorted(scored, key=lambda x: x[0], reverse=True) if s > 0]
    # Always include root and top-level nodes as navigation context.
    context = [n for n in nodes if int(n.get("level") or 0) <= 1]
    merged: list[dict[str, Any]] = []
    seen = set()
    for n in context + candidates:
        nid = n.get("node_id") or id(n)
        if nid not in seen:
            seen.add(nid)
            merged.append(n)
        if len(merged) >= max_candidates:
            break
    return merged


def read_pages(content_path: Path, ranges: list[dict[str, Any]], max_pages: int, max_page_chars: int) -> list[dict[str, Any]]:
    wanted: set[int] = set()
    for r in ranges:
        start = r.get("start_page") or r.get("page")
        end = r.get("end_page") or start
        if start is None:
            continue
        for p in range(int(start), int(end) + 1):
            wanted.add(p)
            if len(wanted) >= max_pages:
                break
        if len(wanted) >= max_pages:
            break
    pages: list[dict[str, Any]] = []
    with content_path.open("r", encoding="utf-8") as f:
        for line in f:
            rec = json.loads(line)
            p = rec.get("page")
            if p in wanted:
                rec = dict(rec)
                rec["text"] = compact(rec.get("text", ""), max_page_chars)
                pages.append(rec)
    pages.sort(key=lambda x: x.get("page") or 0)
    return pages


def main() -> int:
    parser = argparse.ArgumentParser(description="Ask a local Ollama/Gemma model questions over the indexed Cúram corpus")
    parser.add_argument("question", help="Question to ask")
    parser.add_argument("--model", default="gemma3", help="Ollama model name, e.g. gemma3, gemma3:4b, gemma2")
    parser.add_argument("--ollama-url", default=DEFAULT_OLLAMA_URL)
    parser.add_argument("--contents-dir", default="contents")
    parser.add_argument("--max-docs", type=int, default=2)
    parser.add_argument("--max-candidates", type=int, default=45)
    parser.add_argument("--max-pages", type=int, default=20)
    parser.add_argument("--max-page-chars", type=int, default=5000)
    parser.add_argument("--show-intermediate", action="store_true")
    args = parser.parse_args()

    root = Path.cwd()
    contents_dir = Path(args.contents_dir)
    master_path = contents_dir / "index.json"
    if not master_path.exists():
        print(f"Missing master index: {master_path}", file=sys.stderr)
        return 2

    agents = read_text(root / "AGENTS.md")
    skill = read_text(root / "SKILL.md")
    master = load_json(master_path)
    master_for_prompt = {
        "document_count": master.get("document_count"),
        "documents": [
            {
                "doc_id": d.get("doc_id"),
                "title": d.get("title"),
                "index_file": d.get("index_file"),
                "content_file": d.get("content_file"),
                "summary": compact(d.get("summary", ""), 900),
                "page_count": d.get("page_count"),
            }
            for d in master.get("documents", [])
        ],
    }

    system = "You are testing a vectorless document QA skill. Follow instructions exactly and return JSON when requested."
    doc_select_prompt = f"""
Question: {args.question}

AGENTS.md:
{compact(agents, 4000)}

SKILL.md:
{compact(skill, 5000)}

Master index:
{json.dumps(master_for_prompt, ensure_ascii=False, indent=2)}

Choose up to {args.max_docs} relevant documents and useful search keywords.
Return JSON only:
{{"documents":[{{"index_file":"...","reason":"..."}}],"keywords":["..."]}}
""".strip()
    doc_select_raw = ollama_chat(args.ollama_url, args.model, [{"role": "system", "content": system}, {"role": "user", "content": doc_select_prompt}])
    doc_select = extract_json(doc_select_raw, {"documents": [], "keywords": []})
    if args.show_intermediate:
        print("\n[doc selection raw]\n", doc_select_raw)

    selected_index_files = [d.get("index_file") for d in doc_select.get("documents", []) if d.get("index_file")]
    if not selected_index_files:
        selected_index_files = [d.get("index_file") for d in master_for_prompt["documents"][: args.max_docs]]
    keywords = [str(k).lower() for k in doc_select.get("keywords", []) if str(k).strip()] or question_terms(args.question)
    keywords = list(dict.fromkeys(keywords + question_terms(args.question)))[:16]

    all_selected_ranges: list[tuple[dict[str, Any], list[dict[str, Any]], Path]] = []
    for index_file in selected_index_files[: args.max_docs]:
        index_path = contents_dir / index_file
        doc_idx = load_json(index_path)
        doc = doc_idx.get("document", {})
        nodes = flatten_nodes(doc_idx.get("root", {}))
        candidates = select_candidate_nodes(nodes, keywords, args.max_candidates)
        node_prompt = f"""
Question: {args.question}
Document title: {doc.get('title')}

Candidate navigation nodes:
{json.dumps(candidates, ensure_ascii=False, indent=2)}

Pick the smallest page ranges likely needed to answer the question.
Return JSON only:
{{"ranges":[{{"node_id":"...","start_page":1,"end_page":2,"reason":"..."}}]}}
""".strip()
        node_raw = ollama_chat(args.ollama_url, args.model, [{"role": "system", "content": system}, {"role": "user", "content": node_prompt}])
        node_choice = extract_json(node_raw, {"ranges": []})
        if args.show_intermediate:
            print(f"\n[node selection raw for {index_file}]\n", node_raw)
        ranges = node_choice.get("ranges", []) or [n.get("range", {}) for n in candidates[:3]]
        content_path = contents_dir / doc.get("content_file", index_path.parent.joinpath("content.jsonl").name)
        if not content_path.exists():
            content_path = index_path.parent / doc.get("content_file", "content.jsonl")
        all_selected_ranges.append((doc, ranges, content_path))

    source_blocks = []
    for doc, ranges, content_path in all_selected_ranges:
        pages = read_pages(content_path, ranges, args.max_pages, args.max_page_chars)
        for page in pages:
            source_blocks.append(
                f"SOURCE: {doc.get('title')} p. {page.get('page')} ({page.get('unit_id')})\n{page.get('text','')}"
            )
    if not source_blocks:
        print("No source pages selected/read. Try --show-intermediate or increase --max-candidates.", file=sys.stderr)
        return 3

    answer_prompt = f"""
Question: {args.question}

Use only the source pages below. Cite every substantive claim using the format
[Document Title, p. N] or [Document Title, pp. N-M]. If the sources are insufficient, say what is missing.

Sources:
{chr(10).join(source_blocks)}
""".strip()
    answer = ollama_chat(args.ollama_url, args.model, [{"role": "system", "content": "Answer with grounded citations only."}, {"role": "user", "content": answer_prompt}])
    print(answer.strip())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
