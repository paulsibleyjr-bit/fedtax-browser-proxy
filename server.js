import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import fetch from "node-fetch";

const PORT = process.env.PORT || 10000;

const server = http.createServer();

/**
 * WebSocket server
 * IMPORTANT:
 * - noServer: true (we manually handle upgrades)
 * - perMessageDeflate: false (FIXES RSV1 ERROR)
 */
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
});

/**
 * Handle WebSocket upgrade
 * THIS IS THE ONLY PLACE query params exist
 */
server.on("upgrade", async (request, socket, head) => {
  try {
    const url = new URL(request.url, "http://localhost");
    const sessionId = url.searchParams.get("sessionId");
    const proxySecret = url.searchParams.get("proxySecret");

    if (!sessionId || !proxySecret) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\nMissing sessionId/proxySecret");
      socket.destroy();
      return;
    }

    // Verify session with Base44 using JSON body
    const verifyResponse = await fetch(
      "https://api.base44.com/apps/696febb1921e5c4ec6bce8d3/functions/verifyBrowserSession",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, proxySecret }),
      }
    );

    if (!verifyResponse.ok) {
      const err = await verifyResponse.text();
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n" + err);
      socket.destroy();
      return;
    }

    // Accept WebSocket connection
    wss.handleUpgrade(request, socket, head, (clientWs) => {
      clientWs.sessionId = sessionId;
      wss.emit("connection", clientWs);
    });
  } catch (err) {
    socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n" + err.message);
    socket.destroy();
  }
});

/**
 * When client WS is connected, proxy to browserless
 */
wss.on("connection", (clientWs) => {
  const browserlessUrl = process.env.BROWSERLESS_WS_URL;

  if (!browserlessUrl) {
    clientWs.close(1011, "Browserless URL not configured");
    return;
  }

  const upstreamWs = new WebSocket(browserlessUrl, {
    perMessageDeflate: false, // FIX RSV1
  });

  clientWs.on("message", (msg) => {
    if (upstreamWs.readyState === WebSocket.OPEN) {
      upstreamWs.send(msg);
    }
  });

  upstreamWs.on("message", (msg) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(msg);
    }
  });

  clientWs.on("close", () => upstreamWs.close());
  upstreamWs.on("close", () => clientWs.close());
});

server.listen(PORT, () => {
  console.log(`Browser proxy listening on ${PORT}`);
});
