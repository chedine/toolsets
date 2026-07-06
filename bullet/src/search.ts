import MiniSearch, { type Options } from "minisearch";
import { kvGet, kvSet } from "./idb";
import { buildTree, type TreeNode } from "./vault";
import {
  removePath as removeVectors,
  setChunks,
  startEmbeddings,
  vectorSearch,
} from "./embeddings";

// Vault search, built for thousands of files:
// - documents are indexed as heading/bullet-section chunks, so results
//   point at the section, not just the file
// - the BM25 index is persisted to IndexedDB and reconciled against
//   file mtimes on startup, so only changed files are re-read
// - indexing runs in the background and yields to the UI

export interface Chunk {
  id: string;
  name: string; // file name without extension (boosted)
  section: string; // nearest heading text
  path: string;
  line: number; // 1-based line the chunk starts at
  text: string;
}

export interface SearchHit {
  path: string;
  section: string;
  line: number;
  text: string;
  terms: string[]; // query terms that matched
  score: number;
}

const MAX_CHUNK = 1600; // characters; long sections split on blank lines

export function chunkFile(path: string, text: string): Chunk[] {
  const name = (path.split("/").pop() ?? path).replace(/\.\w+$/, "");
  const lines = text.split("\n");
  const chunks: Chunk[] = [];
  let section = "";
  let start = 1;
  let buf: string[] = [];

  const flush = (endExclusive: number) => {
    const body = buf.join("\n").trim();
    buf = [];
    if (!body) {
      start = endExclusive;
      return;
    }
    // split oversized sections on paragraph boundaries
    let pieceStart = start;
    let piece: string[] = [];
    let size = 0;
    let lineNo = start;
    const emit = () => {
      const t = piece.join("\n").trim();
      if (t) {
        chunks.push({
          id: `${path}::${chunks.length}::${hash(t)}`,
          name,
          section,
          path,
          line: pieceStart,
          text: t,
        });
      }
      piece = [];
      size = 0;
    };
    for (const l of body.split("\n")) {
      if (size > MAX_CHUNK && l.trim() === "") {
        emit();
        pieceStart = lineNo + 1;
      } else {
        piece.push(l);
        size += l.length + 1;
      }
      lineNo++;
    }
    emit();
    start = endExclusive;
  };

  lines.forEach((line, i) => {
    const heading = /^#{1,6}\s+(.*)/.exec(line);
    if (heading) {
      flush(i + 1);
      section = heading[1].trim();
      start = i + 1; // the heading line itself, 1-based
      buf.push(line);
    } else {
      buf.push(line);
    }
  });
  flush(lines.length + 1);
  return chunks;
}

// tiny content hash to keep chunk ids unique across re-indexes
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const OPTIONS: Options = {
  fields: ["name", "section", "text"],
  storeFields: ["path", "section", "text", "line"],
  searchOptions: {
    prefix: true,
    fuzzy: 0.2,
    boost: { name: 4, section: 2 },
  },
};

const INDEX_KEY = "search.index";
const META_KEY = "search.meta";

// Chunks are persisted alongside mtimes so that on startup the
// semantic registry can be rebuilt without re-reading unchanged files.
interface FileMeta {
  mtime: number;
  chunks: Chunk[];
}

let mini = new MiniSearch(OPTIONS);
let meta: Record<string, FileMeta> = {};
let root: FileSystemDirectoryHandle | null = null;
let ready = false;
let scanning = false;
let persistTimer: number | undefined;

const tick = () => new Promise((r) => setTimeout(r, 0));

function discardFile(path: string): void {
  removeVectors(path);
  const m = meta[path];
  if (!m) return;
  for (const c of m.chunks) {
    try {
      mini.discard(c.id);
    } catch {
      /* already gone */
    }
  }
  delete meta[path];
}

function indexText(path: string, text: string, mtime: number): void {
  discardFile(path);
  const chunks = chunkFile(path, text);
  mini.addAll(chunks);
  setChunks(path, chunks); // keep the semantic layer in lockstep
  meta[path] = { mtime, chunks };
}

function schedulePersist(): void {
  clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => void persist(), 3000);
}

async function persist(): Promise<void> {
  clearTimeout(persistTimer);
  try {
    await kvSet(INDEX_KEY, JSON.stringify(mini));
    await kvSet(META_KEY, meta);
  } catch (err) {
    console.error("search index persist failed", err);
  }
}

function flattenFiles(nodes: TreeNode[], out: TreeNode[] = []): TreeNode[] {
  for (const n of nodes) {
    if (n.kind === "file") out.push(n);
    if (n.children) flattenFiles(n.children, out);
  }
  return out;
}

// Walk the vault and (re-)index whatever changed since the persisted
// state. Cheap when nothing changed: one metadata read per file.
export async function rescan(progress?: (msg: string) => void): Promise<void> {
  if (!root || scanning) return;
  scanning = true;
  try {
    const files = flattenFiles(await buildTree(root));
    const seen = new Set<string>();
    let changed = 0;
    for (let i = 0; i < files.length; i++) {
      const node = files[i];
      let file: File;
      try {
        file = await (node.handle as FileSystemFileHandle).getFile();
      } catch {
        continue; // deleted out from under us mid-scan; next rescan settles it
      }
      seen.add(node.path);
      if (meta[node.path]?.mtime !== file.lastModified) {
        indexText(node.path, await file.text(), file.lastModified);
        changed++;
        if (changed % 20 === 0) {
          progress?.(`indexing ${i + 1}/${files.length}…`);
          await tick(); // keep the UI responsive
        }
      } else {
        // unchanged file: register its persisted chunks with the
        // semantic layer without touching the disk
        setChunks(node.path, meta[node.path].chunks);
      }
    }
    let removed = 0;
    for (const path of Object.keys(meta)) {
      if (!seen.has(path)) {
        discardFile(path);
        removed++;
      }
    }
    ready = true;
    if (changed || removed) {
      schedulePersist();
      progress?.(`indexed ${files.length} files`);
    }
  } finally {
    scanning = false;
  }
}

export async function initSearch(
  vault: FileSystemDirectoryHandle,
  progress?: (msg: string) => void,
): Promise<void> {
  root = vault;
  ready = false;
  try {
    const [json, savedMeta] = await Promise.all([
      kvGet<string>(INDEX_KEY),
      kvGet<Record<string, FileMeta>>(META_KEY),
    ]);
    const firstEntry = savedMeta && Object.values(savedMeta)[0];
    const validFormat = !firstEntry || Array.isArray(firstEntry.chunks);
    if (json && savedMeta && validFormat) {
      mini = MiniSearch.loadJSON(json, OPTIONS);
      meta = savedMeta;
    } else {
      mini = new MiniSearch(OPTIONS);
      meta = {};
    }
  } catch {
    mini = new MiniSearch(OPTIONS);
    meta = {};
  }
  await rescan(progress);
  // warm the semantic layer in the background: cached vectors load
  // first, missing ones are embedded batch by batch
  startEmbeddings(progress);
}

// Fast path for the file being edited: index from the text we already
// have instead of re-reading the disk.
export function updateFile(path: string, text: string): void {
  if (!root) return;
  indexText(path, text, Date.now()); // mtime approximated; reconciled next startup
  schedulePersist();
}

// Hybrid retrieval: BM25 and cosine-similarity lists merged with
// reciprocal rank fusion. Until the embedding model has warmed up the
// vector list is empty and this degrades gracefully to pure BM25.
const RRF_K = 60;
const FUSE_DEPTH = 50;

export async function query(q: string): Promise<SearchHit[]> {
  if (!ready) throw new Error(scanning ? "still indexing…" : "no index — open a vault");

  const lexical = mini.search(q).slice(0, FUSE_DEPTH);
  const semantic = await vectorSearch(q, FUSE_DEPTH);

  interface Fused {
    hit: SearchHit;
    score: number;
  }
  const fused = new Map<string, Fused>();

  lexical.forEach((r, rank) => {
    fused.set(r.id as string, {
      score: 1 / (RRF_K + rank + 1),
      hit: {
        path: r.path as string,
        section: r.section as string,
        line: r.line as number,
        text: r.text as string,
        terms: r.terms,
        score: 0,
      },
    });
  });

  semantic.forEach(({ chunk }, rank) => {
    const add = 1 / (RRF_K + rank + 1);
    const existing = fused.get(chunk.id);
    if (existing) {
      existing.score += add;
    } else {
      fused.set(chunk.id, {
        score: add,
        hit: {
          path: chunk.path,
          section: chunk.section,
          line: chunk.line,
          text: chunk.text,
          terms: [], // semantic-only hit: no lexical terms to bold
          score: 0,
        },
      });
    }
  });

  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map((f) => ({ ...f.hit, score: f.score }));
}

export function isReady(): boolean {
  return ready;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void persist();
});
