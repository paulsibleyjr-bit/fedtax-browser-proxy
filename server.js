import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 10000;

// Render/health checks
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
});

// IMPORTANT: disable permessage-deflate to avoid RSV1 errors
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
});

// ---- helpers ----
function buildUpstreamUrl() {
  const endpoint = process.env.BROWSERLESS_WS_ENDPOINT || process.env.UPSTREAM_WS_URL || "";
  const token = process.env.BROWSERLESS_TOKEN || "";
  if (!endpoint) return null;

  // If they already gave a full tokenized URL, use it as-is
  if (endpoint.includes("token=")) return endpoint;

  if (!token) return endpoint;

  // Append token safely
  const hasQuery = endpoint.includes("?");
  const sep = hasQuery ? "&" : "?";
  return `${endpoint}${sep}token=${encodeURIComponent(token)}`;
}

function getSessionCredsFromRequest(request) {
  // 1) From query params
  const url = new URL(request.url || "/", "http://localhost");
  let sessionId = url.searchParams.get("sessionId") || "";
  let proxySecret = url.searchParams.get("proxySecret") || "";

  // 2) Fallback: some platforms strip WS query params — allow headers too
  if (!sessionId) sessionId = request.headers["x-session-id"] || "";
  if (!proxySecret) proxySecret = request.headers["x-proxy-secret"] || "";

  return { sessionId, proxySecret, urlString: url.toString() };
}

async function verifyWithBase44(sessionId, proxySecret) {
  // Use env if you set it; otherwise default to base44.app
  const appId = process.env.BASE44_APP_ID;
  const baseApi =
    (process.env.BASE44_API_URL || "https://base44.app/api").replace(/\/$/, "");

  if (!appId) {
    throw new Error("Missing BASE44_APP_ID env var on Render");
  }

  const verifyUrl = `${baseApi}/apps/${appId}/functions/verifyBrowserSession`;

  // IMPORTANT:
  // We send BOTH query params AND JSON body for maximum compatibility
  const withQuery = `${verifyUrl}?sessionId=${encodeURIComponent(
    sessionId
  )}&proxySecret=${encodeURIComponent(proxySecret)}`;

  const res = await fetch(withQuery, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Optional shared secret if you add it to verifyBrowserSession (recommended)
      ...(process.env.PROXY_VERIFY_KEY
        ? { "x-proxy-verify-key": process.env.PROXY_VERIFY_KEY }
        : {}),
    },
    body: JSON.stringify({ sessionId, proxySecret }),
  });

  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

// ---- WS upgrade ----
server.on("upgrade", async (request, socket, head) => {
  try {
    console.log("\n[UPGRADE] request.url =", request.url);
    console.log("[UPGRADE] host =", request.headers.host);
    console.log("[UPGRADE] origin =", request.headers.origin);

    const { sessionId, proxySecret, urlString } = getSessionCredsFromRequest(request);

    console.log("[UPGRADE] parsed url =", urlString);
    console.log("[UPGRADE] sessionId =", sessionId ? sessionId.slice(0, 12) + "..." : "(missing)");
    console.log("[UPGRADE] proxySecret present =", Boolean(proxySecret));

    if (!sessionId || !proxySecret) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\nMissing sessionId/proxySecret");
      socket.destroy();
      return;
    }

    // 1) Verify session with Base44
    const verify = await verifyWithBase44(sessionId, proxySecret);
    if (!verify.ok) {
      console.log("[UPGRADE] verify FAILED status:", verify.status);
      console.log("[UPGRADE] verify body:", verify.text.slice(0, 500));
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n" + verify.text);
      socket.destroy();
      return;
    }

    console.log("[UPGRADE] verify OK");

    // Upgrade accepted
    wss.handleUpgrade(request, socket, head, (clientWs) => {
      wss.emit("connection", clientWs, request);
    });
  } catch (err) {
    console.error("[UPGRADE] error:", err);
    socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\nUpgrade error");
    socket.destroy();
  }
});

// ---- Connection: pipe client <-> browserless ----
wss.on("connection", (clientWs) => {
  console.log("[WS] client connected");

  const upstreamUrl = buildUpstreamUrl();

  if (!upstreamUrl) {
    console.log("[WS] Missing BROWSERLESS_WS_ENDPOINT/UPSTREAM_WS_URL env var");
    clientWs.close(1011, "Missing upstream");
    return;
  }

  console.log("[WS] connecting upstream:", upstreamUrl.replace(/token=[^&]+/, "token=***"));

  const upstreamWs = new WebSocket(upstreamUrl, {
    perMessageDeflate: false,
  });

  // If upstream opens, start piping
  upstreamWs.on("open", () => {
    console.log("[WS] upstream connected");

    // pipe client -> upstream
    clientWs.on("message", (msg) => {
      if (upstreamWs.readyState === WebSocket.OPEN) upstreamWs.send(msg);
    });

    // pipe upstream -> client
    upstreamWs.on("message", (msg) => {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.send(msg);
    });
  });

  upstreamWs.on("close", (code, reason) => {
    console.log("[WS] upstream closed", code, reason?.toString?.() || "");
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1011, "Upstream closed");
  });

  upstreamWs.on("error", (e) => {
    console.log("[WS] upstream error", e?.message || e);
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1011, "Upstream error");
  });

  clientWs.on("close", () => {
    console.log("[WS] client closed");
    if (upstreamWs.readyState === WebSocket.OPEN) upstreamWs.close(1000, "Client closed");
  });

  clientWs.on("error", (e) => {
    console.log("[WS] client error", e?.message || e);
    if (upstreamWs.readyState === WebSocket.OPEN) upstreamWs.close(1011, "Client error");
  });
});

server.listen(PORT, () => {
  console.log("Proxy listening on", PORT);
});
