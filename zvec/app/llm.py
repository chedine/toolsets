from __future__ import annotations

import os
import shlex
import subprocess
from abc import ABC, abstractmethod

import httpx

from .config import Settings


class LLMProvider(ABC):
    @abstractmethod
    def answer(self, question: str, contexts: list[dict]) -> str:
        raise NotImplementedError


SYSTEM_PROMPT = """You answer questions using only the supplied PDF excerpts.
If the excerpts do not contain the answer, say you do not know from the uploaded PDFs.
Cite sources inline as [filename p.page]. Be concise."""


def build_prompt(question: str, contexts: list[dict]) -> str:
    context_text = "\n\n".join(
        f"[{i + 1}] {ctx['filename']} p.{ctx['page']} score={ctx.get('score', 0):.4f}\n{ctx['text']}"
        for i, ctx in enumerate(contexts)
    )
    return f"{SYSTEM_PROMPT}\n\nPDF excerpts:\n{context_text}\n\nQuestion: {question}\n\nAnswer:"


class ExtractiveProvider(LLMProvider):
    def answer(self, question: str, contexts: list[dict]) -> str:
        if not contexts:
            return "No PDF passages were retrieved. Upload PDFs first, or ask a question covered by the uploaded PDFs."
        lines = ["Retrieved relevant passages (set LLM_PROVIDER to generate a synthesized answer):"]
        for ctx in contexts[:5]:
            snippet = " ".join(ctx["text"].split())[:700]
            lines.append(f"\n- {ctx['filename']} p.{ctx['page']}: {snippet}")
        return "\n".join(lines)


class OpenAIChatProvider(LLMProvider):
    def __init__(self, settings: Settings):
        if not settings.openai_api_key:
            raise RuntimeError("OPENAI_API_KEY is required for LLM_PROVIDER=openai")
        self.base_url = settings.openai_base_url
        self.api_key = settings.openai_api_key
        self.model = settings.chat_model

    def answer(self, question: str, contexts: list[dict]) -> str:
        headers = {"Authorization": f"Bearer {self.api_key}"}
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": build_prompt(question, contexts)},
        ]
        with httpx.Client(timeout=120) as client:
            resp = client.post(
                f"{self.base_url}/chat/completions",
                headers=headers,
                json={"model": self.model, "messages": messages, "temperature": 0.1},
            )
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"].strip()


class OllamaChatProvider(LLMProvider):
    def __init__(self, settings: Settings):
        self.base_url = settings.ollama_base_url
        self.model = settings.chat_model

    def answer(self, question: str, contexts: list[dict]) -> str:
        with httpx.Client(timeout=120) as client:
            resp = client.post(
                f"{self.base_url}/api/chat",
                json={
                    "model": self.model,
                    "stream": False,
                    "messages": [
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {"role": "user", "content": build_prompt(question, contexts)},
                    ],
                },
            )
            resp.raise_for_status()
            return resp.json()["message"]["content"].strip()


class CommandProvider(LLMProvider):
    def __init__(self, settings: Settings):
        if not settings.llm_command:
            raise RuntimeError("LLM_COMMAND or COPILOT_CLI_COMMAND is required for command/copilot-cli LLM provider")
        self.command = settings.llm_command

    def answer(self, question: str, contexts: list[dict]) -> str:
        prompt = build_prompt(question, contexts)
        if "{prompt}" in self.command:
            # Treat {prompt} as an argv placeholder instead of shell-quoting it.
            # This avoids cmd.exe/PowerShell issues with POSIX single quotes on Windows.
            argv = [part.replace("{prompt}", prompt) for part in shlex.split(self.command, posix=(os.name != "nt"))]
            if not argv:
                raise RuntimeError("LLM command is empty")
            completed = subprocess.run(
                argv,
                shell=False,
                text=True,
                capture_output=True,
                timeout=180,
            )
        else:
            completed = subprocess.run(
                self.command,
                shell=True,
                input=prompt,
                text=True,
                capture_output=True,
                timeout=180,
            )
        if completed.returncode != 0:
            err = completed.stderr.strip() or completed.stdout.strip()
            raise RuntimeError(f"LLM command failed ({completed.returncode}): {err}")
        return completed.stdout.strip()


def make_llm_provider(settings: Settings) -> LLMProvider:
    provider = settings.llm_provider
    if provider == "extractive":
        return ExtractiveProvider()
    if provider == "openai":
        return OpenAIChatProvider(settings)
    if provider == "ollama":
        return OllamaChatProvider(settings)
    if provider in {"command", "copilot-cli"}:
        return CommandProvider(settings)
    raise RuntimeError(f"Unsupported LLM_PROVIDER={provider!r}")
