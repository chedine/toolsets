export type OracleConnectionConfig = {
  type: "oracle";
  username?: string;
  externalAuth?: boolean;
  password?: string;
  passwordEnv?: string;
  host?: string;
  port?: number;
  service?: string;
  sid?: string;
  tnsAlias?: string;
  tnsAdmin?: string;
  walletLocation?: string;
  walletPassword?: string;
  walletPasswordEnv?: string;
};

export type ConnectionConfig = OracleConnectionConfig;

export type AppConfig = {
  defaultConnection?: string;
  fetchLimit?: number;
  connections: Record<string, ConnectionConfig>;
};

export type Column = { name: string; dbTypeName?: string; nullable?: boolean };

export type QueryResult = {
  kind: "query";
  columns: Column[];
  rows: unknown[][];
  elapsedMs: number;
  truncated: boolean;
};

export type MutationResult = {
  kind: "mutation";
  rowsAffected: number;
  elapsedMs: number;
  committed: boolean;
};

export type ExecutionResult = QueryResult | MutationResult;

export type SessionInfo = {
  name: string;
  autoCommit: boolean;
  dirty: boolean;
};

export type CatalogColumn = {
  name: string;
  dataType?: string;
  primaryKey?: boolean;
  identity?: boolean;
};

export type CatalogTable = {
  name: string;
  columns: CatalogColumn[];
};

export type DatabaseCatalog = {
  tables: CatalogTable[];
};

export type RowUpdate = {
  table: string;
  keys: Record<string, unknown>;
  changes: Record<string, unknown>;
  columnTypes?: Record<string, string>;
};

export type RowInsert = {
  table: string;
  values: Record<string, unknown>;
};

export type RowDuplicate = {
  table: string;
  keys: Record<string, unknown>;
  columns: string[];
  overrides: Record<string, unknown>;
  columnTypes?: Record<string, string>;
};

export type LobValue = {
  __dbcLob: true;
  kind: "BLOB" | "CLOB";
  size?: number;
};

export type LobReference = {
  table: string;
  column: string;
  keys: Record<string, unknown>;
  kind: "BLOB" | "CLOB";
};

export type NotebookDocument = {
  id: string;
  name: string;
  connection?: string;
  cells: Array<{ id: string; sql: string }>;
  createdAt: string;
  updatedAt: string;
};

export type NotebookSummary = Pick<NotebookDocument, "id" | "name" | "connection" | "updatedAt">;

export type Completion = {
  label: string;
  value: string;
  cursorOffset: number;
  detail?: string;
  kind: "command" | "connection" | "template" | "table" | "column" | "keyword";
};
