import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import { loadConfig } from "../core/config.js";
import { ConnectionManager } from "../core/connection-manager.js";
import { NotebookStore } from "../core/notebook-store.js";
import { TemplateStore } from "../core/template-store.js";
import type { LobReference, NotebookDocument, RowDuplicate, RowInsert, RowUpdate } from "../core/types.js";
import type { DatabaseAdapter } from "../db/adapter.js";
import { OracleAdapter } from "../db/oracle-adapter.js";

const host = process.env.ACID_TRIP_HOST ?? process.env.DBC_HOST ?? "127.0.0.1";
const port = Number(process.env.ACID_TRIP_PORT ?? process.env.DBC_PORT ?? 4174);
const config = await loadConfig();
const oracle = new OracleAdapter();
const adapters = new Map<string, DatabaseAdapter>([[oracle.type, oracle]]);
const connections = new ConnectionManager(config, adapters);
const templates = new TemplateStore();
const notebooks = new NotebookStore();
const app = Fastify({ logger: false, bodyLimit: 100 * 1024 * 1024 });
await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024, files: 1 } });

app.setErrorHandler((cause, _request, reply) => {
  const error = cause as Error & { statusCode?: number };
  void reply.status(error.statusCode ?? 500).send({ error: error.message });
});

app.get("/api/state", async () => ({
  defaultConnection: config.defaultConnection,
  configuredConnections: connections.configuredNames(),
  sessions: connections.sessionInfos(),
  templates: await templates.all(),
}));

app.post<{ Params: { name: string } }>("/api/connections/:name/connect", async ({ params }) => {
  const session = await connections.connect(params.name);
  const catalog = await connections.catalogFor(params.name);
  return { session, catalog };
});

app.get<{ Params: { name: string }; Querystring: { refresh?: string } }>(
  "/api/connections/:name/catalog",
  async ({ params, query }) => connections.catalogFor(params.name, query.refresh === "true"),
);

app.post<{ Params: { name: string }; Body: { sql: string } }>(
  "/api/connections/:name/query",
  async ({ params, body }) => connections.executeOn(params.name, body.sql),
);

app.post<{ Params: { name: string }; Body: { enabled: boolean } }>(
  "/api/connections/:name/autocommit",
  async ({ params, body }) => connections.setAutoCommitOn(params.name, body.enabled),
);

app.post<{ Params: { name: string } }>("/api/connections/:name/commit", async ({ params }) => {
  await connections.commitOn(params.name);
  return { ok: true };
});

app.post<{ Params: { name: string } }>("/api/connections/:name/rollback", async ({ params }) => {
  await connections.rollbackOn(params.name);
  return { ok: true };
});

app.post<{ Params: { name: string } }>("/api/connections/:name/cancel", async ({ params }) => {
  await connections.cancelOn(params.name);
  return { ok: true };
});

app.post<{ Params: { name: string }; Body: RowUpdate }>(
  "/api/connections/:name/rows/update",
  async ({ params, body }) => connections.updateRowOn(params.name, body),
);
app.post<{ Params: { name: string }; Body: RowInsert }>(
  "/api/connections/:name/rows/insert",
  async ({ params, body }) => connections.insertRowOn(params.name, body),
);
app.post<{ Params: { name: string }; Body: RowDuplicate }>(
  "/api/connections/:name/rows/duplicate",
  async ({ params, body }) => connections.duplicateRowOn(params.name, body),
);
app.post<{ Params: { name: string }; Body: LobReference }>(
  "/api/connections/:name/lob/read",
  async ({ params, body }, reply) => {
    const content = await connections.readLobOn(params.name, body);
    if (content === null) return reply.status(204).send();
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    return reply
      .header("content-type", body.kind === "CLOB" ? "text/plain; charset=utf-8" : detectMime(buffer))
      .header("content-length", buffer.length)
      .send(buffer);
  },
);
app.post<{ Params: { name: string } }>(
  "/api/connections/:name/lob/write",
  async (request) => {
    const upload = await request.file();
    if (!upload) throw new Error("LOB content file is required");
    const reference = JSON.parse(fieldValue(upload.fields.reference)) as LobReference;
    const buffer = await upload.toBuffer();
    const content = reference.kind === "CLOB" ? buffer.toString("utf8") : buffer;
    return connections.writeLobOn(request.params.name, reference, content);
  },
);

app.get("/api/notebooks", async () => notebooks.list());
app.post<{ Body: { name?: string; connection?: string } }>("/api/notebooks", async ({ body }) => notebooks.create(body.name, body.connection));
app.get<{ Params: { id: string } }>("/api/notebooks/:id", async ({ params }) => notebooks.get(params.id));
app.put<{ Params: { id: string }; Body: NotebookDocument }>("/api/notebooks/:id", async ({ params, body }) => {
  if (params.id !== body.id) throw new Error("Notebook id does not match URL");
  return notebooks.save(body);
});
app.post<{ Params: { id: string } }>("/api/notebooks/:id/duplicate", async ({ params }) => notebooks.duplicate(params.id));
app.delete<{ Params: { id: string } }>("/api/notebooks/:id", async ({ params }) => ({ removed: await notebooks.remove(params.id) }));

app.get("/api/templates", async () => templates.all());
app.put<{ Params: { name: string }; Body: { sql: string } }>("/api/templates/:name", async ({ params, body }) => {
  await templates.save(params.name, body.sql);
  return { ok: true };
});
app.delete<{ Params: { name: string } }>("/api/templates/:name", async ({ params }) => ({
  removed: await templates.remove(params.name),
}));

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(serverDirectory, "../../web-dist");
if (fs.existsSync(webRoot)) {
  await app.register(fastifyStatic, { root: webRoot, wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) return reply.status(404).send({ error: "Not found" });
    return reply.sendFile("index.html");
  });
}

const stop = async (): Promise<void> => {
  await connections.closeAll();
  await app.close();
};
process.once("SIGINT", () => void stop().finally(() => process.exit(0)));
process.once("SIGTERM", () => void stop().finally(() => process.exit(0)));

await app.listen({ host, port });
console.log(`Acid · http://${host}:${port}`);

function fieldValue(field: unknown): string {
  if (!field || typeof field !== "object" || !("value" in field)) throw new Error("Missing multipart reference");
  return String((field as { value: unknown }).value);
}

function detectMime(buffer: Buffer): string {
  if (buffer.subarray(0, 4).equals(Buffer.from([0x25, 0x50, 0x44, 0x46]))) return "application/pdf";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (buffer.subarray(0, 6).toString("ascii").startsWith("GIF8")) return "image/gif";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return "application/octet-stream";
}
