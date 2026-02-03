import http from "http";
import { WebSocketServer, WebSocket } from "ws";

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

// IMPORTANT: Base44/browser -> proxy (client side) compression OFF
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

function buildUpstreamWsUrl() {
  const u = new URL(UPSTREAM_WS_URL);

  // Browserless expects token as query param
  if (BROWSERLESS_TOKEN && !u.searchParams.get("token")) {
    u.searchParams.set("token", BROWSERLESS_TOKEN);
  }

  // IMPORTANT: avoid trailing "/"
  // wss://chrome.browserless.io?token=...
  if (u.pathname === "/") u.pathname = "";

  return u.toString();
}

server.on("upgrade", (request, socket, head) => {
  try {
    console.log("[UPGRADE] request.url =", request.url);

    const url = new URL(request.url, "http://localhost");
    const sessionId = url.searchParams.get("sessionId");
    const proxySecret = url.searchParams.get("proxySecret");

    console.log("[UPGRADE] sessionId present =", Boolean(sessionId));
    console.log("[UPGRADE] proxySecret present =", Boolean(proxySecret));

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
  console.log("[WS] client connected");

  const upstreamUrl = buildUpstreamWsUrl();
  console.log("[UPSTREAM] connecting to:", upstreamUrl);

  // ✅ KEY FIX:
  // Enable permessage-deflate explicitly for Browserless.
  // This prevents RSV1 errors.
  const upstreamWs = new WebSocket(upstreamUrl, {
    perMessageDeflate: {
      threshold: 0,
      clientNoContextTakeover: true,
      serverNoContextTakeover: true,
      clientMaxWindowBits: 15,
      serverMaxWindowBits: 15,
    },
    maxPayload: 64 * 1024 * 1024,
  });

  const pingInterval = setInterval(() => {
    try {
      if (upstreamWs.readyState === WebSocket.OPEN) upstreamWs.ping();
    } catch {}
  }, 25000);

  upstreamWs.on("open", () => {
    console.log("[UPSTREAM] connected");
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(safeJson({ type: "proxy_status", message: "Upstream connected" }));
    }
  });

  upstreamWs.on("message", (data) => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data);
  });

  upstreamWs.on("close", (code, reason) => {
    clearInterval(pingInterval);
    console.log("[UPSTREAM] closed", code, reason?.toString?.() || "");
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(safeJson({ type: "proxy_error", message: "Upstream disconnected", code }));
      clientWs.close();
    }
  });

  upstreamWs.on("error", (e) => {
    clearInterval(pingInterval);
    console.log("[UPSTREAM] error", e?.message || e);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(
        safeJson({
          type: "proxy_error",
          message: "Upstream error: " + (e?.message || "unknown"),
        })
      );
      clientWs.close();
    }
  });

  // Forward client -> upstream
  clientWs.on("message", (data) => {
    if (upstreamWs.readyState === WebSocket.OPEN) upstreamWs.send(data);
  });

  clientWs.on("close", () => {
    console.log("[WS] client closed");
    clearInterval(pingInterval);
    try {
      upstreamWs.close();
    } catch {}
  });

  clientWs.on("error", (e) => {
    console.log("[WS] client error", e?.message || e);
    clearInterval(pingInterval);
    try {
      upstreamWs.close();
    } catch {}
  });
});

server.listen(PORT, () => {
  console.log("Proxy listening on", PORT);
  if (!BROWSERLESS_TOKEN) {
    console.warn("[BOOT] BROWSERLESS_TOKEN missing — Browserless may reject connections.");
  }
});
