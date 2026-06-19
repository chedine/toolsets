from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


USER_CONFIG_PATH = Path.home() / ".config" / "wiki" / "config.yaml"


@dataclass(frozen=True)
class WikiPaths:
    root: Path
    wiki_dir: Path
    sources_dir: Path
    url_inbox: Path
    url_archive: Path
    markdown_inbox_dir: Path
    markdown_archive_dir: Path
    rejected_dir: Path


@dataclass(frozen=True)
class WikiConfig:
    root: Path
    name: str
    topic: str
    paths: WikiPaths
    raw: dict[str, Any]


def read_yaml(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {}


def _expand_path(value: str | os.PathLike[str]) -> Path:
    return Path(value).expanduser().resolve()


def user_default_vault() -> Path | None:
    config = read_yaml(USER_CONFIG_PATH)
    default_vault = config.get("default_vault")
    if not default_vault:
        return None
    return _expand_path(default_vault)


def resolve_vault_path(cli_vault: str | Path | None = None) -> Path:
    """Resolve an existing vault for normal commands.

    Keep agent usage predictable: without --vault, only the current directory is
    considered a vault, and only when it contains wiki.yaml.
    """
    if cli_vault:
        return _expand_path(cli_vault)

    cwd = Path.cwd().resolve()
    if (cwd / "wiki.yaml").exists():
        return cwd

    raise FileNotFoundError(
        "Could not resolve vault. Use --vault /path/to/vault or run from a "
        "directory containing wiki.yaml."
    )


def resolve_init_vault(cli_vault: str | Path | None = None) -> Path:
    """Resolve target vault for init. Defaults to the current directory."""
    if cli_vault:
        return _expand_path(cli_vault)

    return Path.cwd().resolve()


def _path_from_config(root: Path, value: str | None, default: str) -> Path:
    raw = value or default
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = root / path
    return path.resolve()


def load_config(vault: Path) -> WikiConfig:
    root = vault.expanduser().resolve()
    raw = read_yaml(root / "wiki.yaml")

    vault_section = raw.get("vault", {}) if isinstance(raw.get("vault", {}), dict) else {}
    sources_section = raw.get("sources", {}) if isinstance(raw.get("sources", {}), dict) else {}

    name = str(vault_section.get("name") or root.name)
    topic = str(vault_section.get("topic") or "Personal knowledge base")

    wiki_dir = _path_from_config(root, vault_section.get("wiki_dir"), "wiki")
    sources_dir = _path_from_config(root, vault_section.get("sources_dir"), "sources")

    paths = WikiPaths(
        root=root,
        wiki_dir=wiki_dir,
        sources_dir=sources_dir,
        url_inbox=_path_from_config(root, sources_section.get("url_inbox"), "sources/inbox/urls.txt"),
        url_archive=_path_from_config(root, sources_section.get("url_archive"), "sources/archive/urls.txt"),
        markdown_inbox_dir=_path_from_config(root, sources_section.get("markdown_inbox_dir"), "sources/inbox"),
        markdown_archive_dir=_path_from_config(root, sources_section.get("markdown_archive_dir"), "sources/archive/markdown"),
        rejected_dir=_path_from_config(root, sources_section.get("rejected_dir"), "sources/rejected"),
    )

    return WikiConfig(root=root, name=name, topic=topic, paths=paths, raw=raw)
