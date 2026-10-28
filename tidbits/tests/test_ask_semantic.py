import os
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from ask import Asker  # noqa: E402
from semantic import Semantic, TextEmbedding  # noqa: E402
from vault import Vault  # noqa: E402


def note(i, text, created=0):
    return {"id": i, "text": text, "created": created}


class SelectTest(unittest.TestCase):
    def setUp(self):
        self.notes = [note(f"n{i}", "x" * 100, created=i) for i in range(50)]

    def test_small_vault_sends_everything_relevant_first(self):
        a = Asker("m", "medium", budget=1_000_000)
        chosen = a.select(self.notes, ["n3"], [("n7", 0.8, 3.0)])
        self.assertEqual(len(chosen), 50)
        self.assertEqual({chosen[0]["id"], chosen[1]["id"]}, {"n3", "n7"})

    def test_large_vault_sends_only_matches(self):
        a = Asker("m", "medium", budget=2_000)
        chosen = a.select(self.notes, ["n3", "n4"], [("n4", 0.8, 3.0), ("n9", 0.75, 2.5), ("n10", 0.6, 1.0)])
        self.assertEqual([n["id"] for n in chosen], ["n4", "n3", "n9"])  # n4 is in both lists; n10 doesn't stand out

    def test_large_vault_no_match_falls_back_to_newest(self):
        a = Asker("m", "medium", budget=2_000)
        chosen = a.select(self.notes, [], [])
        self.assertEqual(chosen[0]["id"], "n49")
        self.assertEqual(len(chosen), 8)

    def test_context_respects_budget(self):
        a = Asker("m", "medium", budget=500)
        refs, ctx = a.context(self.notes)
        self.assertLessEqual(len(ctx), 500)
        self.assertEqual(list(refs.values())[0], "n0")


class PrivateTest(unittest.TestCase):
    def test_secret_notes_never_reach_pi(self):
        """End to end through stream(): a fake pi records the context file it was given."""
        with tempfile.TemporaryDirectory() as d:
            fake = os.path.join(d, "pi")
            log = os.path.join(d, "seen.txt")
            with open(fake, "w") as f:
                f.write("#!/bin/sh\nwhile [ $# -gt 0 ]; do\n"
                        '  if [ "$1" = "--append-system-prompt" ]; then cat "$2" > ' + log + '; fi\n'
                        "  shift\ndone\n"
                        'echo \'{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"ok"}}\'\n')
            os.chmod(fake, 0o755)
            notes = [note("a", "Public [[water]] fact #stat"), note("b", "PIN is 4321 [[water]] #secret"),
                     note("c", "Bank [[water]] login #Secret #stat"), note("d", "secret recipe, but not tagged")]
            events = []
            a = Asker("m", "medium", pi_bin=fake)
            a.stream("water", notes, ["b", "c", "a"], [("b", 0.9, 4.0), ("c", 0.9, 4.0)], events.append)
            with open(log) as f:
                seen = f.read()
            self.assertIn("Public", seen)
            self.assertIn("secret recipe", seen)
            self.assertNotIn("4321", seen)
            self.assertNotIn("Bank", seen)
            meta = events[0]
            self.assertEqual(sorted(meta["refs"].values()), ["a", "d"])
            self.assertEqual((meta["total"], meta["withheld"]), (2, 2))
            self.assertEqual(events[-1]["type"], "done")


@unittest.skipIf(TextEmbedding is None, "fastembed not installed")
class SemanticTest(unittest.TestCase):
    def test_index_search_and_incremental_cache(self):
        with tempfile.TemporaryDirectory() as d:
            v = Vault(d)
            water = v.create("A [[data center]] uses 500 thousand gallons of [[water]] a day.")
            v.create("[[Caffeine]] half-life is about 5 hours.")
            s = Semantic(v, "BAAI/bge-base-en-v1.5")
            for _ in range(600):
                if s.info()["ready"] and s.info()["indexed"] == 2:
                    break
                time.sleep(0.1)
            self.assertEqual(s.search("H2O use of server farms", 2)[0][0], water["id"])
            self.assertTrue(os.path.exists(os.path.join(d, ".tidbits", "embeddings.npz")))
            # a fresh instance loads the cache instead of re-embedding
            s2 = Semantic(v, "BAAI/bge-base-en-v1.5")
            self.assertEqual(s2.info()["indexed"], 2)


if __name__ == "__main__":
    unittest.main()
