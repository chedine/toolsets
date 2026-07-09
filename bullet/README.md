# Bullet

A distraction-free, monochrome writing app in the spirit of
[Left](https://100r.co/site/left.html) by Hundred Rabbits. Plain
markdown files in a folder you own, an editor with no chrome, a
command bar instead of menus, and fully local search & Q&A — nothing
ever leaves the machine.

```
npm install
npm run dev     # http://localhost:5173
npm run build   # production build in dist/
```

Requires a Chromium browser (File System Access API); `ask` also
requires WebGPU.

### Blocked/offline networks

Search embeddings and the `ask` model normally download from
HuggingFace once and are then cached by the browser. On networks where
HuggingFace is blocked, vendor the models into the app itself — run
this once from any machine with access:

```
node scripts/fetch-models.mjs   # ~900MB into public/models/
```

Then copy/deploy the project including `public/models` (gitignored).
The app probes for vendored models at startup and serves them from its
own origin; without them it falls back to HuggingFace. Two hard-won
subtleties live in the code: transformers.js skips its local-path
check when `localModelPath` parses as a URL (it must stay relative),
and WebLLM appends `resolve/main/` to every model URL, so the vendored
layout mirrors HuggingFace's. Both probes GET-and-parse rather than
HEAD, because dev/static servers with SPA fallback answer missing
files with `index.html` and status 200.

## Using it

Everything is driven from the command bar — press **Cmd+K**, type,
Tab completes, Enter runs. `help` lists all commands. The highlights:

| Command | Effect |
|---|---|
| `vault` | pick the folder your notes live in |
| `new file <path>` / `new folder <path>` | create (intermediate folders auto-created) |
| `rename` / `move` / `delete` | file ops; destructive ones ask for a confirming Enter |
| `search <query>` | ranked hybrid search, Enter opens at the matching section |
| `ask <question>` | local LLM answers from your notes, with clickable sources |
| `theme [dark\|light\|paper\|auto]` | switch palette; bare `theme` cycles |
| `font [mono\|serif\|sans]` | Left's font trio; bare `font` cycles |
| `sidebar` (or Cmd+\\) | hide/show the file tree |

Relative paths in commands resolve against the folder selected in the
sidebar, else the open file's folder; a leading `/` pins to the vault
root. Paste an image and it becomes a real file under `blobs/` with a
markdown reference; drag its corner to resize (the width is written
back into the reference text).

## Architectural decisions

### Editor: CodeMirror 6, skinned to nothing

A production text engine (undo, IME, huge-doc performance, decorations)
is not something to hand-roll. CM6 is stripped of all chrome and themed
entirely through the app's CSS variables. Markdown behavior (lists that
continue on Enter, markers dimmed, headings bold) comes from
`@codemirror/lang-markdown` — battle-tested commands rather than custom
key handling. Block widgets (inline images) live in a `StateField`,
which is the only place CM6 allows them.

### One palette, four variables

Every color in the app derives from `--bg / --fg / --dim / --faint` in
`style.css`. Themes (dark, light, paper) are four-line blocks; the OS
picks via `prefers-color-scheme`, the `theme` command pins via a
`data-theme` attribute that outranks the media query. Structure is
expressed through weight and shade, never hue. Dark mode additionally
uses grayscale font antialiasing and weight-800 headings because
light-on-dark subpixel rendering optically flattens the bold/regular
hierarchy.

Typography follows Left literally: the `font` command cycles the same
trio Left ships — Input Mono, Zilla Slab, Inter — via one CSS variable
(`--app-font`) that everything inherits. Zilla Slab and Inter are OFL
and bundled from npm; Input Mono is not redistributable, so
`node scripts/fetch-fonts.mjs` vendors it into `public/fonts/`
(gitignored) — without it the mono stack falls back to SF Mono on
macOS and bundled JetBrains Mono elsewhere, so Windows/Linux never see
poorly hinted system monospaces.

### Vault: real files, browser only

Notes are plain `.md`/`.txt` files in a user-picked folder (File System
Access API). The directory handle is persisted in IndexedDB and
restored silently when Chromium keeps the permission, otherwise a
one-click "reopen" re-requests it. All file ops are path-based
(`vault.ts`), using native `FileSystemHandle.move()` when available and
copy+delete otherwise. Edits autosave (500ms debounce, flushed on file
switch/blur/close). Pasted images go into a `blobs/` folder inside the
vault so the vault stays self-contained and portable (Obsidian renders
the same references). With no vault open, writing lands in a
localStorage scratch buffer.

### Commands, not menus

Features arrive as verbs in a registry (`commands.ts`: name, usage,
run), so the UI never grows chrome. The status bar doubles as the
prompt; `help` renders straight from the registry. Destructive commands
return a confirm continuation rather than opening a dialog.

### Search: chunked, hybrid, sized for thousands of files

Design target is a ~1000-file vault; all decisions follow from that:

- **Section chunks.** Documents index as heading/bullet sections, so
  results point at the section (with its line number), not the file.
  The chunk is the shared unit for both retrieval layers.
- **BM25 (MiniSearch)** with prefix/fuzzy matching and field boosts
  (filename > heading > body). The serialized index and per-file chunk
  metadata persist in IndexedDB; startup reconciles against file
  mtimes so unchanged files are never re-read. Measured at 1001 files:
  ~300ms first index, ~800ms reconcile restart, ~10ms queries.
- **Local embeddings** (all-MiniLM-L6-v2, quantized, ~25MB) run in a
  Web Worker via transformers.js. Vectors are cached in IndexedDB
  keyed by chunk *content hash*, so identical text is never
  re-embedded — across sessions or moves. Brute-force cosine is
  single-digit ms at this scale; no vector DB until the corpus grows
  ~10x (then: Tauri + zvec).
- **Fusion with a floor.** BM25 and cosine lists merge by reciprocal
  rank fusion, but semantic hits below 0.35 cosine are dropped first —
  nearest-neighbor search always returns *something*, and without an
  absolute floor precise keyword queries drown in "nearest of the
  far" noise. Keyword queries thus degrade to pure BM25 precision;
  meaning queries keep their recall.

### Ask: retrieval-first local RAG

`ask` feeds the top retrieval chunks to Qwen2.5-1.5B-Instruct running
on WebGPU via WebLLM (~1GB one-time download, browser-cached). The
model is deliberately the swappable part — a one-line constant —
because at 1–2B parameters answer quality is dominated by retrieval
quality. Sources shown in the popup come from retrieval, not from the
model's claims, and click through to the exact section. The prompt
forbids citation markers and demands plain sentences; small models
latch onto formatting instructions at the expense of content.

### Storage map

| Where | What |
|---|---|
| Vault folder | notes, `blobs/` images — the only data that matters |
| IndexedDB `kv` | vault handle, serialized search index + chunk metadata |
| IndexedDB `vectors` | chunk embeddings by content hash |
| IndexedDB `images` | pasted-image blobs for the scratch buffer only |
| localStorage | scratch text, theme, sidebar width, expanded folders |
| Browser caches | MiniLM + Qwen model weights |

Everything outside the vault folder is a rebuildable cache.

## Testing

Verification is scripted end-to-end with Playwright driving headless
Chrome: the native directory picker is stubbed with an OPFS directory
handle (same API), which makes vault flows, search-at-scale
benchmarks, and even WebGPU model inference testable without a human.
