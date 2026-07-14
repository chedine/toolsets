import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { configPath } from "./paths.js";
import type { AppConfig } from "./types.js";

const EMPTY_CONFIG: AppConfig = { fetchLimit: 100, connections: {} };

export async function loadConfig(file = configPath()): Promise<AppConfig> {
  try {
    const parsed = YAML.parse(await fs.readFile(file, "utf8")) as Partial<AppConfig> | null;
    return {
      defaultConnection: parsed?.defaultConnection,
      fetchLimit: parsed?.fetchLimit ?? 100,
      connections: parsed?.connections ?? {},
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_CONFIG;
    throw new Error(`Could not read ${file}: ${(error as Error).message}`);
  }
}

export async function writeExampleConfig(file = configPath()): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const example = {
    defaultConnection: "dev",
    fetchLimit: 100,
    connections: {
      dev: {
        type: "oracle",
        host: "localhost",
        port: 1521,
        service: "FREEPDB1",
        username: "app",
        passwordEnv: "DBC_DEV_PASSWORD",
      },
    },
  };
  await fs.writeFile(file, YAML.stringify(example), { flag: "wx", mode: 0o600 });
}
