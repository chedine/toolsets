import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export async function listDirectories(requestedPath) {
  const path = resolve(typeof requestedPath === "string" && requestedPath.trim() ? requestedPath.trim() : homedir());
  const details = await stat(path);
  if (!details.isDirectory()) throw new Error("Path is not a directory");

  const entries = await readdir(path, { withFileTypes: true });
  const directories = (await Promise.all(entries.map(async (entry) => {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) return { name: entry.name, path: entryPath };
    if (!entry.isSymbolicLink()) return undefined;
    try {
      return (await stat(entryPath)).isDirectory() ? { name: entry.name, path: entryPath } : undefined;
    } catch {
      return undefined;
    }
  })))
    .filter((entry) => entry !== undefined)
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }));

  const parent = dirname(path);
  return { path, parent: parent === path ? undefined : parent, directories };
}
