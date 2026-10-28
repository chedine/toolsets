#!/usr/bin/env python3
"""Tidbits: serve the capture UI and a markdown vault over the LAN.

    python3 server.py --vault ~/Tidbits            # http://<host>:8484
    TIDBITS_TOKEN=secret python3 server.py         # open /?t=secret once per device
"""
import argparse
import hmac
import json
import mimetypes
import os
import select
import socket
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

from ask import Asker
from vault import Conflict, Vault

STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
COOKIE = "tidbits_token"


class Handler(BaseHTTPRequestHandler):
    vault: Vault = None
    asker: Asker = None
    token: str = ""

    def log_message(self, fmt, *args):
        if not self.path.startswith("/api/notes") or self.command != "GET":
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

    def authed(self, url):
        if not self.token:
            return True
        c = SimpleCookie(self.headers.get("Cookie", ""))
        if COOKIE in c and hmac.compare_digest(c[COOKIE].value, self.token):
            return True
        given = parse_qs(url.query).get("t", [""])[0]
        if given and hmac.compare_digest(given, self.token):
            self.send_response(302)
            self.send_header("Set-Cookie", f"{COOKIE}={self.token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict")
            self.send_header("Location", url.path or "/")
            self.end_headers()
            return None
        return False

    def route(self, method):
        url = urlparse(self.path)
        ok = self.authed(url)
        if ok is None:
            return
        if not ok:
            if url.path.startswith("/api/"):
                return self.send_json({"error": "unauthorized"}, 401)
            msg = b"Tidbits: open this page once with ?t=<token> to sign in on this device.\n"
            self.send_response(401)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            return self.wfile.write(msg)

        parts = [unquote(p) for p in url.path.strip("/").split("/")]
        try:
            if parts[:2] == ["api", "notes"]:
                note_id = parts[2] if len(parts) > 2 else None
                if method == "GET" and not note_id:
                    return self.send_json({"vault": self.vault.root, "notes": self.vault.notes()})
                if method == "POST" and not note_id:
                    return self.send_json(self.vault.create(self.body().get("text", "")), 201)
                if method == "PUT" and note_id:
                    b = self.body()
                    return self.send_json(self.vault.update(note_id, b.get("text", ""), b.get("base")))
                if method == "DELETE" and note_id:
                    self.vault.delete(note_id)
                    return self.send_json({"ok": True})
            if parts == ["api", "graph"] and method == "GET":
                return self.send_json(self.vault.graph())
            if parts == ["api", "config"] and method == "GET":
                return self.send_json({"vault": self.vault.root, "ask": self.asker.info()})
            if parts == ["api", "ask"] and method == "POST":
                return self.ask(self.body())
            if method == "GET" and not url.path.startswith("/api/"):
                return self.static(url.path)
            self.send_json({"error": "not found"}, 404)
        except Conflict as e:
            self.send_json({"error": "conflict", "note": e.note}, 409)
        except KeyError:
            self.send_json({"error": "no such note"}, 404)
        except ValueError as e:
            self.send_json({"error": str(e)}, 400)

    def ask(self, b):
        q = (b.get("q") or "").strip()
        if not q:
            raise ValueError("empty question")
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        def emit(ev):
            self.wfile.write((json.dumps(ev, ensure_ascii=False) + "\n").encode())
            self.wfile.flush()

        def alive():
            try:
                readable, _, _ = select.select([self.connection], [], [], 0)
                return not readable or self.connection.recv(1, socket.MSG_PEEK) != b""
            except OSError:
                return False

        try:
            self.asker.stream(q, self.vault.notes(), b.get("ids") or [], emit, alive)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the browser cancelled; Asker already killed pi
        self.close_connection = True

    def static(self, path):
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        full = os.path.normpath(os.path.join(STATIC, rel))
        if not full.startswith(STATIC + os.sep) or not os.path.isfile(full):
            return self.send_json({"error": "not found"}, 404)
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", (mimetypes.guess_type(full)[0] or "application/octet-stream") + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_PUT(self):
        self.route("PUT")

    def do_DELETE(self):
        self.route("DELETE")


def lan_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def main():
    ap = argparse.ArgumentParser(description="Tidbits note server")
    ap.add_argument("--vault", default=os.environ.get("TIDBITS_VAULT", "~/Tidbits"))
    ap.add_argument("--host", default=os.environ.get("TIDBITS_HOST", "0.0.0.0"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("TIDBITS_PORT", "8484")))
    ap.add_argument("--ask-model", default=os.environ.get("TIDBITS_ASK_MODEL", "openai-codex/gpt-6-luna"))
    ap.add_argument("--ask-thinking", default=os.environ.get("TIDBITS_ASK_THINKING", "medium"))
    ap.add_argument("--pi-bin", default=os.environ.get("TIDBITS_PI_BIN", "pi"))
    args = ap.parse_args()

    Handler.vault = Vault(args.vault)
    Handler.token = os.environ.get("TIDBITS_TOKEN", "")
    Handler.asker = Asker(args.ask_model, args.ask_thinking, args.pi_bin)
    n = len(Handler.vault.scan())
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"tidbits · vault {Handler.vault.root} · {n} notes")
    a = Handler.asker.info()
    print(f"  ask    {a['model']} ({a['thinking']})" + ("" if a["available"] else " · pi not found, ask disabled"))
    print(f"  local  http://127.0.0.1:{args.port}")
    if args.host == "0.0.0.0":
        suffix = "/?t=<token>" if Handler.token else ""
        print(f"  lan    http://{lan_ip()}:{args.port}{suffix}")
        if not Handler.token:
            print("  note   no TIDBITS_TOKEN set; anyone on this network can read and write notes")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
