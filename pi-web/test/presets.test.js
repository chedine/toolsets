import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPresets } from "../src/presets.js";

test("preset loader normalizes aliases and model objects", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-presets-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "presets.json");
  await writeFile(file, JSON.stringify({ version: 1, presets: [{
    name: "Grammar correction",
    baseLocation: "C:/tmp",
    specialInstructions: "Preserve the author's voice.",
    model: { provider: "test", modelId: "luna" },
  }] }));

  assert.deepEqual(await loadPresets(file), [{
    id: "grammar-correction",
    name: "Grammar correction",
    cwd: "C:/tmp",
    model: "test/luna",
    instructions: "Preserve the author's voice.",
    description: "",
    approveProject: false,
  }]);
});

test("missing preset file is an empty preset list", async () => {
  assert.deepEqual(await loadPresets(join(tmpdir(), "pi-web-no-such-presets.json")), []);
});
