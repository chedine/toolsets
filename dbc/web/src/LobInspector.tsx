import { useEffect, useMemo, useState } from "react";
import type { LobReference, LobValue } from "../../src/core/types";
import { api } from "./api";

export function LobInspector({
  connection,
  reference,
  value,
  staged,
  onStage,
  onClose,
}: {
  connection: string;
  reference: LobReference;
  value: LobValue;
  staged?: Blob;
  onStage(content: Blob): void;
  onClose(): void;
}) {
  const [content, setContent] = useState<Blob | null>(staged ?? null);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(!staged);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (staged) return;
    let active = true;
    void api.readLob(connection, reference).then((blob) => {
      if (!active) return;
      setContent(blob);
      setLoading(false);
    }).catch((cause) => {
      if (active) { setError((cause as Error).message); setLoading(false); }
    });
    return () => { active = false; };
  }, [connection, reference.table, reference.column, JSON.stringify(reference.keys)]);

  useEffect(() => {
    if (value.kind === "CLOB" && content) void content.text().then(setText);
  }, [content, value.kind]);

  const url = useMemo(() => content ? URL.createObjectURL(content) : undefined, [content]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  const replaceFile = (file?: File) => {
    if (!file) return;
    setContent(file);
    if (value.kind === "CLOB") void file.text().then(setText);
  };

  const stage = () => {
    const next = value.kind === "CLOB" ? new Blob([text], { type: "text/plain;charset=utf-8" }) : content;
    if (next) onStage(next);
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="lob-modal">
        <header>
          <div><strong>{reference.column}</strong><span>{value.kind} · {formatBytes(content?.size ?? value.size)}</span></div>
          <button onClick={onClose}>×</button>
        </header>
        <div className="lob-content" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); replaceFile(event.dataTransfer.files[0]); }}>
          {loading && <div className="lob-empty">Loading content…</div>}
          {error && <div className="inline-error">{error}</div>}
          {!loading && !error && value.kind === "CLOB" && <textarea value={text} onChange={(event) => setText(event.target.value)} spellCheck={false} />}
          {!loading && !error && value.kind === "BLOB" && content && (
            content.type.startsWith("image/") ? <img src={url} alt="BLOB preview" />
              : content.type === "application/pdf" ? <iframe src={url} title="PDF preview" />
                : <div className="lob-empty"><strong>Binary content</strong><span>{content.type || "application/octet-stream"} · {formatBytes(content.size)}</span></div>
          )}
          {!loading && !error && !content && <div className="lob-empty">NULL</div>}
        </div>
        <footer>
          <label className="file-button">Replace from file<input type="file" onChange={(event) => replaceFile(event.target.files?.[0])} /></label>
          <span>or drop a file into the preview</span>
          <span className="spacer" />
          {url && <a className="button-link" href={url} download={`${reference.column.toLowerCase()}.${value.kind === "CLOB" ? "txt" : "bin"}`}>Download</a>}
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!content && value.kind === "BLOB"} onClick={stage}>Stage change</button>
        </footer>
      </section>
    </div>
  );
}

export function isLobValue(value: unknown): value is LobValue {
  return Boolean(value && typeof value === "object" && (value as LobValue).__dbcLob === true);
}

export function formatBytes(bytes?: number): string {
  if (bytes == null) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
