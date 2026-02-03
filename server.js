import http from "http";
import { WebSocketServer, WebSocket } from "ws";

/**
 * FEDTAX Browser Proxy (Render)
 * - Accepts WS connections from your Base44 app (browser UI)
 * - Extracts sessionId/proxySecret from the WS upgrade URL query params
 * - Verifies session by POSTing JSON to Base44 verifyBrowserSession
 * - Proxies frames to/from the upstream browserless WS (placeholder section)
 *
 * IMPORTANT:
 * - DISABLE compression to avoid: "Invalid WebSocket frame: RSV1 must be clear"
 */

const PORT = process.env.PORT || 10000;

// ✅ Your Base44 verify function endpoint (keep as-is unless your app id changes)
const VERIFY_URL =
  "https://api.base44.com/apps/696febb1921e5c4ec6bce8d3/functions/verifyBrowserSession";

// If your verify function requires a secret header, add it in Render ENV and uncomment below.
// const INTERNAL_PROXY_SECRET = process.env.INTERNAL_PROXY_SECRET;

function sendHttpError(socket, statusLine, body) {
  try {
    socket.write(`HTTP/1.1 ${statusLine}\r\nContent-Type: text/plain\r\n\r\n${body}`);
  } catch {}
  try {
    socket.destroy();
  } catch {}
}

async function verifySession(sessionId, proxySecret) {
  const res = await fetch(VERIFY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // "X-Internal-Proxy-Secret": INTERNAL_PROXY_SECRET || "",
    },
    body: JSON.stringify({ sessionId, proxySecret }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(text || `verify failed (${res.status})`);
  }

  // verifyBrowserSession returns JSON on success; tolerate text/plain wrappers
  try {
    return JSON.parse(text);
  } catch {
    return { ok: true, raw: text };
  }
}

const server = http.createServer((req, res) => {
  // Basic health check
  if (req.url === "/" || req.url?.startsWith("/health")) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

// ✅ Disable perMessageDeflate to avoid RSV1 issues
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
});

server.on("upgrade", async (request, socket, head) => {
  try {
    const url = new URL(request.url, "http://localhost");

    const sessionId = url.searchParams.get("sessionId");
    const proxySecret = url.searchParams.get("proxySecret");

    if (!sessionId || !proxySecret) {
      return sendHttpError(
        socket,
        "400 Bad Request",
        "Missing sessionId/proxySecret in WS upgrade URL"
      );
    }

    // ✅ Verify immediately during upgrade (this is where query params exist)
    try {
      await verifySession(sessionId, proxySecret);
    } catch (err) {
      return sendHttpError(
        socket,
        "403 Forbidden",
        `verifyBrowserSession failed: ${err?.message || String(err)}`
      );
    }

    // If verified, complete WS upgrade
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } catch (err) {
    return sendHttpError(
      socket,
      "500 Internal Server Error",
      err?.message || "upgrade failed"
    );
  }
});

wss.on("connection", (clientWs, request) => {
  // ✅ Also disable compression on client side
  clientWs._socket?.setNoDelay?.(true);

  // At this point, you're verified.
  // TODO: connect to upstream browserless WS and proxy frames.
  // For now, we just confirm connection and keep it open.

  clientWs.send(
    JSON.stringify({
      ok: true,
      message: "Proxy connected + session verified",
    })
  );

  clientWs.on("message", (data) => {
    // Echo for debugging (remove later)
    clientWs.send(data);
  });

  clientWs.on("close", () => {});
  clientWs.on("error", () => {});
});

server.listen(PORT, () => {
  console.log(`Proxy listening on ${PORT}`);
});
