# zvec PDF Q&A demo

A small FastAPI web app for testing [Alibaba zvec](https://github.com/alibaba/zvec) with PDF uploads, durable local storage, and a chat UI.

## Run

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Open <http://127.0.0.1:8000>.

Uploaded PDFs, extracted chunks, chat history, and the zvec collection are stored under `./data` by default. Retrieval uses zvec vector search plus native full-text search (hybrid with RRF), falling back to vector-only if needed.

## Configuration

Set environment variables before starting the server.

### Storage

```bash
export DATA_DIR=./data
```

### Embeddings

Default is a deterministic local hash embedding, so the app works without any model service:

```bash
export EMBEDDING_PROVIDER=hash
export EMBEDDING_DIM=384
```

OpenAI-compatible embeddings:

```bash
export EMBEDDING_PROVIDER=openai
export OPENAI_API_KEY=...
export OPENAI_BASE_URL=https://api.openai.com/v1   # or compatible endpoint
export EMBEDDING_MODEL=text-embedding-3-small
export EMBEDDING_DIM=1536
```

Ollama embeddings:

```bash
export EMBEDDING_PROVIDER=ollama
export OLLAMA_BASE_URL=http://localhost:11434
export EMBEDDING_MODEL=nomic-embed-text
export EMBEDDING_DIM=768
```

> The embedding provider/dimension is persisted in `DATA_DIR/config.json`. If you change it for an existing collection, delete `DATA_DIR/zvec_collection` and re-upload PDFs, or keep the original settings.

### Chat model / answer generation

Default is extractive mode: it returns the retrieved passages without calling a model.

```bash
export LLM_PROVIDER=extractive
```

OpenAI-compatible chat:

```bash
export LLM_PROVIDER=openai
export OPENAI_API_KEY=...
export OPENAI_BASE_URL=https://api.openai.com/v1
export CHAT_MODEL=gpt-4o-mini
```

Ollama chat:

```bash
export LLM_PROVIDER=ollama
export OLLAMA_BASE_URL=http://localhost:11434
export CHAT_MODEL=llama3.1
```

Copilot CLI / command route:

```bash
export LLM_PROVIDER=copilot-cli
export COPILOT_CLI_COMMAND='your-copilot-wrapper'
```

The command should print the answer to stdout. If the command string does **not** contain `{prompt}`, the full prompt is piped to stdin. If it contains `{prompt}`, `{prompt}` is passed as a single command argument:

```bash
export LLM_PROVIDER=command
export LLM_COMMAND='my-llm-cli --prompt {prompt}'
```

Do not include quotes around the entire command inside the environment variable. On Windows, set it like:

```powershell
$env:LLM_PROVIDER = "copilot-cli"
$env:COPILOT_CLI_COMMAND = "copilot -p {prompt}"
```

This makes it easy to use workstation-approved wrappers around Copilot CLI.

## API

- `POST /api/upload` multipart `files`: upload one or more PDFs.
- `GET /api/documents`: list uploaded PDFs.
- `DELETE /api/documents/{doc_id}`: remove a PDF and its chunks.
- `POST /api/chat` JSON `{ "message": "...", "top_k": 5 }`: ask against uploaded PDFs.
- `GET /api/history`: chat history.
