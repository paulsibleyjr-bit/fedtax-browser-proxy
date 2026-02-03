import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const BUILD = "proxy-v6-2026-02-03-1515";
const PORT = process.env.PORT || 10000;

const UPSTREAM_WS_URL = process.env.UPSTREAM_WS_URL || "wss://chrome.browserless.io/";
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
});

// IMPORTANT: disable compression on the server-side WS listener too
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
});

function buildUpstreamUrl() {
  const u = new URL(UPSTREAM_WS_URL);

  // Ensure token included
  if (BROWSERLESS_TOKEN && !u.searchParams.get("token")) {
    u.searchParams.set("token", BROWSERLESS_TOKEN);
  }

  // Ensure pathname exists
  if (!u.pathname || u.pathname === "") u.pathname = "/";

  return u.toString();
}

server.on("upgrade", (request, socket, head) => {
  try {
    console.log(`[BOOT ${BUILD}] [UPGRADE] request.url =`, request.url);

    const url = new URL(request.url, "http://localhost");
    const sessionId = url.searchParams.get("sessionId");
    const proxySecret = url.searchParams.get("proxySecret");

    console.log(`[BOOT ${BUILD}] [UPGRADE] sessionId present =`, Boolean(sessionId));
    console.log(`[BOOT ${BUILD}] [UPGRADE] proxySecret present =`, Boolean(proxySecret));
    console.log(`[BOOT ${BUILD}] [UPGRADE] verification skipped (OPTION A)`);

    if (!sessionId || !proxySecret) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\nMissing sessionId/proxySecret");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } catch (err) {
    console.error(`[BOOT ${BUILD}] [UPGRADE] error:`, err?.message || err);
    socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\nUpgrade error");
    socket.destroy();
  }
});

wss.on("connection", (clientWs, request) => {
  console.log(`[BOOT ${BUILD}] [WS] client connected`);

  // Pass through any subprotocols the browser requested
  const protoHeader = request?.headers?.["sec-websocket-protocol"];
  const protocols = protoHeader
    ? protoHeader.split(",").map((p) => p.trim()).filter(Boolean)
    : undefined;

  if (protocols?.length) {
    console.log(`[BOOT ${BUILD}] [WS] client protocols:`, protocols.join(", "));
  }

  const upstreamUrl = buildUpstreamUrl();
  console.log(`[BOOT ${BUILD}] [UPSTREAM] connecting to:`, upstreamUrl.replace(/token=[^&]+/g, "token=REDACTED"));

  // Queue messages until upstream opens
  const queue = [];
  const QUEUE_LIMIT = 1000;

  // IMPORTANT: disable compression to upstream too (prevents RSV1 problems)
  const upstreamWs = new WebSocket(upstreamUrl, protocols, {
    perMessageDeflate: false,
    maxPayload: 64 * 1024 * 1024,
  });

  let c2u = 0;
  let u2c = 0;

  const pingInterval = setInterval(() => {
    try {
      if (upstreamWs.readyState === WebSocket.OPEN) upstreamWs.ping();
    } catch {}
  }, 25000);

  function flushQueue() {
    while (queue.length && upstreamWs.readyState === WebSocket.OPEN) {
      upstreamWs.send(queue.shift());
      c2u++;
    }
  }

  upstreamWs.on("open", () => {
    console.log(`[BOOT ${BUILD}] [UPSTREAM] connected`);
    flushQueue();
  });

  upstreamWs.on("message", (data) => {
    u2c++;
    if (u2c === 1) {
      console.log(`[BOOT ${BUILD}] [FLOW] first upstream->client message received`);
    }
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data);
  });

  upstreamWs.on("close", (code, reason) => {
    clearInterval(pingInterval);
    console.log(
      `[BOOT ${BUILD}] [UPSTREAM] closed`,
      code,
      reason?.toString?.() || "",
      `c2u=${c2u} u2c=${u2c}`
    );
    try {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
    } catch {}
  });

  upstreamWs.on("error", (e) => {
    clearInterval(pingInterval);
    console.log(`[BOOT ${BUILD}] [UPSTREAM] error`, e?.message || e, `c2u=${c2u} u2c=${u2c}`);
    try {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
    } catch {}
  });

  clientWs.on("message", (data) => {
    // Log whether Base44 is actually sending anything
    if (c2u === 0) console.log(`[BOOT ${BUILD}] [FLOW] first client->upstream message received`);
    if (upstreamWs.readyState === WebSocket.OPEN) {
      upstreamWs.send(data);
      c2u++;
      return;
    }
    if (queue.length < QUEUE_LIMIT) {
      queue.push(data);
    } else {
      console.log(`[BOOT ${BUILD}] [QUEUE] overflow; closing client`);
      try {
        clientWs.close();
      } catch {}
    }
  });

  clientWs.on("close", () => {
    console.log(`[BOOT ${BUILD}] [WS] client closed`, `c2u=${c2u} u2c=${u2c}`);
    clearInterval(pingInterval);
    try {
      upstreamWs.close();
    } catch {}
  });

  clientWs.on("error", (e) => {
    console.log(`[BOOT ${BUILD}] [WS] client error`, e?.message || e);
    clearInterval(pingInterval);
    try {
      upstreamWs.close();
    } catch {}
  });
});

server.listen(PORT, () => {
  console.log(`[BOOT ${BUILD}] Proxy listening on`, PORT);
  if (!BROWSERLESS_TOKEN) console.warn(`[BOOT ${BUILD}] BROWSERLESS_TOKEN missing`);
});
