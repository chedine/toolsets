# tidbits

Frictionless capture of facts, opinions and thoughts, with the entities in them marked up as you type:

> A [[data center]] can consume upto 500 thousand gallons of [[water]] a day. #stat

Entities are bare strings (case-insensitive). Two entities are related when they share a note, so no relation types are needed. Notes are stored as plain markdown files in a vault folder you choose.

## Run

```bash
python3 server.py --vault ~/Tidbits          # Python 3.9+, no dependencies
```

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
- Search runs in the browser over all notes and is memoised per keystroke; 1000s of notes are fine.

## Ask

`?how much water do data centers use` answers from your notes only, cites them inline (¹ ²), and lists the cited notes below.

- It runs the Pi agent headless (`pi -p --mode json`, with every tool, extension, skill and context file disabled), so it uses Pi's own login from `~/.pi/agent/auth.json`; tidbits never reads tokens.
- The browser orders notes by relevance to the question: entities named in it, their co-occurring neighbours, word matches, then recency. The server sends notes in that order up to about 300k characters, which in practice is the whole vault for a long time.
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
| `GET /api/config` | `{vault, ask:{model, thinking, available}}` |
| `GET /api/graph` | `{nodes:[{id, name, count, notes}], links:[{source, target, weight, notes}]}` — entity co-occurrence, ready for a force-directed view |

## Layout

- `server.py`: HTTP server (stdlib only)
- `ask.py`: runs pi headless for Ask (builds the notes context, streams the answer)
- `vault.py`: file storage and in-memory index. All reads go through `Vault`, so SQLite can replace the index later.
- `static/core.js`: parsing, the search index (BM25, prefix/typo matching), question ranking and the entity index. Its regexes must stay in sync with `vault.py`.
- `static/app.js`: the UI, a port of the "Blocks v3" prototype

```bash
python3 -m unittest discover -s tests
python3 server.py --vault test-vault --port 8485     # sample vault: 37 notes, 33 entities
python3 scripts/make_test_vault.py                   # reset test-vault/ after messing with it
```
