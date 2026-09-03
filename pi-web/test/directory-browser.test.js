import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listDirectories } from "../src/directory-browser.js";

test("directory browser returns sorted directories and directory symlinks", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-directory-browser-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "project10"));
  await mkdir(join(root, "project2"));
  await writeFile(join(root, "notes.txt"), "not a directory");
  await symlink(
    join(root, "project2"),
    join(root, "linked-project"),
    process.platform === "win32" ? "junction" : "dir",
  );

  const result = await listDirectories(root);

  assert.equal(result.path, root);
  assert.deepEqual(result.directories.map(({ name }) => name), ["linked-project", "project2", "project10"]);
  assert.equal(result.directories[0].path, join(root, "linked-project"));
});

test("directory browser rejects file paths", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-directory-browser-file-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "file.txt");
  await writeFile(file, "content");

  await assert.rejects(() => listDirectories(file), /Path is not a directory/);
});
