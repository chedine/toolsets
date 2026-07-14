#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { Application } from "./core/application.js";
import { loadConfig, writeExampleConfig } from "./core/config.js";
import { ConnectionManager } from "./core/connection-manager.js";
import { configPath } from "./core/paths.js";
import { TemplateStore } from "./core/template-store.js";
import { OracleAdapter } from "./db/oracle-adapter.js";
import type { DatabaseAdapter } from "./db/adapter.js";
import { InkApp } from "./ui/ink/App.js";

async function main(): Promise<void> {
  if (process.argv[2] === "init") {
    try {
      await writeExampleConfig();
      console.log(`Created ${configPath()}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        console.error(`${configPath()} already exists`);
        process.exitCode = 1;
        return;
      }
      throw error;
    }
    return;
  }

  const config = await loadConfig();
  const adapters = new Map<string, DatabaseAdapter>();
  const oracle = new OracleAdapter();
  adapters.set(oracle.type, oracle);
  const manager = new ConnectionManager(config, adapters);
  const application = new Application(manager, new TemplateStore());
  render(<InkApp application={application} defaultConnection={config.defaultConnection} />, { exitOnCtrlC: false });
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
