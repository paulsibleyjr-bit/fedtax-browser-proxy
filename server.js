import http from "http";
import { WebSocketServer, WebSocket } from "ws";

/**
 * Render expects an HTTP server to bind to PORT.
 * WebSocket upgrades happen on this same server.
 */
const PORT = process.env.PORT || 10000;

// ENV
const BASE44_API_URL = process.env.BASE44_API_URL || "https://base44.app/api";
const BASE44_APP_ID = process.env.BASE44_APP_ID; // required
const UPSTREAM_WS_URL = process.env.UPSTREAM_WS_URL || "wss://chrome.browserless.io";
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN; // usually required
const PROXY_VERIFY_KEY = process.env.PROXY_VERIFY_KEY; // must match Base44 secret

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
  // Example: https://base44.app/api/apps/<APP_ID>/functions/verifyBrowserSession
  if (!BASE44_APP_ID) return null;
  return `${BASE44_API_URL}/apps/${BASE44_APP_ID}/functions/verifyBrowserSession`;
}

async function verifySession({ sessionId, proxySecret }) {
  const verifyUrl = buildVerifyUrl();
  if (!verifyUrl) {
    return { ok: false, error: "Missing BASE44_APP_ID env var on Render." };
  }

  // Timeout so the upgrade never hangs forever
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 7000);

  try {
    const headers = {
      "Content-Type": "application/json",
    };

    // Send key in 2 common forms so Base44 can’t miss it
    if (PROXY_VERIFY_KEY) {
      headers["x-proxy-verify-key"] = PROXY_VERIFY_KEY;
      headers["authorization"] = `Bearer ${PROXY_VERIFY_KEY}`;
    }

    const resp = await fetch(verifyUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId, proxySecret }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { ok: false, error: text || `verifyBrowserSession failed (${resp.status})` };
    }

    return { ok: true };
  } catch (e) {
    const msg =
      e?.name === "AbortError"
        ? "verifyBrowserSession timed out"
        : (e?.message || String(e));
    return { ok: false, error: msg };
  } finally {
    clearTimeout(t);
  }
}

function buildUpstreamWsUrl() {
  if (!UPSTREAM_WS_URL) return null;

  const upstream = new URL(UPSTREAM_WS_URL);

  // Add token if you have it and it’s not already set
  if (BROWSERLESS_TOKEN && !upstream.searchParams.get("token")) {
    upstream.searchParams.set("token", BROWSERLESS_TOKEN);
  }

  return upstream.toString();
}

server.on("upgrade", async (request, socket, head) => {
  try {
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

    // Accept WS upgrade
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

  let upstreamWs = null;

  const upstreamUrl = buildUpstreamWsUrl();
  if (!upstreamUrl) {
    clientWs.send(
      safeLog({
        type: "proxy_error",
        message: "UPSTREAM_WS_URL is not set. Proxy verified session but cannot connect upstream.",
      })
    );
  }

  if (upstreamUrl) {
    console.log("[UPSTREAM] connecting to:", upstreamUrl);

    upstreamWs = new WebSocket(upstreamUrl, {
      perMessageDeflate: false,
    });

    upstreamWs.on("open", () => {
      console.log("[UPSTREAM] connected");
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(safeLog({ type: "proxy_status", message: "Upstream connected" }));
      }
    });

    upstreamWs.on("message", (data) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data);
      }
    });

    upstreamWs.on("close", (code, reason) => {
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

  if (!BASE44_APP_ID) console.warn("[BOOT] BASE44_APP_ID is missing — verification will fail.");
  if (!PROXY_VERIFY_KEY) console.warn("[BOOT] PROXY_VERIFY_KEY is missing — Base44 will reject proxy.");
  if (!BROWSERLESS_TOKEN) console.warn("[BOOT] BROWSERLESS_TOKEN missing — upstream may reject connections.");
});
