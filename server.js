import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;

const BROWSERLESS_HTTP = process.env.BROWSERLESS_HTTP || "https://chrome.browserless.io";
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;

if (!BROWSERLESS_TOKEN) {
  console.error("FATAL: Missing BROWSERLESS_TOKEN");
  process.exit(1);
}

function redact(url) {
  if (!url) return url;
  return url.replace(/token=([^&]+)/, "token=REDACTED");
}

async function getCDPWebSocketUrl() {
  // Browserless expects token on the HTTP endpoint
  const url = `${BROWSERLESS_HTTP.replace(/\/$/, "")}/json/version?token=${encodeURIComponent(BROWSERLESS_TOKEN)}`;
  const res = await fetch(url);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Browserless /json/version failed ${res.status} ${text}`);
  }

  const json = await res.json();
  const ws = json.webSocketDebuggerUrl;

  if (!ws) throw new Error("Browserless response missing webSocketDebuggerUrl");

  // Ensure wss:// for HTTPS sites
  return ws.replace(/^ws:/, "wss:");
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
});

const wss = new WebSocketServer({ server, perMessageDeflate: false });

wss.on("connection", async (client, req) => {
  console.log("[WS] client connected", req?.url || "");

  let upstream;
  try {
    const cdpUrl = await getCDPWebSocketUrl();
    console.log("[CFG] upstream CDP =", redact(cdpUrl));

    upstream = new WebSocket(cdpUrl, { perMessageDeflate: false });
  } catch (err) {
    console.error("[FATAL] could not get CDP websocket:", err?.message || err);
    try { client.close(); } catch {}
    return;
  }

  upstream.on("open", () => console.log("[UPSTREAM] open"));
  upstream.on("error", (err) => console.error("[UPSTREAM] error", err?.message || err));
  upstream.on("close", (code, reason) =>
    console.log("[UPSTREAM] close", code, reason?.toString?.() || "")
  );

  client.on("error", (err) => console.error("[WS] client error", err?.message || err));
  client.on("close", (code, reason) =>
    console.log("[WS] client close", code, reason?.toString?.() || "")
  );

  client.on("message", (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
  });

  upstream.on("message", (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });

  client.on("close", () => { try { upstream.close(); } catch {} });
  upstream.on("close", () => { try { client.close(); } catch {} });
});

server.listen(PORT, () => console.log("Proxy listening on", PORT));
