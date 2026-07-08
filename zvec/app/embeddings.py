from __future__ import annotations

import hashlib
import math
import re
from abc import ABC, abstractmethod

import httpx

from .config import Settings

_TOKEN_RE = re.compile(r"[A-Za-z0-9_]+")


class EmbeddingProvider(ABC):
    def __init__(self, dimension: int):
        self.dimension = dimension

    @abstractmethod
    def embed(self, texts: list[str]) -> list[list[float]]:
        raise NotImplementedError

    def embed_one(self, text: str) -> list[float]:
        return self.embed([text])[0]


class HashEmbeddingProvider(EmbeddingProvider):
    """Deterministic local embedding for zero-config zvec testing.

    This is not meant to beat real embedding models; it creates useful-enough lexical
    vectors so uploads/search/chat can be tested without network or model access.
    """

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._embed_text(text) for text in texts]

    def _embed_text(self, text: str) -> list[float]:
        vec = [0.0] * self.dimension
        tokens = [m.group(0).lower() for m in _TOKEN_RE.finditer(text)]
        if not tokens:
            return vec

        # Word unigrams + a few character trigrams improve matching of PDF jargon.
        features: list[str] = []
        features.extend(tokens)
        for token in tokens:
            if len(token) >= 5:
                features.extend(token[i : i + 3] for i in range(len(token) - 2))

        for feature in features:
            digest = hashlib.blake2b(feature.encode("utf-8"), digest_size=8).digest()
            value = int.from_bytes(digest, "big")
            idx = value % self.dimension
            sign = 1.0 if (value >> 63) == 0 else -1.0
            vec[idx] += sign

        norm = math.sqrt(sum(x * x for x in vec)) or 1.0
        return [x / norm for x in vec]


class OpenAIEmbeddingProvider(EmbeddingProvider):
    def __init__(self, settings: Settings):
        super().__init__(settings.embedding_dim)
        if not settings.openai_api_key:
            raise RuntimeError("OPENAI_API_KEY is required for EMBEDDING_PROVIDER=openai")
        self.base_url = settings.openai_base_url
        self.api_key = settings.openai_api_key
        self.model = settings.embedding_model

    def embed(self, texts: list[str]) -> list[list[float]]:
        headers = {"Authorization": f"Bearer {self.api_key}"}
        payload: dict = {"model": self.model, "input": texts}
        if self.dimension:
            payload["dimensions"] = self.dimension
        with httpx.Client(timeout=120) as client:
            resp = client.post(f"{self.base_url}/embeddings", headers=headers, json=payload)
            resp.raise_for_status()
            data = resp.json()["data"]
        data.sort(key=lambda item: item["index"])
        return [item["embedding"] for item in data]


class OllamaEmbeddingProvider(EmbeddingProvider):
    def __init__(self, settings: Settings):
        super().__init__(settings.embedding_dim)
        self.base_url = settings.ollama_base_url
        self.model = settings.embedding_model

    def embed(self, texts: list[str]) -> list[list[float]]:
        vectors: list[list[float]] = []
        with httpx.Client(timeout=120) as client:
            for text in texts:
                resp = client.post(
                    f"{self.base_url}/api/embeddings",
                    json={"model": self.model, "prompt": text},
                )
                resp.raise_for_status()
                vectors.append(resp.json()["embedding"])
        return vectors


def make_embedding_provider(settings: Settings) -> EmbeddingProvider:
    provider = settings.embedding_provider
    if provider == "hash":
        return HashEmbeddingProvider(settings.embedding_dim)
    if provider == "openai":
        return OpenAIEmbeddingProvider(settings)
    if provider == "ollama":
        return OllamaEmbeddingProvider(settings)
    raise RuntimeError(f"Unsupported EMBEDDING_PROVIDER={provider!r}")
