import { kvGet, kvSet } from "./idb";

// An Obsidian-style vault: one folder the user picks, everything lives
// under it as plain .md/.txt files in arbitrarily nested folders.
// Built on the File System Access API (Chromium browsers).

declare global {
  interface Window {
    showDirectoryPicker(options?: {
      mode?: "read" | "readwrite";
    }): Promise<FileSystemDirectoryHandle>;
  }
  interface FileSystemHandle {
    queryPermission(descriptor?: {
      mode?: "read" | "readwrite";
    }): Promise<PermissionState>;
    requestPermission(descriptor?: {
      mode?: "read" | "readwrite";
    }): Promise<PermissionState>;
  }
  interface FileSystemFileHandle {
    // Chromium-only; used for cheap renames when available.
    move?(newName: string): Promise<void>;
    move?(parent: FileSystemDirectoryHandle, newName?: string): Promise<void>;
  }
}

export interface TreeNode {
  name: string;
  path: string; // vault-relative, e.g. "projects/bullet/notes.md"
  kind: "dir" | "file";
  handle: FileSystemDirectoryHandle | FileSystemFileHandle;
  children?: TreeNode[];
}

const VAULT_KEY = "vault";

export const supported = "showDirectoryPicker" in window;

export async function pickVault(): Promise<FileSystemDirectoryHandle> {
  const handle = await window.showDirectoryPicker({ mode: "readwrite" });
  await kvSet(VAULT_KEY, handle);
  return handle;
}

// Returns the remembered vault only if we still hold (or are granted on
// a user gesture) readwrite permission.
export async function restoreVault(
  requestIfNeeded: boolean,
): Promise<FileSystemDirectoryHandle | null> {
  const handle = await kvGet<FileSystemDirectoryHandle>(VAULT_KEY);
  if (!handle) return null;
  if (!("queryPermission" in handle)) return handle; // e.g. OPFS handles
  const opts = { mode: "readwrite" } as const;
  if ((await handle.queryPermission(opts)) === "granted") return handle;
  if (requestIfNeeded && (await handle.requestPermission(opts)) === "granted")
    return handle;
  return null;
}

export async function storedVaultName(): Promise<string | null> {
  const handle = await kvGet<FileSystemDirectoryHandle>(VAULT_KEY);
  return handle?.name ?? null;
}

const isTextFile = (name: string) => /\.(md|txt)$/i.test(name);

export async function buildTree(
  dir: FileSystemDirectoryHandle,
  path = "",
): Promise<TreeNode[]> {
  const nodes: TreeNode[] = [];
  for await (const handle of dir.values()) {
    if (handle.name.startsWith(".")) continue;
    // the image store is internal — keep it out of the tree
    if (path === "" && handle.name === "blobs") continue;
    const childPath = path ? `${path}/${handle.name}` : handle.name;
    if (handle.kind === "directory") {
      nodes.push({
        name: handle.name,
        path: childPath,
        kind: "dir",
        handle,
        children: await buildTree(handle, childPath),
      });
    } else if (isTextFile(handle.name)) {
      nodes.push({ name: handle.name, path: childPath, kind: "file", handle });
    }
  }
  // Folders first, then files, both alphabetical.
  return nodes.sort(
    (a, b) =>
      (a.kind === "dir" ? 0 : 1) - (b.kind === "dir" ? 0 : 1) ||
      a.name.localeCompare(b.name),
  );
}

export async function createFolder(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  await parent.getDirectoryHandle(name, { create: true });
}

export async function createFile(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemFileHandle> {
  if (!/\.\w+$/.test(name)) name += ".md";
  return parent.getFileHandle(name, { create: true });
}

export async function readFile(handle: FileSystemFileHandle): Promise<string> {
  return (await handle.getFile()).text();
}

export async function writeFile(
  handle: FileSystemFileHandle,
  text: string,
): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}

// ---- Path-based operations (paths are always vault-root-relative) ----

export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf("/");
  return i === -1
    ? { dir: "", name: path }
    : { dir: path.slice(0, i), name: path.slice(i + 1) };
}

export async function getDir(
  root: FileSystemDirectoryHandle,
  path: string,
  create = false,
): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const part of path.split("/").filter(Boolean)) {
    dir = await dir.getDirectoryHandle(part, { create });
  }
  return dir;
}

export async function getFileByPath(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<FileSystemFileHandle> {
  const { dir, name } = splitPath(path);
  return (await getDir(root, dir)).getFileHandle(name);
}

// Creates intermediate folders as needed. Returns the final path.
export async function ensureFile(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<string> {
  const { dir, name } = splitPath(path);
  const finalName = /\.\w+$/.test(name) ? name : `${name}.md`;
  await (await getDir(root, dir, true)).getFileHandle(finalName, {
    create: true,
  });
  return dir ? `${dir}/${finalName}` : finalName;
}

export async function ensureFolder(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<void> {
  await getDir(root, path, true);
}

// Deletes a file or folder (folders recursively).
export async function deleteByPath(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<void> {
  const { dir, name } = splitPath(path);
  await (await getDir(root, dir)).removeEntry(name, { recursive: true });
}

async function copyFileInto(
  file: FileSystemFileHandle,
  destDir: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  const blob = await file.getFile();
  const target = await destDir.getFileHandle(name, { create: true });
  const writable = await target.createWritable();
  await writable.write(blob);
  await writable.close();
}

async function copyDirInto(
  src: FileSystemDirectoryHandle,
  dest: FileSystemDirectoryHandle,
): Promise<void> {
  for await (const handle of src.values()) {
    if (handle.kind === "directory") {
      await copyDirInto(
        handle,
        await dest.getDirectoryHandle(handle.name, { create: true }),
      );
    } else {
      await copyFileInto(handle, dest, handle.name);
    }
  }
}

async function fileOrNull(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemFileHandle | null> {
  try {
    return await parent.getFileHandle(name);
  } catch {
    return null;
  }
}

// Rename a file or folder in place. Returns the new path.
export async function renameByPath(
  root: FileSystemDirectoryHandle,
  path: string,
  newName: string,
): Promise<string> {
  const { dir, name } = splitPath(path);
  const parent = await getDir(root, dir);
  const newPath = dir ? `${dir}/${newName}` : newName;

  const file = await fileOrNull(parent, name);
  if (file) {
    if (file.move) await file.move(newName);
    else {
      await copyFileInto(file, parent, newName);
      await parent.removeEntry(name);
    }
  } else {
    const srcDir = await parent.getDirectoryHandle(name);
    const destDir = await parent.getDirectoryHandle(newName, { create: true });
    await copyDirInto(srcDir, destDir);
    await parent.removeEntry(name, { recursive: true });
  }
  return newPath;
}

// Move a file or folder into a destination folder. Returns the new path.
export async function moveByPath(
  root: FileSystemDirectoryHandle,
  path: string,
  destFolder: string,
): Promise<string> {
  const { dir, name } = splitPath(path);
  const parent = await getDir(root, dir);
  const dest = await getDir(root, destFolder, true);
  const newPath = destFolder ? `${destFolder}/${name}` : name;
  if (newPath === path) return path;

  const file = await fileOrNull(parent, name);
  if (file) {
    if (file.move) await file.move(dest, name);
    else {
      await copyFileInto(file, dest, name);
      await parent.removeEntry(name);
    }
  } else {
    const srcDir = await parent.getDirectoryHandle(name);
    await copyDirInto(
      srcDir,
      await dest.getDirectoryHandle(name, { create: true }),
    );
    await parent.removeEntry(name, { recursive: true });
  }
  return newPath;
}
