import { realpath, unlink } from "node:fs/promises";
import { extname, isAbsolute, relative, sep } from "node:path";

export async function deleteSessionFile(sessionDir, sessionFile) {
  if (sessionFile === undefined) return;
  if (typeof sessionFile !== "string" || !isAbsolute(sessionFile) || extname(sessionFile) !== ".jsonl") {
    throw new Error("Refusing to delete an invalid session file path");
  }

  let resolvedFile;
  try {
    resolvedFile = await realpath(sessionFile);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const sessionRoot = await realpath(sessionDir);
  const pathFromRoot = relative(sessionRoot, resolvedFile);
  if (!pathFromRoot || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error("Refusing to delete a file outside the configured Pi session directory");
  }
  await unlink(resolvedFile);
}
