"""Shared helpers for xref tools: repo root discovery and config loading.

kit.config.yaml is deliberately simple (flat keys, string lists) so it is
parsed here with no external dependency.
"""
from pathlib import Path


def find_repo_root(start: Path | None = None) -> Path:
    p = (start or Path.cwd()).resolve()
    for cand in [p, *p.parents]:
        if (cand / "kit.config.yaml").is_file():
            return cand
    raise SystemExit("kit.config.yaml not found upward from cwd; "
                     "pass --repo or run inside the agency repo")


def load_config(repo: Path) -> dict:
    """Minimal YAML subset parser: `key: value` and `key:` + `- item` lists."""
    cfg: dict = {}
    key = None
    for raw in (repo / "kit.config.yaml").read_text().splitlines():
        line = raw.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        if line.lstrip().startswith("- ") and key:
            cfg.setdefault(key, []).append(line.lstrip()[2:].strip())
        elif ":" in line and not line.startswith(" "):
            key, _, val = line.partition(":")
            key = key.strip()
            val = val.strip().strip('"')
            if val:
                cfg[key] = val
                key = None
    return cfg
