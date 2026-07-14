import { useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { resolveEditableTable, sameIdentifier } from "../../src/core/result-editing";
import type { DatabaseCatalog, LobReference, LobValue, QueryResult } from "../../src/core/types";
import { api } from "./api";
import { formatBytes, isLobValue, LobInspector } from "./LobInspector";

type DuplicateDraft = { id: string; sourceRow: number; values: Record<string, string> };
type OpenLob = { rowIndex: number; columnIndex: number; value: LobValue; reference: LobReference };

export function ResultGrid({
  result,
  sql,
  catalog,
  connection,
  onResultChange,
  onMutation,
}: {
  result: QueryResult;
  sql: string;
  catalog?: DatabaseCatalog;
  connection: string;
  onResultChange(result: QueryResult): void;
  onMutation(committed: boolean): void;
}) {
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [lobDrafts, setLobDrafts] = useState<Record<string, Blob>>({});
  const [duplicates, setDuplicates] = useState<DuplicateDraft[]>([]);
  const [openLob, setOpenLob] = useState<OpenLob>();
  const [saving, setSaving] = useState(false);
  const [columnWidths, setColumnWidths] = useState<Record<number, number>>({});
  const [copiedCell, setCopiedCell] = useState<string>();
  const copyTimer = useRef<ReturnType<typeof setTimeout>>();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const columnNames = result.columns.map((column) => column.name);
  const table = useMemo(() => resolveEditableTable(sql, catalog, columnNames), [sql, catalog, columnNames.join("\0")]);
  const primaryKeys = table?.columns.filter((column) => column.primaryKey) ?? [];
  const hasKeys = Boolean(table && primaryKeys.length && primaryKeys.every((key) => result.columns.some((column) => sameIdentifier(column.name, key.name))));
  const editable = Boolean(table && hasKeys);
  const changedRows = new Set([...Object.keys(drafts), ...Object.keys(lobDrafts)].map((key) => Number(key.split(":")[0])));
  const changeCount = Object.keys(drafts).length + Object.keys(lobDrafts).length + duplicates.length;

  const keysFor = (rowIndex: number): Record<string, unknown> => Object.fromEntries(primaryKeys.map((column) => {
    const index = result.columns.findIndex((candidate) => sameIdentifier(candidate.name, column.name));
    return [column.name, result.rows[rowIndex][index]];
  }));

  const lobReference = (rowIndex: number, columnIndex: number, value: LobValue): LobReference | undefined => {
    if (!table || !hasKeys) return undefined;
    return { table: table.name, column: result.columns[columnIndex].name, keys: keysFor(rowIndex), kind: value.kind };
  };

  const resizeColumn = (columnIndex: number, event: ReactMouseEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const header = event.currentTarget.parentElement;
    if (!header) return;
    const startX = event.clientX;
    const startWidth = header.getBoundingClientRect().width;
    document.body.classList.add("column-resizing");
    const move = (moveEvent: MouseEvent) => {
      const width = Math.min(1400, Math.max(60, startWidth + moveEvent.clientX - startX));
      setColumnWidths((current) => ({ ...current, [columnIndex]: width }));
    };
    const stop = () => {
      document.body.classList.remove("column-resizing");
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", stop);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", stop);
  };

  const copyCell = async (key: string, value: unknown) => {
    const text = display(value);
    try {
      await writeClipboard(text);
      setCopiedCell(key);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopiedCell(undefined), 800);
    } catch (cause) {
      setError(`Could not copy cell: ${(cause as Error).message}`);
    }
  };

  const columnStyle = (columnIndex: number) => {
    const width = columnWidths[columnIndex];
    return width ? { width, minWidth: width, maxWidth: width } : undefined;
  };

  const duplicate = (rowIndex: number) => {
    if (!table) return;
    const values: Record<string, string> = {};
    result.columns.forEach((column, index) => {
      const metadata = table.columns.find((candidate) => sameIdentifier(candidate.name, column.name));
      if (!metadata?.identity && !asLobValue(result.rows[rowIndex][index], metadata?.dataType)) {
        values[column.name] = metadata?.primaryKey ? "" : display(result.rows[rowIndex][index]);
      }
    });
    setDuplicates((current) => [...current, { id: crypto.randomUUID(), sourceRow: rowIndex, values }]);
    setEditing(true);
  };

  const apply = async () => {
    if (!table || !changeCount) return;
    setSaving(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const rows = result.rows.map((row) => [...row]);
      let committed = false;
      for (const rowIndex of changedRows) {
        const changes: Record<string, unknown> = {};
        const columnTypes: Record<string, string> = {};
        for (const [draftKey, value] of Object.entries(drafts)) {
          const [draftRow, columnIndex] = draftKey.split(":").map(Number);
          if (draftRow !== rowIndex) continue;
          const column = result.columns[columnIndex];
          const metadata = table.columns.find((candidate) => sameIdentifier(candidate.name, column.name));
          changes[column.name] = coerce(value, metadata?.dataType);
          if (metadata?.dataType) columnTypes[column.name] = metadata.dataType;
          rows[rowIndex][columnIndex] = changes[column.name];
        }
        if (Object.keys(changes).length) {
          const response = await api.updateRow(connection, { table: table.name, keys: keysFor(rowIndex), changes, columnTypes });
          if (response.kind === "mutation") committed = response.committed;
        }
      }
      for (const [draftKey, blob] of Object.entries(lobDrafts)) {
        const [rowIndex, columnIndex] = draftKey.split(":").map(Number);
        const original = result.rows[rowIndex][columnIndex];
        const metadata = table.columns.find((column) => sameIdentifier(column.name, result.columns[columnIndex].name));
        const value = asLobValue(original, metadata?.dataType);
        if (!value) continue;
        const reference = lobReference(rowIndex, columnIndex, value);
        if (!reference) continue;
        const response = await api.writeLob(connection, reference, blob);
        if (response.kind === "mutation") committed = response.committed;
        rows[rowIndex][columnIndex] = { ...value, size: blob.size };
      }
      for (const draft of duplicates) {
        const overrides: Record<string, unknown> = {};
        const columnTypes: Record<string, string> = {};
        for (const [columnName, value] of Object.entries(draft.values)) {
          const columnIndex = result.columns.findIndex((column) => sameIdentifier(column.name, columnName));
          const original = display(result.rows[draft.sourceRow][columnIndex]);
          const metadata = table.columns.find((column) => sameIdentifier(column.name, columnName));
          if (metadata?.primaryKey && !value.trim()) throw new Error(`${columnName} is required for the duplicated row`);
          if (value !== original) {
            overrides[columnName] = coerce(value, metadata?.dataType);
            if (metadata?.dataType) columnTypes[columnName] = metadata.dataType;
          }
        }
        const response = await api.duplicateRow(connection, {
          table: table.name,
          keys: keysFor(draft.sourceRow),
          columns: table.columns.filter((column) => !column.identity).map((column) => column.name),
          overrides,
          columnTypes,
        });
        if (response.kind === "mutation") committed = response.committed;
      }
      onResultChange({ ...result, rows });
      onMutation(committed);
      setDrafts({});
      setLobDrafts({});
      setDuplicates([]);
      setEditing(false);
      if (duplicates.length) setNotice(`${duplicates.length} row${duplicates.length === 1 ? "" : "s"} duplicated · rerun to display`);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const revert = () => { setDrafts({}); setLobDrafts({}); setDuplicates([]); setNotice(undefined); };

  const numeric = result.columns.map((column) => /^(NUMBER|FLOAT|BINARY_FLOAT|BINARY_DOUBLE|DECIMAL|INTEGER|INT|SMALLINT)/i.test(column.dbTypeName ?? ""));

  return (
    <div className="result-wrap">
      <div className="result-meta">
        <span><b>{result.rows.length} rows</b> · {result.elapsedMs} ms{result.truncated ? " · limited" : ""}</span>
        <span className="grow" />
        {editable && <button className={`edit-rows-button ${editing ? "active" : ""}`} title={editing ? "Stop editing" : `Edit rows of ${table?.name}`} onClick={() => setEditing((value) => !value)}>✎</button>}
        {!editable && <span className="read-only-reason" title="Use a simple single-table SELECT and include every primary-key column">read-only</span>}
      </div>
      <div className="grid-scroll">
        <table className="result-grid">
          <thead><tr>{editable && <th className="row-actions" />}{result.columns.map((column, index) => (
            <th key={column.name} className={`${numeric[index] ? "num" : ""} resizable-column`} style={columnStyle(index)}>
              <span>{column.name}</span>
              <span className="column-resizer" role="separator" aria-label={`Resize ${column.name}`} onMouseDown={(event) => resizeColumn(index, event)} />
            </th>
          ))}</tr></thead>
          <tbody>
            {result.rows.map((row, rowIndex) => (
              <tr key={rowIndex} className={changedRows.has(rowIndex) ? "changed-row" : ""}>
                {editable && <td className="row-actions"><button title="Stage a duplicate of this row" onClick={() => duplicate(rowIndex)}>⧉</button></td>}
                {row.map((value, columnIndex) => {
                  const key = `${rowIndex}:${columnIndex}`;
                  const column = table?.columns.find((candidate) => sameIdentifier(candidate.name, result.columns[columnIndex].name));
                  const lobValue = asLobValue(value, column?.dataType);
                  const canEdit = editing && Boolean(column) && !column?.primaryKey && !lobValue;
                  const reference = lobValue ? lobReference(rowIndex, columnIndex, lobValue) : undefined;
                  return (
                    <td
                      key={columnIndex}
                      className={`${value == null && !lobValue ? "null" : ""} ${lobValue ? "lob-cell" : "copyable-cell"} ${lobDrafts[key] ? "staged-lob" : ""} ${numeric[columnIndex] && !lobValue ? "num" : ""} ${copiedCell === key ? "copied-cell" : ""}`}
                      style={columnStyle(columnIndex)}
                      title={lobValue ? undefined : copiedCell === key ? "Copied" : "Click to copy full value"}
                      onClick={(event) => {
                        if (lobValue && reference) setOpenLob({ rowIndex, columnIndex, value: lobValue, reference });
                        else if (!(event.target instanceof HTMLInputElement)) void copyCell(key, value);
                      }}
                      onDoubleClick={() => {
                        if (lobValue && reference) setOpenLob({ rowIndex, columnIndex, value: lobValue, reference });
                        else if (editable && column && !column.primaryKey) setEditing(true);
                      }}
                      onDragOver={(event) => { if (lobValue && reference) event.preventDefault(); }}
                      onDrop={(event) => {
                        if (!lobValue || !reference) return;
                        event.preventDefault();
                        const file = event.dataTransfer.files[0];
                        if (file) setLobDrafts((current) => ({ ...current, [key]: file }));
                      }}
                    >
                      {canEdit ? (
                        <input value={drafts[key] ?? display(value)} onChange={(event) => setDrafts((current) => ({ ...current, [key]: event.target.value }))} />
                      ) : lobValue ? (
                        <button className="lob-chip" disabled={!reference} onClick={() => reference && setOpenLob({ rowIndex, columnIndex, value: lobValue, reference })}>
                          {lobValue.kind} · {formatBytes(lobDrafts[key]?.size ?? lobValue.size)}{lobDrafts[key] ? " · staged" : ""}
                        </button>
                      ) : display(value)}
                    </td>
                  );
                })}
              </tr>
            ))}
            {duplicates.map((draft) => (
              <tr className="duplicate-row" key={draft.id}>
                <td className="row-actions"><button title="Discard duplicate" onClick={() => setDuplicates((current) => current.filter(({ id }) => id !== draft.id))}>×</button></td>
                {result.columns.map((column, columnIndex) => {
                  const metadata = table?.columns.find((candidate) => sameIdentifier(candidate.name, column.name));
                  const original = result.rows[draft.sourceRow][columnIndex];
                  const lobValue = asLobValue(original, metadata?.dataType);
                  return <td key={column.name}>{metadata?.identity ? <span className="auto-value">AUTO</span>
                    : lobValue ? <span className="lob-chip">{lobValue.kind} · copied</span>
                      : <input value={draft.values[column.name] ?? ""} onChange={(event) => setDuplicates((current) => current.map((item) => item.id === draft.id ? { ...item, values: { ...item.values, [column.name]: event.target.value } } : item))} />}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {changeCount > 0 && (
        <div className="changes-bar">
          <strong>● {changeCount} staged change{changeCount === 1 ? "" : "s"}</strong>
          <button title="Discard staged changes" onClick={revert}>↺ revert</button>
          <button className="primary" disabled={saving} onClick={() => void apply()}>{saving ? "applying…" : "✓ apply"}</button>
        </div>
      )}
      {notice && <div className="inline-notice">{notice}</div>}
      {error && <div className="inline-error">{error}</div>}
      {openLob && <LobInspector
        connection={connection}
        reference={openLob.reference}
        value={openLob.value}
        staged={lobDrafts[`${openLob.rowIndex}:${openLob.columnIndex}`]}
        onStage={(blob) => setLobDrafts((current) => ({ ...current, [`${openLob.rowIndex}:${openLob.columnIndex}`]: blob }))}
        onClose={() => setOpenLob(undefined)}
      />}
    </div>
  );
}

function asLobValue(value: unknown, dataType?: string): LobValue | undefined {
  if (isLobValue(value)) return value;
  const normalized = dataType?.toUpperCase();
  if (value == null && normalized && (normalized === "BLOB" || normalized.includes("CLOB"))) {
    return { __dbcLob: true, kind: normalized === "BLOB" ? "BLOB" : "CLOB", size: 0 };
  }
  return undefined;
}

function display(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (isLobValue(value)) return `${value.kind} · ${formatBytes(value.size)}`;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard access is unavailable");
}

function coerce(value: string, dataType?: string): unknown {
  if (value.toUpperCase() === "NULL") return null;
  if (dataType && /^(NUMBER|FLOAT|BINARY_FLOAT|BINARY_DOUBLE)/.test(dataType)) {
    const number = Number(value);
    if (!Number.isNaN(number)) return number;
  }
  return value;
}
