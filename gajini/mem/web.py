"""Web interface for mem — FastAPI backend serving a single-page app.

Launch with `mem serve` or `python -m mem.web`.
"""

from __future__ import annotations

import shutil
from datetime import datetime
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .config import MemConfig, load_config
from .note import Note
from .store import Store

_STATIC_DIR = Path(__file__).parent / "static"

# ── Pydantic models ──────────────────────────────────────────────

class NoteListItem(BaseModel):
    filename: str
    title: str
    preview: str
    tags: list[str]
    created: str
    modified: str


class NoteDetail(BaseModel):
    filename: str
    content: str
    raw: str  # full file content including frontmatter
    tags: list[str]
    created: str
    modified: str


class NoteUpdate(BaseModel):
    raw: str  # full file content with frontmatter


class NoteCreate(BaseModel):
    content: str
    tags: list[str] = []
    title: str = ""


class UploadResult(BaseModel):
    path: str
    filename: str


# ── App factory ──────────────────────────────────────────────────

def create_app(config: MemConfig | None = None) -> FastAPI:
    cfg = config or load_config()
    store = Store(cfg)

    app = FastAPI(title="mem", version="0.1.0")

    # Serve images from .assets/
    cfg.ensure_dirs()
    app.mount("/assets", StaticFiles(directory=str(cfg.assets_dir)), name="assets")

    # ── API routes ───────────────────────────────────────────

    @app.get("/api/notes", response_model=list[NoteListItem])
    def list_notes(q: str = "", tag: str = ""):
        tags = [t.strip() for t in tag.split(",") if t.strip()]
        if q and tags:
            by_tag = {n.path for n in store.find_by_tags_any(tags)}
            notes = [n for n in store.search(q) if n.path in by_tag]
        elif tags:
            notes = store.find_by_tags_any(tags)
        elif q:
            notes = store.search(q)
        else:
            notes = store.all_notes()
        return [
            NoteListItem(
                filename=n.path.name,
                title=n.title,
                preview=n.preview,
                tags=n.tags,
                created=n.created.isoformat(),
                modified=n.modified.isoformat(),
            )
            for n in notes
        ]

    @app.get("/api/notes/{filename}", response_model=NoteDetail)
    def get_note(filename: str):
        path = cfg.memory_dir / filename
        if not path.exists():
            raise HTTPException(404, "Note not found")
        note = Note.load(path)
        raw = path.read_text(encoding="utf-8")
        return NoteDetail(
            filename=note.path.name,
            content=note.content,
            raw=raw,
            tags=note.tags,
            created=note.created.isoformat(),
            modified=note.modified.isoformat(),
        )

    @app.put("/api/notes/{filename}", response_model=NoteDetail)
    def update_note(filename: str, body: NoteUpdate):
        path = cfg.memory_dir / filename
        if not path.exists():
            raise HTTPException(404, "Note not found")
        # Write raw content directly (includes frontmatter)
        path.write_text(body.raw, encoding="utf-8")
        note = Note.load(path)
        store.index_note(note)
        raw = path.read_text(encoding="utf-8")
        return NoteDetail(
            filename=note.path.name,
            content=note.content,
            raw=raw,
            tags=note.tags,
            created=note.created.isoformat(),
            modified=note.modified.isoformat(),
        )

    @app.post("/api/notes", response_model=NoteDetail)
    def create_note(body: NoteCreate):
        tags = body.tags if body.tags else ["inbox"]
        note = Note.new(cfg.memory_dir, body.content, tags, title=body.title)
        store.index_note(note)
        raw = note.path.read_text(encoding="utf-8")
        return NoteDetail(
            filename=note.path.name,
            content=note.content,
            raw=raw,
            tags=note.tags,
            created=note.created.isoformat(),
            modified=note.modified.isoformat(),
        )

    @app.delete("/api/notes/{filename}")
    def delete_note(filename: str):
        path = cfg.memory_dir / filename
        if not path.exists():
            raise HTTPException(404, "Note not found")
        note = Note.load(path)
        store.delete(note)
        return {"ok": True}

    @app.get("/api/tags")
    def list_tags():
        return store.all_tags()

    @app.post("/api/upload", response_model=UploadResult)
    async def upload_image(file: UploadFile = File(...)):
        """Upload an image (from clipboard paste or file picker)."""
        cfg.ensure_dirs()
        ext = Path(file.filename or "image.png").suffix or ".png"
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        dest = cfg.assets_dir / f"clip-{stamp}{ext}"
        counter = 1
        while dest.exists():
            dest = cfg.assets_dir / f"clip-{stamp}-{counter}{ext}"
            counter += 1
        with open(dest, "wb") as f:
            shutil.copyfileobj(file.file, f)
        rel = dest.relative_to(cfg.memory_dir)
        return UploadResult(path=str(rel), filename=dest.name)

    # ── SPA ──────────────────────────────────────────────────

    @app.get("/", response_class=HTMLResponse)
    def index():
        html = (_STATIC_DIR / "index.html").read_text(encoding="utf-8")
        return HTMLResponse(html)

    return app


def start_server(
    host: str = "0.0.0.0",
    port: int = 8899,
    config: MemConfig | None = None,
) -> None:
    app = create_app(config)
    print(f"\n  mem web → http://{host}:{port}\n")
    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    start_server()
