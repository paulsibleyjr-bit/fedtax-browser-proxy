import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;

// Full Browserless WS endpoint including token, e.g.
// wss://chrome.browserless.io/?token=YOUR_TOKEN
const UPSTREAM = process.env.BROWSERLESS_WS;

function redact(url) {
  if (!url) return url;
  return url.replace(/token=([^&]+)/i, "token=REDACTED");
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
});

const wss = new WebSocketServer({ server, perMessageDeflate: false });

wss.on("connection", (client, req) => {
  console.log("[WS] client connected", req.url || "/");

  // Validate config before doing anything
  if (!UPSTREAM) {
    console.error("FATAL: BROWSERLESS_WS env var is missing");
    try { client.close(1011, "BROWSERLESS_WS missing"); } catch {}
    return;
  }
  if (!/^wss:\/\//i.test(UPSTREAM)) {
    console.error("FATAL: BROWSERLESS_WS must start with wss://", redact(UPSTREAM));
    try { client.close(1011, "BROWSERLESS_WS must be wss://"); } catch {}
    return;
  }

  console.log("[CFG] upstream =", redact(UPSTREAM));

  const upstream = new WebSocket(UPSTREAM, { perMessageDeflate: false });

  let closed = false;
  const closeBoth = (code = 1000, reason = "") => {
    if (closed) return;
    closed = true;

    try {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close(code, reason);
      }
    } catch {}

    try {
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.close(code, reason);
      }
    } catch {}
  };

  upstream.on("open", () => console.log("[UPSTREAM] open"));

  upstream.on("message", (data, isBinary) => {
    const n = data?.length ?? data?.byteLength ?? 0;
    console.log("[UP->WS] bytes", n, "binary?", isBinary);
    if (client.readyState === WebSocket.OPEN) {
      client.send(data, { binary: isBinary });
    }
  });

  upstream.on("error", (err) => {
    console.error("[UPSTREAM] error", err?.message || err);
    closeBoth(1011, "upstream error");
  });

  upstream.on("close", (code, reason) => {
    console.log("[UPSTREAM] close", code, reason?.toString?.() || "");
    closeBoth(code, "upstream closed");
  });

  client.on("message", (data, isBinary) => {
    const n = data?.length ?? data?.byteLength ?? 0;
    console.log("[WS->UP] bytes", n, "binary?", isBinary);
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
    }
  });

  client.on("error", (err) => {
    console.error("[WS] client error", err?.message || err);
    closeBoth(1011, "client error");
  });

  client.on("close", (code, reason) => {
    console.log("[WS] client close", code, reason?.toString?.() || "");
    closeBoth(code, "client closed");
  });
});

server.listen(PORT, () => console.log("Proxy listening on", PORT));
