import { createReadStream } from "node:fs";
import { access, readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative } from "node:path";
import { attachJsonlReader } from "./jsonl.js";

const CACHE_TTL_MS = 10_000;
const MAX_PARSED_LINE_LENGTH = 2 * 1024 * 1024;
const MAX_SEARCH_MESSAGES = 12;
const MAX_SEARCH_RESULTS = 100;

export class SessionDiscovery {
  #sessionDir;
  #cache = [];
  #cacheTime = 0;

  constructor(sessionDir) {
    this.#sessionDir = sessionDir;
  }

  invalidate() {
    this.#cacheTime = 0;
  }

  async search(query, managedRecords = []) {
    const sessions = await this.#sessions();
    const terms = String(query ?? "").trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const managedFiles = new Set();
    for (const { sessionFile } of managedRecords) {
      if (!sessionFile) continue;
      try {
        managedFiles.add(await realpath(sessionFile));
      } catch {
        managedFiles.add(sessionFile);
      }
    }
    const managedIds = new Set(managedRecords.map(({ id }) => id).filter(Boolean));
    return sessions
      .filter(({ searchText }) => terms.every((term) => searchText.includes(term)))
      .slice(0, MAX_SEARCH_RESULTS)
      .map(({ searchText: _searchText, ...session }) => ({
        ...session,
        managed: managedIds.has(session.id) || managedFiles.has(session.sessionFile),
      }));
  }

  async inspect(sessionFile) {
    if (typeof sessionFile !== "string" || !isAbsolute(sessionFile) || extname(sessionFile) !== ".jsonl") {
      throw new Error("Invalid Pi session file");
    }
    const [sessionRoot, resolvedFile] = await Promise.all([realpath(this.#sessionDir), realpath(sessionFile)]);
    const pathFromRoot = relative(sessionRoot, resolvedFile);
    if (!pathFromRoot || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
      throw new Error("Session file is outside the configured Pi session directory");
    }
    const metadata = await readSessionMetadata(resolvedFile);
    if (!metadata) throw new Error("Invalid or unsupported Pi session file");
    if (!metadata.cwdExists) throw new Error(`Session working directory no longer exists: ${metadata.cwd}`);
    return metadata;
  }

  async #sessions() {
    if (Date.now() - this.#cacheTime < CACHE_TTL_MS) return this.#cache;
    let root;
    try {
      root = await realpath(this.#sessionDir);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const files = await findSessionFiles(root);
    const sessions = [];
    for (const file of files) {
      try {
        const metadata = await readSessionMetadata(file);
        if (metadata) sessions.push(metadata);
      } catch {
        // One damaged session must not prevent discovery of the others.
      }
    }
    sessions.sort((left, right) => right.updatedAt - left.updatedAt);
    this.#cache = sessions;
    this.#cacheTime = Date.now();
    return sessions;
  }
}

async function findSessionFiles(directory) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await findSessionFiles(path));
    else if (entry.isFile() && extname(entry.name) === ".jsonl") files.push(path);
  }
  return files;
}

async function readSessionMetadata(sessionFile) {
  const fileStats = await stat(sessionFile);
  let id;
  let cwd;
  let name;
  let createdAt;
  let model;
  const recentMessages = [];
  const stream = createReadStream(sessionFile);
  await new Promise((resolve, reject) => {
    attachJsonlReader(stream, (line) => {
      if (!line || line.length > MAX_PARSED_LINE_LENGTH) return;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        return;
      }
      if (entry.type === "session") {
        id = typeof entry.id === "string" ? entry.id : id;
        cwd = typeof entry.cwd === "string" ? entry.cwd : cwd;
        const timestamp = Date.parse(entry.timestamp);
        if (Number.isFinite(timestamp)) createdAt = timestamp;
      } else if (entry.type === "session_info" && typeof entry.name === "string") {
        name = entry.name.trim().slice(0, 200) || name;
      } else if (entry.type === "model_change" && typeof entry.modelId === "string") {
        model = entry.modelId;
      } else if (entry.type === "message") {
        const text = messageText(entry.message);
        if (text) {
          recentMessages.push(text.slice(0, 1_000));
          if (recentMessages.length > MAX_SEARCH_MESSAGES) recentMessages.shift();
        }
      }
    });
    stream.once("end", resolve);
    stream.once("error", reject);
  });
  if (!id || !cwd || !isAbsolute(cwd)) return undefined;
  let cwdExists = true;
  try {
    await access(cwd);
  } catch {
    cwdExists = false;
  }
  const snippet = recentMessages.at(-1)?.replace(/\s+/g, " ").slice(0, 240) ?? "";
  const displayName = name || basename(cwd) || "Untitled session";
  return {
    id,
    cwd,
    sessionFile,
    name,
    displayName,
    model,
    snippet,
    cwdExists,
    createdAt: createdAt ?? fileStats.birthtimeMs,
    updatedAt: fileStats.mtimeMs,
    searchText: [id, name, displayName, cwd, model, ...recentMessages].filter(Boolean).join("\n").toLocaleLowerCase(),
  };
}

function messageText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n");
}
