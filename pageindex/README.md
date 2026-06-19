# Vectorless Page Index POC

A lightweight, local indexer for vectorless RAG experiments. It indexes PDF or Markdown documents into per-document source files plus a corpus-level master index.

```text
contents/
  index.json            # master/corpus index: first-level pointers to documents
  <doc-slug>/
    index.json          # document navigation tree: titles, summaries, ranges
    content.jsonl       # extracted source text units, one page/section per line
    metadata.json
    config.snapshot.yaml
```

The project intentionally does **not** include a retriever or vector database. An agent should inspect `contents/index.json`, choose a document, inspect that document's `index.json`, then read referenced units from `content.jsonl`.

## Install

```bash
pip install -r requirements.txt
```

## Run one file

```bash
python3 index_document.py /path/to/document.pdf --config config.yaml
```

Markdown is also supported:

```bash
python3 index_document.py /path/to/document.md --config config.yaml
```

## Batch mode

If no input is supplied, the script indexes all supported files in the configured inbox folder:

```bash
mkdir -p inbox archive
cp /path/to/*.pdf inbox/
python3 index_document.py --config config.yaml
```

Documents are indexed sequentially. After each PDF indexes successfully, it is moved to the configured archive folder. The master index is rewritten at `contents/index.json` immediately after each successfully completed file, then rewritten once more at the end of the run.

The script prints startup status immediately: config path, output dir, supported extensions, inbox path, discovered file count, and a file list. Progress is append-only for reliability: each status update prints the file ordinal (`[m/N]`), file name, elapsed time, an indented status line, and aggregate file progress. Statuses include PDF extraction, outline/tree building, summary node progress (`m/N`), output writing, archiving, and per-file master-index updates.

By default, the LLM provider is `pi_openai_codex`, which reuses Pi's ChatGPT/Codex OAuth credential at `~/.pi/agent/auth.json`.

## Core schema

`contents/index.json` contains corpus-level pointers:

```json
{
  "schema_version": "vectorless-pageindex-lite/v1/corpus-index",
  "document_count": 1,
  "documents": [
    {
      "doc_id": "...",
      "title": "...",
      "doc_dir": "my-document",
      "index_file": "my-document/index.json",
      "content_file": "my-document/content.jsonl",
      "summary": "..."
    }
  ]
}
```

`content.jsonl` for PDF uses one record per page:

```json
{"unit_id":"p000001","type":"page","page":1,"text":"..."}
```

Per-document `index.json`:

```json
{
  "schema_version": "vectorless-pageindex-lite/v1",
  "document": {
    "doc_id": "...",
    "title": "...",
    "source_type": "pdf",
    "source_path": "/absolute/path.pdf",
    "content_file": "content.jsonl",
    "page_count": 10
  },
  "root": {
    "node_id": "n000000",
    "title": "Document title",
    "level": 0,
    "summary": "...",
    "range": {
      "start_unit_id": "p000001",
      "end_unit_id": "p000010",
      "start_page": 1,
      "end_page": 10
    },
    "children": []
  }
}
```

`level` is redundant with nesting but retained as a convenience for agents and debugging.
