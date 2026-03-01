import http from "node:http";
import process from "node:process";
import httpProxy from "http-proxy";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const TARGET_ORIGIN = process.env.TARGET_ORIGIN || "https://chatgpt.com";
const TARGET_PREFIX = normalizePrefix(process.env.TARGET_PREFIX || "/backend-api");

function normalizePrefix(prefix) {
  if (!prefix || prefix === "/") return "";
  const withLeadingSlash = prefix.startsWith("/") ? prefix : `/${prefix}`;
  return withLeadingSlash.endsWith("/")
    ? withLeadingSlash.slice(0, -1)
    : withLeadingSlash;
}

function rewritePath(url = "/") {
  if (!TARGET_PREFIX) return url;
  if (url === TARGET_PREFIX || url.startsWith(`${TARGET_PREFIX}/`)) return url;
  const normalizedUrl = url.startsWith("/") ? url : `/${url}`;
  return `${TARGET_PREFIX}${normalizedUrl}`;
}

function log(message) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${message}`);
}

const proxy = httpProxy.createProxyServer({
  target: TARGET_ORIGIN,
  changeOrigin: true,
  ws: true,
  xfwd: true,
  secure: true,
  ignorePath: false,
});

proxy.on("error", (err, req, res) => {
  log(`proxy error: ${err.message}`);

  if (res && !res.headersSent) {
    res.writeHead(502, { "content-type": "application/json" });
  }

  if (res && !res.writableEnded) {
    res.end(
      JSON.stringify({
        error: "bad_gateway",
        message: "Proxy relay failed",
        detail: err.message,
      }),
    );
  }
});

const server = http.createServer((req, res) => {
  const method = req.method || "GET";
  const originalUrl = req.url || "/";

  if (method === "GET" && originalUrl === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        targetOrigin: TARGET_ORIGIN,
        targetPrefix: TARGET_PREFIX || "/",
      }),
    );
    return;
  }

  const upstreamUrl = rewritePath(originalUrl);
  req.url = upstreamUrl;

  log(`${method} ${originalUrl} -> ${TARGET_ORIGIN}${upstreamUrl}`);

  proxy.web(req, res, { target: TARGET_ORIGIN });
});

server.on("upgrade", (req, socket, head) => {
  const originalUrl = req.url || "/";
  const upstreamUrl = rewritePath(originalUrl);
  req.url = upstreamUrl;

  log(`WS ${originalUrl} -> ${TARGET_ORIGIN}${upstreamUrl}`);

  proxy.ws(req, socket, head, { target: TARGET_ORIGIN });
});

server.listen(PORT, HOST, () => {
  log(`codex relay listening on http://${HOST}:${PORT}`);
  log(`forwarding to ${TARGET_ORIGIN}${TARGET_PREFIX || ""}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    log(`received ${signal}, shutting down`);
    server.close(() => process.exit(0));
  });
}
