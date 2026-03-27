"""Store — CRUD and search over notes, backed by FTS5 index.

All notes live as .md files directly under `memory_dir`.
Images live under `memory_dir/.assets/`.
Search goes through SQLite FTS5 (see index.py).
"""

from __future__ import annotations

import shutil
from pathlib import Path

from .config import MemConfig
from .index import Index
from .note import Note


class Store:
    def __init__(self, config: MemConfig) -> None:
        self.cfg = config
        self._index = Index(config.memory_dir)

    # ── listing ──────────────────────────────────────────────────
    def all_notes(self) -> list[Note]:
        """Return every note, newest first (via index)."""
        return self._load_paths(self._index.all_paths())

    # ── search ───────────────────────────────────────────────────
    def search(self, query: str) -> list[Note]:
        """Full-text search via FTS5.  Results ranked by relevance."""
        return self._load_paths(self._index.search(query))

    def find_by_tags(self, tags: list[str]) -> list[Note]:
        """Return notes that contain ALL of the given tags."""
        return self._load_paths(self._index.find_by_tags_all(tags))

    def find_by_tags_any(self, tags: list[str]) -> list[Note]:
        """Return notes that contain ANY of the given tags."""
        return self._load_paths(self._index.find_by_tags_any(tags))

    # ── tags ─────────────────────────────────────────────────────
    def all_tags(self) -> dict[str, int]:
        """Return {tag: count} across all notes, sorted by count desc."""
        return self._index.all_tags()

    # ── images ───────────────────────────────────────────────────
    def import_image(self, source: Path) -> str:
        """Copy an image to .assets/ and return the relative markdown ref."""
        self.cfg.ensure_dirs()
        dest = self.cfg.assets_dir / source.name
        counter = 1
        while dest.exists():
            dest = self.cfg.assets_dir / f"{source.stem}-{counter}{source.suffix}"
            counter += 1
        shutil.copy2(source, dest)
        rel = dest.relative_to(self.cfg.memory_dir)
        return str(rel)

    # ── delete ───────────────────────────────────────────────────
    def delete(self, note: Note) -> None:
        if note.path.exists():
            note.path.unlink()
        self._index.remove_note(note.path)

    # ── index management ─────────────────────────────────────────
    def index_note(self, note: Note) -> None:
        """Re-index a single note after create/save."""
        self._index.index_note(note.path)

    def rebuild_index(self) -> int:
        """Full rebuild.  Returns count of notes indexed."""
        return self._index.rebuild()

    # ── internal ─────────────────────────────────────────────────
    def _load_paths(self, paths: list[str]) -> list[Note]:
        """Load Note objects from a list of path strings."""
        notes: list[Note] = []
        for p in paths:
            path = Path(p)
            if path.exists():
                try:
                    notes.append(Note.load(path))
                except Exception:
                    continue
        return notes
