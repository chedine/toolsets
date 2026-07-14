import { useEffect, useRef, useState } from "react";
import type { DatabaseCatalog, ExecutionResult, NotebookDocument, NotebookSummary, SessionInfo } from "../../src/core/types";
import { api, type AppState } from "./api";
import { ResultGrid } from "./ResultGrid";
import { SqlEditor } from "./SqlEditor";

type Cell = {
  id: string;
  sql: string;
  result?: ExecutionResult;
  error?: string;
  running?: boolean;
};

const newCell = (sql = ""): Cell => ({ id: crypto.randomUUID(), sql });

export function App() {
  const started = useRef(false);
  const [state, setState] = useState<AppState>({ configuredConnections: [], sessions: [], templates: {} });
  const [activeConnection, setActiveConnection] = useState<string>();
  const [sessions, setSessions] = useState<Record<string, SessionInfo>>({});
  const [catalogs, setCatalogs] = useState<Record<string, DatabaseCatalog>>({});
  const [cells, setCells] = useState<Cell[]>([newCell("select * from properties")]);
  const [notebooks, setNotebooks] = useState<NotebookSummary[]>([]);
  const [activeNotebook, setActiveNotebook] = useState<NotebookDocument>();
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "error">("saved");
  const [history, setHistory] = useState<string[]>([]);
  const [objectFilter, setObjectFilter] = useState("");
  const [expandedTable, setExpandedTable] = useState<string>();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [globalError, setGlobalError] = useState<string>();
  const [theme, setTheme] = useState<"auto" | "light" | "dark">(() => (localStorage.getItem("dbc-theme") as "light" | "dark" | null) ?? "auto");
  const focusCell = useRef<string>();

  useEffect(() => {
    if (theme === "auto") {
      delete document.documentElement.dataset.theme;
      localStorage.removeItem("dbc-theme");
    } else {
      document.documentElement.dataset.theme = theme;
      localStorage.setItem("dbc-theme", theme);
    }
  }, [theme]);

  const addCell = (sql = "") => {
    const cell = newCell(sql);
    focusCell.current = cell.id;
    setCells((current) => [...current, cell]);
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void Promise.all([api.state(), api.notebooks()]).then(async ([initial, savedNotebooks]) => {
      setState(initial);
      setSessions(Object.fromEntries(initial.sessions.map((session) => [session.name, session])));
      let document: NotebookDocument;
      if (savedNotebooks.length) {
        document = await api.getNotebook(savedNotebooks[0].id);
      } else {
        document = await api.createNotebook("Notebook 1", initial.defaultConnection ?? initial.configuredConnections[0]);
      }
      setNotebooks(savedNotebooks.length ? savedNotebooks : [toSummary(document)]);
      setActiveNotebook(document);
      setCells(document.cells.length ? document.cells.map((cell) => ({ ...cell })) : [newCell()]);
      const target = document.connection ?? initial.defaultConnection ?? initial.configuredConnections[0];
      if (target) await connect(target);
    }).catch((error) => setGlobalError(error.message));
  }, []);

  useEffect(() => {
    if (!activeNotebook) return;
    setSaveStatus("saving");
    const timer = setTimeout(() => {
      const document: NotebookDocument = {
        ...activeNotebook,
        connection: activeConnection,
        cells: cells.map(({ id, sql }) => ({ id, sql })),
      };
      void api.saveNotebook(document).then((saved) => {
        setActiveNotebook(saved);
        setNotebooks((current) => [toSummary(saved), ...current.filter(({ id }) => id !== saved.id)]);
        setSaveStatus("saved");
      }).catch(() => setSaveStatus("error"));
    }, 500);
    return () => clearTimeout(timer);
  }, [cells, activeConnection, activeNotebook?.id, activeNotebook?.name]);

  const currentNotebookDocument = (): NotebookDocument | undefined => activeNotebook ? {
    ...activeNotebook,
    connection: activeConnection,
    cells: cells.map(({ id, sql }) => ({ id, sql })),
  } : undefined;

  const openNotebook = async (id: string) => {
    try {
      const current = currentNotebookDocument();
      if (current) await api.saveNotebook(current);
      const document = await api.getNotebook(id);
      setActiveNotebook(document);
      setCells(document.cells.length ? document.cells.map((cell) => ({ ...cell })) : [newCell()]);
      if (document.connection) await connect(document.connection);
    } catch (error) { setGlobalError((error as Error).message); }
  };

  const createNotebook = async () => {
    const name = window.prompt("Notebook name", `Notebook ${notebooks.length + 1}`);
    if (!name) return;
    try {
      const current = currentNotebookDocument();
      if (current) await api.saveNotebook(current);
      const document = await api.createNotebook(name, activeConnection);
      setNotebooks((current) => [toSummary(document), ...current]);
      setActiveNotebook(document);
      setCells(document.cells.map((cell) => ({ ...cell })));
    } catch (error) { setGlobalError((error as Error).message); }
  };

  const duplicateNotebook = async (id: string) => {
    try {
      const current = currentNotebookDocument();
      if (current) await api.saveNotebook(current);
      const document = await api.duplicateNotebook(id);
      setNotebooks((current) => [toSummary(document), ...current]);
      setActiveNotebook(document);
      setCells(document.cells.map((cell) => ({ ...cell })));
    } catch (error) { setGlobalError((error as Error).message); }
  };

  const deleteNotebook = async (id: string) => {
    const target = notebooks.find((notebook) => notebook.id === id);
    if (!target || !window.confirm(`Delete “${target.name}”?`)) return;
    try {
      await api.deleteNotebook(id);
      const remaining = notebooks.filter((notebook) => notebook.id !== id);
      if (id !== activeNotebook?.id) {
        setNotebooks(remaining);
        return;
      }
      if (remaining.length) {
        const document = await api.getNotebook(remaining[0].id);
        setNotebooks(remaining);
        setActiveNotebook(document);
        setCells(document.cells.length ? document.cells.map((cell) => ({ ...cell })) : [newCell()]);
        if (document.connection) await connect(document.connection);
      } else {
        const document = await api.createNotebook("Notebook 1", activeConnection);
        setNotebooks([toSummary(document)]);
        setActiveNotebook(document);
        setCells(document.cells.map((cell) => ({ ...cell })));
      }
    } catch (error) { setGlobalError((error as Error).message); }
  };

  const connect = async (name: string) => {
    setGlobalError(undefined);
    try {
      const response = await api.connect(name);
      setSessions((current) => ({ ...current, [name]: response.session }));
      setCatalogs((current) => ({ ...current, [name]: response.catalog }));
      setActiveConnection(name);
    } catch (error) { setGlobalError((error as Error).message); }
  };

  const updateCell = (id: string, update: Partial<Cell>) => {
    setCells((current) => current.map((cell) => cell.id === id ? { ...cell, ...update } : cell));
  };

  const run = async (cell: Cell) => {
    if (!activeConnection || !cell.sql.trim() || cell.running) return;
    updateCell(cell.id, { running: true, error: undefined });
    setHistory((current) => [cell.sql, ...current.filter((sql) => sql !== cell.sql)].slice(0, 30));
    try {
      const result = await api.query(activeConnection, cell.sql);
      updateCell(cell.id, { result, running: false });
      if (result.kind === "mutation") markMutation(activeConnection, result.committed);
    } catch (error) {
      updateCell(cell.id, { error: (error as Error).message, running: false });
    }
  };

  const cancel = async (cell: Cell) => {
    if (!activeConnection || !cell.running) return;
    try {
      await api.cancel(activeConnection);
    } catch (error) {
      updateCell(cell.id, { error: (error as Error).message, running: false });
    }
  };

  const markMutation = (connection: string, committed: boolean) => {
    setSessions((current) => ({
      ...current,
      [connection]: { ...current[connection], dirty: !committed },
    }));
  };

  const setAutoCommit = async (enabled: boolean) => {
    if (!activeConnection) return;
    try {
      const session = await api.autocommit(activeConnection, enabled);
      setSessions((current) => ({ ...current, [activeConnection]: session }));
    } catch (error) { setGlobalError((error as Error).message); }
  };

  const finishTransaction = async (action: "commit" | "rollback") => {
    if (!activeConnection) return;
    try {
      await api[action](activeConnection);
      setSessions((current) => ({ ...current, [activeConnection]: { ...current[activeConnection], dirty: false } }));
    } catch (error) { setGlobalError((error as Error).message); }
  };

  const openTemplate = (template: string) => {
    const positions = [...template.matchAll(/\{(\d+)\}/g)].map((match) => Number(match[1]));
    let sql = template;
    for (const position of [...new Set(positions)].sort((a, b) => a - b)) {
      const value = window.prompt(`Template argument ${position}`);
      if (value === null) return;
      sql = sql.replaceAll(`{${position}}`, value);
    }
    addCell(sql);
  };

  const saveTemplate = async (sql: string) => {
    const name = window.prompt("Template name");
    if (!name) return;
    try {
      await api.saveTemplate(name, sql);
      setState((current) => ({ ...current, templates: { ...current.templates, [name]: sql } }));
    } catch (error) { setGlobalError((error as Error).message); }
  };

  const activeSession = activeConnection ? sessions[activeConnection] : undefined;
  const catalog = activeConnection ? catalogs[activeConnection] : undefined;
  const filteredTables = catalog?.tables.filter((table) => table.name.toLowerCase().includes(objectFilter.toLowerCase())) ?? [];

  return (
    <div className={`app-shell ${sidebarOpen ? "" : "sidebar-closed"}`}>
      <aside className="sidebar">
        <div className="side-section">
          <div className="section-label"><span>Notebooks</span><button title="New notebook" onClick={() => void createNotebook()}>＋</button></div>
          {notebooks.map((notebook) => (
            <div key={notebook.id} className={`notebook-row ${notebook.id === activeNotebook?.id ? "active" : ""}`}>
              <button className="nb-name" onClick={() => void openNotebook(notebook.id)}>{notebook.id === activeNotebook?.id ? activeNotebook.name : notebook.name}</button>
              <span className="nb-actions">
                <button title="Duplicate notebook" onClick={() => void duplicateNotebook(notebook.id)}>⧉</button>
                <button title="Delete notebook" onClick={() => void deleteNotebook(notebook.id)}>×</button>
              </span>
            </div>
          ))}
        </div>
        <div className="side-section">
          <div className="section-label"><span>Connections</span></div>
          {state.configuredConnections.map((name) => (
            <button key={name} className={`connection ${name === activeConnection ? "active" : ""}`} onClick={() => void connect(name)}>
              <span className={`status-dot ${sessions[name] ? "online" : ""}`}>●</span>
              <span>{name}</span>
              {sessions[name]?.dirty && <span className="dirty-dot" title="Uncommitted changes">●</span>}
            </button>
          ))}
        </div>
        <div className="side-section objects">
          <div className="section-label"><span>Schema</span></div>
          <input className="object-search" placeholder="filter…" value={objectFilter} onChange={(event) => setObjectFilter(event.target.value)} />
          <div className="object-list">
            {filteredTables.map((table) => (
              <div key={table.name}>
                <button className="object-row" title="Double-click to query" onClick={() => setExpandedTable((value) => value === table.name ? undefined : table.name)} onDoubleClick={() => addCell(`select * from ${table.name}`)}>
                  <span className="twig">{expandedTable === table.name ? "▾" : "▸"}</span><span>{table.name}</span>
                </button>
                {expandedTable === table.name && table.columns.map((column) => (
                  <div className="column-row" key={column.name} title={column.dataType}>
                    <span className="key-mark">{column.primaryKey ? "◆" : ""}</span><span>{column.name}</span><small>{column.dataType?.toLowerCase()}</small>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
        <div className="side-section compact-list">
          <div className="section-label"><span>Templates</span></div>
          {Object.entries(state.templates).map(([name, sql]) => <button key={name} onClick={() => openTemplate(sql)}>{name}</button>)}
          {!Object.keys(state.templates).length && <span className="empty">none saved</span>}
        </div>
        <div className="side-section compact-list history-list">
          <div className="section-label"><span>History</span></div>
          {history.slice(0, 8).map((sql, index) => <button key={index} title={sql} onClick={() => addCell(sql)}>{sql}</button>)}
        </div>
      </aside>

      <main className="main">
        {globalError && <div className="global-error"><span>{globalError}</span><button onClick={() => setGlobalError(undefined)}>×</button></div>}
        <section className="notebook">
          <div className="notebook-heading">
            <input
              className="doc-title"
              title="Rename notebook"
              value={activeNotebook?.name ?? ""}
              placeholder="untitled"
              onChange={(event) => setActiveNotebook((current) => current ? { ...current, name: event.target.value } : current)}
            />
            <div className="doc-meta">{activeConnection ?? "no connection"} · {cells.length} cell{cells.length === 1 ? "" : "s"}</div>
          </div>
          {cells.map((cell, index) => (
            <article className={`cell ${cell.error ? "failed" : ""}`} key={cell.id}>
              <div className="cell-head">
                <span className="idx">{index + 1}</span>
                <button
                  className={cell.running ? "running" : ""}
                  title={cell.running ? "Cancel" : "Run (⌘↩)"}
                  disabled={!activeConnection}
                  onClick={() => cell.running ? void cancel(cell) : void run(cell)}
                >{cell.running ? "■ cancel" : "▶ run"}</button>
                <span className="grow" />
                <button title="Save as template" onClick={() => void saveTemplate(cell.sql)}>☆</button>
                <button className="danger" title="Remove cell" disabled={cells.length === 1} onClick={() => setCells((current) => current.filter(({ id }) => id !== cell.id))}>×</button>
              </div>
              <div className="cell-body">
                <SqlEditor
                  value={cell.sql}
                  catalog={catalog}
                  autoFocus={focusCell.current === cell.id}
                  onChange={(sql) => updateCell(cell.id, { sql })}
                  onRun={() => void run({ ...cell, sql: cell.sql })}
                  onRunAndAdd={() => { void run(cell); addCell(); }}
                />
                {cell.error && <div className="cell-error">{cell.error}</div>}
                {cell.result?.kind === "query" && activeConnection && (
                  <ResultGrid
                    result={cell.result}
                    sql={cell.sql}
                    catalog={catalog}
                    connection={activeConnection}
                    onResultChange={(result) => updateCell(cell.id, { result })}
                    onMutation={(committed) => markMutation(activeConnection, committed)}
                  />
                )}
                {cell.result?.kind === "mutation" && <div className="mutation-result"><b>{cell.result.rowsAffected} rows affected</b> · {cell.result.elapsedMs} ms · {cell.result.committed ? "committed" : "pending"}</div>}
              </div>
            </article>
          ))}
          <button className="add-cell" onClick={() => addCell()}><span className="caret" />select …</button>
        </section>
      </main>

      <footer className="statusbar">
        <strong className="product-name">Acid</strong>
        <button title="Toggle sidebar" onClick={() => setSidebarOpen((value) => !value)}>▤</button>
        <span>
          <span className={activeSession ? "ok" : ""}>● </span>
          <span className="conn-name">{activeConnection ?? "no connection"}</span>
        </span>
        {activeSession && (
          <button
            title="Toggle autocommit"
            onClick={() => void setAutoCommit(!activeSession.autoCommit)}
          >autocommit {activeSession.autoCommit ? "on" : "off"}</button>
        )}
        {activeSession?.dirty && <span className="warn">● uncommitted</span>}
        {activeSession && !activeSession.autoCommit && (
          <>
            <button className="commit" disabled={!activeSession.dirty} onClick={() => void finishTransaction("commit")}>✓ commit</button>
            <button className="rollback" disabled={!activeSession.dirty} onClick={() => void finishTransaction("rollback")}>↺ rollback</button>
          </>
        )}
        <span className="grow" />
        <button title="Theme (follows system on auto)" onClick={() => setTheme((current) => current === "auto" ? "light" : current === "light" ? "dark" : "auto")}>◐ {theme}</button>
        <span className={saveStatus === "error" ? "err" : ""}>{saveStatus === "saving" ? "saving…" : saveStatus === "error" ? "save failed" : "saved"}</span>
        <span className="hint"><kbd>⌘</kbd><kbd>↩</kbd> run</span>
        <span className="hint"><kbd>⌘</kbd><kbd>⇧</kbd><kbd>↩</kbd> run + new cell</span>
      </footer>
    </div>
  );
}

function toSummary({ id, name, connection, updatedAt }: NotebookDocument): NotebookSummary {
  return { id, name, connection, updatedAt };
}
