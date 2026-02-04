import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;
const UPSTREAM = process.env.BROWSERLESS_WS;

if (!UPSTREAM) {
  console.error("FATAL: BROWSERLESS_WS env var is missing");
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
});

const wss = new WebSocketServer({
  server,
  perMessageDeflate: false,
});

wss.on("connection", (client, req) => {
  console.log("[WS] client connected", req.url);

  const upstream = new WebSocket(UPSTREAM, {
    perMessageDeflate: false,
  });

  upstream.on("open", () => {
    console.log("[UPSTREAM] connected");
  });

  upstream.on("error", (err) => {
    console.error("[UPSTREAM] error", err?.message || err);
    try { client.close(1011, "upstream error"); } catch {}
  });

  upstream.on("close", (code, reason) => {
    console.log("[UPSTREAM] closed", code, reason?.toString?.() || "");
    try { client.close(code || 1011, reason?.toString?.() || "upstream closed"); } catch {}
  });

  client.on("message", (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
    }
  });

  upstream.on("message", (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data, { binary: isBinary });
    }
  });

  client.on("close", (code, reason) => {
    console.log("[WS] client closed", code, reason?.toString?.() || "");
    try { upstream.close(code, reason); } catch {}
  });

  client.on("error", (err) => {
    console.error("[WS] client error", err?.message || err);
    try { upstream.close(); } catch {}
  });
});

server.listen(PORT, () => {
  console.log("Proxy listening on", PORT);
});
