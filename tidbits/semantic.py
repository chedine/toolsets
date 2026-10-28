"""Local semantic index: note embeddings computed in-process with fastembed (ONNX, no torch).

Optional: without `pip install fastembed` tidbits runs on word search alone. The model is
downloaded once into ~/.cache/tidbits/models; vectors are cached per vault in
<vault>/.tidbits/embeddings.npz (git-ignored) and keyed by a hash of each note's text, so only
new or edited notes are embedded. Embedding runs on a background thread.
"""
import hashlib
import os
import re
import threading

try:
    import numpy as np
    from fastembed import TextEmbedding
except ImportError:  # optional dependency
    np = TextEmbedding = None

ENTITY = re.compile(r"\[\[([^\[\]\n]+)\]\]")
CACHE_DIR = os.path.expanduser(os.environ.get("TIDBITS_CACHE", "~/.cache/tidbits"))


def doc_text(text):
    """What gets embedded: the note as prose, brackets dropped, tags kept as words."""
    return ENTITY.sub(r"\1", text).replace("#", "")


def unit(m):
    return m / np.maximum(np.linalg.norm(m, axis=1, keepdims=True), 1e-9)


def digest(text):
    return hashlib.sha1(doc_text(text).encode("utf-8")).hexdigest()[:16]


class Semantic:
    def __init__(self, vault, model_name):
        self.vault, self.model_name = vault, model_name
        self.available = TextEmbedding is not None
        self.model = None
        self.error = ""
        self.busy = False
        self.lock = threading.RLock()
        self.wake = threading.Event()
        self.ids, self.hashes, self.matrix = [], [], None
        self.dir = os.path.join(vault.root, ".tidbits")
        self.path = os.path.join(self.dir, "embeddings.npz")
        if self.available:
            self._load()
            threading.Thread(target=self._worker, daemon=True).start()
            self.wake.set()

    def info(self):
        with self.lock:
            n = len(self.ids)
        return {"available": self.available, "ready": self.model is not None and not self.busy and not self.wake.is_set(),
                "model": self.model_name, "indexed": n, "error": self.error}

    def refresh(self):
        """Ask the worker to embed anything new or changed (cheap if nothing changed)."""
        if self.available:
            self.wake.set()

    # ---- persistence -------------------------------------------------------

    def _load(self):
        try:
            z = np.load(self.path, allow_pickle=False)
            if str(z["model"]) == self.model_name:
                self.ids, self.hashes, self.matrix = list(z["ids"]), list(z["hashes"]), z["matrix"]
        except (OSError, KeyError, ValueError):
            pass

    def _save(self):
        os.makedirs(self.dir, exist_ok=True)
        ignore = os.path.join(self.dir, ".gitignore")
        if not os.path.exists(ignore):
            with open(ignore, "w") as f:
                f.write("*\n")
        tmp = self.path + ".tmp.npz"
        np.savez(tmp, model=np.array(self.model_name), ids=np.array(self.ids), hashes=np.array(self.hashes),
                 matrix=self.matrix if self.matrix is not None else np.zeros((0, 0), dtype=np.float32))
        os.replace(tmp, self.path)

    # ---- indexing ----------------------------------------------------------

    def _worker(self):
        while True:
            self.wake.wait()
            self.wake.clear()
            self.busy = True
            try:
                if self.model is None:
                    self.model = TextEmbedding(self.model_name, cache_dir=os.path.join(CACHE_DIR, "models"))
                self._sync()
                self.error = ""
            except Exception as e:  # keep serving word search if the model can't load
                self.error = str(e)
            self.busy = False

    def _sync(self):
        notes = self.vault.notes()
        want = {n["id"]: (digest(n["text"]), n["text"]) for n in notes}
        with self.lock:
            have = {i: (h, k) for k, (i, h) in enumerate(zip(self.ids, self.hashes))}
        todo = [i for i, (h, _) in want.items() if have.get(i, (None,))[0] != h]
        gone = [i for i in have if i not in want]
        if not todo and not gone:
            return
        vecs = unit(np.array(list(self.model.embed([doc_text(want[i][1]) for i in todo])), dtype=np.float32)) if todo else None
        with self.lock:
            rows = {i: self.matrix[k] for i, (h, k) in have.items() if i in want and i not in todo}
            for i, v in zip(todo, vecs if vecs is not None else []):
                rows[i] = v
            self.ids = list(rows)
            self.hashes = [want[i][0] for i in self.ids]
            self.matrix = np.stack([rows[i] for i in self.ids]) if rows else None
            self._save()

    # ---- queries -----------------------------------------------------------

    def search(self, query, k=50):
        """[(id, cosine, z)] best first; [] while the index is still building.

        z is how many standard deviations a note stands above the vault's mean similarity. Raw
        cosines barely separate a real match from noise (a nonsense query still scores ~0.58), but
        a real match stands out from the rest of the vault while noise doesn't."""
        if not self.available or self.model is None or not query.strip():
            return []
        q = unit(np.array(list(self.model.query_embed(query)), dtype=np.float32))[0]
        with self.lock:
            if self.matrix is None:
                return []
            scores = self.matrix @ q  # rows and query are unit length, so dot = cosine
            ids = self.ids
        mean, std = float(scores.mean()), float(scores.std()) or 1.0
        top = np.argsort(-scores)[:k]
        return [(ids[i], float(scores[i]), (float(scores[i]) - mean) / std) for i in top]
