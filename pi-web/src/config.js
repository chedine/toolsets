import { homedir } from "node:os";
import { resolve } from "node:path";

function integerFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function isLoopback(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function loadConfig() {
  const host = process.env.PI_WEB_HOST ?? "127.0.0.1";
  const token = process.env.PI_WEB_TOKEN?.trim() || undefined;
  if (!isLoopback(host) && !token) {
    throw new Error("PI_WEB_TOKEN is required when PI_WEB_HOST is not loopback");
  }

  return {
    host,
    port: integerFromEnv("PI_WEB_PORT", 31415),
    token,
    piBin: process.env.PI_WEB_PI_BIN ?? "pi",
    dataDir: resolve(process.env.PI_WEB_DATA_DIR ?? `${homedir()}/.pi-web`),
    sessionDir: resolve(process.env.PI_WEB_SESSION_DIR ?? `${homedir()}/.pi/agent/sessions`),
    rpcTimeoutMs: integerFromEnv("PI_WEB_RPC_TIMEOUT_MS", 10 * 60 * 1000),
  };
}
