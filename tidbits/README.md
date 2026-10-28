# tidbits

Frictionless capture of facts, opinions and thoughts, with the entities in them marked up as you type:

> A [[data center]] can consume upto 500 thousand gallons of [[water]] a day. #stat

Entities are bare strings (case-insensitive). Two entities are related when they share a note, so no relation types are needed. Notes are stored as plain markdown files in a vault folder you choose.

## Run

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt   # once per machine
.venv/bin/python server.py --vault ~/Tidbits
```

The only dependency is `fastembed`, which provides search by meaning. Plain `python3 server.py` (3.9+, standard library only) also works and falls back to word search. On first start the embedding model (208 MB) downloads into `~/.cache/tidbits/models`; after that everything runs offline.

It listens on `0.0.0.0:8484`, and the start-up output prints the LAN URL. To require a token:

```bash
TIDBITS_TOKEN="$(openssl rand -hex 16)" python3 server.py --vault ~/Tidbits
# open http://<host>:8484/?t=<token> once per device; a cookie remembers it
```

| Flag / env | Default |
| --- | --- |
| `--vault` / `TIDBITS_VAULT` | `~/Tidbits` |
| `--host` / `TIDBITS_HOST` | `0.0.0.0` |
| `--port` / `TIDBITS_PORT` | `8484` |
| `TIDBITS_TOKEN` | unset (open on the LAN) |
| `--ask-model` / `TIDBITS_ASK_MODEL` | `openai-codex/gpt-6-luna` (any `pi --list-models` id) |
| `--ask-thinking` / `TIDBITS_ASK_THINKING` | `medium` (`off` … `max`) |
| `--pi-bin` / `TIDBITS_PI_BIN` | `pi` |
| `--ask-budget` / `TIDBITS_ASK_BUDGET` | `24000` characters of notes per question (≈6k tokens) |
| `--private-tags` / `TIDBITS_PRIVATE_TAGS` | `secret` (comma-separated; these notes are never sent to the AI) |
| `--embed-model` / `TIDBITS_EMBED_MODEL` | `BAAI/bge-base-en-v1.5` (any fastembed text model) |
| `TIDBITS_CACHE` | `~/.cache/tidbits` (model downloads) |

## Keys

| Key | Capture | Search (`/…`) | Ask (`?…`) |
| --- | --- | --- | --- |
| `⏎` | new line | edit the selected note | ask |
| `⇧⏎` (or `⌘⏎`) | save / update | ask AI the same words | ask |
| `↑` `↓` | — | move through results | — |
| `[[` | entity autocomplete | filter by entity | — |
| `#` | tag (pulled into a chip, appended on save) | filter by tag | — |
| `⌘E` | wrap selection as an entity | — | — |
| `esc` | clear / cancel edit | clear | clear / cancel |

On touch devices a **save** / **ask** button appears under the input.

## Search

Search is how you browse, since there are no folders or lists in the UI.

- `/` alone shows every tag, a wall of entities sized by how often they're used, and the most recent notes.
- `/water day` ranks notes by relevance (BM25). Every word must match; words match by prefix (`wat` → water) and tolerate typos (`watr`). Words inside entities rank higher. When no note contains every word, the closest matches are shown and labelled as such.
- `"thousand gallons"` matches an exact phrase. `-espresso` excludes notes with that word. `[[data center]]` and `#stat` are exact filters, and all of these combine.
- An **entities** row offers to swap the words you typed for an entity filter (`/data cent` → `[[data center]]`).
- **Also linked** lists the entities and tags that appear alongside the current results. Click one to narrow further.
- **Related by meaning:** below the word matches, notes that mean the same thing without sharing words, e.g. `/H2O usage of server farms` finds the data-center water note. The vault's `[[entity]]`, `#tag`, phrase and `-word` filters still apply to these.
- Word search runs in the browser over all notes and is memoised per keystroke; 1000s of notes are fine. Meaning search is a debounced call to `/api/semantic`.

### Embeddings

- Each note is embedded on the server by `fastembed` (ONNX; no PyTorch, no external service) into `<vault>/.tidbits/embeddings.npz`. That folder has its own `.gitignore`, so the cache never gets committed.
- Vectors are keyed by a hash of the note text, so after the first build only new or edited notes are embedded, on a background thread. Edits made outside the app are picked up the next time the client reloads.
- A meaning hit is shown only if it stands out from the rest of the vault: at least 2.2 standard deviations above the mean similarity, and cosine ≥ 0.55. A raw cosine cutoff can't tell real hits from noise, because nonsense queries still score about 0.58. These thresholds are tuned for bge-base, so re-tune `SEM_Z`/`SEM_FLOOR` in `app.js` and `SEMANTIC_*` in `ask.py` if you change the model.
- Model choice: on a 12-question test set over `test-vault`, bge-base (MRR 1.00, recall@5 0.90) beat nomic-v1.5 (0.92 / 0.90, 523 MB), jina-v2-small (0.88 / 0.93), MiniLM-L6 (0.86 / 0.85), bge-small (0.85 / 0.83) and the snowflake-arctic models.

## Ask

`?how much water do data centers use` answers from your notes only, cites them inline (¹ ²), and lists the cited notes below.

- It runs the Pi agent headless (`pi -p --mode json`, with every tool, extension, skill and context file disabled), so it uses Pi's own login from `~/.pi/agent/auth.json`; tidbits never reads tokens.
- **Which notes are sent:** if the whole vault fits in `--ask-budget` (24k characters by default), all of it is sent, most relevant first. Beyond that, only notes that match the question are sent: the browser's word ranking (entities named in the question, their co-occurring neighbours, word matches) is fused with the embedding ranking (z ≥ 1.8) by reciprocal rank. If nothing matches, the 8 newest notes are sent. Cost per question stays flat as the vault grows, and the answer card shows "read X of Y notes".
- **Private notes:** notes tagged `#secret` (any case, anywhere in the note) are removed on the server before notes are selected, so they are never sent to the model, whatever the browser asks for. The answer card shows how many were withheld. Search and embeddings are unaffected, since they never leave the machine. Use `--private-tags` to change the list.
- Answers stream in as they're generated. Changing or clearing the question cancels the run, and the pi process is killed within about a second, even mid-thinking.

## Vault layout

```
<vault>/<first-tag>/<id>-<slug>.md      # untagged notes sit at the vault root
<vault>/.trash/...                      # deleted notes are moved here, never removed
```

```markdown
---
id: 20261026-230612
created: 2026-10-26T23:06:12+05:30
---
A [[data center]] can consume upto 500 thousand gallons of [[water]] a day. #stat
```

- The body is the source of truth for entities and tags, and the files work in Obsidian or any editor.
- When a note's first tag changes, the file moves folders. The `id` and filename stay the same.
- Files edited outside the app (an editor, `git pull`) are picked up on the next read via mtime. If a note changed on disk after you opened it for editing, the first save is refused (409) and a second save overwrites.
- `.md` files without frontmatter are accepted, using the filename as the id and the mtime as the creation date.

## API

| | |
| --- | --- |
| `GET /api/notes` | `{vault, notes:[{id, text, created, updated, path}]}` |
| `POST /api/notes` | `{text}` → note |
| `PUT /api/notes/<id>` | `{text, base}` → note; `409 {note}` if `base` ≠ current `updated` |
| `DELETE /api/notes/<id>` | move to `.trash` |
| `POST /api/ask` | `{q, ids}` → NDJSON stream: `meta {refs, model}`, `delta {text}`, `done` / `error` |
| `GET /api/semantic?q=&k=` | `{ready, indexed, results:[{id, score, z}]}` |
| `GET /api/config` | `{vault, ask:{model, thinking, available}, semantic:{available, ready, model, indexed}}` |
| `GET /api/graph` | `{nodes:[{id, name, count, notes}], links:[{source, target, weight, notes}]}` — entity co-occurrence, ready for a force-directed view |

## Layout

- `server.py`: HTTP server (stdlib only)
- `ask.py`: runs pi headless for Ask (selects notes, builds the context, streams the answer)
- `semantic.py`: optional embedding index (fastembed) with an on-disk cache per vault
- `vault.py`: file storage and in-memory index. All reads go through `Vault`, so SQLite can replace the index later.
- `static/core.js`: parsing, the search index (BM25, prefix/typo matching), question ranking and the entity index. Its regexes must stay in sync with `vault.py`.
- `static/app.js`: the UI, a port of the "Blocks v3" prototype

```bash
.venv/bin/python -m unittest discover -s tests       # the semantic test is skipped without fastembed
.venv/bin/python server.py --vault test-vault --port 8485   # sample vault: 37 notes, 33 entities
python3 scripts/make_test_vault.py                   # reset test-vault/ after messing with it
```
