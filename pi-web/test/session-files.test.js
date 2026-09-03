import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deleteSessionFile } from "../src/session-files.js";

test("session deletion removes JSONL files inside the configured session directory", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-delete-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const sessionDir = join(directory, "sessions");
  const projectDir = join(sessionDir, "project");
  const sessionFile = join(projectDir, "session.jsonl");
  await mkdir(projectDir, { recursive: true });
  await writeFile(sessionFile, "{}\n");

  await deleteSessionFile(sessionDir, sessionFile);
  await assert.rejects(() => access(sessionFile), { code: "ENOENT" });
});

test("session deletion refuses files outside the configured session directory", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-delete-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const sessionDir = join(directory, "sessions");
  const outsideFile = join(directory, "outside.jsonl");
  await mkdir(sessionDir);
  await writeFile(outsideFile, "{}\n");

  await assert.rejects(() => deleteSessionFile(sessionDir, outsideFile), /outside the configured Pi session directory/);
  await access(outsideFile);
});

test("session deletion refuses symlinks that escape the session directory", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-delete-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const sessionDir = join(directory, "sessions");
  const outsideFile = join(directory, "outside.jsonl");
  const linkedFile = join(sessionDir, "linked.jsonl");
  await mkdir(sessionDir);
  await writeFile(outsideFile, "{}\n");
  try {
    await symlink(outsideFile, linkedFile, "file");
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") {
      context.skip("Windows file symlinks require Developer Mode or elevated privileges");
      return;
    }
    throw error;
  }

  await assert.rejects(() => deleteSessionFile(sessionDir, linkedFile), /outside the configured Pi session directory/);
  await access(outsideFile);
});
