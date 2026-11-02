import os
import sys
import tempfile
import unittest
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from config import Config, fill  # noqa: E402
from engine import ACTION_RE, Engine, clean_question, norm_latex  # noqa: E402
from llm import LLM, extract_json  # noqa: E402
from store import Store, streak  # noqa: E402


class FakeLLM:
    """Stands in for LLM.run: returns canned replies in order and records each call."""

    def __init__(self, replies):
        self.replies, self.calls = list(replies), []

    def run(self, model, system, prompt, on_delta=None, effort="", timeout=180, alive=lambda: True):
        self.calls.append((model, system, prompt))
        text = self.replies.pop(0)
        if on_delta:
            on_delta(text)
        return text


class Core(unittest.TestCase):
    def test_extract_json(self):
        self.assertEqual(extract_json('Sure!\n```json\n{"a": "x}y", "b": {"c": 1}}\n```'), {"a": "x}y", "b": {"c": 1}})
        with self.assertRaises(ValueError):
            extract_json("no json here")

    def test_clean_question(self):
        self.assertIsNone(clean_question({"type": "mcq", "prompt": "?", "options": ["a"], "correct": 0}, ["mcq"]))
        self.assertIsNone(clean_question({"type": "mcq", "prompt": "?", "options": ["a", "b"], "correct": 0}, ["fill"]))
        fill_q = clean_question({"type": "fill", "prompt": "Complete", "template": "x [[1]] y [[2]]", "blanks": [["a"], "b"]}, ["fill"])
        self.assertEqual(fill_q["blanks"], [["a"], ["b"]])
        self.assertIsNone(clean_question({"type": "fill", "prompt": "p", "template": "[[1]]", "blanks": []}, ["fill"]))
        self.assertIsNone(clean_question({"type": "python", "prompt": "p", "tests": "assert True"}, ["python"]))

    def test_norm_latex(self):
        self.assertEqual(norm_latex(r"\frac{2}{3}"), norm_latex(r" \dfrac{2}{3} "))
        self.assertEqual(norm_latex(r"\left(x\right) \cdot 2"), norm_latex("(x)*2"))

    def test_streak(self):
        today = date(2026, 11, 1)
        self.assertEqual(streak(["2026-10-30", "2026-10-31", "2026-11-01"], today), 3)
        self.assertEqual(streak(["2026-10-30", "2026-10-31"], today), 2)  # not yet active today
        self.assertEqual(streak(["2026-10-29"], today), 0)

    def test_fill_template(self):
        self.assertEqual(fill("Hi {{name}} {{other}}", name="{{x}}"), "Hi {{x}} {{other}}")

    def test_action_blocks(self):
        text = 'Sure.\n```action\n{"op": "add_questions", "count": 2}\n```\nDone.'
        self.assertEqual(ACTION_RE.findall(text), ['{"op": "add_questions", "count": 2}\n'])

    def test_claude_strips_paid_keys(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = Config(d)
            llm = LLM(cfg)
            seen = {}
            llm.bin = lambda name: "/bin/claude"
            llm._exec = lambda backend, cmd, env, *a: seen.update(env=env, cmd=cmd) or "ok"
            os.environ["ANTHROPIC_API_KEY"] = "sk-test"
            try:
                llm.run("claude:haiku", "sys", "hi")
            finally:
                del os.environ["ANTHROPIC_API_KEY"]
            self.assertNotIn("ANTHROPIC_API_KEY", seen["env"])
            self.assertIn("--tools", seen["cmd"])


class Flow(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg = Config(self.tmp.name)
        self.store = Store(self.tmp.name)
        self.pid = self.store.save_profile({"name": "Ava", "about": "10 years old"})["id"]

    def tearDown(self):
        self.tmp.cleanup()

    def engine(self, replies):
        return Engine(self.cfg, self.store, FakeLLM(replies))

    def test_course_chapter_answer_chat(self):
        outline = '{"title": "Fractions", "summary": "s", "emoji": "🍕", "chapters": [{"title": "Halves", "desc": "d"}, {"title": "Quarters", "desc": "d"}]}'
        chapter = ('{"lesson": "## Halves", "minutes": 2, "questions": ['
                   '{"type": "mcq", "prompt": "1/2?", "concept": "halves", "hints": ["h"], "solution": "s", "options": ["a", "b"], "correct": 1},'
                   '{"type": "bogus", "prompt": "x"}]}')
        more = '{"questions": [{"type": "mcq", "prompt": "again?", "options": ["a", "b"], "correct": 0, "hints": []}]}'
        reply = 'Try halving it.\n```action\n{"op": "add_questions", "count": 1, "instructions": "easier"}\n```'
        eng = self.engine([outline, chapter, reply, more])
        events = []
        course = eng.build_course({"profile": self.pid, "topic": "fractions"}, events.append, lambda: True)
        self.assertEqual([c["title"] for c in course["chapters"]], ["Halves", "Quarters"])
        self.assertEqual(events[-1]["titles"], ["Halves", "Quarters"])
        chid = course["chapters"][0]["id"]
        ch = eng.generate_chapter(course["id"], chid, events.append, lambda: True)
        self.assertEqual([q["id"] for q in ch["questions"]], ["q1"])  # bogus question dropped

        out = eng.save_answer(course["id"], chid, "q1", {"choice": 0}, {"status": "incorrect"})
        self.assertEqual(out["xp"], 2)
        out = eng.save_answer(course["id"], chid, "q1", {"choice": 1}, {"status": "correct"})
        self.assertEqual(out["xp"], 10)
        self.assertEqual(out["profile"]["xp"], 12)
        out = eng.save_answer(course["id"], chid, "q1", {"choice": 1}, {"status": "correct"})
        self.assertEqual(out["xp"], 0)  # no farming XP by re-checking

        eng.chat(course["id"], chid, "q1", "help", None, events.append, lambda: True)
        ch = self.store.chapter(course["id"], chid)
        self.assertEqual([q["id"] for q in ch["questions"]], ["q1", "q2"])
        self.assertEqual(ch["chats"]["q1"][1]["text"], "Try halving it.")
        entry = self.store.course(course["id"])["chapters"][0]
        self.assertEqual((entry["total"], entry["answered"], entry["score"]), (2, 1, 1))

    def test_outline_edit_keeps_written_chapters(self):
        course = self.store.create_course({"profile": self.pid, "title": "T", "chapters": [{"title": "A"}, {"title": "B"}]})
        a, b = course["chapters"]
        self.store.save_chapter(course["id"], {"id": a["id"], "title": "A", "questions": [], "answers": {}})
        eng = self.engine([])
        c = eng.update_outline(course["id"], {"chapters": [{"id": b["id"], "title": "B2"}, {"title": "New"}], "status": "active"})
        self.assertEqual([x["title"] for x in c["chapters"]], ["B2", "New"])
        self.assertFalse(self.store.has_chapter(course["id"], a["id"]))
        self.assertEqual(c["status"], "active")


if __name__ == "__main__":
    unittest.main()
