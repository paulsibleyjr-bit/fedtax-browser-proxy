import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;
const UPSTREAM = process.env.BROWSERLESS_WS; // wss://chrome.browserless.io/?token=XXXX

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

  const upstream = new WebSocket(UPSTREAM, { perMessageDeflate: false });

  upstream.on("open", () => console.log("[UPSTREAM] connected"));
  upstream.on("close", (code, reason) => {
    console.log("[UPSTREAM] closed", code, reason?.toString?.() || "");
    try { client.close(); } catch {}
  });
  upstream.on("error", (err) => {
    console.error("[UPSTREAM] error", err);
    try { client.close(); } catch {}
  });

  client.on("message", (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
  });
  upstream.on("message", (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });

  client.on("close", () => { try { upstream.close(); } catch {} });
  client.on("error", () => { try { upstream.close(); } catch {} });
});

server.listen(PORT, () => console.log("Proxy listening on", PORT));
