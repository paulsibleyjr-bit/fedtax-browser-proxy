// server.js (Render) - WebSocket proxy for Browserless + Base44 verification (proxySecret auth)

const express = require("express");
const http = require("http");
const WebSocket = require("ws");

// Node 18+ has global fetch. Render uses Node 18+ by default.
const fetchFn = global.fetch;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const {
  BROWSERLESS_TOKEN,
  BROWSERLESS_WS_ENDPOINT = "wss://chrome.browserless.io",
  BASE44_API_URL = "https://base44.app",
  BASE44_APP_ID,
} = process.env;

if (!BROWSERLESS_TOKEN) {
  console.error("Missing env var: BROWSERLESS_TOKEN");
}
if (!BASE44_APP_ID) {
  console.error("Missing env var: BASE44_APP_ID");
}

app.get("/health", (_, res) => res.json({ status: "ok" }));

function getWsParams(reqUrl) {
  const params = new URL(reqUrl, "ws://localhost").searchParams;
  return {
    sessionId: params.get("sessionId"),
    proxySecret: params.get("proxySecret"),
  };
}

async function verifySession({ sessionId, proxySecret }) {
  const verifyUrl =
    `${BASE44_API_URL}/api/apps/${BASE44_APP_ID}/functions/verifyBrowserSession` +
    `?sessionId=${encodeURIComponent(sessionId)}` +
    `&proxySecret=${encodeURIComponent(proxySecret)}`;

  const res = await fetchFn(verifyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Id": sessionId,
      "X-Proxy-Secret": proxySecret,
    },
    body: JSON.stringify({ sessionId, proxySecret }),
  });

  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

wss.on("connection", async (clientSocket, req) => {
  try {
    const { sessionId, proxySecret } = getWsParams(req.url);

    if (!sessionId || !proxySecret) {
      clientSocket.send(
        JSON.stringify({
          type: "error",
          message: "Missing sessionId or proxySecret",
        })
      );
      clientSocket.close();
      return;
    }

    // 1) Verify with Base44 using proxySecret (no user auth token needed)
    const verify = await verifySession({ sessionId, proxySecret });
    if (!verify.ok) {
      console.error("[WS Proxy] verifyBrowserSession failed:", verify.status, verify.text);
      clientSocket.send(
        JSON.stringify({
          type: "error",
          message: "Invalid or expired browser session",
        })
      );
      clientSocket.close();
      return;
    }

    // 2) Connect to browserless (Chrome DevTools Protocol WS)
    const browserlessUrl =
      `${BROWSERLESS_WS_ENDPOINT}?token=${encodeURIComponent(BROWSERLESS_TOKEN)}` +
      `&stealth=true&blockAds=true`;

    const browserSocket = new WebSocket(browserlessUrl);

    browserSocket.on("open", () => {
      clientSocket.send(JSON.stringify({ type: "ready" }));
    });

    // Pipe binary/text messages both ways
    browserSocket.on("message", (data) => {
      if (clientSocket.readyState === WebSocket.OPEN) clientSocket.send(data);
    });

    clientSocket.on("message", (data) => {
      if (browserSocket.readyState === WebSocket.OPEN) browserSocket.send(data);
    });

    browserSocket.on("close", () => {
      if (clientSocket.readyState === WebSocket.OPEN) clientSocket.close();
    });

    browserSocket.on("error", (err) => {
      console.error("[WS Proxy] browserless error:", err?.message || err);
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(JSON.stringify({ type: "error", message: "Browserless connection error" }));
        clientSocket.close();
      }
    });

    clientSocket.on("close", () => {
      if (browserSocket.readyState === WebSocket.OPEN) browserSocket.close();
    });
  } catch (err) {
    console.error("[WS Proxy] connection handler error:", err?.message || err);
    try {
      clientSocket.send(JSON.stringify({ type: "error", message: "Proxy error" }));
    } catch {}
    try {
      clientSocket.close();
    } catch {}
  }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Proxy listening on ${PORT}`);
});
