import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export class SessionStore {
  #path;
  #sessions = new Map();
  #writeQueue = Promise.resolve();

  constructor(dataDir) {
    this.#path = join(dataDir, "sessions.json");
  }

  async load() {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8"));
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
        throw new Error("unsupported sessions registry format");
      }
      for (const session of parsed.sessions) {
        if (typeof session?.id === "string" && typeof session.cwd === "string") {
          this.#sessions.set(session.id, structuredClone(session));
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  list() {
    return [...this.#sessions.values()]
      .map((session) => structuredClone(session))
      .sort((left, right) => (right.updatedAt ?? right.createdAt) - (left.updatedAt ?? left.createdAt));
  }

  get(id) {
    const session = this.#sessions.get(id);
    return session ? structuredClone(session) : undefined;
  }

  async put(session) {
    this.#sessions.set(session.id, structuredClone(session));
    await this.#persist();
  }

  async update(id, patch) {
    const current = this.#sessions.get(id);
    if (!current) return undefined;
    const next = { ...current, ...structuredClone(patch) };
    this.#sessions.set(id, next);
    await this.#persist();
    return structuredClone(next);
  }

  async remove(id) {
    if (!this.#sessions.delete(id)) return false;
    await this.#persist();
    return true;
  }

  #persist() {
    const snapshot = JSON.stringify({ version: 1, sessions: this.list() }, null, 2) + "\n";
    const operation = this.#writeQueue.then(async () => {
      const temporaryPath = `${this.#path}.${process.pid}.tmp`;
      await writeFile(temporaryPath, snapshot, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.#path);
    });
    this.#writeQueue = operation.catch(() => {});
    return operation;
  }
}
