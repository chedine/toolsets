---
name: curam-vectorless-docs
description: Use when answering questions about Cúram/Curam using this project's vectorless indexed documents. Provides a retrieval workflow over contents/index.json, per-document index.json files, and content.jsonl files, with mandatory page citations.
---

# Cúram vectorless document QA

Use this skill when the user asks about Cúram/Curam. Do not rely on general model memory. Use the local indexed document files as the source of truth.

## Corpus entry point

Start here:

- Master index: `contents/index.json`

The master index points to each indexed document's:

- `index_file` — document navigation tree with titles, summaries, ranges
- `content_file` — extracted source text records

Known current document:

- `contents/curamserverdeveloperguide_812/index.json`
- `contents/curamserverdeveloperguide_812/content.jsonl`
- Cúram 8.1.2 Server Developer's Guide, 216 pages

## Retrieval workflow

1. Inspect `contents/index.json` first to choose the relevant document(s).
2. Open the chosen document's `index_file`. Treat it as the navigation map, not final evidence.
3. Walk the tree by reading node `title`, `summary`, `range`, and `children`.
4. Choose the smallest relevant node(s). Prefer leaf or near-leaf nodes whose summaries match the question.
5. Use each selected node's `range.start_page` / `range.end_page` or `start_unit_id` / `end_unit_id` to read matching records from that document's `content_file`.
6. Answer only after verifying relevant page text in `content.jsonl`.
7. If the first node is insufficient, expand to sibling/parent/child nodes or keyword-search the document index and content file, then verify pages.

Useful commands:

```bash
# See indexed documents
python3 - <<'PY'
import json
m=json.load(open('contents/index.json'))
for d in m['documents']:
    print(f"{d['doc_id']} | {d['title']} | {d['index_file']} | {d.get('summary','')[:200]}")
PY

# Keyword search titles/summaries/ranges
rg -n -i "transaction|datamanager|deferred processing" contents/*/index.json

# Print top-level tree nodes for a document
python3 - <<'PY'
import json
idx=json.load(open('contents/curamserverdeveloperguide_812/index.json'))
for c in idx['root']['children']:
    r=c['range']
    print(f"{c['node_id']} | pp. {r.get('start_page')}-{r.get('end_page')} | {c['title']} | {c.get('summary','')[:180]}")
PY

# Read a page range from content.jsonl
python3 - <<'PY'
import json
content_file='contents/curamserverdeveloperguide_812/content.jsonl'
start,end=10,12
with open(content_file, encoding='utf-8') as f:
    for line in f:
        r=json.loads(line)
        p=r.get('page')
        if p is not None and start <= p <= end:
            print(f"\n--- page {p} ({r['unit_id']}) ---\n{r['text']}")
PY
```

## Citation rules

- Cite every substantive factual claim from the document.
- Citation format: `[Cúram Server Developer's Guide 8.1.2, p. N]` or `[Cúram Server Developer's Guide 8.1.2, pp. N-M]`.
- Use the `page` number in `content.jsonl` / `range.start_page` and `range.end_page` as the page number.
- For direct quotes, include a citation immediately after the quote.
- Do not cite `index.json` summaries for detailed facts unless the page text was also checked. Use summaries to navigate; use `content.jsonl` as evidence.
- If the answer cannot be found in the indexed pages, say so and mention the pages/sections checked.

## Answer style

Be concise and practical. If useful, include a short “Sources checked” line with page ranges. For how-to answers, give steps and cite the page(s) supporting each step or group of steps.
