"""Course logic: outline -> chapters (written lazily) -> answers, grades and tutor threads.

Every model call goes through LLM.run with the task's configured model ("outline", "chapter", "grade",
"tutor"), and every prompt is a template from config (so the Settings page can edit them).
"""
import json
import re
import secrets
import threading

from config import fill
from llm import LLMError, extract_json
from store import NotFound, now_ms

TYPES = ("mcq", "fill", "free", "math", "python")
TYPE_LABELS = {"mcq": "Multiple choice", "fill": "Fill in the blanks", "free": "Free-form",
               "math": "Math", "python": "Python"}
ACTION_RE = re.compile(r"```action\s*\n(.*?)```", re.S)
STATUS_RANK = {None: 0, "incorrect": 1, "partial": 2, "correct": 3}


class BadRequest(Exception):
    pass


def learner(profile):
    about = (profile.get("about") or "").strip() or "an adult learner"
    return f"{profile.get('name') or 'Learner'}: {about}"


def norm_latex(s):
    s = (s or "").replace("\\left", "").replace("\\right", "").replace("\\,", "").replace("\\!", "")
    s = s.replace("\\cdot", "*").replace("\\times", "*").replace("−", "-").replace("\\dfrac", "\\frac")
    return re.sub(r"\s+", "", s).strip(".").lower()


def clean_question(q, allowed):
    """A validated copy of a generated question, or None if it is unusable."""
    if not isinstance(q, dict) or q.get("type") not in allowed or not str(q.get("prompt") or "").strip():
        return None
    out = {"type": q["type"], "prompt": str(q["prompt"]), "concept": str(q.get("concept") or "")[:80],
           "hints": [str(h) for h in (q.get("hints") or []) if str(h).strip()][:4],
           "solution": str(q.get("solution") or "")}
    t = q["type"]
    if t == "mcq":
        opts = [str(o) for o in (q.get("options") or [])]
        c = q.get("correct")
        if len(opts) < 2 or not isinstance(c, int) or not 0 <= c < len(opts):
            return None
        out.update(options=opts, correct=c)
    elif t == "fill":
        tpl = str(q.get("template") or "")
        blanks = [[str(a) for a in (b if isinstance(b, list) else [b])] for b in (q.get("blanks") or [])]
        marks = re.findall(r"\[\[(\d+)\]\]", tpl)
        if not marks or len(marks) != len(blanks) or any(not b for b in blanks):
            return None
        out.update(template=tpl, blanks=blanks)
    elif t == "free":
        out["rubric"] = [str(r) for r in (q.get("rubric") or [])][:6]
    elif t == "math":
        if not str(q.get("answer") or "").strip():
            return None
        out.update(answer=str(q["answer"]), answer_label=str(q.get("answer_label") or ""),
                   working=bool(q.get("working")))
    elif t == "python":
        tests = str(q.get("tests") or "")
        if "def test_" not in tests:
            return None
        out.update(starter=str(q.get("starter") or ""), tests=tests)
    return out


class Engine:
    def __init__(self, cfg, store, llm):
        self.cfg, self.store, self.llm = cfg, store, llm
        self.busy = set()
        self.busy_lock = threading.Lock()

    # ---- model calls -------------------------------------------------------

    def call(self, task, system, prompt, on_delta=None, alive=lambda: True):
        t = self.cfg["tasks"][task]
        return self.llm.run(t["model"], system, prompt, on_delta=on_delta, effort=t.get("effort") or "",
                            timeout=int(t.get("timeout") or 180), alive=alive)

    def call_json(self, task, system, prompt, on_delta=None, alive=lambda: True):
        text = self.call(task, system, prompt, on_delta, alive)
        try:
            return extract_json(text)
        except ValueError:
            retry = (f"{prompt}\n\nYour previous reply was not valid JSON. Reply again with ONLY the JSON object, "
                     "no prose and no code fences.")
            return extract_json(self.call(task, system, retry, None, alive))

    def claim(self, key):
        with self.busy_lock:
            if key in self.busy:
                raise BadRequest("already being written, give it a moment")
            self.busy.add(key)

    def release(self, key):
        with self.busy_lock:
            self.busy.discard(key)

    def schema(self):
        return self.cfg.prompt("question_schema")

    def types_text(self, types):
        return ", ".join(f'"{t}" ({TYPE_LABELS[t]})' for t in types)

    # ---- outline -----------------------------------------------------------

    def build_course(self, params, emit, alive):
        profile = self.store.profile(params.get("profile") or "")
        topic = str(params.get("topic") or "").strip()
        if not topic:
            raise BadRequest("tell me what you want to learn")
        course_cfg = self.cfg["course"]
        types = [t for t in (params.get("types") or course_cfg["types"]) if t in TYPES] or list(TYPES)
        depth = params.get("depth") or course_cfg["default_depth"]
        system = fill(self.cfg.prompt("outline"), learner=learner(profile), depth=depth,
                      chapters=int(params.get("chapters") or course_cfg["chapters"]))
        seen = []
        buf = []

        def on_delta(d):
            buf.append(d)
            titles = re.findall(r'"title"\s*:\s*"((?:[^"\\]|\\.)*)"', "".join(buf))[1:]  # [0] is the course
            if len(titles) > len(seen):
                seen[:] = titles
                emit({"type": "titles", "titles": titles})

        data = self.call_json("outline", system, f"Topic: {topic}", on_delta, alive)
        chapters = [{"title": str(c.get("title") or "")[:120], "desc": str(c.get("desc") or "")[:400], "status": "outline"}
                    for c in (data.get("chapters") or []) if isinstance(c, dict) and c.get("title")]
        if not chapters:
            raise LLMError("the model returned no chapters")
        return self.store.create_course({
            "profile": profile["id"], "topic": topic, "title": str(data.get("title") or topic)[:120],
            "summary": str(data.get("summary") or ""), "emoji": str(data.get("emoji") or "📘")[:8],
            "depth": depth, "types": types, "lessons": bool(params.get("lessons", True)),
            "questions": int(params.get("questions") or course_cfg["questions_per_chapter"]),
            "status": "outline", "chapters": chapters})

    def update_outline(self, cid, data):
        with self.store.lock:
            course = self.store.course(cid)
            old = {c["id"]: c for c in course["chapters"]}
            chapters = []
            for c in data.get("chapters") or course["chapters"]:
                entry = dict(old.get(c.get("id")) or {"id": f"c{secrets.token_hex(3)}", "status": "outline"})
                entry["title"] = str(c.get("title") or entry.get("title") or "Untitled")[:120]
                entry["desc"] = str(c.get("desc") if "desc" in c else entry.get("desc", ""))[:400]
                chapters.append(entry)
            for gone in set(old) - {c["id"] for c in chapters}:
                self.store.delete_chapter(cid, gone)
            course["chapters"] = chapters
            for k in ("title", "summary", "emoji"):
                if k in data:
                    course[k] = str(data[k])[:400]
            if data.get("status") in ("outline", "active"):
                course["status"] = data["status"]
            return self.store.save_course(course)

    # ---- chapters ----------------------------------------------------------

    def outline_text(self, course):
        return "\n".join(f"{i}. {c['title']}: {c.get('desc', '')}" for i, c in enumerate(course["chapters"], 1))

    def progress_text(self, course, chid):
        missed = []
        for c in course["chapters"]:
            if c["id"] == chid:
                break
            if not self.store.has_chapter(course["id"], c["id"]):
                continue
            ch = self.store.chapter(course["id"], c["id"])
            for q in ch.get("questions", []):
                st = ((ch.get("answers") or {}).get(q["id"]) or {}).get("result", {}).get("status")
                if st in ("partial", "incorrect") and q.get("concept"):
                    missed.append(q["concept"])
        if not missed:
            return ""
        return ("In earlier chapters the learner struggled with: " + "; ".join(dict.fromkeys(missed)) +
                ". Where it fits naturally, briefly reinforce these.")

    def generate_chapter(self, cid, chid, emit, alive, force=False):
        course = self.store.course(cid)
        idx = next((i for i, c in enumerate(course["chapters"]) if c["id"] == chid), None)
        if idx is None:
            raise NotFound(chid)
        if self.store.has_chapter(cid, chid) and not force:
            return self.store.chapter(cid, chid)
        entry = course["chapters"][idx]
        profile = self.store.profile(course["profile"])
        lesson_rule = ("a short lesson in Markdown that teaches exactly what the questions need: ## subheadings "
                       "(don't repeat the chapter title as a heading, the app already shows it), "
                       "a worked example or two, LaTeX for math. Roughly 300-700 words for an adult; shorter, "
                       "livelier and with fun examples for a child." if course.get("lessons", True)
                       else 'an empty string "" (this course has no lessons, questions only).')
        system = fill(self.cfg.prompt("chapter"), learner=learner(profile), depth=course["depth"],
                      course_title=course["title"], course_summary=course.get("summary", ""),
                      outline=self.outline_text(course), chapter_title=entry["title"],
                      chapter_desc=entry.get("desc", ""), progress=self.progress_text(course, chid),
                      lesson_rule=lesson_rule, count=course.get("questions", 5),
                      types=self.types_text(course["types"]), question_schema=self.schema())
        key = (cid, chid)
        self.claim(key)
        try:
            buf = []

            def on_delta(d):
                buf.append(d)
                text = "".join(buf)
                emit({"type": "progress", "chars": len(text),
                      "questions": len(re.findall(r'"type"\s*:\s*"(?:mcq|fill|free|math|python)"', text))})

            data = self.call_json("chapter", system, f"Write chapter {idx + 1}: {entry['title']}.", on_delta, alive)
        finally:
            self.release(key)
        qs = [q for q in (clean_question(q, course["types"]) for q in data.get("questions") or []) if q]
        if not qs:
            raise LLMError("the model returned no usable questions")
        for i, q in enumerate(qs, 1):
            q["id"] = f"q{i}"
        ch = {"id": chid, "title": entry["title"], "lesson": str(data.get("lesson") or ""),
              "minutes": data.get("minutes") or 0, "questions": qs, "answers": {}, "chats": {},
              "created": now_ms()}
        with self.store.lock:
            course = self.store.course(cid)
            if course.get("status") == "outline":
                course["status"] = "active"
                self.store.save_course(course)
            return self.store.save_chapter(cid, ch)

    # ---- answers -----------------------------------------------------------

    def find_q(self, ch, qid):
        q = next((q for q in ch.get("questions", []) if q["id"] == qid), None)
        if q is None:
            raise NotFound(qid)
        return q

    def save_answer(self, cid, chid, qid, value, result=None, hints=None):
        """Store an answer (and its grade, if any); award XP when the grade improves."""
        with self.store.lock:
            course = self.store.course(cid)
            ch = self.store.chapter(cid, chid)
            self.find_q(ch, qid)
            prev = ch.setdefault("answers", {}).get(qid) or {}
            ans = dict(prev, value=value, at=now_ms())
            if hints is not None:
                ans["hints"] = max(int(hints), int(prev.get("hints") or 0))
            xp = 0
            if result:
                ans["result"] = result
                ans["attempts"] = int(prev.get("attempts") or 0) + 1
                xp = self.xp_for(prev.get("best"), result.get("status"), first=not prev.get("attempts"))
                if STATUS_RANK.get(result.get("status"), 0) > STATUS_RANK.get(prev.get("best"), 0):
                    ans["best"] = result.get("status")
            ch["answers"][qid] = ans
            self.store.save_chapter(cid, ch)
            profile = self.store.activity(course["profile"], xp) if result else self.store.profile(course["profile"])
            return {"answer": ans, "xp": xp, "profile": profile}

    def xp_for(self, best, status, first):
        table = self.cfg["fun"]["xp"]
        gain = {"correct": table["correct"], "partial": table["partial"]}.get(status, 0)
        had = {"correct": table["correct"], "partial": table["partial"]}.get(best, 0)
        extra = max(0, gain - had)
        return extra + (table["attempt"] if first else 0)

    def grade(self, cid, chid, qid, value, alive):
        course = self.store.course(cid)
        ch = self.store.chapter(cid, chid)
        q = self.find_q(ch, qid)
        if q["type"] == "math" and norm_latex(value.get("final")) == norm_latex(q["answer"]):
            result = {"status": "correct", "feedback": "Correct!"}
        else:
            if q["type"] == "free":
                answer = str(value.get("text") or "")
            elif q["type"] == "math":
                lines = [l for l in (value.get("working") or []) if str(l).strip()]
                answer = ("Working (LaTeX, one step per line):\n" + "\n".join(lines) + "\n\n" if lines else "") + \
                         f"Final answer: {q.get('answer_label', '')} {value.get('final') or '(blank)'}"
            else:
                raise BadRequest(f"{q['type']} answers are checked in the browser")
            profile = self.store.profile(course["profile"])
            system = fill(self.cfg.prompt("grade"), learner=learner(profile),
                          question=json.dumps(q, ensure_ascii=False, indent=1), answer=answer)
            data = self.call_json("grade", system, "Grade the answer.", None, alive)
            status = data.get("status") if data.get("status") in ("correct", "partial", "incorrect") else "partial"
            result = {"status": status, "feedback": str(data.get("feedback") or "")}
            if isinstance(data.get("rubric"), list):
                result["rubric"] = [{"point": str(r.get("point", "")), "met": bool(r.get("met"))}
                                    for r in data["rubric"] if isinstance(r, dict)]
            if isinstance(data.get("steps"), list):
                result["steps"] = [{"text": str(s.get("text", "")), "ok": bool(s.get("ok")), "note": str(s.get("note") or "")}
                                   for s in data["steps"] if isinstance(s, dict)]
        return self.save_answer(cid, chid, qid, value, result)

    def finish_chapter(self, cid, chid):
        with self.store.lock:
            course = self.store.course(cid)
            ch = self.store.chapter(cid, chid)
            xp = 0 if ch.get("finished") else self.cfg["fun"]["xp"]["chapter"]
            ch["finished"] = now_ms()
            self.store.save_chapter(cid, ch)
            return {"xp": xp, "profile": self.store.activity(course["profile"], xp)}

    # ---- tutor chat --------------------------------------------------------

    def chat(self, cid, chid, qid, message, current, emit, alive):
        course = self.store.course(cid)
        ch = self.store.chapter(cid, chid)
        q = None if qid == "lesson" else self.find_q(ch, qid)
        profile = self.store.profile(course["profile"])
        n = next(i for i, c in enumerate(course["chapters"], 1) if c["id"] == chid)
        lesson = ch.get("lesson") or "(no lesson)"
        limit = self.cfg["course"]["lesson_chars"]
        if len(lesson) > limit:
            lesson = lesson[:limit] + "\n…(truncated)"
        ctx = [f"Course: {course['title']}", f"Chapter {n}: {ch['title']}", "", "Lesson:", lesson, ""]
        if q:
            saved = (ch.get("answers") or {}).get(qid) or {}
            ctx += [f"The learner is on {qid.upper()} ({TYPE_LABELS[q['type']]}):",
                    json.dumps(q, ensure_ascii=False, indent=1),
                    "", "Their current answer: " + json.dumps(current if current is not None else saved.get("value"),
                                                              ensure_ascii=False),
                    "Last grade: " + json.dumps(saved.get("result") or "not checked yet", ensure_ascii=False),
                    f"Hints already shown: {saved.get('hints', 0)}", ""]
        else:
            ctx += ["The learner is reading the lesson (no specific question).", ""]
        others = [f"{x['id'].upper()} ({x['type']}): {x['prompt'][:120]}" for x in ch.get("questions", [])]
        ctx += ["Questions in this chapter:", *others, ""]
        thread = (ch.get("chats") or {}).get(qid) or []
        turns = self.cfg["course"]["history_turns"]
        if thread:
            ctx.append("Conversation so far:")
            ctx += [f"{'Learner' if m['role'] == 'user' else 'Tutor'}: {m['text']}" for m in thread[-turns:]]
            ctx.append("")
        ctx.append(f"Learner: {message}")
        system = fill(self.cfg.prompt("tutor"), learner=learner(profile))
        text = self.call("tutor", system, "\n".join(ctx), lambda d: emit({"type": "delta", "text": d}), alive)
        actions = []
        for block in ACTION_RE.findall(text):
            try:
                actions.append(json.loads(block))
            except ValueError:
                pass
        reply = ACTION_RE.sub("", text).strip()
        done = []
        for a in actions:
            if not isinstance(a, dict):
                continue
            emit({"type": "action_start", "op": a.get("op")})
            try:
                summary = self.apply_action(course["id"], chid, a, alive)
                done.append(summary)
                emit({"type": "action", "op": a.get("op"), "summary": summary})
            except (LLMError, ValueError, BadRequest, NotFound) as e:
                emit({"type": "action_error", "op": a.get("op"), "message": str(e)})
        with self.store.lock:
            ch = self.store.chapter(cid, chid)
            t = ch.setdefault("chats", {}).setdefault(qid, [])
            t.append({"role": "user", "text": message, "at": now_ms()})
            t.append({"role": "tutor", "text": reply, "actions": done, "at": now_ms()})
            self.store.save_chapter(cid, ch)
        return reply

    # ---- course changes (from the tutor) ------------------------------------

    def apply_action(self, cid, chid, a, alive):
        op = a.get("op")
        if op == "add_questions":
            return self.add_questions(cid, chid, a, alive)
        if op == "rewrite_lesson":
            return self.rewrite_lesson(cid, chid, str(a.get("instructions") or "rewrite it more clearly"), alive)
        if op == "add_chapter":
            return self.add_chapter(cid, a)
        raise BadRequest(f"unknown action {op!r}")

    def add_questions(self, cid, chid, a, alive):
        course = self.store.course(cid)
        ch = self.store.chapter(cid, chid)
        entry = next(c for c in course["chapters"] if c["id"] == chid)
        types = [t for t in (a.get("types") or []) if t in course["types"]] or course["types"]
        count = max(1, min(6, int(a.get("count") or 3)))
        existing = "\n".join(f"- {q['type']}: {q['prompt'][:160]}" for q in ch["questions"])
        system = fill(self.cfg.prompt("more_questions"), learner=learner(self.store.profile(course["profile"])),
                      depth=course["depth"], course_title=course["title"], chapter_title=entry["title"],
                      chapter_desc=entry.get("desc", ""), lesson=(ch.get("lesson") or "")[:self.cfg["course"]["lesson_chars"]],
                      existing=existing, instructions=str(a.get("instructions") or "more practice"),
                      count=count, types=self.types_text(types), question_schema=self.schema())
        data = self.call_json("chapter", system, f"Write {count} new questions.", None, alive)
        qs = [q for q in (clean_question(q, types) for q in data.get("questions") or []) if q]
        if not qs:
            raise LLMError("the model returned no usable questions")
        with self.store.lock:
            ch = self.store.chapter(cid, chid)
            top = max([int(q["id"][1:]) for q in ch["questions"] if q["id"][1:].isdigit()] or [0])
            for i, q in enumerate(qs, 1):
                q["id"] = f"q{top + i}"
                q["added"] = True
            ch["questions"] += qs
            ch.pop("finished", None)
            self.store.save_chapter(cid, ch)
        return f"Added {len(qs)} question{'s' if len(qs) != 1 else ''} ({', '.join(q['id'].upper() for q in qs)})"

    def rewrite_lesson(self, cid, chid, instructions, alive):
        course = self.store.course(cid)
        ch = self.store.chapter(cid, chid)
        entry = next(c for c in course["chapters"] if c["id"] == chid)
        system = fill(self.cfg.prompt("rewrite_lesson"), learner=learner(self.store.profile(course["profile"])),
                      depth=course["depth"], course_title=course["title"], chapter_title=entry["title"],
                      chapter_desc=entry.get("desc", ""), lesson=ch.get("lesson") or "(none yet)",
                      instructions=instructions)
        data = self.call_json("chapter", system, "Rewrite the lesson.", None, alive)
        if not str(data.get("lesson") or "").strip():
            raise LLMError("the model returned an empty lesson")
        with self.store.lock:
            ch = self.store.chapter(cid, chid)
            ch.setdefault("lesson_history", []).append(ch.get("lesson") or "")
            ch["lesson"], ch["minutes"] = str(data["lesson"]), data.get("minutes") or ch.get("minutes")
            self.store.save_chapter(cid, ch)
        return "Rewrote the lesson"

    def add_chapter(self, cid, a):
        title = str(a.get("title") or "").strip()
        if not title:
            raise BadRequest("a new chapter needs a title")
        with self.store.lock:
            course = self.store.course(cid)
            after = a.get("after")
            pos = len(course["chapters"]) if not isinstance(after, int) else max(0, min(after, len(course["chapters"])))
            course["chapters"].insert(pos, {"id": f"c{secrets.token_hex(3)}", "title": title[:120],
                                            "desc": str(a.get("desc") or "")[:400], "status": "outline"})
            self.store.save_course(course)
        return f"Added chapter {pos + 1}: {title}"
