#!/usr/bin/env python3
"""Pi Agent Session Viewer — lightweight web UI for browsing ~/.pi sessions."""

import json
import os
import glob
import re
import html
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from pathlib import Path
from datetime import datetime

SESSIONS_DIR = os.path.expanduser("~/.pi/agent/sessions")
PORT = 8787


def get_all_sessions():
    """Return list of session metadata sorted by date descending."""
    sessions = []
    for filepath in glob.glob(os.path.join(SESSIONS_DIR, "**", "*.jsonl"), recursive=True):
        try:
            with open(filepath, "r") as f:
                first_line = f.readline()
                if not first_line.strip():
                    continue
                header = json.loads(first_line)
                if header.get("type") != "session":
                    continue

                # Count messages and get first user message as title
                title = ""
                msg_count = 0
                model = ""
                for line in f:
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if entry.get("type") == "model_change" and not model:
                        model = entry.get("modelId", "")
                    if entry.get("type") == "message":
                        msg = entry.get("message", {})
                        if msg.get("role") == "user":
                            msg_count += 1
                            if not title:
                                for c in msg.get("content", []):
                                    if c.get("type") == "text":
                                        title = c["text"][:120]
                                        break
                        elif msg.get("role") == "assistant":
                            msg_count += 1

                # Use cwd from session header as project name, fall back to dir
                cwd = header.get("cwd", "")
                if cwd:
                    # Shorten home dir
                    home = os.path.expanduser("~")
                    project = cwd.replace(home, "~")
                else:
                    rel = os.path.relpath(os.path.dirname(filepath), SESSIONS_DIR)
                    project = rel.replace("--", "/").lstrip("/") if rel != "." else "root"

                sessions.append({
                    "id": header.get("id", ""),
                    "timestamp": header.get("timestamp", ""),
                    "cwd": header.get("cwd", ""),
                    "project": project,
                    "title": title or "(no messages)",
                    "messageCount": msg_count,
                    "model": model,
                    "file": filepath,
                })
        except Exception as e:
            continue

    sessions.sort(key=lambda s: s["timestamp"], reverse=True)
    return sessions


def get_session_content(session_id):
    """Load full session content by ID."""
    for filepath in glob.glob(os.path.join(SESSIONS_DIR, "**", f"*{session_id}*.jsonl"), recursive=True):
        entries = []
        with open(filepath, "r") as f:
            for line in f:
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        return entries
    return None


def search_sessions(query):
    """Search across all sessions for a text query. Returns matching sessions with snippets."""
    query_lower = query.lower()
    results = []
    for filepath in glob.glob(os.path.join(SESSIONS_DIR, "**", "*.jsonl"), recursive=True):
        try:
            session_header = None
            matches = []
            model = ""
            with open(filepath, "r") as f:
                for line in f:
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if entry.get("type") == "session":
                        session_header = entry
                    if entry.get("type") == "model_change" and not model:
                        model = entry.get("modelId", "")
                    if entry.get("type") == "message":
                        msg = entry.get("message", {})
                        for c in msg.get("content", []):
                            text = c.get("text", "") or c.get("thinking", "")
                            if query_lower in text.lower():
                                # Extract snippet around match
                                idx = text.lower().index(query_lower)
                                start = max(0, idx - 60)
                                end = min(len(text), idx + len(query) + 60)
                                snippet = ("..." if start > 0 else "") + text[start:end] + ("..." if end < len(text) else "")
                                matches.append({
                                    "role": msg.get("role", ""),
                                    "snippet": snippet,
                                    "contentType": c.get("type", ""),
                                })
                                if len(matches) >= 5:
                                    break
                    if len(matches) >= 5:
                        break

            if matches and session_header:
                cwd = session_header.get("cwd", "")
                if cwd:
                    home = os.path.expanduser("~")
                    project = cwd.replace(home, "~")
                else:
                    rel = os.path.relpath(os.path.dirname(filepath), SESSIONS_DIR)
                    project = rel.replace("--", "/").lstrip("/") if rel != "." else "root"
                results.append({
                    "id": session_header.get("id", ""),
                    "timestamp": session_header.get("timestamp", ""),
                    "cwd": session_header.get("cwd", ""),
                    "project": project,
                    "model": model,
                    "matches": matches,
                    "matchCount": len(matches),
                })
        except Exception:
            continue

    results.sort(key=lambda r: r["timestamp"], reverse=True)
    return results


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        if path == "/" or path == "/index.html":
            self.serve_file("index.html", "text/html")
        elif path == "/api/sessions":
            self.send_json(get_all_sessions())
        elif path == "/api/session":
            sid = params.get("id", [None])[0]
            if not sid:
                self.send_error(400, "Missing id parameter")
                return
            content = get_session_content(sid)
            if content is None:
                self.send_error(404, "Session not found")
                return
            self.send_json(content)
        elif path == "/api/search":
            q = params.get("q", [""])[0]
            if len(q) < 2:
                self.send_json([])
                return
            self.send_json(search_sessions(q))
        else:
            self.send_error(404)

    def send_json(self, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_file(self, filename, content_type):
        filepath = os.path.join(os.path.dirname(os.path.abspath(__file__)), filename)
        try:
            with open(filepath, "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except FileNotFoundError:
            self.send_error(404)

    def log_message(self, format, *args):
        pass  # Suppress logs


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"🔍 Pi Session Viewer running at http://localhost:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.server_close()
