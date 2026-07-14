import type { ConnectionConfig, DatabaseCatalog, ExecutionResult, LobReference, MutationResult, RowDuplicate, RowInsert, RowUpdate } from "../core/types.js";

export interface DatabaseSession {
  execute(sql: string, autoCommit: boolean, fetchLimit: number): Promise<ExecutionResult>;
  loadCatalog(): Promise<DatabaseCatalog>;
  updateRow(update: RowUpdate, autoCommit: boolean): Promise<MutationResult>;
  insertRow(insert: RowInsert, autoCommit: boolean): Promise<MutationResult>;
  duplicateRow(duplicate: RowDuplicate, autoCommit: boolean): Promise<MutationResult>;
  readLob(reference: LobReference): Promise<Buffer | string | null>;
  writeLob(reference: LobReference, content: Buffer | string, autoCommit: boolean): Promise<MutationResult>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

export interface DatabaseAdapter {
  readonly type: ConnectionConfig["type"];
  connect(config: ConnectionConfig): Promise<DatabaseSession>;
}
