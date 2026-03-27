# mem

A minimal note-taking system with a terminal TUI and web interface. Notes are plain Markdown files with YAML frontmatter, stored flat in a single directory. Search is backed by SQLite FTS5.

## Install

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -e .
```

## Note Format

```markdown
---
title: Optional title
tags: [ideas, projects]
created: '2026-03-25T16:30:00'
modified: '2026-03-25T16:30:00'
---

Your content here
```

Files are named `YYYYMMDD-HHMMSS.md` under `~/memory/` (configurable). Notes with no tags default to `inbox`.

## Commands

| Command | Description |
|---|---|
| `mem` | Open TUI with `#inbox` notes |
| `mem new "text" -t tag1,tag2 -T "Title"` | Quick note with tags and title |
| `mem new` | Open TUI editor with blank template |
| `mem new -i photo.png "caption"` | Note with image attachment |
| `mem find "text"` | Full-text search → TUI |
| `mem find -t ideas` | Tag search → TUI |
| `mem find` | Browse all notes in TUI |
| `mem ls [-n 10] [-t work]` | List recent notes |
| `mem tags` | Show all tags with counts |
| `mem edit <filename>` | Open note in TUI editor |
| `mem serve [-p 8899]` | Start web interface |
| `mem reindex` | Rebuild search index |
| `mem config` | Show current config |

## TUI Keybindings

| Key | Action |
|---|---|
| `Ctrl+J` / `Ctrl+K` | Next / previous note |
| `Ctrl+E` | Toggle edit mode |
| `Ctrl+S` | Save edits |
| `Ctrl+I` | Paste image from clipboard (macOS/Win/Linux) |
| `Escape` | Cancel editing |
| `Ctrl+N` | New note |
| `Ctrl+D` | Delete note |
| `Ctrl+F` | Focus search bar |
| `Ctrl+B` | Toggle sidebar |
| `Tab` | Cycle focus: search ↔ list |
| `Ctrl+Q` | Quit |

## Web Interface

```bash
mem serve            # http://0.0.0.0:8899
mem serve -p 3000    # custom port
```

**View mode** — plain keys:

| Key | Action |
|---|---|
| `E` | Edit |
| `N` | New note |
| `D` | Delete |
| `/` | Focus search |
| `B` | Toggle sidebar |
| `↑` / `↓` | Navigate notes |

**Edit mode:**

| Key | Action |
|---|---|
| `⌘S` / `Ctrl+S` | Save |
| `Esc` then `:wq` | Save and exit (vim-style) |
| `Esc` then `:q` | Quit edit (discard) |

Images render inline in both the viewer and the editor. Paste from clipboard with `Ctrl+V` in edit mode.

Settings (⚙): font family (preset or custom), font size, line height, text color, background color. Sidebar width is draggable. All persisted to localStorage.

## Configuration

`~/.config/mem/config.yaml` (created on first run):

```yaml
memory_dir: ~/memory
editor: vim
default_tags: []
assets_subdir: .assets
```

## Architecture

```
mem/
├── cli.py          Click CLI — commands, delegates to store/tui/web
├── clipboard.py    Cross-platform clipboard image grab (macOS/Win/Linux)
├── config.py       YAML config loader (~/.config/mem/config.yaml)
├── index.py        SQLite FTS5 index with mtime-based auto-sync
├── note.py         Note dataclass — frontmatter, serialization, templates
├── store.py        CRUD + search via FTS5 index
├── tui.py          Textual two-panel TUI — sidebar, viewer, inline editor
├── web.py          FastAPI backend — REST API + SPA server
└── static/
    └── index.html  Single-file web SPA (CodeMirror, marked.js, hljs)
```

**Search**: SQLite FTS5 with porter stemming. Index auto-syncs by comparing file mtimes — only re-parses changed files. Instant updates after create/save/delete.

**Notes**: Plain Markdown + YAML frontmatter. Flat directory, timestamp filenames, grep-friendly.

**Images**: Stored in `~/memory/.assets/`, referenced as relative paths in markdown. Web UI serves them at `/assets/`. TUI opens them via system viewer (`Ctrl+O`). Clipboard paste works in both TUI and web.
