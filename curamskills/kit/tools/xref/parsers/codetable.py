"""Parse Curam codetable (.ctx) files: declares codetables and their codes."""
import xml.etree.ElementTree as ET

GLOB = "*.ctx"


def parse(path):
    root = ET.parse(path).getroot()
    declares = []
    for ct in root.iter("codetable"):
        name = ct.get("name") or ct.get("java_identifier") or "?"
        refs = [{"to_type": "code", "to_name": f"{name}.{c.get('value')}",
                 "kind": "defines"} for c in ct.iter("code")]
        declares.append({"type": "codetable", "name": name, "refs": refs})
    return {"declares": declares}
