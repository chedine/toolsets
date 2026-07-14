import os from "node:os";
import path from "node:path";

export const dataDirectory = (): string => {
  const configured = process.env.ACID_TRIP_HOME ?? process.env.DBC_HOME;
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".dbc");
};

export const configPath = (): string => path.join(dataDirectory(), "config.yaml");
export const templatesPath = (): string => path.join(dataDirectory(), "templates.yaml");
export const notebooksDirectory = (): string => path.join(dataDirectory(), "notebooks");
