import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 8080;
const server = new WebSocketServer({ port: PORT });

console.log(`[PROXY] Listening on port ${PORT}`);

server.on('connection', async (clientWs) => {
  console.log('[CLIENT] New connection from Base44');

  try {
    const browserlessToken = process.env.BROWSERLESS_TOKEN;
    if (!browserlessToken) {
      console.error('[ERROR] Missing BROWSERLESS_TOKEN');
      clientWs.close(1011, 'Server misconfiguration');
      return;
    }

    const versionUrl = `https://chrome.browserless.io/json/version?token=${browserlessToken}`;
    console.log('[CFG] Fetching CDP endpoint from Browserless...');

    const versionResp = await fetch(versionUrl);
    if (!versionResp.ok) {
      console.error('[ERROR] Browserless API error:', versionResp.status);
      clientWs.close(1011, 'Browserless auth failed');
      return;
    }

    const versionData = await versionResp.json();
    const cdpWsUrl = versionData.webSocketDebuggerUrl;

    if (!cdpWsUrl) {
      console.error('[ERROR] No webSocketDebuggerUrl in Browserless response');
      clientWs.close(1011, 'Invalid Browserless response');
      return;
    }

    let upstreamUrl = cdpWsUrl.replace(/^ws:\/\//, 'wss://');
    upstreamUrl += `?token=${browserlessToken}`;
    
    console.log('[CFG] Upstream CDP =', upstreamUrl.replace(/token=[^&]+/, 'token=REDACTED'));

    const { default: WebSocket } = await import('ws');
    const upstreamWs = new WebSocket(upstreamUrl);

    upstreamWs.on('open', () => {
      console.log('[UPSTREAM] Connected to Browserless');
    });

    upstreamWs.on('error', (err) => {
      console.error('[UPSTREAM] Error:', err.message);
      clientWs.close(1011, 'upstream error');
    });

    upstreamWs.on('close', (code, reason) => {
      console.log('[UPSTREAM] Closed:', code, reason?.toString() || 'no reason');
      clientWs.close(1011, 'upstream closed');
    });

    // Bidirectional proxy - handle both text and binary
    clientWs.on('message', (data, isBinary) => {
      if (upstreamWs.readyState === WebSocket.OPEN) {
        upstreamWs.send(data, { binary: isBinary });
        console.log('[C→U] Forwarded', isBinary ? 'binary' : 'text', 'message');
      }
    });

    upstreamWs.on('message', (data, isBinary) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data, { binary: isBinary });
        console.log('[U→C] Forwarded', isBinary ? 'binary' : 'text', 'message');
      }
    });

    clientWs.on('close', () => {
      console.log('[CLIENT] Disconnected');
      upstreamWs.close();
    });

  } catch (error) {
    console.error('[ERROR]', error.message);
    clientWs.close(1011, 'proxy error');
  }
});
