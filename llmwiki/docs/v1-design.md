# wiki Design: Agent-Native v0

## Purpose

`wiki` is a personal, local-first markdown knowledge-base workflow. It helps the user capture curated sources with near-zero friction, then uses an existing coding agent such as Pi or Codex to incrementally maintain a persistent markdown wiki.

The durable artifact is the vault: source queues, archive records, generated wiki pages, logs, pending questions, contradictions, and evolving theses. The system is optimized for personal research, investing/trading worldview formation, and long-running synthesis rather than one-off RAG answers.

Initial dogfood domain: AI capex, semiconductor manufacturing bottlenecks, HBM, advanced packaging, chip supply chains, hyperscaler spend, data center power, and market implications.

## Core pivot

Earlier designs assumed the `wiki` CLI would call an LLM directly. The preferred v0 design is simpler:

```txt
Human
  ↓
Pi / Codex / coding agent
  ↓ reads
AGENTS.md
  ↓ uses
wiki CLI helper commands + agent-native tools
  ↓ edits
markdown vault
```

In v0, `wiki` is **not** the agent runtime. Pi/Codex provides:

- LLM access
- subscription/auth handling
- chat interface
- file read/write/edit tools
- bash execution
- web/search/browse tools where available

`wiki` provides deterministic vault utilities:

- initialize vault
- add URLs
- show source/pending status
- archive processed sources
- lint vault
- optionally extract URLs as a fallback

The main behavioral contract lives in `AGENTS.md`.

## Core principles

1. **Zero-friction capture**
   - Adding a URL should be as easy as appending a line to `sources/inbox/urls.txt` or running `wiki add <url>`.
   - Markdown notes can be dropped directly into `sources/inbox/`.

2. **Agent-owned wiki maintenance**
   - Pi/Codex reads `AGENTS.md` and acts as autonomous wiki maintainer.
   - The agent writes and updates the wiki directly using its normal file tools.
   - The user should not have to approve routine page creation, edits, indexing, linking, or filing.

3. **Minimal interruptions**
   - The agent asks questions only when truly blocked or when a clarification materially changes interpretation.
   - Otherwise it makes reasonable assumptions and records unresolved issues in `wiki/_meta/pending.md`.

4. **Persistent compounding knowledge**
   - Ingested sources update existing pages, not just standalone summaries.
   - Chat answers and analyses can become wiki pages when useful.
   - Contradictions, open questions, forecasts, and theses accumulate over time.

5. **Flexible schema**
   - The initial folder structure is a seed, not a prison.
   - Schema and conventions are stored in the vault and can evolve.
   - Major schema changes should be logged.

6. **Markdown-first**
   - The vault should be browsable in Obsidian or any markdown viewer.
   - Use ordinary markdown links, not Obsidian-only wikilinks.

7. **Safe but low-friction autonomy**
   - The agent can edit the vault automatically.
   - The CLI can provide safe deterministic helpers for source bookkeeping and linting.

## Package and CLI name

Package/command name:

```bash
wiki
```

Examples:

```bash
wiki init
wiki add https://example.com/article
wiki status
wiki sources list
wiki sources archive-url https://example.com/article --status ingested
wiki lint
```

The CLI is a helper, not the primary chat interface. The primary interface is Pi/Codex launched from the vault directory.

## Primary user flow

### 1. Capture source with near-zero friction

Manual URL capture:

```txt
# sources/inbox/urls.txt
https://example.com/article-1
https://example.com/article-2
```

CLI capture:

```bash
wiki add https://example.com/article-1
```

Markdown capture:

```txt
sources/inbox/my-note.md
```

### 2. Open agent from vault

```bash
cd ~/vaults/ai-capex
pi
```

or Codex from the same directory.

### 3. Tell the agent what to do

```txt
ingest the new sources
```

The agent reads `AGENTS.md`, checks source queues, uses its native tools to read URLs, updates the wiki, then archives the processed sources via `wiki` CLI.

### 4. Interact with the personal knowledge base

```txt
What is the strongest bottleneck in AI infrastructure right now?
```

The agent answers from the wiki first, cites relevant markdown pages, and may offer to save durable analyses back into the vault.

## Vault location

The vault location must be configurable for the CLI.

Resolution order:

1. CLI flag:

   ```bash
   wiki --vault /path/to/vault status
   ```

2. Environment variable:

   ```bash
   WIKI_VAULT=/path/to/vault
   ```

3. User config value:

   ```yaml
   default_vault: /Users/name/wiki-vaults/ai-capex
   ```

4. Current working directory if it contains `wiki.yaml`.

Suggested config locations:

```txt
~/.config/wiki/config.yaml
<VAULT>/wiki.yaml
```

Vault config overrides user config where appropriate.

## Initial vault structure

```txt
<VAULT>/
├── AGENTS.md
├── wiki.yaml
├── sources/
│   ├── inbox/
│   │   └── urls.txt
│   ├── archive/
│   │   ├── urls.txt
│   │   └── markdown/
│   └── rejected/
└── wiki/
    ├── home.md
    ├── index.md
    ├── _meta/
    │   ├── log.md
    │   ├── pending.md
    │   ├── schema.md
    │   └── lint-report.md
    ├── entities/
    ├── sectors/
    ├── theses/
    ├── themes/
    ├── companies/
    ├── questions/
    ├── contradictions/
    ├── sources/
    ├── facts/
    ├── concepts/
    ├── forecasts/
    └── manuals/
```

## Folder intent

- `entities/`: people, organizations, technologies, products, named things that are not necessarily companies.
- `sectors/`: market or industry sectors.
- `theses/`: evolving investment/research theses.
- `themes/`: broad recurring narratives and drivers.
- `companies/`: company-specific pages.
- `questions/`: open research questions and answered inquiry pages.
- `contradictions/`: explicit unresolved or resolved contradictions.
- `sources/`: source summary pages and source-level notes.
- `facts/`: durable factual claims or fact clusters worth tracking separately.
- `concepts/`: reusable explanatory concepts.
- `forecasts/`: predictions, scenario expectations, and forecast ledgers.
- `manuals/`: user-authored or agent-authored operating manuals for the vault, domain notes, and workflow guidance.
- `_meta/`: operational files used by the tool and agent.

## Source lifecycle

### URL capture

Pending URLs live in:

```txt
sources/inbox/urls.txt
```

Each non-empty, non-comment line is treated as a pending URL.

### URL ingestion

During ingestion, the agent should:

1. read pending URLs from `sources/inbox/urls.txt`
2. use native web/browse/search tools to read actual source content where possible
3. avoid relying only on search snippets unless the source cannot be opened
4. classify source status: `ingested`, `rejected`, `duplicate`, `partial`, or `failed-fetch`
5. update wiki pages as appropriate
6. update `wiki/index.md`, `wiki/_meta/log.md`, and possibly `wiki/_meta/pending.md`
7. archive the URL using the CLI:

   ```bash
   wiki sources archive-url "https://example.com/article" --status ingested
   ```

After archiving, the URL is removed from `sources/inbox/urls.txt` and appended to `sources/archive/urls.txt`.

Suggested archive format:

```txt
2026-06-07 | ingested | https://example.com/article
2026-06-07 | rejected | https://example.com/bad-source
2026-06-07 | duplicate | https://example.com/already-seen
2026-06-07 | partial | https://example.com/partially-readable
2026-06-07 | failed-fetch | https://example.com/unavailable
```

Fetched URL content is **not archived by default**. This keeps capture and storage simple. Rebuilds refetch archived URLs, so rebuilds are not perfectly reproducible if web content changes.

### Markdown ingestion

The user may drop `.md` files directly into:

```txt
sources/inbox/
```

During ingestion, the agent reads the markdown file, files useful content into the wiki, then archives it using:

```bash
wiki sources archive-md sources/inbox/my-note.md --status ingested
```

Processed markdown files move to:

```txt
sources/archive/markdown/
```

Rejected markdown files move to:

```txt
sources/rejected/
```

## URL extraction policy

Default v0 behavior:

> Let Pi/Codex use its native web/search/browse tools to read URL sources directly.

Rationale:

- less tooling to build
- works naturally inside the chosen agent
- agent can adapt to unusual pages
- native browsing/search may outperform a basic scraper
- deterministic extraction is less critical because URL content is not archived by default

Optional fallback command:

```bash
wiki sources extract-url "https://example.com/article" --out .wiki/tmp/source.md
```

This can be implemented later or included as a helper for environments without web access. It should use libraries such as `httpx`, `trafilatura`, `readability-lxml`, and `beautifulsoup4`.

Important ingestion rule for agents:

> Do not deeply integrate a URL source into the wiki if only snippets or metadata were accessible. Mark it `partial` or `failed-fetch`, log the limitation, and move on.

## `wiki` CLI responsibilities

The CLI should do deterministic, non-LLM work.

### Required v0 commands

```bash
wiki init
wiki add <url>
wiki status
wiki sources list
wiki sources archive-url <url> --status ingested|rejected|duplicate|partial|failed-fetch
wiki sources archive-md <path> --status ingested|rejected|duplicate
wiki lint
```

### Optional / later commands

```bash
wiki sources extract-url <url> --out <path>
wiki rebuild --output <path>
wiki doctor
wiki index-check
wiki git-commit
```

## Command details

### `wiki init`

Creates a vault scaffold.

Options:

```bash
wiki init --vault /path/to/vault
wiki init --topic "AI capex and semiconductor bottlenecks"
```

Responsibilities:

- create folder structure
- create `AGENTS.md`
- create `wiki.yaml`
- create initial `wiki/home.md`
- create initial `wiki/index.md`
- create initial `wiki/_meta/schema.md`
- create initial `wiki/_meta/log.md`
- create initial `wiki/_meta/pending.md`
- create empty `sources/inbox/urls.txt`
- create empty `sources/archive/urls.txt`

### `wiki add <url>`

Appends a URL to `sources/inbox/urls.txt`.

Should avoid duplicate pending entries when possible.

### `wiki status`

Prints concise vault status:

- pending URL count
- pending markdown count
- open pending question count
- unresolved contradiction count
- last log entry
- git dirty status if applicable

Example:

```txt
Vault: ai-capex
Pending URLs: 3
Pending markdown files: 1
Open questions: 2
Unresolved contradictions: 1
Git: dirty
```

### `wiki sources list`

Lists pending source items in a parseable format for the agent.

Example:

```txt
URL  https://example.com/article-1
URL  https://example.com/article-2
MD   sources/inbox/my-note.md
```

### `wiki sources archive-url`

Moves a URL from inbox to archive.

Example:

```bash
wiki sources archive-url "https://example.com/article" --status ingested
```

Behavior:

- remove exact URL line from `sources/inbox/urls.txt`
- append dated status entry to `sources/archive/urls.txt`
- preserve unknown comments/other pending URLs

### `wiki sources archive-md`

Moves a markdown source from inbox to archive or rejected folder.

Example:

```bash
wiki sources archive-md sources/inbox/note.md --status ingested
```

Behavior:

- for `ingested` or `duplicate`, move to `sources/archive/markdown/`
- for `rejected`, move to `sources/rejected/`

### `wiki lint`

Health-checks the vault.

Initial checks:

- broken markdown links
- missing frontmatter
- pages missing from index
- orphan pages
- stale pending items
- unresolved contradictions
- pages with weak source attribution
- duplicate or near-duplicate page titles
- source summaries with no linked pages

Writes:

```txt
wiki/_meta/lint-report.md
```

## `AGENTS.md` responsibilities

`AGENTS.md` is the core operating manual for Pi/Codex.

It should instruct the agent to:

- act as autonomous maintainer of this markdown wiki
- maintain zero-friction workflow
- auto-edit without routine confirmations
- ask questions only when truly necessary
- ingest URLs from `sources/inbox/urls.txt`
- ingest markdown files from `sources/inbox/`
- use native web tools to read URLs where available
- never over-integrate inaccessible or snippet-only sources
- maintain `wiki/index.md`
- append to `wiki/_meta/log.md`
- track open questions and contradictions in `wiki/_meta/pending.md`
- use normal markdown links
- use YAML frontmatter
- distinguish facts, source claims, user beliefs, LLM synthesis, speculation, theses, and forecasts
- clearly label confidence and uncertainty
- preserve trading/investing caution: do not turn speculative narratives into facts
- archive processed sources using `wiki` CLI commands
- optionally run `wiki lint` after major sessions
- optionally git commit after successful ingest if configured and available

## Agent modes by instruction, not CLI runtime

The user can ask the agent for different modes conversationally:

### Quiet ingest

```txt
ingest new sources quietly
```

Behavior:

- no interruptions unless completely blocked
- make reasonable assumptions
- file unresolved issues in pending
- archive processed sources

### Interactive ingest

```txt
ingest new sources interactively
```

Behavior:

- still auto-edits
- asks only materially important clarification questions
- if user defers, records pending item and continues

### Chat / Q&A

```txt
What is my current AI capex thesis?
```

Behavior:

- read `wiki/index.md` first
- inspect relevant pages
- answer from the wiki where possible
- cite pages
- mention uncertainty, unresolved contradictions, or stale information
- offer to save durable synthesis if useful

### Review pending

```txt
review pending questions
```

Behavior:

- read `wiki/_meta/pending.md`
- ask the user for clarifications one at a time
- update affected pages
- mark items resolved/deferred
- append log entry

## Configuration

### User config example

Path:

```txt
~/.config/wiki/config.yaml
```

Example:

```yaml
default_vault: /Users/me/vaults/ai-capex
```

### Vault config example

Path:

```txt
<VAULT>/wiki.yaml
```

Example:

```yaml
vault:
  name: ai-capex
  root: .
  wiki_dir: wiki
  sources_dir: sources
  topic: "AI capex, chipmaking bottlenecks, semiconductor supply chain, and market implications"

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
```

Model/provider/API-key configuration is not needed in v0 because Pi/Codex manages model selection and auth. If a later `wiki chat` or `wiki ingest` direct-agent mode is added, model config can return.

## Page conventions

Use markdown with YAML frontmatter.

Example:

```md
---
type: thesis
status: evolving
created: 2026-06-07
updated: 2026-06-07
confidence: medium
sources:
  - wiki/sources/2026-06-07-example-article.md
tags:
  - ai-capex
  - semiconductors
---

# AI capex supercycle

## Current view

...

## Evidence

...

## Contradictions / caveats

...

## Related

- [Advanced packaging](../themes/advanced-packaging.md)
- [HBM supply](../themes/hbm-supply.md)
```

Recommended `type` values:

- `source`
- `entity`
- `sector`
- `thesis`
- `theme`
- `company`
- `question`
- `contradiction`
- `fact`
- `concept`
- `forecast`
- `manual`
- `meta`

The tool should not reject unknown types. Flexibility is more important than strict validation.

## Index and log

### `wiki/index.md`

Content-oriented catalog.

Purpose:

- help user browse
- help agent find relevant pages
- reduce need for embeddings in v0

Each entry should include:

- link
- page type/category
- one-line summary
- updated date if available

### `wiki/_meta/log.md`

Chronological operation log.

Append-only convention.

Entry format:

```md
## [2026-06-07] ingest | Source title or URL

- Status: ingested
- Source: https://example.com/article
- Pages changed:
  - [Advanced packaging](../themes/advanced-packaging.md)
  - [AI capex supercycle](../theses/ai-capex-supercycle.md)
- Notes: Raised one medium-severity contradiction.
```

## Pending questions and contradictions

Primary file:

```txt
wiki/_meta/pending.md
```

Pending item format:

```md
## [Q-2026-06-07-001] Does HBM remain the primary bottleneck through 2026?

- Type: question
- Status: open
- Severity: medium
- Created: 2026-06-07
- Related pages:
  - [HBM supply](../themes/hbm-supply.md)
  - [Advanced packaging](../themes/advanced-packaging.md)

Question:
Older notes emphasize HBM scarcity, while the latest source emphasizes advanced packaging capacity. The wiki may need to distinguish memory, packaging, and foundry bottlenecks by timeframe.
```

Contradictions can also get dedicated pages under:

```txt
wiki/contradictions/
```

Use dedicated contradiction pages for important or recurring contradictions. Use `_meta/pending.md` for operational tracking.

## Git behavior

Git is optional.

If configured and the vault is inside a git repo, the agent may commit after successful ingest/review sessions.

The CLI may later provide:

```bash
wiki git-commit --message "wiki ingest: 2026-06-07"
```

For v0, the agent can use normal git commands.

Git failures should not block the knowledge workflow unless explicitly configured.

## Rebuild behavior

Rebuild is mainly a stabilization/testing tool.

Current assumptions:

- URL content is not archived by default.
- Archived URL list is enough to attempt a rebuild.
- Markdown archive files are stable and can be replayed.

Recommended v0/v1 safety:

- `wiki rebuild` should not destroy the current vault by default.
- Prefer rebuilding into a new output path:

```bash
wiki rebuild --output /tmp/wiki-rebuild-test
```

A direct rebuild command is later-phase because agent-driven ingestion comes first.

## Implementation plan

### Milestone 1: CLI scaffold

- create Python package `wiki`
- use `uv`
- implement CLI with subcommands
- implement config loading
- implement vault path resolution
- implement `wiki init`

### Milestone 2: vault templates

- generate `AGENTS.md`
- generate `wiki.yaml`
- generate folder structure
- generate starter `wiki/home.md`
- generate starter `wiki/index.md`
- generate starter `wiki/_meta/schema.md`
- generate starter `wiki/_meta/log.md`
- generate starter `wiki/_meta/pending.md`

### Milestone 3: source capture/bookkeeping

- implement `wiki add <url>`
- implement URL inbox parsing
- implement `wiki sources list`
- implement `wiki sources archive-url`
- implement markdown inbox detection
- implement `wiki sources archive-md`

### Milestone 4: status and lint

- implement `wiki status`
- implement broken-link lint
- implement frontmatter check
- implement index consistency check
- write `wiki/_meta/lint-report.md`

### Milestone 5: optional URL extraction fallback

- implement `wiki sources extract-url`
- use `httpx`
- use `trafilatura` or `readability-lxml`
- fallback to BeautifulSoup plain text extraction

### Milestone 6: later direct-agent mode, optional

Only after the agent-native workflow is proven useful, consider adding:

```bash
wiki chat
wiki ingest -q
wiki ingest -i
```

Those commands would require direct model integration and are not part of v0.

## Open design questions

1. How detailed should the generated `AGENTS.md` be before it becomes too constraining?
2. Should Pi-specific prompt templates be generated under `.pi/prompts/` for `/ingest`, `/review`, and `/chat`?
3. Should Codex-specific instruction files also be generated if they differ from `AGENTS.md`?
4. Should `wiki sources extract-url` be included in v0 or deferred until native agent web extraction proves insufficient?
5. How aggressive should `wiki lint` be about index consistency and missing citations?
