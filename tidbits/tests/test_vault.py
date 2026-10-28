import os
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from vault import Conflict, Vault, entities, slugify, tags  # noqa: E402


class ParseTest(unittest.TestCase):
    def test_entities_dedupe_case_insensitive(self):
        self.assertEqual(entities("[[Water]] and [[water]] and [[data  center]]"), ["Water", "data center"])

    def test_tags_skip_headings_and_csharp(self):
        self.assertEqual(tags("# Title\nC# is fine #Stat (#verify) #stat"), ["stat", "verify"])

    def test_slug(self):
        self.assertEqual(slugify("A [[data center]] can consume upto 100 #stat"), "a-data-center-can-consume-upto")


class VaultTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.v = Vault(self.dir.name)

    def tearDown(self):
        self.dir.cleanup()

    def files(self):
        out = []
        for d, dirs, fs in os.walk(self.dir.name):
            out += [os.path.relpath(os.path.join(d, f), self.dir.name) for f in fs]
        return sorted(out)

    def test_create_stores_under_first_tag(self):
        n = self.v.create("[[IEA]] says [[electricity]] demand doubles. #stat #energy")
        self.assertTrue(n["path"].startswith("stat" + os.sep))
        with open(os.path.join(self.dir.name, n["path"])) as f:
            raw = f.read()
        self.assertIn(f"id: {n['id']}", raw)
        self.assertTrue(raw.endswith("#stat #energy\n"))

    def test_untagged_lives_at_root(self):
        n = self.v.create("just a thought")
        self.assertEqual(os.path.dirname(n["path"]), "")

    def test_update_moves_folder_and_prunes(self):
        n = self.v.create("fact #stat")
        u = self.v.update(n["id"], "fact #opinion #stat", n["updated"])
        self.assertEqual(u["id"], n["id"])
        self.assertTrue(u["path"].startswith("opinion" + os.sep))
        self.assertFalse(os.path.exists(os.path.join(self.dir.name, "stat")))
        self.assertEqual(u["created"], n["created"])

    def test_conflict_on_stale_base(self):
        n = self.v.create("fact #stat")
        time.sleep(0.02)
        full = os.path.join(self.dir.name, n["path"])
        with open(full, "a") as f:
            f.write("edited elsewhere\n")
        with self.assertRaises(Conflict):
            self.v.update(n["id"], "mine", n["updated"])

    def test_delete_moves_to_trash(self):
        n = self.v.create("bye #x")
        self.v.delete(n["id"])
        self.assertEqual(self.v.notes(), [])
        self.assertTrue(self.files()[0].startswith(".trash"))

    def test_external_file_without_frontmatter(self):
        with open(os.path.join(self.dir.name, "hand.md"), "w") as f:
            f.write("Typed in [[vim]].\n")
        (n,) = self.v.notes()
        self.assertEqual(n["id"], "hand")
        self.assertEqual(n["text"], "Typed in [[vim]].")

    def test_graph_cooccurrence(self):
        self.v.create("[[A]] [[B]] [[C]]")
        self.v.create("[[a]] and [[b]]")
        g = self.v.graph()
        nodes = {x["id"]: x["count"] for x in g["nodes"]}
        links = {(x["source"], x["target"]): x["weight"] for x in g["links"]}
        self.assertEqual(nodes, {"a": 2, "b": 2, "c": 1})
        self.assertEqual(links[("a", "b")], 2)
        self.assertEqual(links[("a", "c")], 1)


if __name__ == "__main__":
    unittest.main()
