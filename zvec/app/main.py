from __future__ import annotations

from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .config import load_settings
from .embeddings import make_embedding_provider
from .llm import make_llm_provider
from .store import PdfQaStore

settings = load_settings()
embedder = make_embedding_provider(settings)
llm = make_llm_provider(settings)
store = PdfQaStore(settings, embedder)

app = FastAPI(title="zvec PDF Q&A demo")
app.mount("/static", StaticFiles(directory=Path(__file__).parent / "static"), name="static")


class ChatRequest(BaseModel):
    message: str
    top_k: int = 5


class ChatResponse(BaseModel):
    answer: str
    sources: list[dict]


@app.get("/")
def index():
    return FileResponse(Path(__file__).parent / "static" / "index.html")


@app.get("/api/config")
def get_config():
    return {
        "embedding_provider": settings.embedding_provider,
        "embedding_model": settings.embedding_model,
        "embedding_dim": embedder.dimension,
        "llm_provider": settings.llm_provider,
        "chat_model": settings.chat_model,
        "documents": len(store.list_documents()),
    }


@app.post("/api/upload")
async def upload(files: Annotated[list[UploadFile], File()]):
    uploaded = []
    for file in files:
        try:
            uploaded.append(store.add_pdf(await file.read(), file.filename or "upload.pdf"))
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"{file.filename}: {exc}") from exc
    return {"uploaded": uploaded}


@app.get("/api/documents")
def documents():
    return {"documents": store.list_documents()}


@app.delete("/api/documents/{doc_id}")
def delete_document(doc_id: str):
    store.delete_document(doc_id)
    return {"ok": True}


@app.post("/api/chat", response_model=ChatResponse)
def chat(req: ChatRequest):
    question = req.message.strip()
    if not question:
        raise HTTPException(status_code=400, detail="message is required")
    try:
        sources = store.search(question, req.top_k)
        answer = llm.answer(question, sources)
        store.add_chat_message("user", question)
        store.add_chat_message("assistant", answer)
        return ChatResponse(answer=answer, sources=sources)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/history")
def history():
    return {"messages": store.chat_history()}
