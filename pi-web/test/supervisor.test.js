import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionStore } from "../src/store.js";
import { SessionSupervisor } from "../src/supervisor.js";

const fakePiSource = `#!/usr/bin/env node
const sessionIndex = process.argv.indexOf("--session");
const sessionFile = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : undefined;
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n");
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    const response = { id: command.id, type: "response", command: command.type, success: true };
    if (command.type === "get_state") response.data = {
      sessionId: "session-id", sessionFile, thinkingLevel: "off", isStreaming: false,
      isCompacting: false, autoCompactionEnabled: true,
    };
    if (command.type === "get_messages") response.data = { messages: [] };
    if (command.type === "get_commands") response.data = { commands: [] };
    if (command.type === "get_available_models") response.data = { models: [] };
    if (command.type === "get_available_thinking_levels") response.data = { levels: ["off"] };
    if (command.type === "get_session_stats") response.data = { cost: 0, tokens: {} };
    process.stdout.write(JSON.stringify(response) + "\\n");
  }
});
`;

test("supervisor stops and permanently deletes a managed session", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-supervisor-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const dataDir = join(directory, "data");
  const sessionDir = join(directory, "sessions");
  const cwd = join(directory, "project");
  const projectSessions = join(sessionDir, "project");
  await Promise.all([mkdir(dataDir), mkdir(cwd), mkdir(projectSessions, { recursive: true })]);
  const sessionFile = join(projectSessions, "session.jsonl");
  await writeFile(sessionFile, "{}\n");
  const executable = join(directory, "fake-pi");
  await writeFile(executable, fakePiSource);
  await chmod(executable, 0o700);

  const store = new SessionStore(dataDir);
  await store.load();
  await store.put({ id: "session-id", cwd, sessionFile, createdAt: 1, updatedAt: 1, approveProject: false });
  const supervisor = new SessionSupervisor({ piBin: executable, rpcTimeoutMs: 2_000, sessionDir }, store);
  context.after(() => supervisor.close());
  await supervisor.attach("session-id");

  await supervisor.deleteSession("session-id");

  assert.equal(store.get("session-id"), undefined);
  assert.deepEqual(supervisor.list(), []);
  await assert.rejects(() => access(sessionFile), { code: "ENOENT" });
});
