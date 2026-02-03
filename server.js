import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 10000;

/**
 * REQUIRED ENV VAR:
 * This must be the REAL upstream websocket endpoint that actually serves the browser.
 * Ask Base44 what it is, or check your old proxy code.
 *
 * Example: wss://browser-provider.example.com/ws
 */
const UPSTREAM_WS_URL = process.env.UPSTREAM_WS_URL;

if (!UPSTREAM_WS_URL) {
  console.warn(
    "[BOOT] Missing UPSTREAM_WS_URL env var. Proxy will verify but cannot connect upstream."
  );
}

// HTTP server (Render requires this)
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
});

// Disable permessage-deflate to avoid RSV1 errors
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
});

server.on("upgrade", async (request, socket, head) => {
  try {
    console.log("[UPGRADE] request.url =", request.url);

    const url = new URL(request.url, "http://localhost");
    const sessionId = url.searchParams.get("sessionId");
    const proxySecret = url.searchParams.get("proxySecret");

    console.log("[UPGRADE] sessionId =", sessionId);
    console.log("[UPGRADE] proxySecret present =", Boolean(proxySecret));

    if (!sessionId || !proxySecret) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\nMissing sessionId/proxySecret");
      socket.destroy();
      return;
    }

    // Verify session against Base44 (JSON body only)
    const verifyResponse = await fetch(
      "https://api.base44.com/apps/696febb1921e5c4ec6bce8d3/functions/verifyBrowserSession",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, proxySecret }),
      }
    );

    if (!verifyResponse.ok) {
      const errText = await verifyResponse.text();
      console.log("[UPGRADE] verify failed:", errText);
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n" + errText);
      socket.destroy();
      return;
    }

    console.log("[UPGRADE] verify OK");

    // Accept upgrade
    wss.handleUpgrade(request, socket, head, (clientWs) => {
      wss.emit("connection", clientWs, request, { sessionId });
    });
  } catch (err) {
    console.error("[UPGRADE] error:", err);
    socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\nUpgrade error");
    socket.destroy();
  }
});
