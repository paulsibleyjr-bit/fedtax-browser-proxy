import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;

// IMPORTANT: Use BROWSERLESS_WS, but also print a redacted version for confirmation.
const UPSTREAM = process.env.BROWSERLESS_WS;

if (!UPSTREAM) {
  console.error("FATAL: BROWSERLESS_WS env var is missing");
}

function redact(url) {
  if (!url) return url;
  return url.replace(/token=([^&]+)/, "token=REDACTED");
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
});

const wss = new WebSocketServer({ server, perMessageDeflate: false });

wss.on("connection", (client, req) => {
  console.log("[WS] client connected", req.url);
  console.log("[CFG] upstream =", redact(UPSTREAM));

  const upstream = new WebSocket(UPSTREAM, { perMessageDeflate: false });

  upstream.on("open", () => console.log("[UPSTREAM] open"));
  upstream.on("error", (err) => console.error("[UPSTREAM] error", err?.message || err));
  upstream.on("close", (code, reason) =>
    console.log("[UPSTREAM] close", code, reason?.toString?.() || "")
  );

  client.on("error", (err) => console.error("[WS] client error", err?.message || err));
  client.on("close", (code, reason) =>
    console.log("[WS] client close", code, reason?.toString?.() || "")
  );

  // LOG + forward client -> upstream
  client.on("message", (data, isBinary) => {
    console.log("[WS->UP] bytes", data?.length || data?.byteLength || "?", "binary?", isBinary);
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
  });

  // LOG + forward upstream -> client
  upstream.on("message", (data, isBinary) => {
    console.log("[UP->WS] bytes", data?.length || data?.byteLength || "?", "binary?", isBinary);
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });

  // teardown
  client.on("close", () => { try { upstream.close(); } catch {} });
  upstream.on("close", () => { try { client.close(); } catch {} });
});

server.listen(PORT, () => console.log("Proxy listening on", PORT));
