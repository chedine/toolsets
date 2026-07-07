#!/usr/bin/env python3
"""Fail if the working tree modifies anything under */components/* outside
the custom components listed in kit.config.yaml.

Run before declaring any change complete. Exit 0 = clean, 1 = violations.
"""
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "xref"))
from common import find_repo_root, load_config  # noqa: E402


def main():
    repo = find_repo_root()
    cfg = load_config(repo)
    custom = set(cfg.get("custom_components", []))
    if not custom:
        raise SystemExit("custom_components not set in kit.config.yaml")

    out = subprocess.run(
        ["git", "status", "--porcelain"], cwd=repo,
        capture_output=True, text=True, check=True).stdout
    bad = []
    for line in out.splitlines():
        path = line[3:].split(" -> ")[-1].strip().strip('"')
        parts = Path(path).parts
        if "components" in parts:
            i = parts.index("components")
            if len(parts) > i + 1 and parts[i + 1] not in custom:
                bad.append(path)
    if bad:
        print("VIOLATION: changes outside custom components "
              f"({', '.join(sorted(custom))}):")
        for p in bad:
            print(f"  {p}")
        print("Revert these and re-apply the change inside a custom "
              "component (see agent-kit/skills/override-ootb-artifact/).")
        sys.exit(1)
    print("OK: no OOTB component modifications")


if __name__ == "__main__":
    main()
