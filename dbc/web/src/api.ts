import type { DatabaseCatalog, ExecutionResult, LobReference, NotebookDocument, NotebookSummary, RowDuplicate, RowInsert, RowUpdate, SessionInfo } from "../../src/core/types";

export type AppState = {
  defaultConnection?: string;
  configuredConnections: string[];
  sessions: SessionInfo[];
  templates: Record<string, string>;
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(url, {
    ...init,
    headers,
  });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  return body;
}

export const api = {
  state: (): Promise<AppState> => request("/api/state"),
  connect: (name: string): Promise<{ session: SessionInfo; catalog: DatabaseCatalog }> =>
    request(`/api/connections/${encodeURIComponent(name)}/connect`, { method: "POST" }),
  catalog: (name: string, refresh = false): Promise<DatabaseCatalog> =>
    request(`/api/connections/${encodeURIComponent(name)}/catalog?refresh=${refresh}`),
  query: (name: string, sql: string): Promise<ExecutionResult> =>
    request(`/api/connections/${encodeURIComponent(name)}/query`, { method: "POST", body: JSON.stringify({ sql }) }),
  autocommit: (name: string, enabled: boolean): Promise<SessionInfo> =>
    request(`/api/connections/${encodeURIComponent(name)}/autocommit`, { method: "POST", body: JSON.stringify({ enabled }) }),
  commit: (name: string): Promise<void> => request(`/api/connections/${encodeURIComponent(name)}/commit`, { method: "POST" }),
  rollback: (name: string): Promise<void> => request(`/api/connections/${encodeURIComponent(name)}/rollback`, { method: "POST" }),
  cancel: (name: string): Promise<void> => request(`/api/connections/${encodeURIComponent(name)}/cancel`, { method: "POST" }),
  updateRow: (name: string, update: RowUpdate): Promise<ExecutionResult> =>
    request(`/api/connections/${encodeURIComponent(name)}/rows/update`, { method: "POST", body: JSON.stringify(update) }),
  insertRow: (name: string, insert: RowInsert): Promise<ExecutionResult> =>
    request(`/api/connections/${encodeURIComponent(name)}/rows/insert`, { method: "POST", body: JSON.stringify(insert) }),
  duplicateRow: (name: string, duplicate: RowDuplicate): Promise<ExecutionResult> =>
    request(`/api/connections/${encodeURIComponent(name)}/rows/duplicate`, { method: "POST", body: JSON.stringify(duplicate) }),
  readLob: async (name: string, reference: LobReference): Promise<Blob | null> => {
    const response = await fetch(`/api/connections/${encodeURIComponent(name)}/lob/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reference),
    });
    if (response.status === 204) return null;
    if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? response.statusText);
    return response.blob();
  },
  writeLob: async (name: string, reference: LobReference, content: Blob): Promise<ExecutionResult> => {
    const form = new FormData();
    form.append("reference", JSON.stringify(reference));
    form.append("content", content, "content.bin");
    const response = await fetch(`/api/connections/${encodeURIComponent(name)}/lob/write`, { method: "POST", body: form });
    const body = await response.json() as ExecutionResult & { error?: string };
    if (!response.ok) throw new Error(body.error ?? response.statusText);
    return body;
  },
  notebooks: (): Promise<NotebookSummary[]> => request("/api/notebooks"),
  createNotebook: (name: string, connection?: string): Promise<NotebookDocument> =>
    request("/api/notebooks", { method: "POST", body: JSON.stringify({ name, connection }) }),
  getNotebook: (id: string): Promise<NotebookDocument> => request(`/api/notebooks/${encodeURIComponent(id)}`),
  saveNotebook: (document: NotebookDocument): Promise<NotebookDocument> =>
    request(`/api/notebooks/${encodeURIComponent(document.id)}`, { method: "PUT", body: JSON.stringify(document) }),
  duplicateNotebook: (id: string): Promise<NotebookDocument> =>
    request(`/api/notebooks/${encodeURIComponent(id)}/duplicate`, { method: "POST" }),
  deleteNotebook: (id: string): Promise<{ removed: boolean }> =>
    request(`/api/notebooks/${encodeURIComponent(id)}`, { method: "DELETE" }),
  saveTemplate: (name: string, sql: string): Promise<void> =>
    request(`/api/templates/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ sql }) }),
};
