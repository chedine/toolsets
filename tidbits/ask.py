"""Answer questions over the vault by running the Pi agent headless.

Pi owns the model credentials (~/.pi/agent/auth.json, refreshed by Pi itself), so tidbits never
touches tokens: each question is one `pi -p --mode json` run with every tool, extension and
context file disabled, and the selected notes passed as an appended system prompt file.
"""
import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
from datetime import datetime

SYSTEM = """You answer questions using ONLY the user's personal notes, given below as <note> elements.
Entities in the notes are wrapped in [[double brackets]]; tags start with #.

Rules:
- Be brief: 1-4 plain sentences, or a short "- " bullet list when listing several facts.
- Wrap entity names you mention in [[ ]] exactly as they appear in the notes.
- Cite the notes you used right after the claim, like [n3] or [n3][n7]. Never invent refs.
- If the notes do not answer the question, say so in one sentence. Do not use outside knowledge,
  except to say briefly how the notes relate to the question.
- No headings, no preamble."""


class Asker:
    def __init__(self, model, thinking, pi_bin="pi", budget=300_000, timeout=180):
        self.model, self.thinking, self.budget, self.timeout = model, thinking, budget, timeout
        self.pi = shutil.which(os.path.expanduser(pi_bin)) or ""

    def info(self):
        return {"model": self.model, "thinking": self.thinking, "available": bool(self.pi)}

    def context(self, notes, ranked_ids):
        """Notes in relevance order (client ranking first, then newest), trimmed to the char budget."""
        by_id = {n["id"]: n for n in notes}
        order = [by_id[i] for i in ranked_ids if i in by_id]
        seen = {n["id"] for n in order}
        order += [n for n in notes if n["id"] not in seen]
        refs, chunks, used = {}, [], 0
        for n in order:
            ref = f"n{len(refs) + 1}"
            day = datetime.fromtimestamp(n["created"] / 1000).strftime("%Y-%m-%d")
            chunk = f'<note ref="{ref}" date="{day}">\n{n["text"]}\n</note>\n'
            if used + len(chunk) > self.budget and refs:
                break
            refs[ref] = n["id"]
            chunks.append(chunk)
            used += len(chunk)
        return refs, "".join(chunks)

    def stream(self, question, notes, ranked_ids, emit, alive=lambda: True):
        """Run one question; emit(dict) is called for meta/delta/done/error events.
        alive() is polled so a cancelled request stops pi even while the model is still thinking."""
        if not self.pi:
            return emit({"type": "error", "message": "pi executable not found (set TIDBITS_PI_BIN)"})
        refs, ctx = self.context(notes, ranked_ids)
        emit({"type": "meta", "model": self.model, "thinking": self.thinking, "refs": refs, "total": len(notes)})
        with tempfile.TemporaryDirectory(prefix="tidbits-ask-") as tmp:
            ctx_file = os.path.join(tmp, "notes.md")
            with open(ctx_file, "w", encoding="utf-8") as f:
                f.write(f"Today is {datetime.now():%Y-%m-%d}. The user has {len(notes)} notes; "
                        f"the {len(refs)} most relevant follow.\n\n{ctx}")
            cmd = [self.pi, "-p", "--mode", "json", "--no-session", "--no-tools", "--no-extensions", "--no-skills",
                   "--no-context-files", "--no-prompt-templates", "--no-themes",
                   "--model", self.model, "--thinking", self.thinking,
                   "--system-prompt", SYSTEM, "--append-system-prompt", ctx_file, "--", question]
            err_file = open(os.path.join(tmp, "stderr.txt"), "w+", encoding="utf-8")
            proc = subprocess.Popen(cmd, cwd=tmp, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                    stderr=err_file, text=True, encoding="utf-8")
            timer = threading.Timer(self.timeout, proc.kill)
            timer.start()

            def watch():
                while proc.poll() is None:
                    if not alive():
                        proc.kill()
                        return
                    time.sleep(0.5)

            threading.Thread(target=watch, daemon=True).start()
            got_text, error = False, None
            try:
                for line in proc.stdout:
                    try:
                        ev = json.loads(line)
                    except ValueError:
                        continue
                    ae = ev.get("assistantMessageEvent") or {}
                    if ev.get("type") == "message_update" and ae.get("type") == "text_delta":
                        got_text = True
                        emit({"type": "delta", "text": ae.get("delta", "")})
                    elif ev.get("type") == "message_end":
                        msg = ev.get("message") or {}
                        if msg.get("role") == "assistant" and (msg.get("stopReason") == "error" or msg.get("errorMessage")):
                            error = msg.get("errorMessage") or "model error"
                proc.wait()
            except BaseException:  # client went away: stop the model run
                proc.kill()
                raise
            finally:
                timer.cancel()
                err_file.seek(0)
                stderr = err_file.read()
                err_file.close()
            if not error and proc.returncode and not got_text:
                tail = stderr.strip().splitlines()[-3:]
                error = " ".join(tail) or f"pi exited with {proc.returncode}"
            emit({"type": "error", "message": error} if error else {"type": "done"})
