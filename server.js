import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 10000;

// ENV
const BASE44_API_URL = process.env.BASE44_API_URL || "https://base44.app/api";
const BASE44_APP_ID = process.env.BASE44_APP_ID;
const PROXY_VERIFY_KEY = process.env.PROXY_VERIFY_KEY; // ✅ you added this in Render
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

// Disable permessage-deflate to avoid RSV1 issues
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
});

function buildVerifyUrl() {
  if (!BASE44_APP_ID) return null;
  return `${BASE44_API_URL}/apps/${BASE44_APP_ID}/functions/verifyBrowserSession`;
}

async function verifySession({ sessionId, proxySecret }) {
  const verifyUrl = buildVerifyUrl();
  if (!verifyUrl) {
    return { ok: false, error: "Missing BASE44_APP_ID env var on Render." };
  }

  // ✅ Hard timeout so upgrade doesn't hang
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 7000);

  try {
    const headers = { "Content-Type": "application/json" };

    // ✅ If Base44 is checking a header secret, send it
    // (Safe even if Base44 doesn't require it.)
    if (PROXY_VERIFY_KEY) {
      headers["x-proxy-verify-key"] = PROXY_VERIFY_KEY;
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

    // We don't need to parse; success is enough
    return { ok: true };
  } catch (e) {
    const msg = e?.name === "AbortError" ? "verifyBrowserSession timed out" : (e?.message || String(e));
    return { ok: false, error: msg };
  } finally {
    clearTimeout(t);
  }
}

function buildUpstreamWsUrl() {
  if (!UPSTREAM_WS_URL) return null;

  const upstream = new URL(UPSTREAM_WS_URL);

  // ✅ Add token if needed
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
    console.error("[UPGRADE] error:", err?.message || err);
    socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\nUpgrade error");
    socket.destroy();
  }
});

wss.on("connection", (clientWs) => {
  console.log("[WS] client connected");

  const upstreamUrl = buildUpstreamWsUrl();
  if (!upstreamUrl) {
    console.log("[WS] missing UPSTREAM_WS_URL");
    try { clientWs.close(1011, "Missing UPSTREAM_WS_URL"); } catch {}
    return;
  }

  console.log("[UPSTREAM] connecting to:", upstreamUrl);

  const upstreamWs = new WebSocket(upstreamUrl, { perMessageDeflate: false });

  // ✅ Buffer messages until upstream is ready (NO injecting our own messages)
  const buffer = [];
  let upstreamOpen = false;

  upstreamWs.on("open", () => {
    upstreamOpen = true;
    console.log("[UPSTREAM] connected");

    // Flush buffered client messages
    for (const msg of buffer) {
      try { upstreamWs.send(msg); } catch {}
    }
    buffer.length = 0;
  });

  upstreamWs.on("message", (data) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data);
    }
  });

  upstreamWs.on("close", (code, reason) => {
    console.log("[UPSTREAM] closed", code, reason?.toString?.() || "");
    try { clientWs.close(1011, "Upstream closed"); } catch {}
  });

  upstreamWs.on("error", (e) => {
    console.log("[UPSTREAM] error", e?.message || e);
    try { clientWs.close(1011, "Upstream error"); } catch {}
  });

  clientWs.on("message", (data) => {
    // If upstream not ready yet, buffer briefly instead of sending garbage to the client
    if (!upstreamOpen || upstreamWs.readyState !== WebSocket.OPEN) {
      buffer.push(data);
      // Prevent infinite memory growth
      if (buffer.length > 200) buffer.shift();
      return;
    }
    upstreamWs.send(data);
  });

  clientWs.on("close", () => {
    console.log("[WS] client closed");
    try { upstreamWs.close(); } catch {}
  });

  clientWs.on("error", (e) => {
    console.log("[WS] client error", e?.message || e);
    try { upstreamWs.close(); } catch {}
  });
});

server.listen(PORT, () => {
  console.log("Proxy listening on", PORT);

  if (!BASE44_APP_ID) console.warn("[BOOT] BASE44_APP_ID missing.");
  if (!PROXY_VERIFY_KEY) console.warn("[BOOT] PROXY_VERIFY_KEY missing (may be required by Base44 verify).");
  if (!BROWSERLESS_TOKEN) console.warn("[BOOT] BROWSERLESS_TOKEN missing (upstream may reject).");
});
