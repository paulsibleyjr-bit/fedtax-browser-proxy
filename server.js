import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;

const BROWSERLESS_HTTP = process.env.BROWSERLESS_HTTP;
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;

if (!BROWSERLESS_HTTP || !BROWSERLESS_TOKEN) {
  console.error("FATAL: Missing BROWSERLESS_HTTP or BROWSERLESS_TOKEN");
  process.exit(1);
}

async function getCDPWebSocket() {
  const res = await fetch(
    `${BROWSERLESS_HTTP}/json/version?token=${BROWSERLESS_TOKEN}`
  );

  if (!res.ok) {
    throw new Error(`Browserless version fetch failed ${res.status}`);
  }

  const json = await res.json();

  if (!json.webSocketDebuggerUrl) {
    throw new Error("Missing webSocketDebuggerUrl from Browserless");
  }

  return json.webSocketDebuggerUrl.replace(/^ws:/, "wss:");
}

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("ok");
});

const wss = new WebSocketServer({ server, perMessageDeflate: false });

wss.on("connection", async (client) => {
  console.log("[WS] client connected");

  let upstream;
  try {
    const cdpUrl = await getCDPWebSocket();
    console.log("[CFG] upstream CDP =", cdpUrl);

    upstream = new WebSocket(cdpUrl, { perMessageDeflate: false });
  } catch (err) {
    console.error("[FATAL] CDP fetch failed:", err.message);
    client.close();
    return;
  }

  upstream.on("open", () => console.log("[UPSTREAM] open"));
  upstream.on("close", (c) => console.log("[UPSTREAM] close", c));
  upstream.on("error", (e) => console.error("[UPSTREAM] error", e.message));

  client.on("close", (c) => {
    console.log("[WS] client close", c);
    upstream?.close();
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
});

server.listen(PORT, () => {
  console.log("Proxy listening on", PORT);
});
