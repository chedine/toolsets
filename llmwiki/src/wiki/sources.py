from __future__ import annotations

import shutil
from datetime import date
from pathlib import Path

from .config import WikiConfig

URL_ARCHIVE_STATUSES = {"ingested", "rejected", "duplicate", "partial", "failed-fetch"}
MD_ARCHIVE_STATUSES = {"ingested", "rejected", "duplicate"}


def parse_pending_urls(path: Path) -> list[str]:
    if not path.exists():
        return []
    urls: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        urls.append(stripped)
    return urls


def add_url(config: WikiConfig, url: str) -> bool:
    inbox = config.paths.url_inbox
    inbox.parent.mkdir(parents=True, exist_ok=True)
    existing = parse_pending_urls(inbox)
    if url in existing:
        return False

    if inbox.exists():
        content = inbox.read_text(encoding="utf-8")
        needs_newline = bool(content) and not content.endswith("\n")
    else:
        content = ""
        needs_newline = False

    with inbox.open("a", encoding="utf-8") as f:
        if needs_newline:
            f.write("\n")
        f.write(f"{url}\n")
    return True


def pending_markdown_files(config: WikiConfig) -> list[Path]:
    inbox_dir = config.paths.markdown_inbox_dir
    if not inbox_dir.exists():
        return []
    return sorted(
        p for p in inbox_dir.iterdir()
        if p.is_file() and p.suffix.lower() == ".md" and p.name != "urls.txt"
    )


def list_sources(config: WikiConfig) -> list[tuple[str, str]]:
    items: list[tuple[str, str]] = []
    for url in parse_pending_urls(config.paths.url_inbox):
        items.append(("URL", url))
    for path in pending_markdown_files(config):
        try:
            shown = str(path.relative_to(config.root))
        except ValueError:
            shown = str(path)
        items.append(("MD", shown))
    return items


def archive_url(config: WikiConfig, url: str, status: str) -> None:
    if status not in URL_ARCHIVE_STATUSES:
        allowed = ", ".join(sorted(URL_ARCHIVE_STATUSES))
        raise ValueError(f"Invalid URL archive status '{status}'. Allowed: {allowed}")

    inbox = config.paths.url_inbox
    if not inbox.exists():
        raise FileNotFoundError(f"URL inbox not found: {inbox}")

    lines = inbox.read_text(encoding="utf-8").splitlines(keepends=True)
    removed = False
    kept: list[str] = []
    for line in lines:
        if line.strip() == url:
            removed = True
            continue
        kept.append(line)

    if not removed:
        raise ValueError(f"URL not found in inbox: {url}")

    inbox.write_text("".join(kept), encoding="utf-8")

    archive = config.paths.url_archive
    archive.parent.mkdir(parents=True, exist_ok=True)
    entry = f"{date.today().isoformat()} | {status} | {url}\n"
    with archive.open("a", encoding="utf-8") as f:
        f.write(entry)


def _unique_destination(dest: Path) -> Path:
    if not dest.exists():
        return dest
    stem = dest.stem
    suffix = dest.suffix
    parent = dest.parent
    i = 1
    while True:
        candidate = parent / f"{stem}-{i}{suffix}"
        if not candidate.exists():
            return candidate
        i += 1


def _resolve_md_source(config: WikiConfig, source: str) -> Path:
    raw = Path(source).expanduser()
    candidates: list[Path] = []
    if raw.is_absolute():
        candidates.append(raw)
    else:
        candidates.append(config.root / raw)
        candidates.append(Path.cwd() / raw)

    for candidate in candidates:
        if candidate.exists():
            return candidate.resolve()

    # Return the vault-relative candidate for a useful error message.
    return candidates[0].resolve()


def archive_markdown(config: WikiConfig, source: str, status: str) -> Path:
    if status not in MD_ARCHIVE_STATUSES:
        allowed = ", ".join(sorted(MD_ARCHIVE_STATUSES))
        raise ValueError(f"Invalid markdown archive status '{status}'. Allowed: {allowed}")

    src = _resolve_md_source(config, source)
    if not src.exists():
        raise FileNotFoundError(f"Markdown source not found: {src}")
    if not src.is_file():
        raise ValueError(f"Markdown source is not a file: {src}")
    if src.suffix.lower() != ".md":
        raise ValueError(f"Markdown source must be a .md file: {src}")

    inbox = config.paths.markdown_inbox_dir.resolve()
    try:
        src.relative_to(inbox)
    except ValueError as exc:
        raise ValueError(f"Markdown source must be under {inbox}: {src}") from exc

    if status in {"ingested", "duplicate"}:
        dest_dir = config.paths.markdown_archive_dir
    else:
        dest_dir = config.paths.rejected_dir
    dest_dir.mkdir(parents=True, exist_ok=True)

    dest = _unique_destination(dest_dir / src.name)
    shutil.move(str(src), str(dest))
    return dest
