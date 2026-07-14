import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NotebookStore } from "./notebook-store.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))));

async function store(): Promise<NotebookStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dbc-notebooks-"));
  directories.push(directory);
  return new NotebookStore(directory);
}

describe("NotebookStore", () => {
  it("creates, saves and lists notebooks", async () => {
    const notebooks = await store();
    const created = await notebooks.create("Research", "xe");
    created.cells[0].sql = "select 1 from dual";
    await notebooks.save(created);
    expect(await notebooks.get(created.id)).toMatchObject({ name: "Research", cells: [{ sql: "select 1 from dual" }] });
    expect(await notebooks.list()).toMatchObject([{ id: created.id, name: "Research", connection: "xe" }]);
  });

  it("duplicates cells with new ids", async () => {
    const notebooks = await store();
    const created = await notebooks.create("Original");
    const duplicate = await notebooks.duplicate(created.id);
    expect(duplicate.name).toBe("Original copy");
    expect(duplicate.id).not.toBe(created.id);
    expect(duplicate.cells[0].id).not.toBe(created.cells[0].id);
  });
});
