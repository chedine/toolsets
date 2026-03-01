import http from "node:http";
import https from "node:https";
import net from "node:net";
import process from "node:process";

const PORT = Number(process.env.PORT || 8789);
const HOST = process.env.HOST || "0.0.0.0";

let requestCounter = 0;
const nextId = (prefix) => `${prefix}-${++requestCounter}`;

function log(message) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${message}`);
}

function errInfo(err) {
  if (!err) return "unknown";
  const code = err.code ? ` code=${err.code}` : "";
  return `${err.message}${code}`;
}

function sanitizeHeaders(headers) {
  const next = { ...headers };
  delete next["proxy-connection"];
  delete next["proxy-authorization"];
  delete next["proxy-authenticate"];
  return next;
}

function sendJson(res, code, data) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

const server = http.createServer((clientReq, clientRes) => {
  const id = nextId("http");
  const startedAt = Date.now();

  const method = clientReq.method || "GET";
  const rawUrl = clientReq.url || "/";

  if (method === "GET" && rawUrl === "/healthz") {
    sendJson(clientRes, 200, { ok: true, mode: "forward-proxy" });
    return;
  }

  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    const host = clientReq.headers.host;
    if (!host) {
      log(`[${id}] bad request: missing host header for url=${rawUrl}`);
      sendJson(clientRes, 400, { error: "bad_request", message: "Missing host header" });
      return;
    }

    try {
      target = new URL(`http://${host}${rawUrl}`);
    } catch {
      log(`[${id}] bad request: invalid target url=${rawUrl} host=${host}`);
      sendJson(clientRes, 400, { error: "bad_request", message: `Invalid target URL: ${rawUrl}` });
      return;
    }
  }

  const isHttps = target.protocol === "https:";
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    log(`[${id}] unsupported protocol: ${target.protocol} for url=${rawUrl}`);
    sendJson(clientRes, 400, {
      error: "bad_request",
      message: `Unsupported protocol: ${target.protocol}`,
    });
    return;
  }

  const requestImpl = isHttps ? https : http;
  const upstreamPath = `${target.pathname}${target.search}`;
  const headers = sanitizeHeaders(clientReq.headers);

  log(`[${id}] ${method} ${rawUrl} -> ${target.origin}${upstreamPath}`);

  const upstreamReq = requestImpl.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      method,
      path: upstreamPath,
      headers,
    },
    (upstreamRes) => {
      const durationMs = Date.now() - startedAt;
      const status = upstreamRes.statusCode || 502;
      const length = upstreamRes.headers["content-length"] || "?";
      log(`[${id}] upstream response status=${status} bytes=${length} durationMs=${durationMs}`);

      clientRes.writeHead(status, upstreamRes.statusMessage || "Bad Gateway", upstreamRes.headers);
      upstreamRes.pipe(clientRes);
    },
  );

  upstreamReq.on("error", (err) => {
    log(`[${id}] upstream request error: ${errInfo(err)}`);
    if (!clientRes.headersSent) {
      sendJson(clientRes, 502, {
        error: "bad_gateway",
        message: "Forward proxy request failed",
        detail: err.message,
      });
    } else {
      clientRes.end();
    }
  });

  clientReq.on("aborted", () => {
    log(`[${id}] client request aborted`);
    upstreamReq.destroy();
  });

  clientRes.on("close", () => {
    const durationMs = Date.now() - startedAt;
    log(`[${id}] client response closed finished=${clientRes.writableEnded} durationMs=${durationMs}`);
  });

  clientReq.pipe(upstreamReq);
});

server.on("connect", (req, clientSocket, head) => {
  const id = nextId("connect");
  const startedAt = Date.now();

  const authority = req.url || "";
  const [hostPart, portPart] = authority.split(":");
  const targetHost = hostPart;
  const targetPort = Number(portPart || 443);

  if (!targetHost || Number.isNaN(targetPort)) {
    log(`[${id}] invalid CONNECT authority=${authority}`);
    clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    clientSocket.destroy();
    return;
  }

  const ua = req.headers["user-agent"] || "-";
  const conn = req.headers["connection"] || "-";
  const pconn = req.headers["proxy-connection"] || "-";
  log(
    `[${id}] CONNECT ${authority} headBytes=${head?.length || 0} ua=${ua} conn=${conn} proxy-conn=${pconn}`,
  );

  const upstreamSocket = net.connect(targetPort, targetHost, () => {
    log(
      `[${id}] tunnel established local=${upstreamSocket.localAddress}:${upstreamSocket.localPort} remote=${upstreamSocket.remoteAddress}:${upstreamSocket.remotePort}`,
    );

    const connectResponse =
      "HTTP/1.1 200 OK\r\n" +
      "Connection: keep-alive\r\n" +
      "Proxy-Agent: codexrouter-forward\r\n" +
      "\r\n";

    clientSocket.write(connectResponse, () => {
      if (head && head.length > 0) {
        upstreamSocket.write(head);
      }

      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });
  });

  upstreamSocket.on("error", (err) => {
    log(`[${id}] upstream socket error: ${errInfo(err)}`);
    try {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    } catch {
      // ignore write errors during teardown
    }
    clientSocket.destroy();
  });

  upstreamSocket.on("end", () => {
    log(`[${id}] upstream socket end`);
  });

  upstreamSocket.on("close", (hadError) => {
    const durationMs = Date.now() - startedAt;
    log(
      `[${id}] upstream socket close hadError=${hadError} bytesRead=${upstreamSocket.bytesRead} bytesWritten=${upstreamSocket.bytesWritten} durationMs=${durationMs}`,
    );
  });

  clientSocket.on("error", (err) => {
    log(`[${id}] client socket error: ${errInfo(err)}`);
    upstreamSocket.destroy();
  });

  clientSocket.on("end", () => {
    log(`[${id}] client socket end`);
  });

  clientSocket.on("close", (hadError) => {
    const durationMs = Date.now() - startedAt;
    log(
      `[${id}] client socket close hadError=${hadError} bytesRead=${clientSocket.bytesRead} bytesWritten=${clientSocket.bytesWritten} durationMs=${durationMs}`,
    );
  });
});

server.on("clientError", (err, socket) => {
  log(`server clientError: ${errInfo(err)}`);
  try {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  } catch {
    socket.destroy();
  }
});

server.listen(PORT, HOST, () => {
  log(`forward proxy listening on http://${HOST}:${PORT}`);
  log(
    `proxy env reminder: HTTP_PROXY=http://${HOST}:${PORT} HTTPS_PROXY=http://${HOST}:${PORT} ALL_PROXY=http://${HOST}:${PORT}`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    log(`received ${signal}, shutting down`);
    server.close(() => process.exit(0));
  });
}
