import oracledb from "oracledb";
import type { ConnectionConfig, DatabaseCatalog, ExecutionResult, LobReference, LobValue, MutationResult, OracleConnectionConfig, RowDuplicate, RowInsert, RowUpdate } from "../core/types.js";
import type { DatabaseAdapter, DatabaseSession } from "./adapter.js";

export class OracleAdapter implements DatabaseAdapter {
  readonly type = "oracle" as const;

  async connect(config: ConnectionConfig): Promise<DatabaseSession> {
    const oracle = config as OracleConnectionConfig;
    const password = resolveSecret(oracle.password, oracle.passwordEnv, "database password", !oracle.externalAuth);
    const walletPassword = resolveSecret(oracle.walletPassword, oracle.walletPasswordEnv, "wallet password", false);
    const attributes: oracledb.ConnectionAttributes = {
      user: oracle.username,
      password,
      externalAuth: oracle.externalAuth,
      connectString: makeConnectString(oracle),
    };

    // Thin mode accepts these properties, although older type definitions omit them.
    const thinAttributes = attributes as oracledb.ConnectionAttributes & {
      configDir?: string;
      walletLocation?: string;
      walletPassword?: string;
    };
    if (oracle.tnsAdmin) thinAttributes.configDir = oracle.tnsAdmin;
    if (oracle.walletLocation) thinAttributes.walletLocation = oracle.walletLocation;
    if (walletPassword) thinAttributes.walletPassword = walletPassword;

    return new OracleSession(await oracledb.getConnection(thinAttributes));
  }
}

class OracleSession implements DatabaseSession {
  constructor(private readonly connection: oracledb.Connection) {}

  async execute(sql: string, autoCommit: boolean, fetchLimit: number): Promise<ExecutionResult> {
    const started = performance.now();
    const result = await this.connection.execute<unknown[]>(sql, [], {
      autoCommit,
      outFormat: oracledb.OUT_FORMAT_ARRAY,
      maxRows: fetchLimit + 1,
    });
    const elapsedMs = Math.round(performance.now() - started);

    if (result.metaData) {
      const allRows = (result.rows ?? []) as unknown[][];
      await replaceLobsWithMetadata(allRows, result.metaData);
      return {
        kind: "query",
        columns: result.metaData.map((column) => ({
          name: column.name,
          dbTypeName: column.dbTypeName,
          nullable: column.nullable,
        })),
        rows: allRows.slice(0, fetchLimit),
        elapsedMs,
        truncated: allRows.length > fetchLimit,
      };
    }

    return {
      kind: "mutation",
      rowsAffected: result.rowsAffected ?? 0,
      elapsedMs,
      committed: autoCommit,
    };
  }

  async loadCatalog(): Promise<DatabaseCatalog> {
    const result = await this.connection.execute<[string, string, string, number, number]>(
      `SELECT c.table_name, c.column_name, c.data_type,
              CASE WHEN pk.column_name IS NULL THEN 0 ELSE 1 END AS is_primary_key,
              CASE WHEN ident.column_name IS NULL THEN 0 ELSE 1 END AS is_identity
         FROM user_tab_columns c
         LEFT JOIN (
           SELECT cc.table_name, cc.column_name
             FROM user_constraints con
             JOIN user_cons_columns cc ON cc.constraint_name = con.constraint_name
            WHERE con.constraint_type = 'P'
         ) pk ON pk.table_name = c.table_name AND pk.column_name = c.column_name
         LEFT JOIN user_tab_identity_cols ident
           ON ident.table_name = c.table_name AND ident.column_name = c.column_name
        ORDER BY c.table_name, c.column_id`,
      [],
      { outFormat: oracledb.OUT_FORMAT_ARRAY, maxRows: 100_000 },
    );
    const byTable = new Map<string, { name: string; columns: { name: string; dataType?: string; primaryKey?: boolean; identity?: boolean }[] }>();
    for (const [tableName, columnName, dataType, primaryKey, identity] of result.rows ?? []) {
      let table = byTable.get(tableName);
      if (!table) {
        table = { name: tableName, columns: [] };
        byTable.set(tableName, table);
      }
      table.columns.push({ name: columnName, dataType, primaryKey: primaryKey === 1, identity: identity === 1 });
    }
    return { tables: [...byTable.values()] };
  }

  async updateRow(update: RowUpdate, autoCommit: boolean): Promise<MutationResult> {
    const changes = Object.entries(update.changes);
    const keys = Object.entries(update.keys);
    if (!changes.length) throw new Error("No row changes supplied");
    if (!keys.length) throw new Error("A primary key is required to update a row");
    const binds: Record<string, unknown> = {};
    const setSql = changes.map(([name, value], index) => {
      binds[`set${index}`] = value;
      return `${oracleIdentifier(name)} = :set${index}`;
    }).join(", ");
    const whereSql = keys.map(([name, value], index) => {
      binds[`key${index}`] = value;
      return `${oracleIdentifier(name)} = :key${index}`;
    }).join(" AND ");
    const started = performance.now();
    const result = await this.connection.execute(
      `UPDATE ${oracleIdentifier(update.table, true)} SET ${setSql} WHERE ${whereSql}`,
      binds as oracledb.BindParameters,
      { autoCommit },
    );
    return {
      kind: "mutation",
      rowsAffected: result.rowsAffected ?? 0,
      elapsedMs: Math.round(performance.now() - started),
      committed: autoCommit,
    };
  }

  async insertRow(insert: RowInsert, autoCommit: boolean): Promise<MutationResult> {
    const values = Object.entries(insert.values);
    if (!values.length) throw new Error("No values supplied for the new row");
    const binds = Object.fromEntries(values.map(([, value], index) => [`value${index}`, value]));
    const started = performance.now();
    const result = await this.connection.execute(
      `INSERT INTO ${oracleIdentifier(insert.table, true)} (${values.map(([name]) => oracleIdentifier(name)).join(", ")}) VALUES (${values.map((_, index) => `:value${index}`).join(", ")})`,
      binds as oracledb.BindParameters,
      { autoCommit },
    );
    return mutation(result.rowsAffected, started, autoCommit);
  }

  async duplicateRow(duplicate: RowDuplicate, autoCommit: boolean): Promise<MutationResult> {
    if (!duplicate.columns.length) throw new Error("No duplicate columns supplied");
    const { clause, binds } = whereClause(duplicate.keys);
    const overrideEntries = Object.entries(duplicate.overrides);
    overrideEntries.forEach(([, value], index) => { binds[`override${index}`] = value; });
    const overrideIndexes = new Map(overrideEntries.map(([name], index) => [name.toUpperCase(), index]));
    const selectValues = duplicate.columns.map((column) => {
      const index = overrideIndexes.get(column.toUpperCase());
      return index === undefined ? oracleIdentifier(column) : `:override${index}`;
    });
    const started = performance.now();
    const result = await this.connection.execute(
      `INSERT INTO ${oracleIdentifier(duplicate.table, true)} (${duplicate.columns.map((column) => oracleIdentifier(column)).join(", ")}) SELECT ${selectValues.join(", ")} FROM ${oracleIdentifier(duplicate.table, true)} WHERE ${clause}`,
      binds as oracledb.BindParameters,
      { autoCommit },
    );
    return mutation(result.rowsAffected, started, autoCommit);
  }

  async readLob(reference: LobReference): Promise<Buffer | string | null> {
    const { clause, binds } = whereClause(reference.keys);
    const result = await this.connection.execute<unknown[]>(
      `SELECT ${oracleIdentifier(reference.column)} FROM ${oracleIdentifier(reference.table, true)} WHERE ${clause}`,
      binds as oracledb.BindParameters,
      { outFormat: oracledb.OUT_FORMAT_ARRAY, maxRows: 2 },
    );
    if (!result.rows?.length) throw new Error("LOB row no longer exists");
    if (result.rows.length > 1) throw new Error("LOB lookup matched more than one row");
    const value = result.rows[0][0];
    if (value == null) return null;
    if (Buffer.isBuffer(value) || typeof value === "string") return value;
    const lob = value as oracledb.Lob;
    try {
      return await lob.getData();
    } finally {
      lob.destroy();
    }
  }

  async writeLob(reference: LobReference, content: Buffer | string, autoCommit: boolean): Promise<MutationResult> {
    const { clause, binds } = whereClause(reference.keys);
    const started = performance.now();
    const value = reference.kind === "BLOB"
      ? { val: Buffer.isBuffer(content) ? content : Buffer.from(content), type: oracledb.BLOB }
      : { val: Buffer.isBuffer(content) ? content.toString("utf8") : content, type: oracledb.CLOB };
    const result = await this.connection.execute(
      `UPDATE ${oracleIdentifier(reference.table, true)} SET ${oracleIdentifier(reference.column)} = :lobValue WHERE ${clause}`,
      { ...binds, lobValue: value } as oracledb.BindParameters,
      { autoCommit },
    );
    return mutation(result.rowsAffected, started, autoCommit);
  }

  async commit(): Promise<void> { await this.connection.commit(); }
  async rollback(): Promise<void> { await this.connection.rollback(); }
  async cancel(): Promise<void> { await this.connection.break(); }
  async close(): Promise<void> { await this.connection.close(); }
}

async function replaceLobsWithMetadata(
  rows: unknown[][],
  metadata: Array<{ dbTypeName?: string }>,
): Promise<void> {
  for (const row of rows) {
    for (let index = 0; index < row.length; index++) {
      const dbType = metadata[index]?.dbTypeName?.toUpperCase();
      const kind = dbType === "BLOB" ? "BLOB" : dbType?.includes("CLOB") ? "CLOB" : undefined;
      if (!kind || row[index] == null) continue;
      const value = row[index] as oracledb.Lob & { length?: number };
      const placeholder: LobValue = { __dbcLob: true, kind, size: value.length };
      if (typeof value.destroy === "function") value.destroy();
      row[index] = placeholder;
    }
  }
}

function whereClause(keys: Record<string, unknown>): { clause: string; binds: Record<string, unknown> } {
  const entries = Object.entries(keys);
  if (!entries.length) throw new Error("A primary key is required");
  const binds: Record<string, unknown> = {};
  const clause = entries.map(([name, value], index) => {
    binds[`key${index}`] = value;
    return `${oracleIdentifier(name)} = :key${index}`;
  }).join(" AND ");
  return { clause, binds };
}

function mutation(rowsAffected: number | undefined, started: number, committed: boolean): MutationResult {
  return {
    kind: "mutation",
    rowsAffected: rowsAffected ?? 0,
    elapsedMs: Math.round(performance.now() - started),
    committed,
  };
}

function resolveSecret(
  literal: string | undefined,
  environmentName: string | undefined,
  label: string,
  required = true,
): string | undefined {
  if (environmentName) {
    const value = process.env[environmentName];
    if (value === undefined) throw new Error(`${label} environment variable ${environmentName} is not set`);
    return value;
  }
  if (literal !== undefined) return literal;
  if (required) throw new Error(`No ${label} configured; use passwordEnv or password`);
  return undefined;
}

function oracleIdentifier(value: string, allowQualified = false): string {
  const pattern = allowQualified
    ? /^[A-Za-z][A-Za-z0-9_$#]*(\.[A-Za-z][A-Za-z0-9_$#]*)?$/
    : /^[A-Za-z][A-Za-z0-9_$#]*$/;
  if (!pattern.test(value)) throw new Error(`Invalid Oracle identifier: ${value}`);
  return value.split(".").map((part) => `"${part.toUpperCase()}"`).join(".");
}

export function makeConnectString(config: OracleConnectionConfig): string {
  if (config.tnsAlias) return config.tnsAlias;
  if (!config.host) throw new Error("Oracle connection needs host or tnsAlias");
  const port = config.port ?? 1521;
  if (config.service) return `${config.host}:${port}/${config.service}`;
  if (config.sid) {
    return `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${config.host})(PORT=${port}))(CONNECT_DATA=(SID=${config.sid})))`;
  }
  throw new Error("Oracle connection needs service, sid, or tnsAlias");
}
