// server.js (CommonJS-safe for Render)

const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

// Node 22 has global fetch; keep a fallback just in case.
const fetchFn = global.fetch
  ? global.fetch
  : (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const PORT = process.env.PORT || 10000;

// ENV
const BASE44_API_URL = process.env.BASE44_API_URL || "https://base44.app/api";
const BASE44_APP_ID = process.env.BASE44_APP_ID;
const UPSTREAM_WS_URL = process.env.UPSTREAM_WS_URL || "wss://chrome.browserless.io";
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
const PROXY_VERIFY_KEY = process.env.PROXY_VERIFY_KEY;

// Basic health server (Render needs an HTTP listener)
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
});

// IMPORTANT: disable permessage-deflate (prevents RSV1 issues)
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

function buildVerifyUrl() {
  if (!BASE44_APP_ID) return null;
  return `${BASE44_API_URL}/apps/${BASE44_APP_ID}/functions/verifyBrowserSession`;
}

async function verifySession({ sessionId, proxySecret }) {
  const verifyUrl = buildVerifyUrl();
  if (!verifyUrl) return { ok: false, error: "Missing BASE44_APP_ID on Render." };

  if (!PROXY_VERIFY_KEY) {
    return { ok: false, error: "Missing PROXY_VERIFY_KEY on Render." };
  }

  const headers = {
    "Content-Type": "application/json",
    // ✅ send BOTH variants so Base44 can check either
    "x-proxy-verify-key": PROXY_VERIFY_KEY,
    authorization: `Bearer ${PROXY_VERIFY_KEY}`,
  };

  const resp = await fetchFn(verifyUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ sessionId, proxySecret }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return { ok: false, error: text || `verifyBrowserSession failed (${resp.status})` };
  }

  return { ok: true };
}

function buildUpstreamWsUrl() {
  if (!UPSTREAM_WS_URL) return null;

  const upstream = new URL(UPSTREAM_WS_URL);

  // Add token if missing
  if (BROWSERLESS_TOKEN && !upstream.searchParams.get("token")) {
    upstream.searchParams.set("token", BROWSERLESS_TOKEN);
  }

  return upstream.toString();
}

server.on("upgrade", async (request, socket, head) => {
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

    const verify = await verifySession({ sessionId, proxySecret });
    if (!verify.ok) {
      console.log("[UPGRADE] verify failed:", verify.error);
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n" + verify.error);
      socket.destroy();
      return;
    }

    console.log("[UPGRADE] verify OK");

    wss.handleUpgrade(request, socket, head, (clientWs) => {
      wss.emit("connection", clientWs, request);
    });
  } catch (err) {
    console.error("[UPGRADE] error:", err && err.stack ? err.stack : err);
    socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\nUpgrade error");
    socket.destroy();
  }
});

wss.on("connection", (clientWs) => {
  console.log("[WS] client connected");

  const upstreamUrl = buildUpstreamWsUrl();
  let upstreamWs = null;

  if (!upstreamUrl) {
    clientWs.send(
      safeJson({
        type: "proxy_error",
        message: "UPSTREAM_WS_URL missing. Set it on Render.",
      })
    );
    return;
  }

  console.log("[UPSTREAM] connecting to:", upstreamUrl);

  upstreamWs = new WebSocket(upstreamUrl, { perMessageDeflate: false });

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
    console.log("[UPSTREAM] closed", code, reason ? reason.toString() : "");
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  });

  upstreamWs.on("error", (e) => {
    console.log("[UPSTREAM] error", e && e.message ? e.message : e);
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  });

  clientWs.on("message", (data) => {
    if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN) {
      upstreamWs.send(data);
    }
  });

  clientWs.on("close", () => {
    console.log("[WS] client closed");
    try {
      if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN) upstreamWs.close();
    } catch {}
  });

  clientWs.on("error", () => {
    try {
      if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN) upstreamWs.close();
    } catch {}
  });
});

server.listen(PORT, () => {
  console.log("Proxy listening on", PORT);

  if (!BASE44_APP_ID) console.warn("[BOOT] BASE44_APP_ID missing.");
  if (!PROXY_VERIFY_KEY) console.warn("[BOOT] PROXY_VERIFY_KEY missing.");
  if (!BROWSERLESS_TOKEN) console.warn("[BOOT] BROWSERLESS_TOKEN missing.");
});
