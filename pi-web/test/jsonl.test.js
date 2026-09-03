import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { attachJsonlReader, serializeJsonLine } from "../src/jsonl.js";

test("JSONL reader handles fragmented and coalesced LF records", async () => {
  const stream = new PassThrough();
  const lines = [];
  const detach = attachJsonlReader(stream, (line) => lines.push(line));
  stream.write('{"one":');
  stream.write('1}\n{"two":2}\n');
  stream.end('{"three":3}');
  await once(stream, "end");
  assert.deepEqual(lines, ['{"one":1}', '{"two":2}', '{"three":3}']);
  detach();
});

test("JSONL reader does not split Unicode line separators", () => {
  const stream = new PassThrough();
  const lines = [];
  attachJsonlReader(stream, (line) => lines.push(line));
  stream.end('{"text":"a b c"}\n');
  assert.deepEqual(lines, ['{"text":"a b c"}']);
});

test("serializer emits exactly one LF-delimited record", () => {
  assert.equal(serializeJsonLine({ text: "hello\nworld" }), '{"text":"hello\\nworld"}\n');
});
