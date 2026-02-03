import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 10000;

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

    // ✅ OPTION A: Skip verification for now
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

  let upstreamWs = null;
  const upstreamUrl = buildUpstreamWsUrl();

  if (!upstreamUrl) {
    clientWs.send(
      safeLog({
        type: "proxy_error",
        message: "UPSTREAM_WS_URL is not set. Proxy connected but cannot connect upstream.",
      })
    );
  }

  if (upstreamUrl) {
    console.log("[UPSTREAM] connecting to:", upstreamUrl);

    upstreamWs = new WebSocket(upstreamUrl, { perMessageDeflate: false });

    upstreamWs.on("open", () => {
      console.log("[UPSTREAM] connected");
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(safeLog({ type: "proxy_status", message: "Upstream connected" }));
      }
    });

    upstreamWs.on("message", (data) => {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data);
    });

    upstreamWs.on("close", (code, reason) => {
      console.log("[UPSTREAM] closed", code, reason?.toString?.() || "");
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(safeLog({ type: "proxy_error", message: "Upstream disconnected", code }));
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

  if (!process.env.UPSTREAM_WS_URL) {
    console.warn("[BOOT] UPSTREAM_WS_URL not set — defaulting to wss://chrome.browserless.io");
  }
  if (!BROWSERLESS_TOKEN) {
    console.warn("[BOOT] BROWSERLESS_TOKEN missing — upstream may reject connections if token is required.");
  }
});
