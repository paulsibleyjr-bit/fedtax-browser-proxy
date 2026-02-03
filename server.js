import http from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;

// HTTP server (Render requires this)
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
});

// IMPORTANT: disable permessage-deflate to avoid RSV1 errors
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
});

server.on("upgrade", async (request, socket, head) => {
  try {
    // 🔥 LOG EXACT URL WE GET
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

    // ✅ Verify with Base44 by JSON BODY (not query params)
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
      console.log("[UPGRADE] verify failed:", err);
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n" + err);
      socket.destroy();
      return;
    }

    console.log("[UPGRADE] verify OK");

    // Upgrade accepted
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } catch (err) {
    console.error("[UPGRADE] error:", err);
    socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\nUpgrade error");
    socket.destroy();
  }
});

// Basic WS passthrough (placeholder)
wss.on("connection", (ws) => {
  console.log("[WS] connected");

  ws.on("message", (msg) => {
    // echo for now; replace with your actual proxying logic
    ws.send(msg);
  });

  ws.on("close", () => console.log("[WS] closed"));
  ws.on("error", (e) => console.log("[WS] error", e?.message || e));
});

server.listen(PORT, () => {
  console.log("Proxy listening on", PORT);
});
