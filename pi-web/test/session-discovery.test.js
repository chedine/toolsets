import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionDiscovery } from "../src/session-discovery.js";

async function writeSession(path, { id, cwd, name, model, message }) {
  const entries = [
    { type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd },
    ...(name ? [{ type: "session_info", id: `${id}-name`, name }] : []),
    { type: "model_change", id: `${id}-model`, provider: "test", modelId: model },
    { type: "message", id: `${id}-message`, message: { role: "user", content: [{ type: "text", text: message }] } },
  ];
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

test("native Pi sessions are searchable and identify managed records", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-discovery-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const sessionRoot = join(directory, "sessions");
  const projectA = join(directory, "project-a");
  const projectB = join(directory, "project-b");
  const group = join(sessionRoot, "group");
  await Promise.all([mkdir(group, { recursive: true }), mkdir(projectA), mkdir(projectB)]);

  const alpha = join(group, "alpha.jsonl");
  const beta = join(group, "beta.jsonl");
  await writeSession(alpha, {
    id: "alpha-id",
    cwd: projectA,
    name: "Alpha Refactor",
    model: "sonnet-test",
    message: "Fix the websocket timeout regression",
  });
  await writeSession(beta, {
    id: "beta-id",
    cwd: projectB,
    model: "haiku-test",
    message: "Plan the database migration",
  });
  await utimes(alpha, new Date(2_000), new Date(2_000));
  await utimes(beta, new Date(3_000), new Date(3_000));
  await writeFile(join(group, "damaged.jsonl"), "not json\n");

  const discovery = new SessionDiscovery(sessionRoot);
  const all = await discovery.search("");
  assert.deepEqual(all.map(({ id }) => id), ["beta-id", "alpha-id"]);
  assert.equal(all[0].displayName, "project-b");

  const byMessage = await discovery.search("websocket regression", [{ sessionFile: alpha }]);
  assert.equal(byMessage.length, 1);
  assert.equal(byMessage[0].id, "alpha-id");
  assert.equal(byMessage[0].managed, true);
  assert.match(byMessage[0].snippet, /websocket timeout/);

  const byMetadata = await discovery.search("Alpha sonnet project-a");
  assert.equal(byMetadata.length, 1);
  assert.match(byMetadata[0].sessionFile, /alpha\.jsonl$/);
  assert.equal(byMetadata[0].cwdExists, true);
});

test("session inspection rejects files outside the configured session directory", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-discovery-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const sessionRoot = join(directory, "sessions");
  const cwd = join(directory, "project");
  await Promise.all([mkdir(sessionRoot), mkdir(cwd)]);
  const outside = join(directory, "outside.jsonl");
  await writeSession(outside, {
    id: "outside-id",
    cwd,
    name: "Outside",
    model: "test",
    message: "not importable",
  });

  const discovery = new SessionDiscovery(sessionRoot);
  await assert.rejects(() => discovery.inspect(outside), /outside the configured Pi session directory/);
});
