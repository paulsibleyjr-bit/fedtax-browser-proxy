import http from "http";
import { WebSocketServer, WebSocket } from "ws";

/**
 * Render expects an HTTP server to bind to PORT.
 * WebSocket upgrades happen on this same server.
 */
const PORT = process.env.PORT || 10000;

// REQUIRED ENV (but we do NOT crash if missing)
const BASE44_API_URL = process.env.BASE44_API_URL || "https://base44.app/api";
const BASE44_APP_ID = process.env.BASE44_APP_ID; // should be set in Render env
const UPSTREAM_WS_URL = process.env.UPSTREAM_WS_URL || "wss://chrome.browserless.io";
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;

// Healthcheck HTTP server (Render requires this)
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
});

// Disable permessage-deflate to avoid RSV1/permessage-deflate issues
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
});

function safeLog(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

function buildVerifyUrl() {
  // Base44 functions endpoint
  // Example: https://base44.app/api/apps/<APP_ID>/functions/verifyBrowserSession
  if (!BASE44_APP_ID) return null;
  return `${BASE44_API_URL}/apps/${BASE44_APP_ID}/functions/verifyBrowserSession`;
}

async function verifySession({ sessionId, proxySecret }) {
  const verifyUrl = buildVerifyUrl();
  if (!verifyUrl) {
    return { ok: false, error: "Missing BASE44_APP_ID env var on Render." };
  }

  const resp = await fetch(verifyUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // IMPORTANT: Send JSON body (do not rely on query params)
    body: JSON.stringify({ sessionId, proxySecret }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return { ok: false, error: text || `verifyBrowserSession failed (${resp.status})` };
  }

  // verifyBrowserSession may return JSON or text; we don’t strictly need it
  const dataText = await resp.text().catch(() => "");
  return { ok: true, dataText };
}

function buildUpstreamWsUrl({ originalRequestUrl }) {
  // Your upstream should usually be Browserless.
  // Many Browserless setups expect token via query param: ?token=XXX
  // If you have a different Browserless endpoint (e.g. wss://YOUR_ENDPOINT),
  // set UPSTREAM_WS_URL accordingly in Render.

  // If upstream is missing token, we still allow WS but will report error on connect attempt.
  if (!UPSTREAM_WS_URL) return null;

  // Preserve any existing path or query from UPSTREAM_WS_URL,
  // and append token if needed.
  const upstream = new URL(UPSTREAM_WS_URL);

  // If token is required and not already present, add it.
  if (BROWSERLESS_TOKEN && !upstream.searchParams.get("token")) {
    upstream.searchParams.set("token", BROWSERLESS_TOKEN);
  }

  return upstream.toString();
}

server.on("upgrade", async (request, socket, head) => {
  try {
    // Log what we receive
    console.log("[UPGRADE] request.url =", request.url);

    // Parse query params from the websocket URL the browser used:
    // wss://fedtax-browser-proxy.onrender.com/?sessionId=...&proxySecret=...
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

    // Verify session against Base44
    const verify = await verifySession({ sessionId, proxySecret });
    if (!verify.ok) {
      console.log("[UPGRADE] verify failed:", verify.error);
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n" + verify.error);
      socket.destroy();
      return;
    }

    console.log("[UPGRADE] verify OK");

    // Accept the WS upgrade
    wss.handleUpgrade(request, socket, head, (clientWs) => {
      wss.emit("connection", clientWs, request);
    });
  } catch (err) {
    console.error("[UPGRADE] error:", err?.message || err);
    socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\nUpgrade error");
    socket.destroy();
  }
});

wss.on("connection", (clientWs, request) => {
  console.log("[WS] client connected");

  // We connect to upstream on demand.
  let upstreamWs = null;
  let upstreamReady = false;

  const upstreamUrl = buildUpstreamWsUrl({ originalRequestUrl: request?.url });

  // If upstream config is missing, we keep the client alive but explain the issue.
  if (!upstreamUrl) {
    clientWs.send(
      safeLog({
        type: "proxy_error",
        message: "UPSTREAM_WS_URL is not set. Proxy verified session but cannot connect upstream.",
      })
    );
  }

  // Attempt upstream connection if we have a URL
  if (upstreamUrl) {
    console.log("[UPSTREAM] connecting to:", upstreamUrl);

    upstreamWs = new WebSocket(upstreamUrl, {
      perMessageDeflate: false,
    });

    upstreamWs.on("open", () => {
      upstreamReady = true;
      console.log("[UPSTREAM] connected");
      clientWs.send(safeLog({ type: "proxy_status", message: "Upstream connected" }));
    });

    upstreamWs.on("message", (data) => {
      // Forward upstream -> client
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data);
      }
    });

    upstreamWs.on("close", (code, reason) => {
      upstreamReady = false;
      console.log("[UPSTREAM] closed", code, reason?.toString?.() || "");
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(
          safeLog({
            type: "proxy_error",
            message: "Upstream disconnected",
            code,
          })
        );
      }
    });

    upstreamWs.on("error", (e) => {
      upstreamReady = false;
      console.log("[UPSTREAM] error", e?.message || e);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(
          safeLog({
            type: "proxy_error",
            message: "Upstream connection error: " + (e?.message || "unknown"),
          })
        );
      }
    });
  }

  // Forward client -> upstream
  clientWs.on("message", (data) => {
    if (!upstreamWs || upstreamWs.readyState !== WebSocket.OPEN) {
      // Don’t crash — just tell client upstream isn’t ready
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(
          safeLog({
            type: "proxy_error",
            message: upstreamUrl
              ? "Upstream not ready yet. Try again in a moment."
              : "Upstream URL missing. Check Render env vars.",
          })
        );
      }
      return;
    }

    upstreamWs.send(data);
  });

  clientWs.on("close", () => {
    console.log("[WS] client closed");
    try {
      if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN) upstreamWs.close();
    } catch {}
  });

  clientWs.on("error", (e) => {
    console.log("[WS] client error", e?.message || e);
    try {
      if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN) upstreamWs.close();
    } catch {}
  });
});

server.listen(PORT, () => {
  console.log("Proxy listening on", PORT);

  // IMPORTANT: DO NOT EXIT IF MISSING ENV VARS
  if (!BASE44_APP_ID) {
    console.warn("[BOOT] BASE44_APP_ID is missing — verifyBrowserSession will fail until set.");
  }
  if (!process.env.UPSTREAM_WS_URL) {
    console.warn("[BOOT] UPSTREAM_WS_URL not set — defaulting to wss://chrome.browserless.io");
  }
  if (!BROWSERLESS_TOKEN) {
    console.warn("[BOOT] BROWSERLESS_TOKEN missing — upstream may reject connections if token is required.");
  }
});
