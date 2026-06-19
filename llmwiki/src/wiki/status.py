from __future__ import annotations

import re
import subprocess
from pathlib import Path

from .config import WikiConfig
from .sources import parse_pending_urls, pending_markdown_files


def _read(path: Path) -> str:
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8")


def _without_fenced_code(markdown: str) -> str:
    lines: list[str] = []
    in_fence = False
    for line in markdown.splitlines():
        if line.strip().startswith("```"):
            in_fence = not in_fence
            continue
        if not in_fence:
            lines.append(line)
    return "\n".join(lines)


def _blocks(markdown: str) -> list[str]:
    markdown = _without_fenced_code(markdown)
    blocks: list[str] = []
    current: list[str] = []
    for line in markdown.splitlines():
        if line.startswith("## ") and current:
            blocks.append("\n".join(current))
            current = [line]
        else:
            current.append(line)
    if current:
        blocks.append("\n".join(current))
    return blocks


def _field(block: str, name: str) -> str | None:
    pattern = re.compile(rf"^-\s*{re.escape(name)}:\s*(.+?)\s*$", re.IGNORECASE | re.MULTILINE)
    match = pattern.search(block)
    if not match:
        return None
    return match.group(1).strip().lower()


def count_open_pending_questions(config: WikiConfig) -> int:
    pending = _read(config.paths.wiki_dir / "_meta" / "pending.md")
    count = 0
    for block in _blocks(pending):
        type_value = _field(block, "Type")
        status_value = _field(block, "Status")
        heading_is_question = block.startswith("## [Q-")
        is_question = type_value == "question" or heading_is_question
        is_open = status_value in {"open", "unresolved"}
        if is_question and is_open:
            count += 1
    return count


def count_unresolved_contradictions(config: WikiConfig) -> int:
    count = 0

    pending = _read(config.paths.wiki_dir / "_meta" / "pending.md")
    for block in _blocks(pending):
        type_value = _field(block, "Type")
        status_value = _field(block, "Status")
        heading_is_contradiction = block.startswith("## [C-")
        is_contradiction = type_value == "contradiction" or heading_is_contradiction
        unresolved = status_value in {"open", "unresolved"}
        if is_contradiction and unresolved:
            count += 1

    contradictions_dir = config.paths.wiki_dir / "contradictions"
    if contradictions_dir.exists():
        for path in contradictions_dir.glob("*.md"):
            text = _read(path)
            if re.search(r"^status:\s*(open|unresolved)\s*$", text, re.IGNORECASE | re.MULTILINE):
                count += 1

    return count


def last_log_entry(config: WikiConfig) -> str:
    log = _read(config.paths.wiki_dir / "_meta" / "log.md")
    headings = [line.strip() for line in log.splitlines() if line.startswith("## ")]
    if headings:
        return headings[-1].removeprefix("## ").strip()
    return "none"


def git_status(vault: Path) -> str:
    try:
        inside = subprocess.run(
            ["git", "-C", str(vault), "rev-parse", "--is-inside-work-tree"],
            check=False,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError:
        return "git unavailable"

    if inside.returncode != 0 or inside.stdout.strip() != "true":
        return "not a git repo"

    dirty = subprocess.run(
        ["git", "-C", str(vault), "status", "--porcelain"],
        check=False,
        capture_output=True,
        text=True,
    )
    if dirty.returncode != 0:
        return "unknown"
    return "dirty" if dirty.stdout.strip() else "clean"


def build_status(config: WikiConfig) -> dict[str, str | int]:
    return {
        "vault": config.name,
        "pending_urls": len(parse_pending_urls(config.paths.url_inbox)),
        "pending_markdown_files": len(pending_markdown_files(config)),
        "open_questions": count_open_pending_questions(config),
        "unresolved_contradictions": count_unresolved_contradictions(config),
        "last_log": last_log_entry(config),
        "git": git_status(config.root),
    }
