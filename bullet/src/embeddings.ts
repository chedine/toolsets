import { getAllVectors, putVector } from "./idb";
import type { Chunk } from "./search";

// Semantic layer over the same chunks BM25 indexes. Vectors are
// computed in a worker, cached in IndexedDB by content hash, and
// searched by brute-force cosine — at vault scale (tens of thousands
// of chunks) that is single-digit milliseconds.

export interface VectorHit {
  chunk: Chunk;
  score: number;
}

const BATCH = 16;

// Cosine top-k always returns k "nearest" chunks no matter how far
// away they are; without a floor, weak queries drag in noise. For
// MiniLM embeddings ~0.35 separates topical relevance from chance.
const MIN_SCORE = 0.35;

const hashOf = (chunk: Chunk) => chunk.id.split("::").pop()!;

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<
  number,
  { resolve: (vecs: Float32Array[]) => void; reject: (err: Error) => void }
>();

// chunk registry (mirrors the BM25 index) and the vector cache
const registry = new Map<string, Chunk>(); // chunk id → chunk
let vectors = new Map<string, Float32Array>(); // content hash → vector

let cacheLoaded: Promise<void> | null = null;
let modelReady = false;
let pumping = false;
let progressFn: ((msg: string) => void) | undefined;

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./embed.worker.ts", import.meta.url), {
    type: "module",
  });
  worker.onmessage = (e) => {
    const { id, dim, data, error } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error) {
      p.reject(new Error(error));
      return;
    }
    modelReady = true;
    const vecs: Float32Array[] = [];
    for (let i = 0; i < data.length / dim; i++) {
      vecs.push(data.slice(i * dim, (i + 1) * dim));
    }
    p.resolve(vecs);
  };
  return worker;
}

function embed(texts: string[]): Promise<Float32Array[]> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ensureWorker().postMessage({ id, texts });
  });
}

async function loadCache(): Promise<void> {
  cacheLoaded ??= getAllVectors()
    .then((m) => {
      vectors = m;
    })
    .catch(() => {});
  await cacheLoaded;
}

// Embed every registered chunk that has no cached vector yet.
async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    await loadCache();
    for (;;) {
      const todo: Chunk[] = [];
      for (const chunk of registry.values()) {
        if (!vectors.has(hashOf(chunk))) {
          todo.push(chunk);
          if (todo.length >= BATCH) break;
        }
      }
      if (todo.length === 0) break;
      const vecs = await embed(todo.map((c) => c.text));
      todo.forEach((chunk, i) => {
        const h = hashOf(chunk);
        vectors.set(h, vecs[i]);
        void putVector(h, vecs[i]);
      });
      const missing = [...registry.values()].filter(
        (c) => !vectors.has(hashOf(c)),
      ).length;
      if (missing > 0 && missing % 5 === 0) {
        progressFn?.(`embedding… ${missing} chunks left`);
      }
    }
  } catch (err) {
    console.error("embedding pump failed", err);
  } finally {
    pumping = false;
  }
}

export function startEmbeddings(progress?: (msg: string) => void): void {
  progressFn = progress;
  void pump();
}

export function setChunks(path: string, chunks: Chunk[]): void {
  removePath(path);
  for (const c of chunks) registry.set(c.id, c);
  if (modelReady) void pump(); // pick up new text in the background
}

export function removePath(path: string): void {
  for (const [id, c] of registry) {
    if (c.path === path) registry.delete(id);
  }
}

// Cosine top-k over embedded chunks. Returns [] until at least some
// chunk vectors exist (cached or freshly pumped); embedding the query
// itself loads the model on first use — a few seconds once, then warm.
export async function vectorSearch(
  query: string,
  k: number,
): Promise<VectorHit[]> {
  await loadCache();
  let anyVector = false;
  for (const chunk of registry.values()) {
    if (vectors.has(hashOf(chunk))) {
      anyVector = true;
      break;
    }
  }
  if (!anyVector) {
    void pump(); // start embedding the backlog; lexical covers meanwhile
    return [];
  }
  let qv: Float32Array;
  try {
    [qv] = await embed([query]);
  } catch (err) {
    console.error("query embedding failed", err);
    return [];
  }
  const hits: VectorHit[] = [];
  for (const chunk of registry.values()) {
    const v = vectors.get(hashOf(chunk));
    if (!v) continue;
    let dot = 0;
    for (let i = 0; i < v.length; i++) dot += v[i] * qv[i];
    if (dot >= MIN_SCORE) hits.push({ chunk, score: dot }); // normalized vectors
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, k);
}

export function embeddingsReady(): boolean {
  return modelReady;
}
