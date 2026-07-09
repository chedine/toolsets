#!/usr/bin/env python3
"""Parse a CER (CREOLE) session dump into a JSON graph and emit a
self-contained viewer.html.

Usage:
    python3 parse.py <dump-dir> [-o viewer.html] [--json graph.json]

The dump directory is the one containing index.html, the per-ruleset
pages, and a RuleObjects/ folder of per-object pages.
"""

import argparse
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path


# ---------------------------------------------------------------- mini DOM

class Node:
    __slots__ = ("tag", "attrs", "children", "parent")

    def __init__(self, tag, attrs=None, parent=None):
        self.tag = tag
        self.attrs = dict(attrs or {})
        self.children = []          # Node or str
        self.parent = parent

    def find_all(self, tag):
        out = []
        stack = list(self.children)
        while stack:
            n = stack.pop(0)
            if isinstance(n, Node):
                if n.tag == tag:
                    out.append(n)
                stack = list(n.children) + stack
        return out

    def direct(self, tag):
        return [c for c in self.children if isinstance(c, Node) and c.tag == tag]

    def text(self):
        parts = []
        stack = list(self.children)
        while stack:
            n = stack.pop(0)
            if isinstance(n, str):
                parts.append(n)
            else:
                stack = list(n.children) + stack
        return "".join(parts)


class DomParser(HTMLParser):
    VOID = {"br", "hr", "img", "meta", "link", "input"}
    # tags whose open implicitly closes a same-tag ancestor
    AUTOCLOSE = {"li": {"li"}, "tr": {"tr", "td", "th"}, "td": {"td", "th"},
                 "th": {"td", "th"}, "p": {"p"}}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("root")
        self.cur = self.root

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        for closer in self.AUTOCLOSE.get(tag, ()):
            n = self.cur
            while n is not self.root:
                if n.tag == closer:
                    self.cur = n.parent
                    break
                if n.tag in ("table", "ul"):
                    break
                n = n.parent
        node = Node(tag, attrs, self.cur)
        self.cur.children.append(node)
        if tag not in self.VOID:
            self.cur = node

    def handle_endtag(self, tag):
        tag = tag.lower()
        n = self.cur
        while n is not self.root:
            if n.tag == tag:
                self.cur = n.parent
                return
            # a stray end tag must not close anything beyond its enclosing
            # cell/table — otherwise unbalanced markup deep inside a
            # derivation swallows the rest of the row
            if n.tag in ("td", "th", "table") and tag != "table":
                return
            n = n.parent

    def handle_data(self, data):
        if data:
            self.cur.children.append(data)


def parse_html(path: Path) -> Node:
    p = DomParser()
    p.feed(path.read_text(encoding="utf-8", errors="replace"))
    return p.root


# ------------------------------------------------------------- extraction

LINK_RE = re.compile(r"([^/#]+)\.html(?:#(.+))?$")


def parse_ref(href):
    """'.../<objId>.html#<attr>' -> (objId, attr|None); None if no match."""
    m = LINK_RE.search(href or "")
    if not m:
        return None
    return m.group(1), m.group(2)


def clean(s):
    return re.sub(r"\s+", " ", s or "").strip()


def list_items(node):
    """All <li> of a <ul>/<ol>, descending through lists nested directly
    inside a list (the dump emits <UL>text<OL><LI>… with no wrapping <LI>)."""
    out = []
    for c in node.children:
        if isinstance(c, Node):
            if c.tag == "li":
                out.append(c)
            elif c.tag in ("ul", "ol"):
                out.extend(list_items(c))
    return out


def derivation_tree(node):
    """Convert a derivation <TD> subtree into a recursive JSON tree.

    Each item: {"t": text} | {"ref": [obj, attr], "t": label} |
               {"t": text, "c": [children]} |
               {"tbl": {"h": [headers], "rows": [[cell_items, ...], ...]}}
    (tbl = an embedded decision table, typically If/Then)
    """
    items = []
    buf = []

    def flush():
        t = clean("".join(buf))
        buf.clear()
        if t:
            items.append({"t": t})

    for child in node.children:
        if isinstance(child, str):
            buf.append(child)
        elif child.tag == "a":
            flush()
            ref = parse_ref(child.attrs.get("href", ""))
            label = clean(child.text())
            if ref:
                items.append({"t": label, "ref": [ref[0], ref[1] or ""]})
            else:
                items.append({"t": label})
        elif child.tag in ("ul", "ol"):
            flush()
            for li in list_items(child):
                sub = derivation_tree(li)
                if len(sub) == 1 and "c" not in sub[0]:
                    items.append(sub[0])
                elif sub:
                    plain_head = "c" not in sub[0] and "tbl" not in sub[0]
                    head = sub[0] if plain_head else {"t": ""}
                    rest = sub[1:] if plain_head else sub
                    entry = dict(head)
                    if rest:
                        entry["c"] = rest
                    items.append(entry)
        elif child.tag == "table":
            flush()
            headers = [clean(th.text()) for th in child.find_all("th")]
            rows = []
            for tr in child.find_all("tr"):
                tds = tr.direct("td")
                if tds:
                    rows.append([derivation_tree(td) for td in tds])
            items.append({"tbl": {"h": headers, "rows": rows}})
        else:
            buf.append(child.text())
    flush()
    return items


def parse_value(td):
    """Value cell -> plain string, {"tl": [[from,to,value],...]} for a nested
    Timeline table, {"ref": objId, "t": label} for a rule-object reference, or
    {"list": [[objId|None, label], ...]} for a list of references."""
    tables = td.find_all("table")
    for t in tables:
        ths = t.find_all("th")
        if ths and clean(ths[0].text()).lower() == "timeline":
            rows = []
            for tr in t.find_all("tr"):
                tds = tr.direct("td")
                if len(tds) == 3:
                    rows.append([clean(td_.text()) for td_ in tds])
            if rows:
                return {"tl": rows}
    anchors = [(parse_ref(a.attrs.get("href", "")), clean(a.text()))
               for a in td.find_all("a")]
    anchors = [(r[0], t) for r, t in anchors if r and not r[1]]
    if len(anchors) == 1:
        return {"ref": anchors[0][0], "t": anchors[0][1]}
    if anchors:
        return {"list": [[oid, t] for oid, t in anchors]}
    return clean(td.text())


def parse_rule_object(path: Path):
    root = parse_html(path)
    obj_id = path.stem
    sections = {}
    body = root.find_all("body")
    body = body[0] if body else root
    current = None
    for child in body.children:
        if isinstance(child, Node) and child.tag == "h2":
            current = clean(child.text())
            sections[current] = []
        elif current is not None and isinstance(child, Node):
            sections[current].append(child)

    def sec_text(name):
        nodes = sections.get(name, [])
        return clean(" ".join(n.text() for n in nodes))

    obj = {
        "id": obj_id,
        "type": sec_text("Type"),
        "desc": sec_text("Description"),
        "creation": sec_text("Creation"),
        "action": sec_text("Action during this session"),
        "attrs": {},
    }

    tables = []
    for n in sections.get("Attributes", []):
        tables.extend([n] if n.tag == "table" else n.find_all("table"))
    for table in tables:
        for tr in table.find_all("tr"):
            tds = tr.direct("td")
            if len(tds) < 6:
                continue
            name = clean(tds[0].text())
            deps = []
            for a in tds[5].find_all("a"):
                ref = parse_ref(a.attrs.get("href", ""))
                if ref and ref[1]:
                    deps.append([ref[0], ref[1]])
            obj["attrs"][name] = {
                "type": clean(tds[1].text()),
                "state": clean(tds[2].text()),
                "value": parse_value(tds[3]),
                "deriv": derivation_tree(tds[4]),
                "deps": deps,
            }
    return obj


def parse_ruleset_page(path: Path):
    """Return (ruleset_name, [object ids referenced])."""
    root = parse_html(path)
    title = root.find_all("title")
    name = clean(title[0].text()) if title else path.stem
    ids = []
    for a in root.find_all("a"):
        href = a.attrs.get("href", "")
        if "RuleObjects/" in href:
            ref = parse_ref(href)
            if ref:
                ids.append(ref[0])
    return name, ids


# ------------------------------------------------------------------ main

def build_graph(dump_dir: Path):
    ro_dir = dump_dir / "RuleObjects"
    if not ro_dir.is_dir():
        sys.exit(f"error: {ro_dir} not found — is this a session dump directory?")

    objects = {}
    for f in sorted(ro_dir.glob("*.html")):
        obj = parse_rule_object(f)
        objects[obj["id"]] = obj

    rulesets = {}
    obj_ruleset = {}
    for f in sorted(dump_dir.glob("*.html")):
        if f.name == "index.html":
            continue
        name, ids = parse_ruleset_page(f)
        ids = [i for i in ids if i in objects]
        if ids:
            rulesets[name] = sorted(set(ids))
            for i in ids:
                obj_ruleset[i] = name

    for oid, obj in objects.items():
        obj["ruleset"] = obj_ruleset.get(oid) or (obj["type"].split(".")[0] if "." in obj["type"] else "")

    n_attrs = sum(len(o["attrs"]) for o in objects.values())
    n_edges = sum(len(a["deps"]) for o in objects.values() for a in o["attrs"].values())
    meta = {
        "source": str(dump_dir),
        "objects": len(objects),
        "attributes": n_attrs,
        "edges": n_edges,
    }
    return {"meta": meta, "rulesets": rulesets, "objects": objects}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("dump_dir", type=Path)
    ap.add_argument("-o", "--out", type=Path, default=Path("viewer.html"))
    ap.add_argument("--json", type=Path, help="also write the raw graph JSON")
    args = ap.parse_args()

    graph = build_graph(args.dump_dir)
    if args.json:
        args.json.write_text(json.dumps(graph, indent=1), encoding="utf-8")
        print(f"wrote {args.json}")

    template = Path(__file__).parent / "viewer_template.html"
    if not template.exists():
        sys.exit(f"error: {template} not found")
    payload = json.dumps(graph, separators=(",", ":"))
    payload = payload.replace("</", "<\\/")  # keep </script> inert
    html = template.read_text(encoding="utf-8").replace("/*__DATA__*/null", payload, 1)
    args.out.write_text(html, encoding="utf-8")
    m = graph["meta"]
    print(f"wrote {args.out}: {m['objects']} objects, "
          f"{m['attributes']} attributes, {m['edges']} edges")


if __name__ == "__main__":
    main()
