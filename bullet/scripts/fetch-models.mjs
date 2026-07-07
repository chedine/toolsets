// Vendors the search-embedding and ask models into public/models/ so
// Bullet can run on machines/networks where huggingface.co is blocked.
// Run once from a machine with access:  node scripts/fetch-models.mjs
// Then deploy/copy the project including public/models (~1GB).
// The app prefers these local copies and falls back to HuggingFace.

import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "models");

// Keep in sync with src/embed.worker.ts
const EMBED_REPO = "Xenova/all-MiniLM-L6-v2";
const EMBED_FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/model_quantized.onnx", // transformers.js dtype "q8"
];

// Keep in sync with src/ask.ts
const ASK_MODEL = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";
const ASK_REPO = `mlc-ai/${ASK_MODEL}`;
// WebLLM's prebuilt lib for this model (see @mlc-ai/web-llm prebuiltAppConfig)
const ASK_WASM =
  "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/Qwen2-1.5B-Instruct-q4f16_1_cs1k-webgpu.wasm";

async function download(url, dest) {
  if (existsSync(dest) && statSync(dest).size > 0) {
    console.log(`  skip (exists) ${dest.slice(OUT.length + 1)}`);
    return;
  }
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  mkdirSync(dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  const mb = (statSync(dest).size / 1e6).toFixed(1);
  console.log(`  ${dest.slice(OUT.length + 1)}  (${mb} MB)`);
}

console.log(`embedding model: ${EMBED_REPO}`);
for (const f of EMBED_FILES) {
  await download(
    `https://huggingface.co/${EMBED_REPO}/resolve/main/${f}`,
    join(OUT, EMBED_REPO, f),
  );
}

// Layout mirrors HuggingFace (<model>/resolve/main/<file>) because
// WebLLM appends "resolve/main/" to every model URL it loads from.
console.log(`ask model: ${ASK_REPO}`);
const tree = await (
  await fetch(`https://huggingface.co/api/models/${ASK_REPO}/tree/main`)
).json();
for (const entry of tree) {
  if (entry.type !== "file") continue;
  await download(
    `https://huggingface.co/${ASK_REPO}/resolve/main/${entry.path}`,
    join(OUT, ASK_MODEL, "resolve", "main", entry.path),
  );
}
await download(ASK_WASM, join(OUT, ASK_MODEL, "resolve", "main", "lib.wasm"));

console.log(`\ndone -> ${OUT}`);
