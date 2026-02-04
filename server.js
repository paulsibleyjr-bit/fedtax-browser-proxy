import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 8080;
const server = new WebSocketServer({ port: PORT });

console.log(`[PROXY] Listening on port ${PORT}`);

server.on('connection', async (clientWs) => {
  console.log('[CLIENT] New connection from Base44');
  
  let upstreamWs = null;
  let upstreamReady = false;
  let pingInterval = null;
  const messageBuffer = [];

  // Register message handler IMMEDIATELY (before async operations)
  clientWs.on('message', (data, isBinary) => {
    console.log('[C→] Received message from client, size=' + data.length);
    if (upstreamWs && upstreamReady) {
      upstreamWs.send(data, (err) => {
        if (err) console.error('[C→U] Error:', err.message);
        else console.log('[C→U] Forwarded');
      });
    } else {
      messageBuffer.push(data);
      console.log('[BUFFER] Queued, upstream ready=' + upstreamReady);
    }
  });

  clientWs.on('close', () => {
    console.log('[CLIENT] Disconnected');
    if (pingInterval) clearInterval(pingInterval);
    if (upstreamWs) upstreamWs.close();
  });

  try {
    const browserlessToken = process.env.BROWSERLESS_TOKEN;
    if (!browserlessToken) {
      console.error('[ERROR] Missing BROWSERLESS_TOKEN');
      clientWs.close(1011, 'No token');
      return;
    }

    const versionUrl = `https://chrome.browserless.io/json/version?token=${browserlessToken}`;
    const versionResp = await fetch(versionUrl);
    if (!versionResp.ok) {
      clientWs.close(1011, 'Browserless error');
      return;
    }

    const versionData = await versionResp.json();
    let upstreamUrl = versionData.webSocketDebuggerUrl.replace(/^ws:\/\//, 'wss://');
    upstreamUrl += `?token=${browserlessToken}`;

    const { default: WebSocket } = await import('ws');
    upstreamWs = new WebSocket(upstreamUrl);

    upstreamWs.on('open', () => {
      console.log('[UPSTREAM] Connected');
      upstreamReady = true;

      pingInterval = setInterval(() => {
        if (upstreamWs?.readyState === WebSocket.OPEN) {
          upstreamWs.ping();
        }
      }, 30000);

      while (messageBuffer.length > 0) {
        upstreamWs.send(messageBuffer.shift());
      }
    });

    upstreamWs.on('message', (data) => {
      if (clientWs.readyState === 1) {
        clientWs.send(data, (err) => {
          if (err) console.error('[U→C] Error:', err.message);
          else console.log('[U→C] Forwarded');
        });
      }
    });

    upstreamWs.on('error', (err) => {
      console.error('[UPSTREAM] Error:', err.message);
      clientWs.close(1011, 'upstream error');
    });

    upstreamWs.on('close', () => {
      clientWs.close(1011, 'upstream closed');
    });

  } catch (error) {
    console.error('[ERROR]', error.message);
    clientWs.close(1011, 'error');
  }
});
