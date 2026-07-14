import type { AppConfig, DatabaseCatalog, ExecutionResult, LobReference, MutationResult, RowDuplicate, RowInsert, RowUpdate, SessionInfo } from "./types.js";
import type { DatabaseAdapter, DatabaseSession } from "../db/adapter.js";

interface ManagedSession extends SessionInfo {
  session: DatabaseSession;
  catalog?: DatabaseCatalog;
  catalogPromise?: Promise<DatabaseCatalog>;
}

export class ConnectionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private activeName?: string;

  constructor(
    private readonly config: AppConfig,
    private readonly adapters: Map<string, DatabaseAdapter>,
  ) {}

  get active(): SessionInfo | undefined {
    const session = this.activeName ? this.sessions.get(this.activeName) : undefined;
    return session ? info(session) : undefined;
  }

  configuredNames(): string[] { return Object.keys(this.config.connections); }
  sessionInfos(): SessionInfo[] { return [...this.sessions.values()].map(info); }

  async connect(name: string): Promise<SessionInfo> {
    const existing = this.sessions.get(name);
    if (existing) {
      this.activeName = name;
      return info(existing);
    }
    const connectionConfig = this.config.connections[name];
    if (!connectionConfig) throw new Error(`Unknown connection: ${name}`);
    const adapter = this.adapters.get(connectionConfig.type);
    if (!adapter) throw new Error(`No adapter installed for ${connectionConfig.type}`);
    const managed: ManagedSession = {
      name,
      autoCommit: false,
      dirty: false,
      session: await adapter.connect(connectionConfig),
    };
    this.sessions.set(name, managed);
    this.activeName = name;
    return info(managed);
  }

  use(name: string): SessionInfo {
    const session = this.sessions.get(name);
    if (!session) throw new Error(`${name} is not connected; run /connect ${name}`);
    this.activeName = name;
    return info(session);
  }

  setAutoCommit(enabled: boolean): SessionInfo {
    return this.setAutoCommitOn(this.requireActive().name, enabled);
  }

  setAutoCommitOn(name: string, enabled: boolean): SessionInfo {
    const session = this.requireSession(name);
    if (enabled && !session.autoCommit && session.dirty) {
      throw new Error("Commit or rollback the current transaction before enabling autocommit");
    }
    session.autoCommit = enabled;
    return info(session);
  }

  async execute(sql: string): Promise<ExecutionResult> {
    return this.executeOn(this.requireActive().name, sql);
  }

  async executeOn(name: string, sql: string): Promise<ExecutionResult> {
    const managed = this.requireSession(name);
    const result = await managed.session.execute(sql, managed.autoCommit, this.config.fetchLimit ?? 100);
    if (result.kind === "mutation") managed.dirty = !result.committed && result.rowsAffected > 0;
    return result;
  }

  async updateRowOn(name: string, update: RowUpdate): Promise<MutationResult> {
    const managed = this.requireSession(name);
    return this.trackMutation(managed, await managed.session.updateRow(update, managed.autoCommit));
  }

  async insertRowOn(name: string, insert: RowInsert): Promise<MutationResult> {
    const managed = this.requireSession(name);
    return this.trackMutation(managed, await managed.session.insertRow(insert, managed.autoCommit));
  }

  async duplicateRowOn(name: string, duplicate: RowDuplicate): Promise<MutationResult> {
    const managed = this.requireSession(name);
    return this.trackMutation(managed, await managed.session.duplicateRow(duplicate, managed.autoCommit));
  }

  async readLobOn(name: string, reference: LobReference): Promise<Buffer | string | null> {
    return this.requireSession(name).session.readLob(reference);
  }

  async writeLobOn(name: string, reference: LobReference, content: Buffer | string): Promise<MutationResult> {
    const managed = this.requireSession(name);
    return this.trackMutation(managed, await managed.session.writeLob(reference, content, managed.autoCommit));
  }

  async commit(): Promise<void> {
    return this.commitOn(this.requireActive().name);
  }

  async commitOn(name: string): Promise<void> {
    const managed = this.requireSession(name);
    await managed.session.commit();
    managed.dirty = false;
  }

  async rollback(): Promise<void> {
    return this.rollbackOn(this.requireActive().name);
  }

  async rollbackOn(name: string): Promise<void> {
    const managed = this.requireSession(name);
    await managed.session.rollback();
    managed.dirty = false;
  }

  async catalog(refresh = false): Promise<DatabaseCatalog> {
    return this.catalogFor(this.requireActive().name, refresh);
  }

  async catalogFor(name: string, refresh = false): Promise<DatabaseCatalog> {
    const managed = this.requireSession(name);
    if (refresh) {
      managed.catalog = undefined;
      managed.catalogPromise = undefined;
    }
    if (managed.catalog) return managed.catalog;
    if (!managed.catalogPromise) {
      managed.catalogPromise = managed.session.loadCatalog()
        .then((catalog) => {
          managed.catalog = catalog;
          return catalog;
        })
        .finally(() => { managed.catalogPromise = undefined; });
    }
    return managed.catalogPromise;
  }

  async cancel(): Promise<void> {
    return this.cancelOn(this.requireActive().name);
  }

  async cancelOn(name: string): Promise<void> {
    await this.requireSession(name).session.cancel();
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.sessions.values()].map(({ session }) => session.close()));
    this.sessions.clear();
  }

  private trackMutation(managed: ManagedSession, result: MutationResult): MutationResult {
    if (result.rowsAffected > 0) managed.dirty = !result.committed;
    return result;
  }

  private requireActive(): ManagedSession {
    if (!this.activeName) throw new Error("No active connection; run /connect <name>");
    return this.requireSession(this.activeName);
  }

  private requireSession(name: string): ManagedSession {
    const session = this.sessions.get(name);
    if (!session) throw new Error(`${name} is not connected`);
    return session;
  }
}

const info = ({ name, autoCommit, dirty }: ManagedSession): SessionInfo => ({ name, autoCommit, dirty });
