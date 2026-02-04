import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;

// Required env vars
const BROWSERLESS_HTTP = process.env.BROWSERLESS_HTTP || "https://chrome.browserless.io";
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;

// Optional: if you want to require a key from the client (not required for basic functionality)
const PROXY_VERIFY_KEY = process.env.PROXY_VERIFY_KEY;

function redact(url) {
  if (!url) return url;
  return url.replace(/token=([^&]+)/, "token=REDACTED");
}

function toWss(url) {
  if (!url) return url;
  return url.replace(/^ws:\/\//i, "wss://");
}

async function getCdpWebSocketDebuggerUrl() {
  if (!BROWSERLESS_TOKEN) {
    throw new Error("BROWSERLESS_TOKEN env var is missing");
  }

  // Browserless: /json/version returns { webSocketDebuggerUrl: "wss://.../devtools/browser/<id>?token=..." }
  const versionUrl = `${BROWSERLESS_HTTP.replace(/\/$/, "")}/json/version?token=${encodeURIComponent(
    BROWSERLESS_TOKEN
  )}`;

  const resp = await fetch(versionUrl, {
    method: "GET",
    headers: { "accept": "application/json" },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Browserless /json/version failed: ${resp.status} ${text}`.trim());
  }

  const data = await resp.json();
  const wsUrl = data?.webSocketDebuggerUrl;

  if (!wsUrl) {
    throw new Error("Browserless response missing webSocketDebuggerUrl");
  }

  return toWss(wsUrl);
}

// Simple health endpoint
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
});

// WebSocket proxy
const wss = new WebSocketServer({ server, perMessageDeflate: false });

wss.on("connection", async (client, req) => {
  try {
    console.log("[WS] client connected", req.url || "/");

    // OPTIONAL: if you want to enforce a verify key from client querystring, uncomment:
    // const url = new URL(req.url || "/", "http://localhost");
    // const key = url.searchParams.get("key");
    // if (PROXY_VERIFY_KEY && key !== PROXY_VERIFY_KEY) {
    //   console.log("[WS] rejected: bad key");
    //   client.close(1008, "unauthorized");
    //   return;
    // }

    console.log("[CFG] browserless http =", BROWSERLESS_HTTP);
    console.log("[CFG] token present =", Boolean(BROWSERLESS_TOKEN));

    console.log("[CFG] Fetching CDP endpoint from Browserless...");
    const upstreamUrl = await getCdpWebSocketDebuggerUrl();

    console.log("[CFG] upstream CDP =", redact(upstreamUrl));

    const upstream = new WebSocket(upstreamUrl, { perMessageDeflate: false });

    let clientClosed = false;
    let upstreamClosed = false;

    const safeClose = (ws, code, reason) => {
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(code, reason);
        }
      } catch {}
    };

    upstream.on("open", () => console.log("[UPSTREAM] open"));
    upstream.on("error", (err) => console.error("[UPSTREAM] error", err?.message || err));
    upstream.on("close", (code, reason) => {
      upstreamClosed = true;
      console.log("[UPSTREAM] close", code, reason?.toString?.() || "");
      if (!clientClosed) safeClose(client, 1011, "upstream closed");
    });

    client.on("error", (err) => console.error("[WS] client error", err?.message || err));
    client.on("close", (code, reason) => {
      clientClosed = true;
      console.log("[WS] client close", code, reason?.toString?.() || "");
      if (!upstreamClosed) safeClose(upstream, 1000, "client closed");
    });

    // Pipe client -> upstream
    client.on("message", (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
      }
    });

    // Pipe upstream -> client
    upstream.on("message", (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data, { binary: isBinary });
      }
    });
  } catch (err) {
    console.error("[ERROR] connection setup failed:", err?.message || err);
    try {
      client.close(1011, "proxy setup failed");
    } catch {}
  }
});

server.listen(PORT, () => console.log("Proxy listening on", PORT));
