"""Configuration management for mem.

Config lives at ~/.config/mem/config.yaml and is created with sane
defaults on first run.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml

_CONFIG_DIR = Path.home() / ".config" / "mem"
_CONFIG_FILE = _CONFIG_DIR / "config.yaml"

_DEFAULTS = {
    "memory_dir": "~/memory",
    "editor": os.environ.get("EDITOR", "vim"),
    "default_tags": [],
    "assets_subdir": ".assets",
}


@dataclass
class MemConfig:
    memory_dir: Path
    editor: str
    default_tags: list[str]
    assets_subdir: str

    # ── derived paths ────────────────────────────────────────────
    @property
    def assets_dir(self) -> Path:
        return self.memory_dir / self.assets_subdir

    # ── ensure dirs exist ────────────────────────────────────────
    def ensure_dirs(self) -> None:
        self.memory_dir.mkdir(parents=True, exist_ok=True)
        self.assets_dir.mkdir(parents=True, exist_ok=True)


def load_config() -> MemConfig:
    """Load config from disk, creating defaults if needed."""
    if not _CONFIG_FILE.exists():
        _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        _CONFIG_FILE.write_text(yaml.dump(_DEFAULTS, default_flow_style=False))

    raw = yaml.safe_load(_CONFIG_FILE.read_text()) or {}
    merged = {**_DEFAULTS, **raw}

    cfg = MemConfig(
        memory_dir=Path(merged["memory_dir"]).expanduser().resolve(),
        editor=merged["editor"],
        default_tags=merged.get("default_tags", []),
        assets_subdir=merged.get("assets_subdir", ".assets"),
    )
    cfg.ensure_dirs()
    return cfg
