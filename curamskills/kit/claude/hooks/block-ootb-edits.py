#!/usr/bin/env python3
"""Claude Code PreToolUse hook: deny Edit/Write to OOTB component files.

Belt-and-braces with check_ootb_untouched.py — this blocks the mistake
before it happens instead of catching it after. Registered by install.py in
.claude/settings.json for the Edit and Write tools.

Reads the hook JSON payload on stdin; exits 0 with a permissionDecision of
"deny" when the target path is inside */components/<name>/ where <name> is
not a custom component.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]
                       / "tools" / "xref"))
from common import find_repo_root, load_config  # noqa: E402


def main():
    payload = json.load(sys.stdin)
    path = (payload.get("tool_input") or {}).get("file_path", "")
    if not path:
        sys.exit(0)
    try:
        repo = find_repo_root(Path(payload.get("cwd", ".")))
        custom = set(load_config(repo).get("custom_components", []))
    except SystemExit:
        sys.exit(0)  # not inside an agency repo; don't interfere

    parts = Path(path).parts
    if "components" in parts and custom:
        i = parts.index("components")
        if len(parts) > i + 1 and parts[i + 1] not in custom:
            print(json.dumps({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": (
                        f"'{parts[i + 1]}' is an OOTB component — never edit "
                        "product components inline. Apply the change in a "
                        f"custom component ({', '.join(sorted(custom))}); "
                        "see agent-kit/skills/override-ootb-artifact/SKILL.md.")
                }}))
    sys.exit(0)


if __name__ == "__main__":
    main()
