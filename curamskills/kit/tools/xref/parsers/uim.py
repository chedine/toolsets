"""Parse UIM page/view files: declares pages, refs to facade operations,
linked pages, and connected properties."""
import xml.etree.ElementTree as ET
from pathlib import Path

GLOB = "*.uim"


def parse(path):
    root = ET.parse(path).getroot()
    page_id = root.get("PAGE_ID") or Path(path).stem
    refs = []
    for si in root.iter("SERVER_INTERFACE"):
        cls, op = si.get("CLASS"), si.get("OPERATION")
        if cls:
            refs.append({"to_type": "facade", "to_name": cls,
                         "kind": si.get("PHASE", "")})
        if cls and op:
            refs.append({"to_type": "facade_op", "to_name": f"{cls}.{op}",
                         "kind": si.get("PHASE", "")})
    for link in root.iter("LINK"):
        target = link.get("PAGE_ID")
        if target:
            refs.append({"to_type": "uim", "to_name": target, "kind": "link"})
    for inc in root.iter("INCLUDE"):  # .vim view includes
        f = inc.get("FILE_NAME")
        if f:
            refs.append({"to_type": "uim", "to_name": Path(f).stem,
                         "kind": "include"})
    return {"declares": [{"type": "uim", "name": page_id, "refs": refs}]}
