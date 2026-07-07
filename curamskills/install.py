#!/usr/bin/env python3
"""Install/update the curamskills kit into an agency repo.

Prereq: copy agency-template/kit.config.yaml to the repo root and fill it in.

  python3 install.py /path/to/agency-repo

Writes (overwriting kit-owned files, never agency-owned ones):
  AGENTS.md                  rendered from kit/AGENTS.template.md
  CLAUDE.md                  one-line pointer to AGENTS.md (if absent)
  agent-kit/docs|skills|tools|claude/   the portable core
  .claude/skills/<name>/     copies of each skill for Claude Code
  .claude/settings.json      hook registration (only created if absent;
                             otherwise prints the fragment to merge by hand)

Never touched: kit.config.yaml, agent-kit/docs/agency-notes/, agent-kit/xref.db
"""
import json
import shutil
import stat
import sys
from pathlib import Path

KIT = Path(__file__).parent / "kit"


def load_config(repo: Path) -> dict:
    sys.path.insert(0, str(KIT / "tools" / "xref"))
    from common import load_config as lc
    return lc(repo)


def render_agents_md(cfg: dict) -> str:
    text = (KIT / "AGENTS.template.md").read_text()
    subs = {
        "{{AGENCY_NAME}}": cfg.get("agency_name", "the agency"),
        "{{COMPONENT_ORDER}}": ", ".join(cfg.get("component_order", [])),
        "{{CUSTOM_COMPONENTS}}": ", ".join(cfg.get("custom_components", [])),
        "{{PRIMARY_COMPONENT}}": cfg.get("primary_component", ""),
        "{{BUILD_COMMAND}}": cfg.get("build_command", ""),
    }
    for k, v in subs.items():
        text = text.replace(k, v)
    return text


def copy_tree(src: Path, dst: Path, preserve: set[str] = frozenset()):
    for item in src.rglob("*"):
        rel = item.relative_to(src)
        if any(str(rel).startswith(p) for p in preserve) or item.is_dir():
            continue
        target = dst / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(item, target)
        if item.suffix == ".py" or item.name in ("xref", "manuals-search"):
            target.chmod(target.stat().st_mode | stat.S_IEXEC)


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    repo = Path(sys.argv[1]).resolve()
    if not (repo / "kit.config.yaml").is_file():
        raise SystemExit(
            f"{repo}/kit.config.yaml missing — copy it from "
            "agency-template/ and fill it in first")
    cfg = load_config(repo)

    # 1. portable core
    kit_dst = repo / "agent-kit"
    for sub in ("docs", "skills", "tools", "claude"):
        copy_tree(KIT / sub, kit_dst / sub,
                  preserve={"agency-notes"} if sub == "docs" else set())
    (kit_dst / "docs" / "agency-notes").mkdir(parents=True, exist_ok=True)

    # 2. AGENTS.md + CLAUDE.md pointer
    (repo / "AGENTS.md").write_text(render_agents_md(cfg))
    claude_md = repo / "CLAUDE.md"
    if not claude_md.exists():
        claude_md.write_text("Read AGENTS.md — it is the source of truth "
                             "for working in this repo.\n")

    # 3. Claude Code skills
    for skill_dir in (KIT / "skills").iterdir():
        if skill_dir.name.startswith("_") or not skill_dir.is_dir():
            continue
        dst = repo / ".claude" / "skills" / skill_dir.name
        dst.mkdir(parents=True, exist_ok=True)
        for f in skill_dir.iterdir():
            shutil.copy2(f, dst / f.name)

    # 4. hook registration
    settings = repo / ".claude" / "settings.json"
    fragment = json.loads((KIT / "claude" / "settings-fragment.json").read_text())
    fragment.pop("_comment", None)
    if settings.exists():
        print(f"NOTE: {settings} exists — merge this fragment by hand:\n"
              + json.dumps(fragment, indent=2))
    else:
        settings.parent.mkdir(parents=True, exist_ok=True)
        settings.write_text(json.dumps(fragment, indent=2) + "\n")

    print(f"Installed kit into {repo}")
    print("Next: python3 agent-kit/tools/xref/build_index.py")


if __name__ == "__main__":
    main()
