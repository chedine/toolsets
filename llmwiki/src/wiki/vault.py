from __future__ import annotations

import json
from datetime import date
from pathlib import Path


WIKI_SUBDIRS = [
    "wiki/_meta",
    "wiki/entities",
    "wiki/sectors",
    "wiki/theses",
    "wiki/themes",
    "wiki/companies",
    "wiki/questions",
    "wiki/contradictions",
    "wiki/sources",
    "wiki/facts",
    "wiki/concepts",
    "wiki/forecasts",
    "wiki/manuals",
    "sources/inbox",
    "sources/archive/markdown",
    "sources/rejected",
]


def _today() -> str:
    return date.today().isoformat()


def _write_if_missing(path: Path, content: str) -> bool:
    if path.exists():
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return True


def agents_template(topic: str) -> str:
    return f"""# Wiki agent instructions

You are the autonomous maintainer of this local-first markdown wiki.

Topic: {topic}

## Operating principles

- Maintain a zero-friction workflow for the user.
- Edit wiki files directly without routine confirmation.
- Ask questions only when truly blocked or when clarification materially changes interpretation.
- If uncertain but not blocked, make a reasonable assumption and record the issue in `wiki/_meta/pending.md`.
- Use ordinary markdown links, not Obsidian-only wikilinks.
- Use YAML frontmatter on durable wiki pages.
- Clearly distinguish facts, source claims, user beliefs, LLM synthesis, speculation, theses, and forecasts.
- Label confidence and uncertainty, especially for investing/trading-related notes.

## Ingesting sources

When asked to ingest new sources:

1. Run `wiki sources list` or inspect `sources/inbox/`.
2. For URLs, use your native web/search/browse tools where available.
3. Do not deeply integrate a URL if only snippets or metadata are accessible. Mark it `partial` or `failed-fetch` and log the limitation.
4. For markdown files in `sources/inbox/`, read the file and integrate durable content into the wiki.
5. Update existing pages before creating duplicate pages.
6. Maintain `wiki/index.md` as the content-oriented catalog.
7. Append a concise entry to `wiki/_meta/log.md`.
8. Track open questions and contradictions in `wiki/_meta/pending.md`.
9. Archive processed sources with:
   - `wiki sources archive-url "<url>" --status ingested|rejected|duplicate|partial|failed-fetch`
   - `wiki sources archive-md <path> --status ingested|rejected|duplicate`

## Answering questions

When answering from the wiki:

1. Read `wiki/index.md` first.
2. Inspect relevant pages.
3. Cite markdown pages used.
4. Mention uncertainty, unresolved contradictions, or stale information.
5. Offer to save durable synthesis back into the wiki when useful.
"""


def wiki_yaml_template(vault: Path, topic: str) -> str:
    name = vault.name
    return f"""vault:
  name: {json.dumps(name)}
  root: .
  wiki_dir: wiki
  sources_dir: sources
  topic: {json.dumps(topic)}

sources:
  url_inbox: sources/inbox/urls.txt
  url_archive: sources/archive/urls.txt
  archive_url_content: false
  markdown_inbox_dir: sources/inbox
  markdown_archive_dir: sources/archive/markdown
  rejected_dir: sources/rejected

git:
  enabled: true
  commit_after_ingest: true
  fail_on_commit_error: false

lint:
  require_frontmatter: true
  check_broken_links: true
  check_index_entries: true

agent:
  preferred: pi
  context_file: AGENTS.md
  use_native_web_tools: true
  fallback_url_extractor: false
"""


def home_template(topic: str) -> str:
    today = _today()
    return f"""---
type: meta
status: active
created: {today}
updated: {today}
confidence: high
sources: []
tags: []
---

# Home

This is the home page for the wiki.

Topic: {topic}

Start with [Index](index.md).
"""


def index_template(topic: str) -> str:
    today = _today()
    return f"""---
type: meta
status: active
created: {today}
updated: {today}
confidence: high
sources: []
tags: []
---

# Index

Content-oriented catalog for the wiki.

Topic: {topic}

## Core

- [Home](home.md) — meta — Wiki home page. Updated {today}.

## Sources

## Entities

## Companies

## Themes

## Theses

## Questions

## Contradictions

## Facts

## Concepts

## Forecasts

## Manuals
"""


def schema_template() -> str:
    today = _today()
    return f"""---
type: meta
status: active
created: {today}
updated: {today}
confidence: high
sources: []
tags: []
---

# Schema

This file records the evolving vault schema and conventions.

## Page conventions

Use markdown files with YAML frontmatter when creating durable wiki pages.

Recommended frontmatter fields:

```yaml
type: theme
status: evolving
created: {today}
updated: {today}
confidence: medium
sources: []
tags: []
```

Recommended `type` values:

- source
- entity
- sector
- thesis
- theme
- company
- question
- contradiction
- fact
- concept
- forecast
- manual
- meta

Unknown types are allowed when useful.

## Link conventions

Use ordinary relative markdown links, for example:

```md
[Advanced packaging](../themes/advanced-packaging.md)
```
"""


def log_template() -> str:
    today = _today()
    return f"""---
type: meta
status: active
created: {today}
updated: {today}
confidence: high
sources: []
tags: []
---

# Log

Append-only operation log.
"""


def pending_template() -> str:
    today = _today()
    return f"""---
type: meta
status: active
created: {today}
updated: {today}
confidence: high
sources: []
tags: []
---

# Pending questions and contradictions

Track unresolved questions, contradictions, and operational uncertainties here.

Example:

```md
## [Q-{today}-001] Example open question

- Type: question
- Status: open
- Severity: medium
- Created: {today}
- Related pages: []

Question:
Describe the issue.
```
"""


def init_vault(vault: Path, topic: str | None = None) -> list[Path]:
    topic = topic or "Personal knowledge base"
    vault = vault.expanduser().resolve()
    created: list[Path] = []

    vault.mkdir(parents=True, exist_ok=True)

    for rel in WIKI_SUBDIRS:
        path = vault / rel
        if not path.exists():
            path.mkdir(parents=True, exist_ok=True)
            created.append(path)

    files = {
        "AGENTS.md": agents_template(topic),
        "wiki.yaml": wiki_yaml_template(vault, topic),
        "wiki/home.md": home_template(topic),
        "wiki/index.md": index_template(topic),
        "wiki/_meta/schema.md": schema_template(),
        "wiki/_meta/log.md": log_template(),
        "wiki/_meta/pending.md": pending_template(),
        "wiki/_meta/lint-report.md": "# Lint report\n\nNot generated yet.\n",
        "sources/inbox/urls.txt": "",
        "sources/archive/urls.txt": "",
    }

    for rel, content in files.items():
        path = vault / rel
        if _write_if_missing(path, content):
            created.append(path)

    return created
