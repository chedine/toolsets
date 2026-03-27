"""SQLite FTS5 search index for notes.

Index lives at `memory_dir/.index.db`.  Syncs automatically by
comparing file mtimes — only re-parses changed/new files, removes
deleted ones.  Search hits FTS5 instead of scanning every file.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import frontmatter as fm


_SCHEMA = """
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    path,           -- absolute path (unique key, unindexed)
    mtime,          -- file mtime as float  (unindexed)
    title,          -- first content line
    content,        -- full body text
    tags,           -- space-separated tags
    created,        -- ISO timestamp        (unindexed)
    tokenize = 'porter unicode61',
    content_rowid = 'rowid'
);
"""

# FTS5 unindexed columns: declare via prefix trick in schema won't work,
# so we use a regular table + an FTS table that mirrors it.
_SCHEMA_V2 = """
CREATE TABLE IF NOT EXISTS notes (
    path    TEXT PRIMARY KEY,
    mtime   REAL NOT NULL,
    title   TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    tags    TEXT NOT NULL DEFAULT '',
    created TEXT NOT NULL DEFAULT ''
);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    title,
    content,
    tags,
    content = 'notes',
    content_rowid = 'rowid',
    tokenize = 'porter unicode61'
);

-- Triggers to keep FTS in sync with the notes table
CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, title, content, tags)
        VALUES (new.rowid, new.title, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, content, tags)
        VALUES ('delete', old.rowid, old.title, old.content, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, content, tags)
        VALUES ('delete', old.rowid, old.title, old.content, old.tags);
    INSERT INTO notes_fts(rowid, title, content, tags)
        VALUES (new.rowid, new.title, new.content, new.tags);
END;
"""


class Index:
    """Manages the FTS5 index for a memory directory."""

    def __init__(self, memory_dir: Path) -> None:
        self._dir = memory_dir
        self._db_path = memory_dir / ".index.db"
        self._conn: sqlite3.Connection | None = None

    # ── connection ───────────────────────────────────────────────
    @property
    def conn(self) -> sqlite3.Connection:
        if self._conn is None:
            self._conn = sqlite3.connect(str(self._db_path))
            self._conn.executescript(_SCHEMA_V2)
        return self._conn

    def close(self) -> None:
        if self._conn:
            self._conn.close()
            self._conn = None

    # ── sync ─────────────────────────────────────────────────────
    def sync(self) -> None:
        """Bring the index up to date with files on disk."""
        c = self.conn

        # What's on disk right now
        disk: dict[str, float] = {}
        for p in self._dir.glob("*.md"):
            disk[str(p)] = p.stat().st_mtime

        # What's in the index
        indexed: dict[str, float] = {}
        for row in c.execute("SELECT path, mtime FROM notes"):
            indexed[row[0]] = row[1]

        # Delete removed files
        removed = set(indexed) - set(disk)
        if removed:
            c.executemany(
                "DELETE FROM notes WHERE path = ?",
                [(p,) for p in removed],
            )

        # Add new / update changed files
        for path_str, mtime in disk.items():
            old_mtime = indexed.get(path_str)
            if old_mtime is not None and abs(old_mtime - mtime) < 0.001:
                continue  # unchanged
            self._index_file(path_str, mtime)

        c.commit()

    def _index_file(self, path_str: str, mtime: float) -> None:
        """Parse a single file and upsert into the index."""
        path = Path(path_str)
        try:
            post = fm.load(str(path))
        except Exception:
            return

        tags_raw = post.get("tags", [])
        if isinstance(tags_raw, str):
            tags_raw = [t.strip() for t in tags_raw.split(",") if t.strip()]
        tags_str = " ".join(t.lower() for t in tags_raw)

        content = post.content or ""
        title = ""
        for line in content.splitlines():
            t = line.strip().lstrip("#").strip()
            if t:
                title = t
                break

        created = str(post.get("created", ""))

        c = self.conn
        # Upsert
        c.execute("DELETE FROM notes WHERE path = ?", (path_str,))
        c.execute(
            "INSERT INTO notes (path, mtime, title, content, tags, created) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (path_str, mtime, title, content, tags_str, created),
        )

    # ── index a single note (called after create/save) ──────────
    def index_note(self, path: Path) -> None:
        """Re-index one file immediately."""
        if not path.exists():
            self.conn.execute("DELETE FROM notes WHERE path = ?", (str(path),))
        else:
            self._index_file(str(path), path.stat().st_mtime)
        self.conn.commit()

    def remove_note(self, path: Path) -> None:
        """Remove one file from the index."""
        self.conn.execute("DELETE FROM notes WHERE path = ?", (str(path),))
        self.conn.commit()

    # ── search ───────────────────────────────────────────────────
    def search(self, query: str) -> list[str]:
        """Full-text search.  Returns list of paths, ranked by relevance."""
        self.sync()
        rows = self.conn.execute(
            "SELECT n.path FROM notes n "
            "JOIN notes_fts f ON f.rowid = n.rowid "
            "WHERE notes_fts MATCH ? "
            "ORDER BY rank",
            (self._fts_query(query),),
        ).fetchall()
        return [r[0] for r in rows]

    def find_by_tags_any(self, tags: list[str]) -> list[str]:
        """Return paths of notes matching ANY of the given tags."""
        self.sync()
        # FTS query: tag1 OR tag2 OR tag3  (search the tags column)
        expr = " OR ".join(t.lower() for t in tags)
        rows = self.conn.execute(
            "SELECT n.path FROM notes n "
            "JOIN notes_fts f ON f.rowid = n.rowid "
            "WHERE notes_fts MATCH ? "
            "ORDER BY n.created DESC",
            (f"tags : ({expr})",),
        ).fetchall()
        return [r[0] for r in rows]

    def find_by_tags_all(self, tags: list[str]) -> list[str]:
        """Return paths of notes matching ALL of the given tags."""
        self.sync()
        expr = " AND ".join(f"tags : {t.lower()}" for t in tags)
        rows = self.conn.execute(
            "SELECT n.path FROM notes n "
            "JOIN notes_fts f ON f.rowid = n.rowid "
            "WHERE notes_fts MATCH ? "
            "ORDER BY n.created DESC",
            (expr,),
        ).fetchall()
        return [r[0] for r in rows]

    def all_paths(self) -> list[str]:
        """Return all indexed paths, newest first."""
        self.sync()
        rows = self.conn.execute(
            "SELECT path FROM notes ORDER BY created DESC"
        ).fetchall()
        return [r[0] for r in rows]

    def all_tags(self) -> dict[str, int]:
        """Return {tag: count} from the index."""
        self.sync()
        counts: dict[str, int] = {}
        rows = self.conn.execute("SELECT tags FROM notes").fetchall()
        for (tags_str,) in rows:
            for tag in tags_str.split():
                if tag:
                    counts[tag] = counts.get(tag, 0) + 1
        return dict(sorted(counts.items(), key=lambda kv: -kv[1]))

    # ── helpers ──────────────────────────────────────────────────
    @staticmethod
    def _fts_query(raw: str) -> str:
        """Turn a user query into a valid FTS5 query.

        Simple approach: quote each token so special chars don't break FTS,
        join with implicit AND.
        """
        tokens = raw.strip().split()
        if not tokens:
            return '""'
        parts = []
        for tok in tokens:
            # Strip quotes, wrap in quotes for safety
            clean = tok.strip('"').replace('"', '')
            if clean:
                parts.append(f'"{clean}"')
        return " ".join(parts) if parts else '""'

    # ── rebuild ──────────────────────────────────────────────────
    def rebuild(self) -> int:
        """Drop and rebuild the entire index.  Returns count indexed."""
        c = self.conn
        c.executescript("""
            DROP TABLE IF EXISTS notes;
            DROP TABLE IF EXISTS notes_fts;
        """)
        self._conn = None  # reconnect to recreate schema
        c = self.conn
        count = 0
        for p in self._dir.glob("*.md"):
            self._index_file(str(p), p.stat().st_mtime)
            count += 1
        c.commit()
        return count
