# Project instructions: Cúram vectorless document QA

When asked about Cúram/Curam, use the local indexed docs. Do not answer from general memory.

Start with the master index:

- `contents/index.json`

Then follow each selected document's pointers:

- `index_file` — document tree/navigation map
- `content_file` — extracted source text

Known current document:

- `contents/curamserverdeveloperguide_812/index.json`
- `contents/curamserverdeveloperguide_812/content.jsonl`
- Cúram 8.1.2 Server Developer's Guide, 216 pages

Workflow:

1. Inspect `contents/index.json` first to choose relevant document(s).
2. Inspect the chosen document `index.json` as the navigation tree.
3. Use node `title`, `summary`, `range`, and `children` to choose the smallest relevant node(s).
4. Read the corresponding page records from that document's `content.jsonl`.
5. Answer only from verified page text.
6. Cite every substantive document-backed claim as `[Cúram Server Developer's Guide 8.1.2, p. N]` or `pp. N-M`.

Helpful commands:

```bash
python3 - <<'PY'
import json
m=json.load(open('contents/index.json'))
for d in m['documents']:
    print(f"{d['doc_id']} | {d['title']} | {d['index_file']}")
PY

rg -n -i "keyword" contents/*/index.json

python3 - <<'PY'
import json
content_file='contents/curamserverdeveloperguide_812/content.jsonl'
start,end=1,3
with open(content_file, encoding='utf-8') as f:
    for line in f:
        r=json.loads(line)
        p=r.get('page')
        if p is not None and start <= p <= end:
            print(f"\n--- page {p} ({r['unit_id']}) ---\n{r['text']}")
PY
```

See `SKILL.md` for the full workflow and citation rules.
