#!/usr/bin/env python3
"""Build the cross-reference index (xref.db) for a Curam codebase.

Indexes two views of the same codebase:

  source view — EJBServer/components/* and webclient/components/*.
      Answers "where do I edit". Component precedence is NOT computed here;
      that is the build's job.
  live view — the build's merged/generated output (config: live_roots, e.g.
      EJBServer/build). Answers "what actually runs": merged codetables, DMX,
      messages, resolved UIM. Reverse-reference queries should trust this
      view — it reflects merge/overwrite resolution exactly as the build did.

The build does not preserve provenance, but overwrite-type artifacts are
copied into the build verbatim, so a content-hash match between a live file
and a source file identifies the winning component. Hashes are stored here;
the `xref` CLI does the matching.

Run after a build so the live view is fresh. Usage:
  build_index.py [--repo PATH] [--db PATH] [--incremental]
"""
import argparse
import hashlib
import importlib
import pkgutil
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import parsers  # noqa: E402
from common import find_repo_root, load_config  # noqa: E402

SCHEMA = """
CREATE TABLE IF NOT EXISTS files(
  path TEXT PRIMARY KEY, component TEXT, view TEXT, mtime REAL, sha TEXT,
  indexed_at REAL);
CREATE TABLE IF NOT EXISTS artifacts(
  id INTEGER PRIMARY KEY, type TEXT, name TEXT, component TEXT, view TEXT,
  path TEXT, UNIQUE(type, name, path));
CREATE TABLE IF NOT EXISTS refs(
  src_id INTEGER REFERENCES artifacts(id) ON DELETE CASCADE,
  to_type TEXT, to_name TEXT, kind TEXT);
CREATE INDEX IF NOT EXISTS idx_art_name ON artifacts(type, name);
CREATE INDEX IF NOT EXISTS idx_refs_to ON refs(to_type, to_name);
CREATE INDEX IF NOT EXISTS idx_files_sha ON files(sha);
"""


def load_parsers():
    """Import every module in parsers/; each exposes GLOB and parse(path)."""
    mods = []
    for m in pkgutil.iter_modules(parsers.__path__):
        if not m.name.startswith("_"):
            mods.append(importlib.import_module(f"parsers.{m.name}"))
    return mods


def component_of(path: Path, repo: Path) -> str:
    parts = path.relative_to(repo).parts
    try:
        i = parts.index("components")
        return parts[i + 1]
    except (ValueError, IndexError):
        return "-"  # live-view files have no component


def index_file(db, parser, path: Path, repo: Path, view: str):
    comp = component_of(path, repo)
    rel = str(path.relative_to(repo))
    db.execute(
        "DELETE FROM refs WHERE src_id IN (SELECT id FROM artifacts WHERE path=?)",
        (rel,))
    db.execute("DELETE FROM artifacts WHERE path=?", (rel,))
    try:
        result = parser.parse(path)
    except Exception as e:  # keep indexing; record the failure
        print(f"  WARN parse failed {rel}: {e}", file=sys.stderr)
        return
    for decl in result.get("declares", []):
        cur = db.execute(
            "INSERT OR IGNORE INTO artifacts(type,name,component,view,path)"
            " VALUES(?,?,?,?,?)",
            (decl["type"], decl["name"], comp, view, rel))
        art_id = cur.lastrowid or db.execute(
            "SELECT id FROM artifacts WHERE type=? AND name=? AND path=?",
            (decl["type"], decl["name"], rel)).fetchone()[0]
        for ref in decl.get("refs", []):
            db.execute("INSERT INTO refs VALUES(?,?,?,?)",
                       (art_id, ref["to_type"], ref["to_name"],
                        ref.get("kind", "")))
    sha = hashlib.sha1(path.read_bytes()).hexdigest()
    db.execute("INSERT OR REPLACE INTO files VALUES(?,?,?,?,?,?)",
               (rel, comp, view, path.stat().st_mtime, sha, time.time()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", type=Path, default=None)
    ap.add_argument("--db", type=Path, default=None)
    ap.add_argument("--incremental", action="store_true")
    args = ap.parse_args()

    repo = args.repo or find_repo_root()
    cfg = load_config(repo)
    db_path = args.db or repo / cfg.get("xref_db", "agent-kit/xref.db")
    db = sqlite3.connect(db_path)
    db.executescript(SCHEMA)

    known = {}
    if args.incremental:
        known = dict(db.execute("SELECT path, mtime FROM files"))

    views = [("source", [repo / "EJBServer" / "components",
                         repo / "webclient" / "components"])]
    live_roots = [repo / p for p in cfg.get("live_roots", [])]
    if live_roots:
        views.append(("live", live_roots))
    else:
        print("NOTE: live_roots not set in kit.config.yaml — indexing source "
              "view only; reverse-reference queries will not reflect the "
              "build's merge resolution.", file=sys.stderr)

    for view, roots in views:
        for root in roots:
            if not root.is_dir():
                print(f"  WARN {view} root missing: {root}", file=sys.stderr)
    views = [(v, [r for r in roots if r.is_dir()]) for v, roots in views]

    n = 0
    for parser in load_parsers():
        for view, roots in views:
            for root in roots:
                for path in root.rglob(parser.GLOB):
                    rel = str(path.relative_to(repo))
                    if (args.incremental
                            and known.get(rel) == path.stat().st_mtime):
                        continue
                    index_file(db, parser, path, repo, view)
                    n += 1
    db.commit()
    print(f"Indexed {n} files -> {db_path}")
    for t, v, c in db.execute("SELECT type, view, COUNT(*) FROM artifacts "
                              "GROUP BY type, view ORDER BY type, view"):
        print(f"  {t} [{v}]: {c}")


if __name__ == "__main__":
    main()
