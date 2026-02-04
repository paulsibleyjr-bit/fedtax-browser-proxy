import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 8080;
const server = new WebSocketServer({ port: PORT });

console.log(`[PROXY] Listening on port ${PORT}`);

server.on('connection', async (clientWs) => {
  console.log('[CLIENT] New connection from Base44');
  
  let upstreamWs = null;
  let upstreamReady = false;
  const messageBuffer = [];

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
    
    console.log('[CFG] Upstream CDP =', upstreamUrl.substring(0, 60) + '...');

    const { default: WebSocket } = await import('ws');
    upstreamWs = new WebSocket(upstreamUrl);

    upstreamWs.on('open', () => {
      console.log('[UPSTREAM] Connected to Browserless');
      upstreamReady = true;
      
      // Flush buffered messages
      while (messageBuffer.length > 0) {
        const data = messageBuffer.shift();
        upstreamWs.send(data, (err) => {
          if (err) console.error('[UPSTREAM] Send error:', err.message);
        });
      }
    });

    upstreamWs.on('error', (err) => {
      console.error('[UPSTREAM] Error:', err.message);
      clientWs.close(1011, 'upstream error');
    });

    upstreamWs.on('close', (code, reason) => {
      console.log('[UPSTREAM] Closed:', code, reason?.toString() || 'no reason');
      clientWs.close(1011, 'upstream closed');
    });

    // Client → Upstream
    clientWs.on('message', (data) => {
      if (upstreamWs) {
        if (upstreamReady) {
          upstreamWs.send(data, (err) => {
            if (err) console.error('[UPSTREAM] Send error:', err.message);
            else console.log('[C→U] Message forwarded');
          });
        } else {
          // Buffer until upstream ready
          messageBuffer.push(data);
          console.log('[BUFFER] Buffering message, upstream not ready yet');
        }
      }
    });

    // Upstream → Client
    upstreamWs.on('message', (data) => {
      if (clientWs.readyState === 1) {
        clientWs.send(data, (err) => {
          if (err) console.error('[CLIENT] Send error:', err.message);
          else console.log('[U→C] Message forwarded');
        });
      }
    });

    clientWs.on('close', () => {
      console.log('[CLIENT] Disconnected');
      if (upstreamWs) upstreamWs.close();
    });

  } catch (error) {
    console.error('[ERROR]', error.message);
    clientWs.close(1011, 'proxy error');
  }
});
