import { describe, expect, it } from "vitest";
import { ConnectionManager } from "./connection-manager.js";
import type { DatabaseAdapter, DatabaseSession } from "../db/adapter.js";

const session: DatabaseSession = {
  execute: async (_sql, autoCommit) => ({ kind: "mutation", rowsAffected: 1, elapsedMs: 1, committed: autoCommit }),
  loadCatalog: async () => ({ tables: [] }),
  updateRow: async (_update, autoCommit) => ({ kind: "mutation", rowsAffected: 1, elapsedMs: 1, committed: autoCommit }),
  insertRow: async (_insert, autoCommit) => ({ kind: "mutation", rowsAffected: 1, elapsedMs: 1, committed: autoCommit }),
  duplicateRow: async (_duplicate, autoCommit) => ({ kind: "mutation", rowsAffected: 1, elapsedMs: 1, committed: autoCommit }),
  readLob: async () => Buffer.from("test"),
  writeLob: async (_reference, _content, autoCommit) => ({ kind: "mutation", rowsAffected: 1, elapsedMs: 1, committed: autoCommit }),
  commit: async () => undefined,
  rollback: async () => undefined,
  cancel: async () => undefined,
  close: async () => undefined,
};

const adapter: DatabaseAdapter = {
  type: "oracle",
  connect: async () => session,
};

describe("ConnectionManager", () => {
  it("keeps autocommit state per connection", async () => {
    const manager = makeManager();
    await manager.connect("one");
    manager.setAutoCommit(true);
    await manager.connect("two");
    expect(manager.active?.autoCommit).toBe(false);
    expect(manager.use("one").autoCommit).toBe(true);
  });

  it("requires a transaction decision before turning autocommit on", async () => {
    const manager = makeManager();
    await manager.connect("one");
    await manager.execute("update t set x=1");
    expect(() => manager.setAutoCommit(true)).toThrow("Commit or rollback");
    await manager.rollback();
    expect(manager.setAutoCommit(true).autoCommit).toBe(true);
  });
});

function makeManager(): ConnectionManager {
  return new ConnectionManager(
    { connections: { one: { type: "oracle" }, two: { type: "oracle" } } },
    new Map([["oracle", adapter]]),
  );
}
