"""Note model — Markdown files with YAML front-matter.

File format
-----------
---
title: Optional title
tags: [ideas, projects]
created: 2026-03-25T16:30:00
modified: 2026-03-25T16:30:00
---

Your note content here…
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import frontmatter


@dataclass
class Note:
    path: Path
    content: str
    tags: list[str] = field(default_factory=list)
    created: datetime = field(default_factory=datetime.now)
    modified: datetime = field(default_factory=datetime.now)
    fm_title: str = ""  # explicit title from frontmatter

    # ── derived ──────────────────────────────────────────────────
    @property
    def title(self) -> str:
        """Explicit frontmatter title, or first non-empty line of content."""
        if self.fm_title:
            return self.fm_title
        for line in self.content.splitlines():
            text = line.strip()
            if text:
                return re.sub(r"^#+\s*", "", text)
        return self.path.stem

    @property
    def preview(self) -> str:
        """First ~80 chars of content for list display."""
        t = self.title
        return t[:80] + ("…" if len(t) > 80 else "")

    @property
    def tag_str(self) -> str:
        return ", ".join(self.tags) if self.tags else "—"

    # ── serialization ────────────────────────────────────────────
    def to_markdown(self) -> str:
        meta = dict(
            tags=self.tags,
            created=self.created.isoformat(),
            modified=self.modified.isoformat(),
        )
        if self.fm_title:
            meta["title"] = self.fm_title
        post = frontmatter.Post(self.content, **meta)
        return frontmatter.dumps(post) + "\n"

    def save(self) -> None:
        self.modified = datetime.now()
        self.path.write_text(self.to_markdown(), encoding="utf-8")

    # ── deserialization ──────────────────────────────────────────
    @classmethod
    def load(cls, path: Path) -> Note:
        post = frontmatter.load(str(path))
        created = post.get("created", "")
        modified = post.get("modified", "")
        tags = post.get("tags", [])
        fm_title = post.get("title", "")
        if isinstance(tags, str):
            tags = [t.strip() for t in tags.split(",") if t.strip()]

        def _parse_dt(val: str | datetime) -> datetime:
            if isinstance(val, datetime):
                return val
            try:
                return datetime.fromisoformat(str(val))
            except (ValueError, TypeError):
                return datetime.now()

        return cls(
            path=path,
            content=post.content,
            tags=tags,
            created=_parse_dt(created),
            modified=_parse_dt(modified),
            fm_title=fm_title or "",
        )

    @classmethod
    def new(
        cls,
        memory_dir: Path,
        content: str,
        tags: list[str] | None = None,
        title: str = "",
    ) -> Note:
        """Create a brand-new note with a timestamp-based filename."""
        now = datetime.now()
        stem = now.strftime("%Y%m%d-%H%M%S")
        path = memory_dir / f"{stem}.md"

        counter = 1
        while path.exists():
            path = memory_dir / f"{stem}-{counter}.md"
            counter += 1

        resolved_tags = tags if tags else ["inbox"]

        note = cls(
            path=path,
            content=content,
            tags=resolved_tags,
            created=now,
            modified=now,
            fm_title=title,
        )
        note.save()
        return note

    # ── template for editor ──────────────────────────────────────
    @staticmethod
    def editor_template(tags: list[str] | None = None, title: str = "") -> str:
        now = datetime.now()
        tag_list = tags or []
        meta = dict(
            tags=tag_list,
            created=now.isoformat(),
            modified=now.isoformat(),
        )
        if title:
            meta["title"] = title
        post = frontmatter.Post("\n", **meta)
        return frontmatter.dumps(post) + "\n"
