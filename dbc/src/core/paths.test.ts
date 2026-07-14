import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configPath } from "./paths.js";

const originalDirectory = process.cwd();
const originalConfig = process.env.ACID_TRIP_CONFIG;
const originalHome = process.env.ACID_TRIP_HOME;
const originalLegacyHome = process.env.DBC_HOME;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  process.chdir(originalDirectory);
  restore("ACID_TRIP_CONFIG", originalConfig);
  restore("ACID_TRIP_HOME", originalHome);
  restore("DBC_HOME", originalLegacyHome);
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("configPath", () => {
  it("prefers config.yaml in the launch directory", async () => {
    delete process.env.ACID_TRIP_CONFIG;
    delete process.env.ACID_TRIP_HOME;
    delete process.env.DBC_HOME;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acid-trip-config-"));
    temporaryDirectories.push(directory);
    await fs.writeFile(path.join(directory, "config.yaml"), "connections: {}\n");
    process.chdir(directory);
    expect(configPath()).toBe(path.join(process.cwd(), "config.yaml"));
  });

  it("allows an explicit config path", () => {
    process.env.ACID_TRIP_CONFIG = "./custom.yaml";
    expect(configPath()).toBe(path.join(originalDirectory, "custom.yaml"));
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
