#!/usr/bin/env python3
"""Lightweight vectorless document indexer.

Builds an agent-navigable tree index plus a source text JSONL file for one
PDF or Markdown document. Retrieval is intentionally out of scope: agents are
expected to inspect index.json, then read the referenced content.jsonl units.
"""
from __future__ import annotations

import argparse
import base64
import copy
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import textwrap
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import requests
import yaml

try:
    from tqdm import tqdm
except ImportError:  # pragma: no cover - fallback for minimal environments
    tqdm = None


# ----------------------------- generic helpers -----------------------------


def deep_get(data: dict[str, Any], path: str, default: Any = None) -> Any:
    cur: Any = data
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return default
        cur = cur[part]
    return cur


def require_config(config: dict[str, Any], path: str) -> Any:
    val = deep_get(config, path)
    if val is None:
        raise ValueError(f"Missing required config value: {path}")
    return val


def now_iso() -> str:
    return dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def slugify(value: str, max_length: int) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9._-]+", "-", value)
    value = re.sub(r"-+", "-", value).strip("-._")
    if not value:
        value = "document"
    return value[:max_length].strip("-._") or "document"


def normalize_text(text: str, config: dict[str, Any]) -> str:
    if not deep_get(config, "content.normalize_whitespace", True):
        return text
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = "\n".join(line.rstrip() for line in text.split("\n"))
    if deep_get(config, "content.collapse_blank_lines", True):
        text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract_json_from_text(text: str) -> Any:
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, flags=re.S | re.I)
    if fence:
        text = fence.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    start_positions = [i for i in (text.find("{"), text.find("[")) if i >= 0]
    if not start_positions:
        raise ValueError("No JSON object/array found in LLM response")
    start = min(start_positions)
    end = max(text.rfind("}"), text.rfind("]"))
    if end <= start:
        raise ValueError("Could not find complete JSON in LLM response")
    return json.loads(text[start : end + 1])


def compact_for_prompt(text: str, max_chars: int) -> str:
    text = text.strip()
    if len(text) <= max_chars:
        return text
    half = max_chars // 2
    return text[:half].rstrip() + "\n\n[...middle omitted...]\n\n" + text[-half:].lstrip()


PROGRESS: "ProgressReporter | None" = None
LLM_SEMAPHORE: "threading.BoundedSemaphore | None" = None
THREAD_CONTEXT = threading.local()


class ProgressReporter:
    """Sequential progress reporter.

    Supports two styles:
    - inline: redraws the small file dashboard in-place (single-threaded; no background UI)
    - log: append-only status lines for non-TTY/log environments
    """

    def __init__(self, config: dict[str, Any], files: list[Path]):
        self.config = config
        self.files = files
        self.total_files = len(files)
        self.positions = {str(p): i for i, p in enumerate(files, start=1)}
        self.statuses = {str(p): "queued" for p in files}
        self.states = {str(p): "queued" for p in files}
        self.started_at = time.time()
        self.updated_at = {str(p): self.started_at for p in files}
        self.done_count = 0
        self.failed_count = 0
        self.rendered_lines = 0
        configured_style = str(deep_get(config, "progress.style", "inline")).lower()
        force_inline = bool(deep_get(config, "progress.force_inline", False))
        self.inline = configured_style == "inline" and (force_inline or sys.stdout.isatty())

    def start(self) -> None:
        if self.inline:
            self.render()
            return
        log(self.config, f"Files to process ({self.total_files}):")
        for p in self.files:
            log(self.config, f"  ○ [{self.positions[str(p)]}/{self.total_files}] {p}")
        self._print_totals()

    def stop(self) -> None:
        if self.inline:
            self.render()
            print(flush=True)
        else:
            self._print_totals(final=True)

    def symbol(self, state: str) -> str:
        colors = bool(deep_get(self.config, "progress.colors", True)) and self.inline
        if state == "done":
            return "\033[32m●\033[0m" if colors else "●"
        if state == "failed":
            return "\033[31m●\033[0m" if colors else "●"
        if state == "running":
            return "\033[33m●\033[0m" if colors else "●"
        return "\033[90m○\033[0m" if colors else "○"

    def _counts(self) -> tuple[int, int, int]:
        running_count = sum(1 for s in self.states.values() if s == "running")
        return self.done_count, running_count, self.failed_count

    def _print_totals(self, final: bool = False) -> None:
        done_count, running_count, failed_count = self._counts()
        prefix = "Final" if final else "Progress"
        log(self.config, f"{prefix}: {done_count}/{self.total_files} files done, {running_count} running, {failed_count} failed")

    def render(self) -> None:
        done_count, running_count, failed_count = self._counts()
        now = time.time()
        lines = [f"Indexing files: {done_count}/{self.total_files} done, {running_count} running, {failed_count} failed"]
        for p in self.files:
            key = str(p)
            state = self.states[key]
            status_text = self.statuses[key]
            if state == "running":
                status_text = f"{status_text} ({int(now - self.updated_at[key])}s)"
            lines.append(f"  {self.symbol(state)} [{self.positions[key]}/{self.total_files}] {p.name}")
            lines.append(f"      ↳ {status_text}")
        if self.rendered_lines:
            print(f"\033[{self.rendered_lines}A\033[J", end="")
        print("\n".join(lines), flush=True)
        self.rendered_lines = len(lines)

    def update(self, path: Path, message: str, state: str = "running") -> None:
        key = str(path)
        if key not in self.statuses:
            return
        old_state = self.states[key]
        if old_state != "done" and state == "done":
            self.done_count += 1
        if old_state != "failed" and state == "failed":
            self.failed_count += 1
        self.statuses[key] = message
        self.states[key] = state
        self.updated_at[key] = time.time()
        if self.inline:
            self.render()
            return
        elapsed = int(self.updated_at[key] - self.started_at)
        log(self.config, f"{self.symbol(state)} [{self.positions[key]}/{self.total_files}] {path.name} (+{elapsed}s)")
        log(self.config, f"    ↳ {message}")
        self._print_totals()

    def done(self, path: Path, message: str = "done") -> None:
        self.update(path, message, "done")

    def failed(self, path: Path, message: str) -> None:
        self.update(path, message, "failed")


def log(config: dict[str, Any], message: str) -> None:
    if deep_get(config, "progress.verbose", True):
        print(message, flush=True)


def status(config: dict[str, Any], path: Path, message: str, state: str = "running") -> None:
    if PROGRESS is not None:
        PROGRESS.update(path, message, state)
    else:
        log(config, f"[{path.name}] {message}")


def progress_iter(iterable: Iterable[Any], config: dict[str, Any], *, total: int | None = None, desc: str = "", unit: str = "it") -> Iterable[Any]:
    if not deep_get(config, "progress.enabled", True):
        return iterable
    if tqdm is not None:
        return tqdm(iterable, total=total, desc=desc, unit=unit)

    # Dependency-free fallback so users still see activity if tqdm is not installed.
    def _fallback() -> Iterable[Any]:
        update_every = max(1, int(deep_get(config, "progress.basic_update_every", 1)))
        if desc:
            total_s = str(total) if total is not None else "?"
            print(f"{desc}: 0/{total_s} {unit}", flush=True)
        for i, item in enumerate(iterable, start=1):
            yield item
            if desc and (i % update_every == 0 or (total is not None and i == total)):
                total_s = str(total) if total is not None else "?"
                print(f"{desc}: {i}/{total_s} {unit}", flush=True)

    return _fallback()


def unique_destination(path: Path) -> Path:
    if not path.exists():
        return path
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    candidate = path.with_name(f"{path.stem}-{stamp}{path.suffix}")
    counter = 2
    while candidate.exists():
        candidate = path.with_name(f"{path.stem}-{stamp}-{counter}{path.suffix}")
        counter += 1
    return candidate


def write_json_atomic(path: Path, data: Any, *, pretty: bool = True) -> None:
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    content = json.dumps(data, ensure_ascii=False, indent=2 if pretty else None) + "\n"
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, path)


# -------------------------------- LLM client --------------------------------


class LLMError(RuntimeError):
    pass


@dataclass
class LLMClient:
    config: dict[str, Any]

    def complete(self, system: str, prompt: str) -> str:
        provider = require_config(self.config, "llm.provider")
        if provider == "mock":
            return self._complete_mock(prompt)
        semaphore = LLM_SEMAPHORE
        context_path = getattr(THREAD_CONTEXT, "path", None)
        context_note = getattr(THREAD_CONTEXT, "llm_note", "LLM request")
        if semaphore is None:
            return self._complete_with_provider(provider, system, prompt)
        if context_path is not None:
            status(self.config, context_path, f"waiting for LLM slot: {context_note}")
        with semaphore:
            if context_path is not None:
                status(self.config, context_path, f"LLM request in progress: {context_note}")
            return self._complete_with_provider(provider, system, prompt)

    def _complete_with_provider(self, provider: str, system: str, prompt: str) -> str:
        if provider == "openai_responses":
            return self._complete_openai_responses(system, prompt)
        if provider == "pi_openai_codex":
            return self._complete_pi_openai_codex(system, prompt)
        raise ValueError(f"Unsupported llm.provider: {provider}")

    def _complete_mock(self, prompt: str) -> str:
        if "summary" in prompt.lower():
            return "Mock summary. Configure a real LLM provider for production-quality summaries."
        return "[]"

    def _request_with_retries(self, *, method: str, url: str, **kwargs: Any) -> requests.Response:
        retries = int(require_config(self.config, "llm.max_retries"))
        timeout = int(require_config(self.config, "llm.timeout_seconds"))
        kwargs.setdefault("timeout", timeout)
        last_exc: Exception | None = None
        for attempt in range(retries + 1):
            try:
                resp = requests.request(method, url, **kwargs)
                if resp.status_code in {429, 500, 502, 503, 504} and attempt < retries:
                    time.sleep(2**attempt)
                    continue
                return resp
            except requests.RequestException as exc:
                last_exc = exc
                if attempt < retries:
                    time.sleep(2**attempt)
                    continue
        raise LLMError(f"Request failed after retries: {last_exc}")

    def _complete_openai_responses(self, system: str, prompt: str) -> str:
        api_key = os.getenv(require_config(self.config, "llm.openai_api_key_env"))
        if not api_key:
            raise LLMError("OPENAI API key not found in configured environment variable")
        base = str(require_config(self.config, "llm.openai_base_url")).rstrip("/")
        body: dict[str, Any] = {
            "model": require_config(self.config, "llm.model"),
            "instructions": system,
            "input": prompt,
            "store": False,
        }
        temperature = deep_get(self.config, "llm.temperature")
        if temperature is not None:
            body["temperature"] = temperature
        resp = self._request_with_retries(
            method="POST",
            url=f"{base}/responses",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=body,
        )
        if not resp.ok:
            raise LLMError(f"OpenAI Responses error {resp.status_code}: {resp.text[:1000]}")
        data = resp.json()
        if data.get("output_text"):
            return data["output_text"]
        parts: list[str] = []
        for item in data.get("output", []) or []:
            for block in item.get("content", []) or []:
                if block.get("type") in {"output_text", "text"} and block.get("text"):
                    parts.append(block["text"])
        return "\n".join(parts).strip()

    def _pi_token_from_auth(self) -> str:
        auth_path = Path(os.path.expanduser(str(require_config(self.config, "llm.auth_path"))))
        provider_key = str(require_config(self.config, "llm.auth_provider_key"))
        package_dir = Path(os.path.expanduser(str(require_config(self.config, "llm.pi_agent_package_dir"))))
        if package_dir.exists():
            node_code = f"""
import {{ AuthStorage }} from './dist/core/auth-storage.js';
const storage = AuthStorage.create({json.dumps(str(auth_path))});
const key = await storage.getApiKey({json.dumps(provider_key)}, {{ includeFallback: false }});
if (!key) process.exit(2);
process.stdout.write(JSON.stringify({{ access: key }}));
"""
            try:
                proc = subprocess.run(
                    ["node", "--input-type=module", "-e", node_code],
                    cwd=str(package_dir),
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=30,
                    check=False,
                )
                if proc.returncode == 0:
                    return json.loads(proc.stdout)["access"]
            except Exception:
                pass
        if not auth_path.exists():
            raise LLMError(f"Pi auth file not found: {auth_path}")
        data = json.loads(auth_path.read_text())
        cred = data.get(provider_key) or {}
        token = cred.get("access")
        if not token:
            raise LLMError(f"No access token for {provider_key} in {auth_path}")
        if cred.get("expires") and int(cred["expires"]) <= int(time.time() * 1000):
            raise LLMError(f"Stored {provider_key} token is expired and refresh helper is unavailable")
        return token

    @staticmethod
    def _jwt_payload(token: str) -> dict[str, Any]:
        parts = token.split(".")
        if len(parts) != 3:
            raise LLMError("Pi OpenAI Codex token is not a JWT")
        payload = parts[1] + "=" * (-len(parts[1]) % 4)
        return json.loads(base64.urlsafe_b64decode(payload.encode()).decode())

    def _complete_pi_openai_codex(self, system: str, prompt: str) -> str:
        token = self._pi_token_from_auth()
        claims = self._jwt_payload(token)
        account_id = (claims.get("https://api.openai.com/auth") or {}).get("chatgpt_account_id")
        if not account_id:
            raise LLMError("Could not extract chatgpt_account_id from Pi OpenAI token")
        base = str(require_config(self.config, "llm.codex_base_url")).rstrip("/")
        url = f"{base}/codex/responses"
        body: dict[str, Any] = {
            "model": require_config(self.config, "llm.model"),
            "store": False,
            "stream": True,
            "instructions": system,
            "input": [{"role": "user", "content": [{"type": "input_text", "text": prompt}]}],
            "text": {"verbosity": "low"},
        }
        temperature = deep_get(self.config, "llm.temperature")
        if temperature is not None:
            body["temperature"] = temperature
        headers = {
            "Authorization": f"Bearer {token}",
            "chatgpt-account-id": account_id,
            "originator": str(require_config(self.config, "llm.originator")),
            "OpenAI-Beta": "responses=experimental",
            "Accept": "text/event-stream",
            "Content-Type": "application/json",
            "User-Agent": "pi-vectorless-indexer",
        }
        resp = self._request_with_retries(method="POST", url=url, headers=headers, json=body, stream=True)
        if not resp.ok:
            raise LLMError(f"Pi OpenAI Codex error {resp.status_code}: {resp.text[:1000]}")
        return self._read_sse_text(resp)

    @staticmethod
    def _read_sse_text(resp: requests.Response) -> str:
        chunks: list[str] = []
        completed_text: str | None = None
        for raw in resp.iter_lines(decode_unicode=True):
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8", errors="replace")
            if not raw or not raw.startswith("data:"):
                continue
            data_s = raw[5:].strip()
            if data_s == "[DONE]":
                break
            try:
                event = json.loads(data_s)
            except json.JSONDecodeError:
                continue
            typ = event.get("type", "")
            if typ in {"response.output_text.delta", "response.output_text.annotation.added"}:
                if event.get("delta"):
                    chunks.append(event["delta"])
            elif typ in {"response.output_text.done", "response.output_text.completed"}:
                if event.get("text"):
                    completed_text = event["text"]
            elif typ in {"response.completed", "response.done", "response.incomplete"}:
                text = extract_text_from_response_obj(event.get("response") or {})
                if text:
                    completed_text = text
            elif typ in {"error", "response.failed"}:
                raise LLMError(f"Codex stream error: {json.dumps(event)[:1000]}")
        return (completed_text or "".join(chunks)).strip()


def extract_text_from_response_obj(response: dict[str, Any]) -> str:
    parts: list[str] = []
    if response.get("output_text"):
        parts.append(response["output_text"])
    for item in response.get("output", []) or []:
        for block in item.get("content", []) or []:
            if isinstance(block, dict):
                if block.get("text"):
                    parts.append(block["text"])
                elif block.get("type") == "output_text" and block.get("content"):
                    parts.append(block["content"])
    return "\n".join(parts).strip()


# ------------------------------ content models ------------------------------


@dataclass
class ContentUnit:
    unit_id: str
    text: str
    type: str
    page: int | None = None
    line_start: int | None = None
    line_end: int | None = None
    heading: str | None = None

    def to_json(self) -> dict[str, Any]:
        obj: dict[str, Any] = {"unit_id": self.unit_id, "type": self.type}
        if self.page is not None:
            obj["page"] = self.page
        if self.line_start is not None:
            obj["line_start"] = self.line_start
        if self.line_end is not None:
            obj["line_end"] = self.line_end
        if self.heading:
            obj["heading"] = self.heading
        obj["text"] = self.text
        return obj


# ----------------------------- PDF extraction -------------------------------


def extract_pdf(path: Path, config: dict[str, Any]) -> tuple[list[ContentUnit], str, list[tuple[int, str, int]]]:
    try:
        import fitz  # PyMuPDF
    except ImportError as exc:
        raise RuntimeError("PyMuPDF is required for PDF indexing. Run: pip install -r requirements.txt") from exc

    doc = fitz.open(str(path))
    units: list[ContentUnit] = []
    include_empty = bool(deep_get(config, "content.include_empty_pages", False))
    for i, page in enumerate(doc, start=1):
        text = normalize_text(page.get_text("text") or "", config)
        if text or include_empty:
            units.append(ContentUnit(unit_id=f"p{i:06d}", type="page", page=i, text=text))
    metadata_title = (doc.metadata or {}).get("title") or ""
    title = derive_document_title(path, "pdf", units, config, metadata_title=metadata_title)
    outline_raw = doc.get_toc(simple=True) or []
    outline = [(int(level), str(t).strip(), int(page)) for level, t, page in outline_raw if str(t).strip()]
    doc.close()
    return units, title.strip() or path.stem, outline


def first_nonempty_line(text: str) -> str | None:
    for line in text.splitlines():
        line = line.strip()
        if line:
            return line[:200]
    return None


def _title_ignore_re(config: dict[str, Any]) -> re.Pattern[str]:
    pattern = str(deep_get(config, "title.ignore_lines_regex", r"^(note|edition|©|copyright|before using|merative and)"))
    return re.compile(pattern, flags=re.I)


def title_candidate_from_text(text: str, config: dict[str, Any]) -> str:
    ignore = _title_ignore_re(config)
    max_lines = int(deep_get(config, "title.cover_max_lines", 4))
    lines: list[str] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or ignore.search(line):
            continue
        if len(line) > 180:
            continue
        lines.append(line)
        if len(lines) >= max_lines:
            break
    return " ".join(lines).strip()


def choose_better_title(metadata_title: str, cover_title: str, fallback: str) -> str:
    metadata_title = " ".join((metadata_title or "").split()).strip()
    cover_title = " ".join((cover_title or "").split()).strip()
    fallback = fallback.strip()
    if cover_title and metadata_title:
        if cover_title.lower().startswith(metadata_title.lower()) and len(cover_title) > len(metadata_title):
            return cover_title
        if len(metadata_title) < 20 and len(cover_title) > len(metadata_title):
            return cover_title
        if re.search(r"\b(guide|manual|reference|handbook|specification)\b", cover_title, flags=re.I):
            return cover_title
    return cover_title or metadata_title or fallback


def derive_document_title(path: Path, source_type: str, units: list[ContentUnit], config: dict[str, Any], metadata_title: str = "") -> str:
    if source_type == "markdown":
        for unit in units:
            if unit.heading:
                return unit.heading
    cover_pages = int(deep_get(config, "title.cover_pages_to_scan", 3))
    candidates: list[str] = []
    for unit in units[:cover_pages]:
        candidate = title_candidate_from_text(unit.text, config)
        if candidate:
            candidates.append(candidate)
    cover_title = candidates[0] if candidates else ""
    return choose_better_title(metadata_title, cover_title, path.stem)


def derive_title_from_content_file(content_path: Path, source_type: str, config: dict[str, Any], metadata_title: str = "") -> str | None:
    if not content_path.exists():
        return None
    units: list[ContentUnit] = []
    cover_pages = int(deep_get(config, "title.cover_pages_to_scan", 3))
    try:
        with content_path.open("r", encoding="utf-8") as f:
            for i, line in enumerate(f):
                if i >= cover_pages:
                    break
                rec = json.loads(line)
                units.append(ContentUnit(unit_id=rec.get("unit_id", ""), type=rec.get("type", source_type), page=rec.get("page"), line_start=rec.get("line_start"), line_end=rec.get("line_end"), heading=rec.get("heading"), text=rec.get("text", "")))
    except Exception:
        return None
    return derive_document_title(content_path, source_type, units, config, metadata_title=metadata_title) if units else None


# ---------------------------- Markdown parsing ------------------------------


def extract_markdown(path: Path, config: dict[str, Any]) -> tuple[list[ContentUnit], str, list[dict[str, Any]]]:
    text = normalize_text(path.read_text(encoding="utf-8"), config)
    lines = text.splitlines()
    headings: list[tuple[int, str, int]] = []
    for i, line in enumerate(lines, start=1):
        m = re.match(r"^(#{1,6})\s+(.+?)\s*$", line)
        if m:
            headings.append((len(m.group(1)), m.group(2).strip(), i))
    title = headings[0][1] if headings else path.stem
    if not headings:
        return [ContentUnit(unit_id="m000001", type="markdown_section", line_start=1, line_end=len(lines), heading=title, text=text)], title, []

    units: list[ContentUnit] = []
    for idx, (_level, heading, start) in enumerate(headings):
        end = headings[idx + 1][2] - 1 if idx + 1 < len(headings) else len(lines)
        section_text = "\n".join(lines[start - 1 : end]).strip()
        units.append(
            ContentUnit(
                unit_id=f"m{idx + 1:06d}",
                type="markdown_section",
                line_start=start,
                line_end=end,
                heading=heading,
                text=section_text,
            )
        )
    flat_nodes = [
        {"title": h, "level": lvl, "line_start": start, "unit_index": i + 1}
        for i, (lvl, h, start) in enumerate(headings)
    ]
    return units, title, flat_nodes


# ----------------------------- tree generation ------------------------------


def outline_to_tree(outline: list[tuple[int, str, int]], page_count: int) -> list[dict[str, Any]]:
    if not outline:
        return []
    items: list[dict[str, Any]] = []
    for i, (level, title, start_page) in enumerate(outline):
        start_page = min(max(1, start_page), page_count)
        end_page = page_count
        for next_level, _next_title, next_page in outline[i + 1 :]:
            if next_level <= level:
                end_page = max(start_page, min(page_count, next_page - 1))
                break
        items.append({"title": title, "level": level, "start_page": start_page, "end_page": end_page, "children": []})
    return nest_flat_nodes(items)


def nest_flat_nodes(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    roots: list[dict[str, Any]] = []
    stack: list[dict[str, Any]] = []
    min_level = min((int(x.get("level", 1)) for x in items), default=1)
    for item in items:
        node = copy.deepcopy(item)
        node["level"] = int(node.get("level", min_level)) - min_level + 1
        node.setdefault("children", [])
        while stack and int(stack[-1]["level"]) >= int(node["level"]):
            stack.pop()
        if stack:
            stack[-1].setdefault("children", []).append(node)
        else:
            roots.append(node)
        stack.append(node)
    return roots


def llm_pdf_structure(units: list[ContentUnit], title: str, llm: LLMClient, config: dict[str, Any]) -> list[dict[str, Any]]:
    preview_chars = int(require_config(config, "indexing.structure_preview_chars_per_page"))
    max_pages = int(require_config(config, "indexing.max_structure_pages_per_call"))
    max_nodes = int(require_config(config, "indexing.max_structure_nodes"))
    selected = units[:max_pages]
    page_map = []
    for u in selected:
        page_map.append(f"<page {u.page}>\n{compact_for_prompt(u.text, preview_chars)}")
    omitted = "" if len(units) <= max_pages else f"\n\nNOTE: Only first {max_pages} pages are shown from {len(units)} total pages."
    system = "You create high-quality hierarchical document navigation indexes. Return valid JSON only."
    prompt = f"""
Document title: {title}
Total pages: {len(units)}{omitted}

Create a hierarchical table-of-contents style index from the page text previews below.
Return a JSON array of nodes. Each node must have:
- title: string
- level: integer, 1 for top-level sections
- start_page: integer
- end_page: integer

Rules:
- Use natural document sections, not arbitrary chunks.
- Include only meaningful sections/subsections useful for agent navigation.
- Use at most {max_nodes} nodes total.
- Page numbers must be 1-indexed and within 1..{len(units)}.
- Ranges must be non-empty.
- Do not add summaries; summaries are generated later.
- Return JSON only, no markdown.

Page previews:
{chr(10).join(page_map)}
""".strip()
    old_note = getattr(THREAD_CONTEXT, "llm_note", None)
    THREAD_CONTEXT.llm_note = "inferring document structure"
    try:
        raw = llm.complete(system, prompt)
    finally:
        if old_note is None:
            try:
                del THREAD_CONTEXT.llm_note
            except AttributeError:
                pass
        else:
            THREAD_CONTEXT.llm_note = old_note
    data = extract_json_from_text(raw)
    if isinstance(data, dict):
        data = data.get("nodes") or data.get("tree") or []
    flat: list[dict[str, Any]] = []
    for x in data:
        try:
            start = int(x["start_page"])
            end = int(x.get("end_page", start))
            level = int(x.get("level", 1))
            if start < 1 or start > len(units):
                continue
            end = min(max(end, start), len(units))
            title_x = str(x.get("title", "")).strip()
            if not title_x:
                continue
            flat.append({"title": title_x, "level": max(1, level), "start_page": start, "end_page": end, "children": []})
        except Exception:
            continue
    if not flat:
        return []
    flat.sort(key=lambda n: (n["start_page"], n["level"], n["end_page"]))
    return nest_flat_nodes(flat)


def markdown_nodes_to_tree(flat_nodes: list[dict[str, Any]], units: list[ContentUnit]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    line_count = max((u.line_end or 1 for u in units), default=1)
    for i, item in enumerate(flat_nodes):
        level = int(item["level"])
        start_line = int(item["line_start"])
        end_line = line_count
        for nxt in flat_nodes[i + 1 :]:
            if int(nxt["level"]) <= level:
                end_line = int(nxt["line_start"]) - 1
                break
        start_unit = int(item["unit_index"])
        end_unit = len(units)
        for nxt in flat_nodes[i + 1 :]:
            if int(nxt["level"]) <= level:
                end_unit = int(nxt["unit_index"]) - 1
                break
        items.append(
            {
                "title": item["title"],
                "level": level,
                "line_start": start_line,
                "line_end": max(start_line, end_line),
                "start_unit_idx": start_unit,
                "end_unit_idx": max(start_unit, end_unit),
                "children": [],
            }
        )
    return nest_flat_nodes(items)


def fallback_pdf_tree(page_count: int, config: dict[str, Any]) -> list[dict[str, Any]]:
    max_pages = int(require_config(config, "indexing.max_pages_per_leaf"))
    nodes = []
    for start in range(1, page_count + 1, max_pages):
        end = min(page_count, start + max_pages - 1)
        nodes.append({"title": f"Pages {start}-{end}", "level": 1, "start_page": start, "end_page": end, "children": []})
    return nodes


def split_large_pdf_leaves(nodes: list[dict[str, Any]], config: dict[str, Any]) -> None:
    if not deep_get(config, "indexing.split_large_leaves", True):
        return
    max_pages = int(require_config(config, "indexing.max_pages_per_leaf"))
    for node in nodes:
        split_large_pdf_leaves(node.get("children", []), config)
        if node.get("children"):
            continue
        start = int(node.get("start_page", 1))
        end = int(node.get("end_page", start))
        if end - start + 1 <= max_pages:
            continue
        children = []
        for s in range(start, end + 1, max_pages):
            e = min(end, s + max_pages - 1)
            children.append({"title": f"{node['title']} — pages {s}-{e}", "level": int(node.get("level", 1)) + 1, "start_page": s, "end_page": e, "children": []})
        node["children"] = children


def assign_ids_levels_ranges(node: dict[str, Any], *, source_type: str, units: list[ContentUnit], counter: list[int], level: int) -> None:
    node["node_id"] = f"n{counter[0]:06d}"
    counter[0] += 1
    node["level"] = level
    if source_type == "pdf":
        if "range" not in node:
            start_page = int(node.get("start_page", 1))
            end_page = int(node.get("end_page", start_page))
            start_page = min(max(1, start_page), len(units))
            end_page = min(max(start_page, end_page), len(units))
            node["range"] = {
                "start_unit_id": f"p{start_page:06d}",
                "end_unit_id": f"p{end_page:06d}",
                "start_page": start_page,
                "end_page": end_page,
            }
        node.pop("start_page", None)
        node.pop("end_page", None)
    else:
        if "range" not in node:
            start_idx = int(node.get("start_unit_idx", 1))
            end_idx = int(node.get("end_unit_idx", start_idx))
            start_idx = min(max(1, start_idx), len(units))
            end_idx = min(max(start_idx, end_idx), len(units))
            start_unit = units[start_idx - 1]
            end_unit = units[end_idx - 1]
            node["range"] = {
                "start_unit_id": start_unit.unit_id,
                "end_unit_id": end_unit.unit_id,
                "line_start": start_unit.line_start,
                "line_end": end_unit.line_end,
            }
        for k in ["line_start", "line_end", "start_unit_idx", "end_unit_idx"]:
            node.pop(k, None)
    node.setdefault("summary", "")
    node.setdefault("children", [])
    for child in node["children"]:
        assign_ids_levels_ranges(child, source_type=source_type, units=units, counter=counter, level=level + 1)


# ------------------------------- summaries ----------------------------------


def unit_text_for_range(units: list[ContentUnit], range_obj: dict[str, Any]) -> str:
    start_id = range_obj["start_unit_id"]
    end_id = range_obj["end_unit_id"]
    ids = [u.unit_id for u in units]
    try:
        s = ids.index(start_id)
        e = ids.index(end_id)
    except ValueError:
        return ""
    parts = []
    for u in units[s : e + 1]:
        label = f"[page {u.page}]" if u.page is not None else f"[lines {u.line_start}-{u.line_end}]"
        parts.append(f"{label}\n{u.text}")
    return "\n\n".join(parts)


def collect_nodes_postorder(node: dict[str, Any]) -> list[dict[str, Any]]:
    nodes: list[dict[str, Any]] = []
    for child in node.get("children", []):
        nodes.extend(collect_nodes_postorder(child))
    nodes.append(node)
    return nodes


def summarize_tree(root: dict[str, Any], units: list[ContentUnit], llm: LLMClient, config: dict[str, Any], *, desc: str, path: Path | None = None) -> None:
    if not deep_get(config, "indexing.generate_summaries", True):
        return
    nodes = collect_nodes_postorder(root)
    if PROGRESS is not None and path is not None:
        update_every = max(1, int(deep_get(config, "progress.summary_update_every", 1)))
        total = len(nodes)
        for i, node in enumerate(nodes, start=1):
            if i == 1 or i % update_every == 0 or i == total:
                status(config, path, f"summarizing nodes {i}/{total}: {node.get('title', '')[:80]}")
            summarize_one_node(node, units, llm, config, is_root=(node is root))
        return
    for node in progress_iter(nodes, config, total=len(nodes), desc=desc, unit="node"):
        summarize_one_node(node, units, llm, config, is_root=(node is root))


def summarize_one_node(node: dict[str, Any], units: list[ContentUnit], llm: LLMClient, config: dict[str, Any], is_root: bool = False) -> None:
    max_words = int(require_config(config, "indexing.root_summary_max_words" if is_root else "indexing.summary_max_words"))
    summary_input_chars = int(require_config(config, "indexing.summary_input_chars"))
    child_context_chars = int(require_config(config, "indexing.child_context_chars"))
    text = compact_for_prompt(unit_text_for_range(units, node["range"]), summary_input_chars)
    child_context = ""
    if node.get("children"):
        child_lines = [f"- {c['title']}: {c.get('summary', '')}" for c in node["children"]]
        child_context = compact_for_prompt("\n".join(child_lines), child_context_chars)
    system = "You summarize document sections for a vectorless RAG navigation index. Be precise, grounded, and concise."
    prompt = f"""
Section title: {node['title']}
Range: {json.dumps(node['range'], ensure_ascii=False)}

Child section summaries, if any:
{child_context or '(none)'}

Source text excerpt:
{text}

Write a concise summary of this section in at most {max_words} words.
Mention key topics and facts useful for deciding whether to open this node.
Return plain text only, no bullets unless essential.
""".strip()
    old_note = getattr(THREAD_CONTEXT, "llm_note", None)
    THREAD_CONTEXT.llm_note = f"summarizing node {node.get('node_id', '')} {node.get('title', '')[:80]}"
    try:
        node["summary"] = llm.complete(system, prompt).strip()
    except Exception as exc:
        if deep_get(config, "llm.required", True):
            raise
        node["summary"] = extractive_summary(text, max_words) + f" [LLM summary failed: {exc}]"
    finally:
        if old_note is None:
            try:
                del THREAD_CONTEXT.llm_note
            except AttributeError:
                pass
        else:
            THREAD_CONTEXT.llm_note = old_note


def extractive_summary(text: str, max_words: int) -> str:
    words = re.findall(r"\S+", text)
    return " ".join(words[:max_words])


# -------------------------------- indexing ----------------------------------


def build_pdf_index(path: Path, config: dict[str, Any], llm: LLMClient) -> tuple[list[ContentUnit], str, dict[str, Any]]:
    status(config, path, "extracting PDF text")
    units, title, outline = extract_pdf(path, config)
    if not units:
        raise RuntimeError("No text pages extracted from PDF")
    status(config, path, f"extracted {len(units)} page units; PDF outline entries: {len(outline)}; title: {title!r}")
    tree_nodes: list[dict[str, Any]] = []
    if deep_get(config, "pdf.use_native_outline", True) and len(outline) >= int(require_config(config, "pdf.min_outline_items")):
        status(config, path, "building tree from native PDF outline")
        tree_nodes = outline_to_tree(outline, len(units))
    if not tree_nodes and deep_get(config, "indexing.prefer_llm_structure_when_no_outline", True):
        try:
            status(config, path, "no usable outline; asking LLM to infer document structure")
            tree_nodes = llm_pdf_structure(units, title, llm, config)
            status(config, path, f"LLM structure generated {sum(1 for _ in flatten_tree(tree_nodes))} nodes before splitting")
        except Exception as exc:
            if deep_get(config, "llm.required", True):
                print(f"Warning: LLM structure generation failed; using page-window fallback: {exc}", file=sys.stderr, flush=True)
            tree_nodes = []
    if not tree_nodes:
        status(config, path, "using page-window fallback tree")
        tree_nodes = fallback_pdf_tree(len(units), config)
    split_large_pdf_leaves(tree_nodes, config)
    root = {
        "title": title,
        "level": 0,
        "range": {"start_unit_id": units[0].unit_id, "end_unit_id": units[-1].unit_id, "start_page": 1, "end_page": len(units)},
        "summary": "",
        "children": tree_nodes,
    }
    counter = [0]
    assign_ids_levels_ranges(root, source_type="pdf", units=units, counter=counter, level=0)
    status(config, path, f"tree has {count_nodes(root)} nodes; generating summaries")
    summarize_tree(root, units, llm, config, desc=f"Summarizing {path.name}", path=path)
    status(config, path, "summaries complete")
    return units, title, root


def build_markdown_index(path: Path, config: dict[str, Any], llm: LLMClient) -> tuple[list[ContentUnit], str, dict[str, Any]]:
    status(config, path, "extracting Markdown sections")
    units, title, flat_nodes = extract_markdown(path, config)
    status(config, path, f"extracted {len(units)} section units and {len(flat_nodes)} headings; title: {title!r}")
    if flat_nodes:
        status(config, path, "building tree from Markdown headings")
        tree_nodes = markdown_nodes_to_tree(flat_nodes, units)
    else:
        tree_nodes = []
    root_range = {
        "start_unit_id": units[0].unit_id,
        "end_unit_id": units[-1].unit_id,
        "line_start": units[0].line_start,
        "line_end": units[-1].line_end,
    }
    root = {"title": title, "level": 0, "range": root_range, "summary": "", "children": tree_nodes}
    counter = [0]
    assign_ids_levels_ranges(root, source_type="markdown", units=units, counter=counter, level=0)
    status(config, path, f"tree has {count_nodes(root)} nodes; generating summaries")
    summarize_tree(root, units, llm, config, desc=f"Summarizing {path.name}", path=path)
    status(config, path, "summaries complete")
    return units, title, root


def write_outputs(path: Path, config: dict[str, Any], units: list[ContentUnit], title: str, root: dict[str, Any]) -> Path:
    output_dir = Path(os.path.expanduser(str(require_config(config, "output_dir"))))
    max_slug = int(require_config(config, "output.slug_max_length"))
    doc_hash = sha256_file(path)
    slug = slugify(path.stem, max_slug)
    doc_dir = output_dir / slug
    status(config, path, f"writing outputs to {doc_dir}")
    if doc_dir.exists() and deep_get(config, "output.overwrite", True):
        shutil.rmtree(doc_dir)
    doc_dir.mkdir(parents=True, exist_ok=True)

    content_file = doc_dir / "content.jsonl"
    with content_file.open("w", encoding="utf-8") as f:
        for unit in units:
            f.write(json.dumps(unit.to_json(), ensure_ascii=False) + "\n")

    source_type = "pdf" if path.suffix.lower() == ".pdf" else "markdown"
    document: dict[str, Any] = {
        "doc_id": doc_hash[:16],
        "title": title,
        "source_path": str(path.resolve()),
        "source_type": source_type,
        "sha256": doc_hash,
        "content_file": "content.jsonl",
        "created_at": now_iso(),
    }
    if source_type == "pdf":
        document["page_count"] = len(units)
        document["content_unit_type"] = "page"
    else:
        document["content_unit_type"] = "markdown_section"
        document["unit_count"] = len(units)
        document["line_count"] = units[-1].line_end

    index = {
        "schema_version": require_config(config, "schema_version"),
        "document": document,
        "root": root,
    }
    index_file = doc_dir / "index.json"
    write_json_atomic(index_file, index, pretty=bool(deep_get(config, "output.pretty_index_json", True)))

    if deep_get(config, "output.write_metadata", True):
        meta = {
            "document": document,
            "stats": {
                "content_units": len(units),
                "tree_nodes": count_nodes(root),
            },
            "files": {"index": "index.json", "content": "content.jsonl"},
        }
        write_json_atomic(doc_dir / "metadata.json", meta, pretty=True)
    if deep_get(config, "output.write_config_snapshot", True):
        (doc_dir / "config.snapshot.yaml").write_text(yaml.safe_dump(config, sort_keys=False, allow_unicode=True), encoding="utf-8")
    return doc_dir


def count_nodes(node: dict[str, Any]) -> int:
    return 1 + sum(count_nodes(c) for c in node.get("children", []))


def flatten_tree(nodes: list[dict[str, Any]]) -> Iterable[dict[str, Any]]:
    for node in nodes:
        yield node
        yield from flatten_tree(node.get("children", []))


def load_config(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    if not isinstance(data, dict):
        raise ValueError(f"Config must be a YAML mapping: {path}")
    return data


def supported_extensions(config: dict[str, Any]) -> set[str]:
    configured = deep_get(config, "input.extensions", [".pdf", ".md", ".markdown"])
    return {str(ext).lower() if str(ext).startswith(".") else f".{str(ext).lower()}" for ext in configured}


def discover_input_files(config: dict[str, Any], input_arg: str | None) -> list[Path]:
    exts = supported_extensions(config)
    if input_arg:
        path = Path(input_arg).expanduser()
        if not path.exists():
            raise FileNotFoundError(path)
        if path.is_file():
            if path.suffix.lower() not in exts:
                raise ValueError(f"Unsupported input type: {path}")
            log(config, f"Input file: {path}")
            return [path]
        recursive = bool(deep_get(config, "input.recursive", False))
        pattern = "**/*" if recursive else "*"
        files = [p for p in path.glob(pattern) if p.is_file() and p.suffix.lower() in exts]
        log(config, f"Input folder: {path} ({'recursive' if recursive else 'non-recursive'})")
        return sorted(files)

    inbox = Path(os.path.expanduser(str(require_config(config, "input.inbox_dir"))))
    inbox.mkdir(parents=True, exist_ok=True)
    recursive = bool(deep_get(config, "input.recursive", False))
    pattern = "**/*" if recursive else "*"
    files = [p for p in inbox.glob(pattern) if p.is_file() and p.suffix.lower() in exts]
    log(config, f"No input specified. Scanning inbox: {inbox} ({'recursive' if recursive else 'non-recursive'})")
    return sorted(files)


def archive_source_file(path: Path, config: dict[str, Any]) -> Path | None:
    if not deep_get(config, "input.archive_after_index", True):
        return None
    archive_exts = {
        str(ext).lower() if str(ext).startswith(".") else f".{str(ext).lower()}"
        for ext in deep_get(config, "input.archive_extensions", [".pdf"])
    }
    if path.suffix.lower() not in archive_exts:
        return None
    archive_dir = Path(os.path.expanduser(str(require_config(config, "input.archive_dir"))))
    archive_dir.mkdir(parents=True, exist_ok=True)
    dest = unique_destination(archive_dir / path.name)
    status(config, path, f"moving indexed source to archive: {dest}")
    shutil.move(str(path), str(dest))
    return dest


def update_archived_path(doc_dir: Path, archived_path: Path | None) -> None:
    if archived_path is None:
        return
    for name in ["index.json", "metadata.json"]:
        p = doc_dir / name
        if not p.exists():
            continue
        data = json.loads(p.read_text(encoding="utf-8"))
        document = data.get("document") if name == "index.json" else data.get("document")
        if isinstance(document, dict):
            document["archived_path"] = str(archived_path.resolve())
        write_json_atomic(p, data, pretty=True)


def index_one_file(input_path: Path, config: dict[str, Any], llm: LLMClient) -> Path:
    size_mb = input_path.stat().st_size / (1024 * 1024)
    status(config, input_path, f"starting ({size_mb:.1f} MB)")
    suffix = input_path.suffix.lower()
    if suffix == ".pdf":
        units, title, root = build_pdf_index(input_path, config, llm)
    elif suffix in {".md", ".markdown"}:
        units, title, root = build_markdown_index(input_path, config, llm)
    else:
        raise ValueError("Only PDF and Markdown inputs are supported")
    doc_dir = write_outputs(input_path, config, units, title, root)
    archived_path = archive_source_file(input_path, config)
    update_archived_path(doc_dir, archived_path)
    return doc_dir


def write_master_index(config: dict[str, Any], *, announce: bool = True) -> Path:
    output_dir = Path(os.path.expanduser(str(require_config(config, "output_dir"))))
    if announce:
        log(config, f"Writing master corpus index from documents under {output_dir}...")
    output_dir.mkdir(parents=True, exist_ok=True)
    master_name = str(require_config(config, "output.master_index_file"))
    master_path = output_dir / master_name
    docs: list[dict[str, Any]] = []
    for index_path in sorted(output_dir.glob("*/index.json")):
        try:
            idx = json.loads(index_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        document = idx.get("document") or {}
        root = idx.get("root") or {}
        rel_doc_dir = index_path.parent.relative_to(output_dir).as_posix()
        content_rel = f"{rel_doc_dir}/{document.get('content_file', 'content.jsonl')}"
        repaired_title = derive_title_from_content_file(output_dir / content_rel, document.get("source_type", ""), config, metadata_title=document.get("title") or "")
        if repaired_title and repaired_title != document.get("title"):
            document["title"] = repaired_title
            idx["document"] = document
            try:
                write_json_atomic(index_path, idx, pretty=True)
                meta_path = index_path.parent / "metadata.json"
                if meta_path.exists():
                    meta = json.loads(meta_path.read_text(encoding="utf-8"))
                    if isinstance(meta.get("document"), dict):
                        meta["document"]["title"] = repaired_title
                        write_json_atomic(meta_path, meta, pretty=True)
            except Exception:
                pass
        entry = {
            "doc_id": document.get("doc_id"),
            "title": repaired_title or document.get("title"),
            "source_type": document.get("source_type"),
            "doc_dir": rel_doc_dir,
            "index_file": f"{rel_doc_dir}/index.json",
            "content_file": content_rel,
            "summary": root.get("summary", ""),
            "source_path": document.get("source_path"),
            "archived_path": document.get("archived_path"),
            "sha256": document.get("sha256"),
        }
        for key in ["page_count", "unit_count", "line_count", "content_unit_type"]:
            if key in document:
                entry[key] = document[key]
        docs.append(entry)
    master = {
        "schema_version": f"{require_config(config, 'schema_version')}/corpus-index",
        "generated_at": now_iso(),
        "output_dir": str(output_dir.resolve()),
        "document_count": len(docs),
        "documents": docs,
    }
    write_json_atomic(master_path, master, pretty=True)
    return master_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build vectorless index.json + content.jsonl for PDF/Markdown documents")
    parser.add_argument("input", nargs="?", help="Optional file or folder. If omitted, index files in configured inbox_dir.")
    parser.add_argument("--config", default="config.yaml", help="Path to YAML config")
    args = parser.parse_args(argv)

    config_path = Path(args.config).expanduser()
    config = load_config(config_path)
    log(config, f"Loaded config: {config_path}")
    log(config, f"Output dir: {require_config(config, 'output_dir')}")
    log(config, f"Supported extensions: {', '.join(sorted(supported_extensions(config)))}")
    files = discover_input_files(config, args.input)
    log(config, f"Discovered {len(files)} file(s) to index.")
    if not files:
        inbox = deep_get(config, "input.inbox_dir", "inbox")
        print(f"No supported files found. Put PDFs/Markdown in {inbox}/ or pass a file path.", flush=True)
        write_master_index(config)
        return 0

    log(config, f"LLM provider: {require_config(config, 'llm.provider')} / model: {require_config(config, 'llm.model')}")
    llm_parallel = max(1, int(deep_get(config, "llm.max_parallel_requests", 1)))
    log(config, f"Parallel LLM requests: {llm_parallel}")

    global PROGRESS, LLM_SEMAPHORE
    LLM_SEMAPHORE = threading.BoundedSemaphore(llm_parallel)
    PROGRESS = ProgressReporter(config, files)
    PROGRESS.start()
    log(config, "File processing mode: sequential")

    doc_dirs: list[Path] = []
    failures: list[tuple[Path, str]] = []
    stop_on_error = bool(deep_get(config, "input.stop_on_error", True))
    local_llm = LLMClient(config)

    for input_path in files:
        THREAD_CONTEXT.path = input_path
        try:
            doc_dir = index_one_file(input_path, config, local_llm)
            status(config, input_path, "updating master index")
            per_file_master_path = write_master_index(config, announce=False)
            doc_dirs.append(doc_dir)
            if PROGRESS:
                PROGRESS.done(input_path, f"indexed -> {doc_dir}; master updated -> {per_file_master_path}")
        except Exception as exc:
            failures.append((input_path, str(exc)))
            if PROGRESS:
                PROGRESS.failed(input_path, str(exc))
            print(f"Failed: {input_path}: {exc}", file=sys.stderr, flush=True)
            if stop_on_error:
                break
        finally:
            try:
                del THREAD_CONTEXT.path
            except AttributeError:
                pass

    master_path = write_master_index(config)
    if PROGRESS:
        PROGRESS.stop()
    print(f"Master index: {master_path}")
    print(f"Indexed documents: {len(doc_dirs)}")
    if failures:
        print(f"Failures: {len(failures)}", file=sys.stderr)
        for path, err in failures:
            print(f"- {path}: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
