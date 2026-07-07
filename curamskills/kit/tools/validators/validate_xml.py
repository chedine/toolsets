#!/usr/bin/env python3
"""Validate Curam XML artifacts.

Always checks well-formedness. If kit.config.yaml maps the file's extension
to an XSD (xsd_map entries like `uim=path/to/UIM.xsd`) and xmllint is
available, also validates against the schema — Curam ships XSDs/DTDs for UIM
and codetables inside the client/server infrastructure; point xsd_map at
them.

Usage: validate_xml.py <file> [<file> ...]
"""
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "xref"))
from common import find_repo_root, load_config  # noqa: E402


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    repo = find_repo_root()
    cfg = load_config(repo)
    xsd_map = {}
    for entry in cfg.get("xsd_map", []):
        ext, _, xsd = entry.partition("=")
        xsd_map[ext.strip().lstrip(".")] = repo / xsd.strip()

    failed = False
    for f in map(Path, sys.argv[1:]):
        try:
            ET.parse(f)
        except ET.ParseError as e:
            print(f"FAIL {f}: not well-formed: {e}")
            failed = True
            continue
        xsd = xsd_map.get(f.suffix.lstrip("."))
        if xsd and xsd.is_file() and shutil.which("xmllint"):
            r = subprocess.run(["xmllint", "--noout", "--schema", str(xsd),
                                str(f)], capture_output=True, text=True)
            if r.returncode != 0:
                print(f"FAIL {f}: schema:\n{r.stderr.strip()}")
                failed = True
                continue
            print(f"OK   {f} (well-formed + schema)")
        else:
            print(f"OK   {f} (well-formed; no schema configured)")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
