// One IndexedDB database for everything that can't live in text files:
// pasted image blobs and the persisted vault directory handle.

const DB = "bullet";
const VERSION = 3;

function withStore(
  store: "images" | "kv" | "vectors",
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("images")) db.createObjectStore("images");
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("vectors")) db.createObjectStore("vectors");
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const req = run(open.result.transaction(store, mode).objectStore(store));
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    };
  });
}

export const putImage = (id: string, blob: Blob) =>
  withStore("images", "readwrite", (s) => s.put(blob, id));

export const getImage = (id: string) =>
  withStore("images", "readonly", (s) => s.get(id)) as Promise<Blob | undefined>;

export const kvSet = (key: string, value: unknown) =>
  withStore("kv", "readwrite", (s) => s.put(value, key));

export const kvGet = <T>(key: string) =>
  withStore("kv", "readonly", (s) => s.get(key)) as Promise<T | undefined>;

// Chunk embeddings, keyed by content hash so identical text is never
// re-embedded, across sessions or across files.
export const putVector = (hash: string, vec: Float32Array) =>
  withStore("vectors", "readwrite", (s) => s.put(vec, hash));

export async function getAllVectors(): Promise<Map<string, Float32Array>> {
  const [keys, values] = await Promise.all([
    withStore("vectors", "readonly", (s) => s.getAllKeys()) as Promise<string[]>,
    withStore("vectors", "readonly", (s) => s.getAll()) as Promise<Float32Array[]>,
  ]);
  const map = new Map<string, Float32Array>();
  keys.forEach((k, i) => map.set(k, new Float32Array(values[i])));
  return map;
}
