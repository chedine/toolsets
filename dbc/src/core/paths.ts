import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const dataDirectory = (): string => {
  const configured = process.env.ACID_TRIP_HOME ?? process.env.DBC_HOME;
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".dbc");
};

export const configPath = (): string => {
  if (process.env.ACID_TRIP_CONFIG) return path.resolve(process.env.ACID_TRIP_CONFIG);
  if (process.env.ACID_TRIP_HOME || process.env.DBC_HOME) return path.join(dataDirectory(), "config.yaml");
  const projectConfig = path.resolve(process.cwd(), "config.yaml");
  return fs.existsSync(projectConfig) ? projectConfig : path.join(dataDirectory(), "config.yaml");
};
export const templatesPath = (): string => path.join(dataDirectory(), "templates.yaml");
export const notebooksDirectory = (): string => path.join(dataDirectory(), "notebooks");
