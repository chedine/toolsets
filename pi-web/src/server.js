import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { loadConfig } from "./config.js";
import { listDirectories } from "./directory-browser.js";
import { SessionDiscovery } from "./session-discovery.js";
import { deleteSessionFile } from "./session-files.js";
import { SessionStore } from "./store.js";
import { SessionSupervisor } from "./supervisor.js";

const config = loadConfig();
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const markedPath = fileURLToPath(new URL("../node_modules/marked/lib/marked.esm.js", import.meta.url));
const domPurifyPath = fileURLToPath(new URL("../node_modules/dompurify/dist/purify.es.mjs", import.meta.url));
const store = new SessionStore(config.dataDir);
await store.load();
const supervisor = new SessionSupervisor(config, store);
const discovery = new SessionDiscovery(config.sessionDir);
const sockets = new Set();

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

function tokenMatches(candidate) {
  if (!config.token) return true;
  const expected = Buffer.from(config.token);
  const actual = Buffer.from(candidate ?? "");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function originMatches(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function broadcast(message) {
  for (const socket of sockets) send(socket, message);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    const assets = new Map([
      ["/", "index.html"],
      ["/index.html", "index.html"],
      ["/app.js", "app.js"],
      ["/styles.css", "styles.css"],
      ["/fonts/archivo.woff2", "fonts/archivo.woff2"],
      ["/fonts/jetbrains-mono.woff2", "fonts/jetbrains-mono.woff2"],
      ["/fonts/space-grotesk.woff2", "fonts/space-grotesk.woff2"],
    ]);
    const vendorAssets = new Map([
      ["/vendor/marked.esm.js", markedPath],
      ["/vendor/purify.es.mjs", domPurifyPath],
    ]);
    const asset = assets.get(url.pathname);
    const assetPath = asset ? join(publicDir, asset) : vendorAssets.get(url.pathname);
    if (!assetPath) {
      response.writeHead(404).end("Not found");
      return;
    }
    const body = await readFile(assetPath);
    response.writeHead(200, {
      "content-type": contentTypes[extname(assetPath)] ?? "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; connect-src 'self' ws: wss:; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
    });
    response.end(body);
  } catch (error) {
    response.writeHead(500).end(error instanceof Error ? error.message : "Internal error");
  }
});

const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname !== "/ws" || !originMatches(request) || !tokenMatches(url.searchParams.get("token"))) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  websocketServer.handleUpgrade(request, socket, head, (websocket) => websocketServer.emit("connection", websocket));
});

websocketServer.on("connection", (socket) => {
  sockets.add(socket);
  send(socket, { type: "hello", sessions: supervisor.list() });

  socket.on("message", async (data, isBinary) => {
    let message;
    try {
      if (isBinary) throw new Error("Binary messages are not supported");
      message = JSON.parse(data.toString());
      if (!message || typeof message.type !== "string") throw new Error("Invalid message");
      switch (message.type) {
        case "list_sessions":
          send(socket, { type: "sessions", sessions: supervisor.list(), requestId: message.requestId });
          break;
        case "search_sessions": {
          const sessions = await discovery.search(message.query, supervisor.list());
          send(socket, { type: "session_search_results", sessions, requestId: message.requestId });
          break;
        }
        case "browse_directories": {
          const listing = await listDirectories(message.path);
          send(socket, { type: "directory_listing", ...listing, requestId: message.requestId });
          break;
        }
        case "import_session": {
          const metadata = await discovery.inspect(message.sessionFile);
          const result = await supervisor.importSession(metadata);
          send(socket, { type: "attached", ...result, sessionId: result.record.id, requestId: message.requestId });
          break;
        }
        case "create_session": {
          const result = await supervisor.create({
            cwd: message.cwd,
            name: message.name,
            approveProject: message.approveProject,
          });
          send(socket, { type: "attached", ...result, sessionId: result.record.id, requestId: message.requestId });
          break;
        }
        case "attach_session": {
          const result = await supervisor.attach(message.sessionId);
          send(socket, { type: "attached", ...result, sessionId: message.sessionId, requestId: message.requestId });
          break;
        }
        case "rpc": {
          const responseMessage = await supervisor.request(message.sessionId, message.command);
          send(socket, {
            type: "rpc_response",
            sessionId: message.sessionId,
            requestId: message.requestId,
            response: responseMessage,
          });
          break;
        }
        case "extension_ui_response":
          supervisor.sendExtensionResponse(message.sessionId, {
            type: "extension_ui_response",
            id: message.id,
            ...(message.cancelled ? { cancelled: true } : {}),
            ...(typeof message.value === "string" ? { value: message.value } : {}),
            ...(typeof message.confirmed === "boolean" ? { confirmed: message.confirmed } : {}),
          });
          break;
        case "stop_session":
          await supervisor.stopSession(message.sessionId);
          send(socket, { type: "session_stopped", sessionId: message.sessionId, requestId: message.requestId });
          break;
        case "delete_session": {
          const managed = supervisor.list().find((session) =>
            session.id === message.sessionId || session.sessionFile === message.sessionFile);
          if (managed) await supervisor.deleteSession(managed.id);
          else {
            if (typeof message.sessionFile !== "string") throw new Error("Session file is required");
            await deleteSessionFile(config.sessionDir, message.sessionFile);
          }
          discovery.invalidate();
          send(socket, { type: "session_deleted", sessionId: message.sessionId, requestId: message.requestId });
          break;
        }
        default:
          throw new Error(`Unknown message type: ${message.type}`);
      }
    } catch (error) {
      send(socket, {
        type: "error",
        requestId: message?.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => sockets.delete(socket));
});

supervisor.onEvent((event) => broadcast(event));

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  for (const socket of sockets) socket.close(1001, "Server stopping");
  await supervisor.close();
  await new Promise((resolve) => server.close(resolve));
}
process.on("SIGINT", () => void close().then(() => process.exit(0)));
process.on("SIGTERM", () => void close().then(() => process.exit(0)));

server.listen(config.port, config.host, () => {
  const auth = config.token ? "token required" : "loopback only, no token";
  console.log(`pi-web listening on http://${config.host}:${config.port} (${auth})`);
});
