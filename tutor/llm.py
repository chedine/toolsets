"""Run one model turn headless, through either Claude Code or Pi.

Model ids carry their backend: "claude:sonnet" runs `claude -p` on the user's Claude subscription
(ANTHROPIC_API_KEY is stripped from the environment, so it can never fall back to paid API billing),
and "pi:openai-codex/gpt-6-luna" runs `pi -p`, which uses Pi's own logins. Neither tool gets any
tools, MCP servers, skills or session history: every call is one stateless prompt -> text.
"""
import json
import os
import shutil
import subprocess
import tempfile
import threading
import time

PAID_ENV = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")


class LLMError(Exception):
    pass


class LLM:
    def __init__(self, cfg):
        self.cfg = cfg
        self._pi_models = None
        self._lock = threading.Lock()

    def bin(self, name):
        return shutil.which(os.path.expanduser(self.cfg[f"{name}_bin"])) or ""

    # ---- model catalogue ---------------------------------------------------

    def models(self):
        """Every selectable model: Claude Code aliases first, then whatever `pi --list-models` offers
        (minus hidden providers; Anthropic is hidden by default so Claude always goes through Claude Code)."""
        out = []
        if self.bin("claude"):
            out += [{"id": f"claude:{m}", "label": f"Claude {m}", "backend": "claude"} for m in self.cfg["claude_models"]]
        hidden = set(self.cfg.get("hide_pi_providers") or [])
        out += [{"id": f"pi:{p}/{m}", "label": f"{m} ({p})", "backend": "pi"}
                for p, m in self.pi_models() if p not in hidden]
        return out

    def pi_models(self):
        with self._lock:
            if self._pi_models is not None:
                return self._pi_models
            self._pi_models = []
            pi = self.bin("pi")
            if pi:
                try:
                    res = subprocess.run([pi, "--list-models"], capture_output=True, text=True, timeout=30)
                    for line in res.stdout.splitlines()[1:]:
                        parts = line.split()
                        if len(parts) >= 2:
                            self._pi_models.append((parts[0], parts[1]))
                except (OSError, subprocess.SubprocessError):
                    pass
            return self._pi_models

    # ---- one turn ----------------------------------------------------------

    def run(self, model, system, prompt, on_delta=None, effort="", timeout=180, alive=lambda: True):
        """Run one prompt and return the full reply text. on_delta(str) receives streamed text."""
        backend, _, name = model.partition(":")
        if backend == "claude":
            exe = self.bin("claude")
            if not exe:
                raise LLMError("claude executable not found (set claude_bin)")
            cmd = [exe, "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
                   "--model", name, "--tools", "", "--strict-mcp-config", "--disable-slash-commands",
                   "--no-session-persistence", "--setting-sources", "", "--system-prompt", system]
            if effort:
                cmd += ["--effort", effort]
            env = {k: v for k, v in os.environ.items() if k not in PAID_ENV}
        elif backend == "pi":
            exe = self.bin("pi")
            if not exe:
                raise LLMError("pi executable not found (set pi_bin)")
            cmd = [exe, "-p", "--mode", "json", "--no-session", "--no-tools", "--no-extensions", "--no-skills",
                   "--no-context-files", "--no-prompt-templates", "--no-themes", "--model", name,
                   "--system-prompt", system]
            if effort:
                cmd += ["--thinking", effort]
            env = dict(os.environ)
        else:
            raise LLMError(f"unknown model id {model!r} (expected claude:… or pi:…)")
        return self._exec(backend, cmd + ["--", prompt], env, on_delta, timeout, alive)

    def _exec(self, backend, cmd, env, on_delta, timeout, alive):
        with tempfile.TemporaryDirectory(prefix="tutor-llm-") as tmp:
            err_file = open(os.path.join(tmp, "stderr.txt"), "w+", encoding="utf-8")
            proc = subprocess.Popen(cmd, cwd=tmp, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                    stderr=err_file, text=True, encoding="utf-8")
            timer = threading.Timer(timeout, proc.kill)
            timer.start()

            def watch():
                while proc.poll() is None:
                    if not alive():
                        proc.kill()
                        return
                    time.sleep(0.5)

            threading.Thread(target=watch, daemon=True).start()
            parts, final, error = [], None, None
            try:
                for line in proc.stdout:
                    try:
                        ev = json.loads(line)
                    except ValueError:
                        continue
                    delta, done, err = (self._claude_event if backend == "claude" else self._pi_event)(ev)
                    if delta:
                        parts.append(delta)
                        if on_delta:
                            on_delta(delta)
                    if done is not None:
                        final = done
                    if err:
                        error = err
                proc.wait()
            except BaseException:
                proc.kill()
                raise
            finally:
                timer.cancel()
                err_file.seek(0)
                stderr = err_file.read()
                err_file.close()
            text = final if final is not None else "".join(parts)
            if not error and proc.returncode and not text:
                tail = stderr.strip().splitlines()[-3:]
                error = " ".join(tail) or f"{backend} exited with {proc.returncode}"
            if error:
                raise LLMError(error)
            if not alive():
                raise LLMError("cancelled")
            return text

    @staticmethod
    def _claude_event(ev):
        t = ev.get("type")
        if t == "stream_event":
            e = ev.get("event") or {}
            d = e.get("delta") or {}
            if e.get("type") == "content_block_delta" and d.get("type") == "text_delta":
                return d.get("text", ""), None, None
        elif t == "result":
            if ev.get("is_error"):
                return None, None, ev.get("result") or ev.get("subtype") or "claude error"
            return None, ev.get("result") or "", None
        return None, None, None

    @staticmethod
    def _pi_event(ev):
        ae = ev.get("assistantMessageEvent") or {}
        if ev.get("type") == "message_update" and ae.get("type") == "text_delta":
            return ae.get("delta", ""), None, None
        if ev.get("type") == "message_end":
            msg = ev.get("message") or {}
            if msg.get("role") == "assistant" and (msg.get("stopReason") == "error" or msg.get("errorMessage")):
                return None, None, msg.get("errorMessage") or "model error"
        return None, None, None


def extract_json(text):
    """The first JSON object in a reply, tolerating ```json fences and chatter around it."""
    s = text.strip()
    start = s.find("{")
    if start < 0:
        raise ValueError("no JSON object in reply")
    depth, in_str, esc = 0, False, False
    for i in range(start, len(s)):
        c = s[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return json.loads(s[start:i + 1])
    raise ValueError("unterminated JSON object in reply")
