import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.PORT || 10000);

// ====== ENV ======
const BASE44_APP_ID = process.env.BASE44_APP_ID; // must be set in Render env
const BASE44_FUNCTIONS_BASE =
  process.env.BASE44_FUNCTIONS_BASE ||
  (BASE44_APP_ID ? `https://base44.app/api/apps/${BASE44_APP_ID}/functions` : null);

// Prefer a fully formed Browserless endpoint if you have it, else build from UPSTREAM + token
const BROWSERLESS_WS_ENDPOINT = process.env.BROWSERLESS_WS_ENDPOINT; // optional
const UPSTREAM_WS_URL = process.env.UPSTREAM_WS_URL; // e.g. wss://chrome.browserless.io
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN; // required if building URL

function buildUpstreamUrl() {
  if (BROWSERLESS_WS_ENDPOINT && BROWSERLESS_WS_ENDPOINT.startsWith("ws")) {
    return BROWSERLESS_WS_ENDPOINT;
  }
  if (!UPSTREAM_WS_URL || !UPSTREAM_WS_URL.startsWith("ws")) return null;
  if (!BROWSERLESS_TOKEN) return null;

  // Browserless expects token in query string
  const hasQuery = UPSTREAM_WS_URL.includes("?");
  return `${UPSTREAM_WS_URL}${hasQuery ? "&" : "?"}token=${encodeURIComponent(BROWSERLESS_TOKEN)}`;
}

function safeLogBoot() {
  console.log("[BOOT] starting…");
  console.log("[BOOT] PORT =", PORT);
  console.log("[BOOT] BASE44_APP_ID present =", Boolean(BASE44_APP_ID));
  console.log("[BOOT] BASE44_FUNCTIONS_BASE =", BASE44_FUNCTIONS_BASE || "(missing)");
  console.log("[BOOT] BROWSERLESS_WS_ENDPOINT present =", Boolean(BROWSERLESS_WS_ENDPOINT));
  console.log("[BOOT] UPSTREAM_WS_URL =", UPSTREAM_WS_URL || "(missing)");
  console.log("[BOOT] BROWSERLESS_TOKEN present =", Boolean(BROWSERLESS_TOKEN));
  console.log("[BOOT] computed upstream =", buildUpstreamUrl() || "(missing)");
}

safeLogBoot();

// ====== HTTP server for Render health checks ======
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
});

// Disable permessage-deflate to avoid RSV1 / compression mismatches
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
});

async function verifySession(sessionId, proxySecret) {
  if (!BASE44_FUNCTIONS_BASE) {
    throw new Error("Missing BASE44_APP_ID / BASE44_FUNCTIONS_BASE");
  }

  const verifyUrl = `${BASE44_FUNCTIONS_BASE}/verifyBrowserSession`;

  const resp = await fetch(verifyUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, proxySecret }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`verifyBrowserSession failed (${resp.status}): ${text || "no body"}`);
  }

  // Some Base44 responses may be text/plain even if JSON inside
  const text = await resp.text().catch(() => "");
  return text;
}

function pipeSockets(clientWs, upstreamWs) {
  clientWs.on("message", (msg) => {
    if (upstreamWs.readyState === WebSocket.OPEN) upstreamWs.send(msg);
  });
  upstreamWs.on("message", (msg) => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(msg);
  });

  const closeBoth = (why) => {
    try { clientWs.close(); } catch {}
    try { upstreamWs.close(); } catch {}
    console.log("[PIPE] closed:", why);
  };

  clientWs.on("close", () => closeBoth("client close"));
  upstreamWs.on("close", () => closeBoth("upstream close"));

  clientWs.on("error", (e) => closeBoth("client error: " + (e?.message || e)));
  upstreamWs.on("error", (e) => closeBoth("upstream error: " + (e?.message || e)));
}

server.on("upgrade", async (request, socket, head) => {
  try {
    console.log("\n[UPGRADE] request.url =", request.url);

    const url = new URL(request.url, "http://localhost");
    const sessionId = url.searchParams.get("sessionId");
    const proxySecret = url.searchParams.get("proxySecret");

    console.log("[UPGRADE] sessionId =", sessionId);
    console.log("[UPGRADE] proxySecret present =", Boolean(proxySecret));

    if (!sessionId || !proxySecret) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\nMissing sessionId/proxySecret");
      socket.destroy();
      return;
    }

    // Verify session with Base44
    console.log("[VERIFY] calling verifyBrowserSession…");
    await verifySession(sessionId, proxySecret);
    console.log("[VERIFY] OK");

    const upstreamUrl = buildUpstreamUrl();
    if (!upstreamUrl) {
      socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\nMissing upstream Browserless config");
      socket.destroy();
      console.log("[UPSTREAM] missing config; cannot connect");
      return;
    }

    // Accept client upgrade
    wss.handleUpgrade(request, socket, head, (clientWs) => {
      console.log("[WS] client connected; dialing upstream…");

      const upstreamWs = new WebSocket(upstreamUrl, {
        perMessageDeflate: false,
      });

      upstreamWs.on("open", () => {
        console.log("[UPSTREAM] connected ✅");
        pipeSockets(clientWs, upstreamWs);
      });

      upstreamWs.on("error", (e) => {
        console.log("[UPSTREAM] error:", e?.message || e);
        try { clientWs.close(); } catch {}
      });

      wss.emit("connection", clientWs, request);
    });
  } catch (err) {
    console.error("[UPGRADE] error:", err?.message || err);
    socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\nUpgrade error");
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`[BOOT] Proxy listening on ${PORT}`);
});
