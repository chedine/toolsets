#!/usr/bin/env python3
"""Margin tutor: AI-built courses with lessons, practice questions and a tutor at your elbow.

    python3 server.py                     # port 8585 on every interface (LAN too), notebooks in ~/Tutor
    python3 server.py --host 127.0.0.1    # this machine only
"""
import argparse
import json
import mimetypes
import os
import re
import select
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

from config import Config
from engine import BadRequest, Engine
from llm import LLM, LLMError
from store import NotFound, Store

STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
TASKS = ("outline", "chapter", "grade", "tutor")

ROUTES = []


def route(method, pattern):
    def deco(fn):
        ROUTES.append((method, re.compile(f"^{pattern}$"), fn))
        return fn
    return deco


class Handler(BaseHTTPRequestHandler):
    cfg: Config = None
    store: Store = None
    llm: LLM = None
    engine: Engine = None

    def log_message(self, fmt, *args):
        if self.command != "GET" or not self.path.startswith("/api/"):
            super().log_message(fmt, *args)

    # ---- helpers -----------------------------------------------------------

    def send_json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def alive(self):
        """False once the browser has gone away (lets a cancelled request stop the model run)."""
        try:
            r, _, _ = select.select([self.connection], [], [], 0)
            return not (r and self.connection.recv(1, socket.MSG_PEEK) == b"")
        except OSError:
            return False

    def stream(self, work):
        """Server-sent events: work(emit) runs while events flow; its return value is the final 'done' event."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True

        def emit(ev):
            self.wfile.write(f"data: {json.dumps(ev, ensure_ascii=False)}\n\n".encode())
            self.wfile.flush()

        try:
            emit({"type": "done", "data": work(emit)})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except (LLMError, BadRequest, NotFound, ValueError) as e:
            try:
                emit({"type": "error", "message": str(e) or e.__class__.__name__})
            except OSError:
                pass

    def dispatch(self, method):
        url = urlparse(self.path)
        path = unquote(url.path)
        if not path.startswith("/api/"):
            return self.static(path) if method == "GET" else self.send_error(405)
        for m, rx, fn in ROUTES:
            match = rx.match(path)
            if m == method and match:
                try:
                    return fn(self, *match.groups(), query=parse_qs(url.query))
                except NotFound as e:
                    return self.send_json({"error": f"not found: {e}"}, 404)
                except (BadRequest, ValueError, KeyError) as e:
                    return self.send_json({"error": str(e)}, 400)
                except LLMError as e:
                    return self.send_json({"error": str(e)}, 502)
        self.send_json({"error": "no such endpoint"}, 404)

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_DELETE(self):
        self.dispatch("DELETE")

    def static(self, path):
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        full = os.path.realpath(os.path.join(STATIC, rel))
        if not full.startswith(os.path.realpath(STATIC) + os.sep) or not os.path.isfile(full):
            full = os.path.join(STATIC, "index.html")  # client-side routes
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(full)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)


# ---- settings ---------------------------------------------------------------

@route("GET", "/api/config")
def get_config(h, query):
    c = h.cfg
    h.send_json({"tasks": c["tasks"], "course": c["course"], "fun": c["fun"], "suggestions": c["suggestions"],
                 "models": h.llm.models(), "data": c.data})


@route("PUT", "/api/settings")
def put_settings(h, query):
    data = h.body()
    over = {}
    for task, t in (data.get("tasks") or {}).items():
        if task in TASKS:
            over.setdefault("tasks", {})[task] = {k: t[k] for k in ("model", "effort", "timeout") if k in t}
    for key in ("course", "fun", "suggestions"):
        if key in data:
            over[key] = data[key]
    h.cfg.update(over)
    get_config(h, query)


@route("GET", "/api/prompts")
def get_prompts(h, query):
    h.send_json(h.cfg.prompts())


@route("PUT", "/api/prompts/([a-z_]+)")
def put_prompt(h, name, query):
    h.cfg.set_prompt(name, str(h.body().get("text") or ""))
    h.send_json(h.cfg.prompts())


@route("DELETE", "/api/prompts/([a-z_]+)")
def reset_prompt(h, name, query):
    h.cfg.reset_prompt(name)
    h.send_json(h.cfg.prompts())


# ---- profiles ---------------------------------------------------------------

@route("GET", "/api/profiles")
def get_profiles(h, query):
    h.send_json(h.store.profiles())


@route("POST", "/api/profiles")
def save_profile(h, query):
    data = h.body()
    if not str(data.get("name") or "").strip() and not data.get("id"):
        raise BadRequest("a profile needs a name")
    h.send_json(h.store.save_profile(data))


@route("DELETE", "/api/profiles/([a-z0-9-]+)")
def delete_profile(h, pid, query):
    h.store.delete_profile(pid)
    h.send_json(h.store.profiles())


# ---- courses ----------------------------------------------------------------

@route("GET", "/api/courses")
def list_courses(h, query):
    h.send_json(h.store.courses(query.get("profile", [None])[0]))


@route("POST", "/api/courses")
def create_course(h, query):
    params = h.body()
    h.stream(lambda emit: h.engine.build_course(params, emit, h.alive))


@route("GET", "/api/courses/([a-z0-9-]+)")
def get_course(h, cid, query):
    h.send_json(h.store.course(cid))


@route("PUT", "/api/courses/([a-z0-9-]+)")
def put_course(h, cid, query):
    h.send_json(h.engine.update_outline(cid, h.body()))


@route("DELETE", "/api/courses/([a-z0-9-]+)")
def delete_course(h, cid, query):
    h.store.delete_course(cid)
    h.send_json({"ok": True})


@route("GET", "/api/courses/([a-z0-9-]+)/ch/([a-z0-9-]+)")
def get_chapter(h, cid, chid, query):
    h.send_json(h.store.chapter(cid, chid))


@route("POST", "/api/courses/([a-z0-9-]+)/ch/([a-z0-9-]+)/generate")
def generate_chapter(h, cid, chid, query):
    force = bool(h.body().get("force"))
    h.stream(lambda emit: h.engine.generate_chapter(cid, chid, emit, h.alive, force=force))


@route("PUT", "/api/courses/([a-z0-9-]+)/ch/([a-z0-9-]+)/answers/([a-z0-9]+)")
def put_answer(h, cid, chid, qid, query):
    d = h.body()
    h.send_json(h.engine.save_answer(cid, chid, qid, d.get("value"), d.get("result"), d.get("hints")))


@route("POST", "/api/courses/([a-z0-9-]+)/ch/([a-z0-9-]+)/grade/([a-z0-9]+)")
def grade(h, cid, chid, qid, query):
    h.send_json(h.engine.grade(cid, chid, qid, h.body().get("value") or {}, h.alive))


@route("POST", "/api/courses/([a-z0-9-]+)/ch/([a-z0-9-]+)/finish")
def finish(h, cid, chid, query):
    h.send_json(h.engine.finish_chapter(cid, chid))


@route("POST", "/api/courses/([a-z0-9-]+)/ch/([a-z0-9-]+)/chat/([a-z0-9]+)")
def chat(h, cid, chid, qid, query):
    d = h.body()
    message = str(d.get("message") or "").strip()
    if not message:
        raise BadRequest("empty message")
    h.stream(lambda emit: h.engine.chat(cid, chid, qid, message, d.get("current"), emit, h.alive))


def lan_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default=os.environ.get("TUTOR_DATA", "~/Tutor"), help="notebook folder (default ~/Tutor)")
    ap.add_argument("--host", default=os.environ.get("TUTOR_HOST"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("TUTOR_PORT") or 0) or None)
    args = ap.parse_args()
    data = os.path.abspath(os.path.expanduser(args.data))
    os.makedirs(data, exist_ok=True)
    cfg = Config(data)
    Handler.cfg, Handler.store, Handler.llm = cfg, Store(data), LLM(cfg)
    Handler.engine = Engine(cfg, Handler.store, Handler.llm)
    host, port = args.host or cfg["host"], args.port or cfg["port"]
    srv = ThreadingHTTPServer((host, port), Handler)
    srv.daemon_threads = True
    print(f"Margin tutor  (notebooks: {data})")
    print(f"  local  http://{'127.0.0.1' if host in ('0.0.0.0', '') else host}:{port}")
    if host in ("0.0.0.0", ""):
        print(f"  lan    http://{lan_ip()}:{port}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
