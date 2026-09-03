import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiRpcProcess } from "../src/rpc-process.js";

const fakePiSource = `#!/usr/bin/env node
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
    const base = { id: command.id, type: "response", command: command.type, success: true };
    if (command.type === "get_state") base.data = {
      thinkingLevel: "off", isStreaming: false, isCompacting: false,
      steeringMode: "one-at-a-time", followUpMode: "one-at-a-time",
      sessionId: "fake-session", sessionFile: "/tmp/fake.jsonl",
      autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0,
    };
    if (command.type === "get_messages") base.data = { messages: [] };
    if (command.type === "get_commands") base.data = { commands: [] };
    if (command.type === "get_available_models") base.data = { models: [] };
    if (command.type === "get_available_thinking_levels") base.data = { levels: ["off"] };
    if (command.type === "get_session_stats") base.data = {
      userMessages: 0, assistantMessages: 0, toolCalls: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    };
    if (command.type === "prompt") base.data = { images: command.images ?? [] };
    process.stdout.write(JSON.stringify(base) + "\\n");
    if (command.type === "prompt") process.stdout.write('{"type":"agent_settled"}\\n');
  }
});
`;

test("Pi RPC process starts, snapshots, requests, and streams events", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-rpc-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "fake-pi");
  await writeFile(executable, fakePiSource);
  await chmod(executable, 0o700);

  const rpc = new PiRpcProcess({
    piBin: executable,
    rpcTimeoutMs: 2_000,
    cwd: directory,
    name: "test",
    approveProject: false,
  });
  context.after(() => rpc.stop());

  const initialState = await rpc.start();
  assert.equal(initialState.sessionId, "fake-session");
  const snapshot = await rpc.snapshot();
  assert.equal(snapshot.state.sessionFile, "/tmp/fake.jsonl");
  assert.deepEqual(snapshot.thinkingLevels, ["off"]);
  assert.equal(snapshot.stats.cost, 0);

  const settled = new Promise((resolve) => {
    const unsubscribe = rpc.onEvent((event) => {
      if (event.type === "agent_settled") {
        unsubscribe();
        resolve();
      }
    });
  });
  const image = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
  const response = await rpc.request({ type: "prompt", message: "hello", images: [image] });
  assert.deepEqual(response.data.images, [image]);
  await settled;
});
