import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const BUILD = "proxy-v3-2026-02-03-1435"; // <-- used to confirm deploy

const PORT = process.env.PORT || 10000;

const UPSTREAM_WS_URL = process.env.UPSTREAM_WS_URL || "wss://chrome.browserless.io";
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;

// Render healthcheck
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
});

// Browser -> Proxy compression OFF (Base44 client side)
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
});

function safeJson(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

function buildBrowserlessWsUrl() {
  const u = new URL(UPSTREAM_WS_URL);

  if (BROWSERLESS_TOKEN && !u.searchParams.get("token")) {
    u.searchParams.set("token", BROWSERLESS_TOKEN);
  }

  // IMPORTANT: Browserless should be: wss://host?token=...
  // URL() will default pathname to "/" so we intentionally omit pathname entirely:
  return `${u.protocol}//${u.host}${u.search}`;
}

server.on("upgrade", (request, socket, head) => {
  try {
    console.log(`[BOOT ${BUILD}] [UPGRADE] request.url =`, request.url);

    const url = new URL(request.url, "http://localhost");
    const sessionId = url.searchParams.get("sessionId");
    const proxySecret = url.searchParams.get("proxySecret");

    console.log(`[UPGRADE] sessionId present =`, Boolean(sessionId));
    console.log(`[UPGRADE] proxySecret present =`, Boolean(proxySecret));

    if (!sessionId || !proxySecret) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\nMissing sessionId/proxySecret");
      socket.destroy();
      return;
    }

    // OPTION A: skip verification entirely
    console.log("[UPGRADE] verification skipped (OPTION A)");

    wss.handleUpgrade(request, socket, head, (clientWs) => {
      wss.emit("connection", clientWs, request);
    });
  } catch (err) {
    console.error("[UPGRADE] error:", err?.message || err);
    socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\nUpgrade error");
    socket.destroy();
  }
});

wss.on("connection", (clientWs) => {
  console.log(`[BOOT ${BUILD}] [WS] client connected`);

  const upstreamUrl = buildBrowserlessWsUrl();
  console.log(`[BOOT ${BUILD}] [UPSTREAM] connecting to:`, upstreamUrl);

  // KEY FIX: enable permessage-deflate on upstream client
  const upstreamWs = new WebSocket(upstreamUrl, {
    perMessageDeflate: true,
    maxPayload: 64 * 1024 * 1024,
  });

  const pingInterval = setInterval(() => {
    try {
      if (upstreamWs.readyState === WebSocket.OPEN) upstreamWs.ping();
    } catch {}
  }, 25000);

  upstreamWs.on("open", () => {
    console.log(`[BOOT ${BUILD}] [UPSTREAM] connected`);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(safeJson({ type: "proxy_status", message: "Upstream connected" }));
    }
  });

  upstreamWs.on("message", (data) => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data);
  });

  upstreamWs.on("close", (code, reason) => {
    clearInterval(pingInterval);
    console.log(`[BOOT ${BUILD}] [UPSTREAM] closed`, code, reason?.toString?.() || "");
    try {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
    } catch {}
  });

  upstreamWs.on("error", (e) => {
    clearInterval(pingInterval);
    console.log(`[BOOT ${BUILD}] [UPSTREAM] error`, e?.message || e);
    try {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
    } catch {}
  });

  // Forward client -> upstream
  clientWs.on("message", (data) => {
    if (upstreamWs.readyState === WebSocket.OPEN) upstreamWs.send(data);
  });

  clientWs.on("close", () => {
    console.log(`[BOOT ${BUILD}] [WS] client closed`);
    clearInterval(pingInterval);
    try {
      upstreamWs.close();
    } catch {}
  });

  clientWs.on("error", (e) => {
    console.log(`[BOOT ${BUILD}] [WS] client error`, e?.message || e);
    clearInterval(pingInterval);
    try {
      upstreamWs.close();
    } catch {}
  });
});

server.listen(PORT, () => {
  console.log(`[BOOT ${BUILD}] Proxy listening on`, PORT);
  if (!BROWSERLESS_TOKEN) console.warn(`[BOOT ${BUILD}] BROWSERLESS_TOKEN missing`);
});
