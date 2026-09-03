import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const functionStart = app.indexOf("function conversationRows(");
const functionEnd = app.indexOf("\nfunction renderConversation(", functionStart);
assert.notEqual(functionStart, -1);
assert.notEqual(functionEnd, -1);
const conversationRows = vm.runInNewContext(`${app.slice(functionStart, functionEnd)}\nconversationRows;`);

const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const thought = (text) => ({
  role: "assistant",
  content: [
    { type: "thinking", thinking: text },
    { type: "toolCall", id: text, name: "read", arguments: {} },
  ],
});
const toolResult = (id) => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text: "result" }] });

test("hidden tool execution keeps only the latest thinking placeholder", () => {
  const messages = [user("research this"), thought("Planning"), toolResult("one"), thought("Reading"), toolResult("two")];
  const rows = conversationRows(messages, thought("Comparing the latest results"), false, true);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].message.role, "user");
  assert.equal(rows[1].message.content.length, 1);
  assert.equal(rows[1].message.content[0].thinking, "Comparing the latest results");
  assert.equal(rows[1].streaming, true);
});

test("a final answer with thinking replaces the pending placeholder", () => {
  const final = {
    role: "assistant",
    content: [{ type: "thinking", thinking: "Writing the answer" }, { type: "text", text: "Final answer" }],
  };
  const rows = conversationRows([user("question"), thought("Earlier thought"), toolResult("one"), final], undefined, false, true);

  assert.equal(rows.length, 2);
  assert.equal(rows[1].message.content[1].text, "Final answer");
});

test("a final answer without thinking retains one preceding placeholder", () => {
  const final = { role: "assistant", content: [{ type: "text", text: "Final answer" }] };
  const rows = conversationRows([
    user("question"), thought("First thought"), toolResult("one"), thought("Latest thought"), toolResult("two"), final,
  ], undefined, false, true);

  assert.equal(rows.length, 3);
  assert.equal(rows[1].message.content[0].thinking, "Latest thought");
  assert.equal(rows[2].message, final);
});

test("showing tools preserves every transcript row", () => {
  const messages = [user("question"), thought("First thought"), toolResult("one"), thought("Second thought")];
  const partial = thought("Streaming thought");
  const rows = conversationRows(messages, partial, true, true);

  assert.equal(rows.length, messages.length + 1);
  assert.equal(rows[2].message.role, "toolResult");
  assert.equal(rows.at(-1).message, partial);
});
