from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    embedding_provider: str
    embedding_model: str
    embedding_dim: int
    llm_provider: str
    chat_model: str
    openai_base_url: str
    openai_api_key: str | None
    ollama_base_url: str
    llm_command: str | None
    max_upload_mb: int


def load_settings() -> Settings:
    data_dir = Path(os.getenv("DATA_DIR", "./data")).resolve()
    embedding_provider = os.getenv("EMBEDDING_PROVIDER", "hash").lower().strip()
    default_embedding_model = {
        "hash": "hash",
        "openai": "text-embedding-3-small",
        "ollama": "nomic-embed-text",
    }.get(embedding_provider, "hash")

    default_dim = {
        "hash": 384,
        "openai": 1536,
        "ollama": 768,
    }.get(embedding_provider, 384)

    llm_provider = os.getenv("LLM_PROVIDER", "extractive").lower().strip()
    llm_command = os.getenv("COPILOT_CLI_COMMAND") if llm_provider == "copilot-cli" else None
    llm_command = llm_command or os.getenv("LLM_COMMAND")

    return Settings(
        data_dir=data_dir,
        embedding_provider=embedding_provider,
        embedding_model=os.getenv("EMBEDDING_MODEL", default_embedding_model),
        embedding_dim=int(os.getenv("EMBEDDING_DIM", str(default_dim))),
        llm_provider=llm_provider,
        chat_model=os.getenv("CHAT_MODEL", "gpt-4o-mini"),
        openai_base_url=os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/"),
        openai_api_key=os.getenv("OPENAI_API_KEY"),
        ollama_base_url=os.getenv("OLLAMA_BASE_URL", "http://localhost:11434").rstrip("/"),
        llm_command=llm_command,
        max_upload_mb=int(os.getenv("MAX_UPLOAD_MB", "100")),
    )
