const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const fetch = global.fetch;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const {
  BROWSERLESS_TOKEN,
  BROWSERLESS_WS_ENDPOINT = 'wss://chrome.browserless.io',
  BASE44_API_URL = 'https://base44.app',
  BASE44_APP_ID
} = process.env;

wss.on('connection', async (client, req) => {
  const params = new URL(req.url, 'ws://localhost').searchParams;
  const sessionId = params.get('sessionId');
  const token = params.get('token');

  if (!sessionId || !token) {
    client.close();
    return;
  }

  // 🔐 Verify session with Base44
  const verifyRes = await fetch(
    `${BASE44_API_URL}/api/apps/${BASE44_APP_ID}/functions/verifyBrowserSession`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ sessionId })
    }
  );

  if (!verifyRes.ok) {
    client.close();
    return;
  }

  const browserless = new WebSocket(
    `${BROWSERLESS_WS_ENDPOINT}?token=${BROWSERLESS_TOKEN}`
  );

  browserless.on('message', data => client.send(data));
  client.on('message', data => browserless.send(data));

  browserless.on('close', () => client.close());
  client.on('close', () => browserless.close());
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Proxy listening on ${PORT}`);
});
