import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const BUILD = "proxy-v7-2026-02-03-1520";
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

// Allow permessage-deflate (so RSV1 frames are legal)
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: {
    threshold: 0,
    serverNoContextTakeover: true,
    clientNoContextTakeover: true,
  },
});

function buildUpstreamUrl() {
  const u = new URL(UPSTREAM_WS_URL);

  if (BROWSERLESS_TOKEN && !u.searchParams.get("token")) {
    u.searchParams.set("token", BROWSERLESS_TOKEN);
  }

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

  // Pass through any subprotocols from the browser
  const protoHeader = request?.headers?.["sec-websocket-protocol"];
  const protocols = protoHeader
    ? protoHeader.split(",").map((p) => p.trim()).filter(Boolean)
    : undefined;

  if (protocols?.length) {
    console.log(`[BOOT ${BUILD}] [WS] client protocols:`, protocols.join(", "));
  }

  const upstreamUrl = buildUpstreamUrl();
  console.log(
    `[BOOT ${BUILD}] [UPSTREAM] connecting to:`,
    upstreamUrl.replace(/token=[^&]+/g, "token=REDACTED")
  );

  const queue = [];
  const QUEUE_LIMIT = 2000;

  // Enable permessage-deflate to match Browserless (fixes RSV1)
  const upstreamWs = new WebSocket(upstreamUrl, protocols, {
    perMessageDeflate: {
      threshold: 0,
      clientNoContextTakeover: true,
      serverNoContextTakeover: true,
    },
    maxPayload: 64 * 1024 * 1024,
  });

  let c2u = 0;
  let u2c = 0;
  let sawClientMsg = false;
  let sawUpstreamMsg = false;

  // Keepalive pings (Browserless sometimes expects activity)
  const pingInterval = setInterval(() => {
    try {
      if (upstreamWs.readyState === WebSocket.OPEN) upstreamWs.ping();
      if (clientWs.readyState === WebSocket.OPEN) clientWs.ping();
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
    if (!sawUpstreamMsg) {
      sawUpstreamMsg = true;
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
      `c2u=${c2u} u2c=${u2c} sawClientMsg=${sawClientMsg} sawUpstreamMsg=${sawUpstreamMsg}`
    );
    try {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
    } catch {}
  });

  upstreamWs.on("error", (e) => {
    clearInterval(pingInterval);
    console.log(
      `[BOOT ${BUILD}] [UPSTREAM] error`,
      e?.message || e,
      `c2u=${c2u} u2c=${u2c} sawClientMsg=${sawClientMsg} sawUpstreamMsg=${sawUpstreamMsg}`
    );
    try {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
    } catch {}
  });

  clientWs.on("message", (data) => {
    if (!sawClientMsg) {
      sawClientMsg = true;
      console.log(`[BOOT ${BUILD}] [FLOW] first client->upstream message received`);
    }

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
    console.log(
      `[BOOT ${BUILD}] [WS] client closed`,
      `c2u=${c2u} u2c=${u2c} sawClientMsg=${sawClientMsg} sawUpstreamMsg=${sawUpstreamMsg}`
    );
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
