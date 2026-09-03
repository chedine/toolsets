import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionStore } from "../src/store.js";

test("session registry persists and reloads records", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-store-"));
  context.after(() => rm(directory, { recursive: true, force: true }));

  const store = new SessionStore(directory);
  await store.load();
  await store.put({ id: "one", cwd: "/tmp/project", createdAt: 1, updatedAt: 1 });
  await store.update("one", { name: "Test", updatedAt: 2 });

  const reopened = new SessionStore(directory);
  await reopened.load();
  assert.deepEqual(reopened.get("one"), {
    id: "one",
    cwd: "/tmp/project",
    name: "Test",
    createdAt: 1,
    updatedAt: 2,
  });

  const persisted = JSON.parse(await readFile(join(directory, "sessions.json"), "utf8"));
  assert.equal(persisted.version, 1);
  assert.equal(persisted.sessions.length, 1);
});

test("session registry removes records durably", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-store-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SessionStore(directory);
  await store.load();
  await store.put({ id: "remove-me", cwd: "/tmp/project", createdAt: 1, updatedAt: 1 });

  assert.equal(await store.remove("remove-me"), true);
  assert.equal(await store.remove("remove-me"), false);
  const reopened = new SessionStore(directory);
  await reopened.load();
  assert.equal(reopened.get("remove-me"), undefined);
});

test("session registry returns newest sessions first and defensive copies", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-store-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SessionStore(directory);
  await store.load();
  await store.put({ id: "old", cwd: "/tmp/old", createdAt: 1, updatedAt: 1 });
  await store.put({ id: "new", cwd: "/tmp/new", createdAt: 2, updatedAt: 2 });

  const records = store.list();
  assert.deepEqual(records.map(({ id }) => id), ["new", "old"]);
  records[0].cwd = "changed";
  assert.equal(store.get("new").cwd, "/tmp/new");
});
