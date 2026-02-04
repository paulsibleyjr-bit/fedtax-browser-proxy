import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;

// Set these in Render env:
const BROWSERLESS_HTTP = process.env.BROWSERLESS_HTTP || "https://chrome.browserless.io";
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN; // token only, no scheme

function redact(url) {
  if (!url) return url;
  return url.replace(/token=([^&]+)/i, "token=REDACTED");
}

async function getCdpWsUrl() {
  if (!BROWSERLESS_TOKEN) throw new Error("BROWSERLESS_TOKEN missing");

  const base = BROWSERLESS_HTTP.replace(/\/$/, "");
  const url = `${base}/json/version?token=${encodeURIComponent(BROWSERLESS_TOKEN)}`;

  const res = await fetch(url, { method: "GET" });
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Browserless /json/version failed ${res.status}: ${text.slice(0, 200)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Browserless /json/version returned non-JSON: ${text.slice(0, 200)}`);
  }

  const ws = data.webSocketDebuggerUrl;
  if (!ws) throw new Error("webSocketDebuggerUrl missing in /json/version response");

  // Ensure WSS
  let wsUrl = ws.replace(/^ws:\/\//i, "wss://");

  // If token is not included, append it
  if (!/token=/i.test(wsUrl)) {
    wsUrl += (wsUrl.includes("?") ? "&" : "?") + `token=${encodeURIComponent(BROWSERLESS_TOKEN)}`;
  }

  return wsUrl;
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
});

const wss = new WebSocketServer({ server, perMessageDeflate: false });

wss.on("connection", async (client, req) => {
  console.log("[WS] client connected", req.url || "/");

  let upstreamUrl;
  try {
    upstreamUrl = await getCdpWsUrl();
    console.log("[CFG] upstream CDP =", redact(upstreamUrl));
  } catch (e) {
    console.error("[CFG] failed to get CDP WS URL:", e?.message || e);
    try { client.close(1011, "failed to get CDP websocket url"); } catch {}
    return;
  }

  const upstream = new WebSocket(upstreamUrl, { perMessageDeflate: false });

  let closed = false;
  const closeBoth = (code = 1000, reason = "") => {
    if (closed) return;
    closed = true;
    try {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close(code, reason);
      }
    } catch {}
    try {
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.close(code, reason);
      }
    } catch {}
  };

  upstream.on("open", () => console.log("[UPSTREAM] open"));

  upstream.on("message", (data, isBinary) => {
    const n = data?.length ?? data?.byteLength ?? 0;
    console.log("[UP->WS] bytes", n, "binary?", isBinary);
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });

  upstream.on("error", (err) => {
    console.error("[UPSTREAM] error", err?.message || err);
    closeBoth(1011, "upstream error");
  });

  upstream.on("close", (code, reason) => {
    console.log("[UPSTREAM] close", code, reason?.toString?.() || "");
    closeBoth(code, "upstream closed");
  });

  client.on("message", (data, isBinary) => {
    const n = data?.length ?? data?.byteLength ?? 0;
    console.log("[WS->UP] bytes", n, "binary?", isBinary);
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
  });

  client.on("error", (err) => {
    console.error("[WS] client error", err?.message || err);
    closeBoth(1011, "client error");
  });

  client.on("close", (code, reason) => {
    console.log("[WS] client close", code, reason?.toString?.() || "");
    closeBoth(code, "client closed");
  });
});

server.listen(PORT, () => console.log("Proxy listening on", PORT));
