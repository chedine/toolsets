"""Profiles and course notebooks as plain JSON files.

    <data>/profiles.json                    learners, with their XP and active days
    <data>/courses/<id>/course.json         title, outline, per-chapter progress counters
    <data>/courses/<id>/<chapter-id>.json   lesson, questions, answers, grades, tutor threads

Every write is atomic (temp file + rename), so a crash never leaves half a notebook behind.
"""
import json
import os
import re
import secrets
import shutil
import threading
import time
from datetime import date, timedelta

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,79}$")


class NotFound(Exception):
    pass


def slug(text, n=40):
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")[:n].strip("-")
    return s or "course"


def now_ms():
    return int(time.time() * 1000)


def write_json(path, obj):
    tmp = f"{path}.{secrets.token_hex(4)}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        raise NotFound(path) from None


def streak(days, today=None):
    """Consecutive active days ending today (or yesterday, so the streak survives until bedtime)."""
    have = set(days or [])
    d = today or date.today()
    if d.isoformat() not in have:
        d -= timedelta(days=1)
    n = 0
    while d.isoformat() in have:
        n += 1
        d -= timedelta(days=1)
    return n


class Store:
    def __init__(self, root):
        self.root = root
        self.courses_dir = os.path.join(root, "courses")
        os.makedirs(self.courses_dir, exist_ok=True)
        self.lock = threading.RLock()

    # ---- profiles ----------------------------------------------------------

    def _profiles_path(self):
        return os.path.join(self.root, "profiles.json")

    def profiles(self):
        try:
            ps = read_json(self._profiles_path())
        except NotFound:
            ps = []
        for p in ps:
            p["streak"] = streak(p.get("days"))
        return ps

    def save_profile(self, data):
        with self.lock:
            ps = self.profiles()
            p = next((x for x in ps if x["id"] == data.get("id")), None)
            if p is None:
                p = {"id": f"{slug(data.get('name'), 20)}-{secrets.token_hex(2)}", "xp": 0, "days": [], "created": now_ms()}
                ps.append(p)
            for k in ("name", "emoji", "color", "about"):
                if k in data:
                    p[k] = str(data[k])[:500]
            write_json(self._profiles_path(), [{k: v for k, v in x.items() if k != "streak"} for x in ps])
            p["streak"] = streak(p.get("days"))
            return p

    def delete_profile(self, pid):
        with self.lock:
            ps = [x for x in self.profiles() if x["id"] != pid]
            write_json(self._profiles_path(), [{k: v for k, v in x.items() if k != "streak"} for x in ps])

    def profile(self, pid):
        p = next((x for x in self.profiles() if x["id"] == pid), None)
        if p is None:
            raise NotFound(pid)
        return p

    def activity(self, pid, xp):
        """Add XP and mark today active; returns the updated profile."""
        with self.lock:
            ps = self.profiles()
            p = next((x for x in ps if x["id"] == pid), None)
            if p is None:
                raise NotFound(pid)
            p["xp"] = int(p.get("xp", 0)) + max(0, int(xp))
            today = date.today().isoformat()
            if today not in p.setdefault("days", []):
                p["days"] = (p["days"] + [today])[-400:]
            write_json(self._profiles_path(), [{k: v for k, v in x.items() if k != "streak"} for x in ps])
            p["streak"] = streak(p["days"])
            return p

    # ---- courses -----------------------------------------------------------

    def _dir(self, cid):
        if not ID_RE.match(cid or ""):
            raise NotFound(cid)
        return os.path.join(self.courses_dir, cid)

    def courses(self, profile=None):
        out = []
        for name in os.listdir(self.courses_dir):
            path = os.path.join(self.courses_dir, name, "course.json")
            if not os.path.exists(path):
                continue
            c = read_json(path)
            if profile and c.get("profile") != profile:
                continue
            out.append(c)
        return sorted(out, key=lambda c: -c.get("updated", 0))

    def create_course(self, course):
        with self.lock:
            cid = f"{slug(course.get('title'))}-{secrets.token_hex(2)}"
            os.makedirs(self._dir(cid))
            course.update(id=cid, created=now_ms(), updated=now_ms())
            for ch in course.get("chapters", []):
                ch.setdefault("id", f"c{secrets.token_hex(3)}")
            write_json(os.path.join(self._dir(cid), "course.json"), course)
            return course

    def course(self, cid):
        return read_json(os.path.join(self._dir(cid), "course.json"))

    def save_course(self, course):
        with self.lock:
            course["updated"] = now_ms()
            write_json(os.path.join(self._dir(course["id"]), "course.json"), course)
            return course

    def delete_course(self, cid):
        with self.lock:
            shutil.rmtree(self._dir(cid), ignore_errors=True)

    # ---- chapters ----------------------------------------------------------

    def _ch_path(self, cid, chid):
        if not ID_RE.match(chid or ""):
            raise NotFound(chid)
        return os.path.join(self._dir(cid), f"{chid}.json")

    def chapter(self, cid, chid):
        return read_json(self._ch_path(cid, chid))

    def has_chapter(self, cid, chid):
        return os.path.exists(self._ch_path(cid, chid))

    def delete_chapter(self, cid, chid):
        with self.lock:
            if self.has_chapter(cid, chid):
                os.remove(self._ch_path(cid, chid))

    def save_chapter(self, cid, ch):
        """Write a chapter and refresh its progress counters in course.json."""
        with self.lock:
            write_json(self._ch_path(cid, ch["id"]), ch)
            course = self.course(cid)
            for entry in course["chapters"]:
                if entry["id"] == ch["id"]:
                    entry.update(progress(ch), status="ready")
            self.save_course(course)
            return ch


def progress(ch):
    """Counters shown on the course page: questions, answered, score (partial counts half), missed."""
    qs = ch.get("questions", [])
    answers = ch.get("answers", {})
    graded = [answers[q["id"]]["result"]["status"] for q in qs
              if (answers.get(q["id"]) or {}).get("result", {}).get("status") in ("correct", "partial", "incorrect")]
    score = sum(1 if s == "correct" else 0.5 if s == "partial" else 0 for s in graded)
    return {"total": len(qs), "answered": len(graded), "score": score,
            "missed": sum(1 for s in graded if s != "correct"), "finished": bool(ch.get("finished"))}
