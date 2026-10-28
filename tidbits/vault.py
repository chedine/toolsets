"""Markdown vault: one file per note, stored under its first tag's folder.

<vault>/<first-tag>/<id>-<slug>.md   (untagged notes live at the vault root)

    ---
    id: 20261026-230612
    created: 2026-10-26T23:06:12+05:30
    ---
    A [[data center]] can consume upto 500 thousand gallons of [[water]] a day. #stat

The note body is the source of truth for entities ([[...]]) and tags (#...).
The in-memory index is rebuilt incrementally from file mtimes, so edits made
outside the app (editor, git pull) show up on the next read. Everything that
reads the index goes through Vault, so it can be swapped for SQLite later.
"""
import os
import re
import threading
import time
from datetime import datetime

ENTITY = re.compile(r"\[\[([^\[\]\n]+)\]\]")
TAG = re.compile(r"(^|[\s(/])#([\w-]+)", re.UNICODE)
SKIP_DIRS = {".git", ".trash", ".obsidian", "node_modules"}


def entity_key(name):
    return " ".join(name.split()).lower()


def entities(text):
    out, seen = [], set()
    for m in ENTITY.finditer(text):
        name = " ".join(m.group(1).split())
        key = name.lower()
        if key and key not in seen:
            seen.add(key)
            out.append(name)
    return out


def tags(text):
    out = []
    for m in TAG.finditer(text):
        t = m.group(2).lower()
        if t not in out:
            out.append(t)
    return out


def slugify(text, words=6, limit=48):
    plain = ENTITY.sub(lambda m: m.group(1), text)
    plain = TAG.sub(lambda m: m.group(1), plain)
    parts = re.findall(r"[\w]+", plain.lower(), re.UNICODE)[:words]
    return "-".join(parts)[:limit].strip("-") or "note"


def parse_file(raw):
    """Return (meta, body). Files without frontmatter are accepted as-is."""
    meta = {}
    if raw.startswith("---\n"):
        end = raw.find("\n---", 4)
        if end != -1:
            for line in raw[4:end].splitlines():
                k, sep, v = line.partition(":")
                if sep:
                    meta[k.strip()] = v.strip()
            raw = raw[end + 4:]
            if raw.startswith("\n"):
                raw = raw[1:]
    return meta, raw.strip("\n")


def render_file(meta, body):
    head = "".join(f"{k}: {v}\n" for k, v in meta.items())
    return f"---\n{head}---\n{body.strip()}\n"


def parse_time(s, fallback):
    try:
        return int(datetime.fromisoformat(s).timestamp() * 1000)
    except (TypeError, ValueError):
        return fallback


class Conflict(Exception):
    def __init__(self, note):
        self.note = note


class Vault:
    def __init__(self, root):
        self.root = os.path.abspath(os.path.expanduser(root))
        os.makedirs(self.root, exist_ok=True)
        self.lock = threading.RLock()
        self.cache = {}  # relpath -> (mtime_ns, size, note)
        self.by_id = {}  # id -> relpath

    # ---- index -------------------------------------------------------------

    def scan(self):
        with self.lock:
            seen = {}
            for dirpath, dirnames, filenames in os.walk(self.root):
                dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
                for fn in filenames:
                    if not fn.endswith(".md"):
                        continue
                    full = os.path.join(dirpath, fn)
                    rel = os.path.relpath(full, self.root)
                    try:
                        st = os.stat(full)
                    except FileNotFoundError:
                        continue
                    hit = self.cache.get(rel)
                    if hit and hit[0] == st.st_mtime_ns and hit[1] == st.st_size:
                        seen[rel] = hit
                        continue
                    note = self._read(full, rel, st)
                    if note:
                        seen[rel] = (st.st_mtime_ns, st.st_size, note)
            self.cache = seen
            self.by_id = {}
            for rel in sorted(seen):
                note = seen[rel][2]
                if note["id"] in self.by_id:  # copied file: fall back to its path
                    note["id"] = rel
                self.by_id[note["id"]] = rel
            return [v[2] for v in seen.values()]

    def _read(self, full, rel, st):
        try:
            with open(full, encoding="utf-8") as f:
                meta, body = parse_file(f.read())
        except (OSError, UnicodeDecodeError):
            return None
        mtime = st.st_mtime_ns // 1_000_000
        return {
            "id": meta.get("id") or os.path.splitext(os.path.basename(rel))[0],
            "created": parse_time(meta.get("created"), mtime),
            "updated": mtime,
            "path": rel,
            "text": body,
        }

    def notes(self):
        return sorted(self.scan(), key=lambda n: -n["created"])

    def graph(self):
        """Entities as nodes, co-occurrence within a note as weighted links."""
        nodes, links = {}, {}
        for n in self.scan():
            names = entities(n["text"])
            keys = [entity_key(x) for x in names]
            for name, key in zip(names, keys):
                node = nodes.setdefault(key, {"id": key, "name": name, "count": 0, "notes": []})
                node["count"] += 1
                node["notes"].append(n["id"])
            for i in range(len(keys)):
                for j in range(i + 1, len(keys)):
                    a, b = sorted((keys[i], keys[j]))
                    link = links.setdefault((a, b), {"source": a, "target": b, "weight": 0, "notes": []})
                    link["weight"] += 1
                    link["notes"].append(n["id"])
        return {"nodes": list(nodes.values()), "links": list(links.values())}

    # ---- writes ------------------------------------------------------------

    def _folder(self, text):
        t = tags(text)
        return t[0] if t else ""

    def _write(self, rel, content):
        full = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        tmp = full + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(tmp, full)

    def _get(self, note_id):
        self.scan()
        rel = self.by_id.get(note_id)
        if not rel:
            raise KeyError(note_id)
        return rel, self.cache[rel][2]

    def create(self, text):
        text = text.strip()
        if not text:
            raise ValueError("empty note")
        with self.lock:
            self.scan()
            now = datetime.now().astimezone()
            base = now.strftime("%Y%m%d-%H%M%S")
            note_id, i = base, 2
            while note_id in self.by_id:
                note_id, i = f"{base}-{i}", i + 1
            rel = os.path.join(self._folder(text), f"{note_id}-{slugify(text)}.md")
            meta = {"id": note_id, "created": now.isoformat(timespec="seconds")}
            self._write(rel, render_file(meta, text))
            return self._get(note_id)[1]

    def update(self, note_id, text, base=None):
        text = text.strip()
        if not text:
            raise ValueError("empty note")
        with self.lock:
            rel, cur = self._get(note_id)
            if base is not None and int(base) != cur["updated"]:
                raise Conflict(cur)
            with open(os.path.join(self.root, rel), encoding="utf-8") as f:
                meta, _ = parse_file(f.read())
            meta.setdefault("id", note_id)
            meta.setdefault("created", datetime.fromtimestamp(cur["created"] / 1000).astimezone().isoformat(timespec="seconds"))
            new_rel = os.path.join(self._folder(text), os.path.basename(rel))
            if new_rel != rel and os.path.exists(os.path.join(self.root, new_rel)):
                stem, ext = os.path.splitext(new_rel)
                new_rel = f"{stem}-{int(time.time())}{ext}"
            self._write(new_rel, render_file(meta, text))
            if new_rel != rel:
                os.remove(os.path.join(self.root, rel))
                self._prune(os.path.dirname(rel))
            return self._get(note_id)[1]

    def delete(self, note_id):
        with self.lock:
            rel, _ = self._get(note_id)
            dest = os.path.join(self.root, ".trash", rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            if os.path.exists(dest):
                stem, ext = os.path.splitext(dest)
                dest = f"{stem}-{int(time.time())}{ext}"
            os.replace(os.path.join(self.root, rel), dest)
            self._prune(os.path.dirname(rel))
            self.scan()

    def _prune(self, rel_dir):
        """Remove a tag folder once its last note has moved out."""
        if not rel_dir:
            return
        try:
            os.rmdir(os.path.join(self.root, rel_dir))
        except OSError:
            pass
