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
      console.log('[STATUS] Ready to forward messages');
      
      pingInterval = setInterval(() => {
        if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN) {
          upstreamWs.ping();
          console.log('[KEEPALIVE] Ping sent to Browserless');
        }
      }, 30000);
      
      while (messageBuffer.length > 0) {
        const data = messageBuffer.shift();
        upstreamWs.send(data, (err) => {
          if (err) console.error('[UPSTREAM] Send error:', err.message);
          else console.log('[BUFFER] Flushed buffered message');
        });
      }
    });

    upstreamWs.on('error', (err) => {
      console.error('[UPSTREAM] Error:', err.message);
      clientWs.close(1011, 'upstream error');
    });

    upstreamWs.on('close', (code, reason) => {
      console.log('[UPSTREAM] Closed:', code, reason?.toString() || 'no reason');
      if (pingInterval) clearInterval(pingInterval);
      clientWs.close(1011, 'upstream closed');
    });

    upstreamWs.on('pong', () => {
      console.log('[KEEPALIVE] Pong received from Browserless');
    });

    clientWs.on('message', (data, isBinary) => {
      console.log('[C→] Received message from client, size=' + data.length + ', binary=' + isBinary);
      if (upstreamWs) {
        if (upstreamReady) {
          console.log('[C→U] Forwarding to upstream...');
          upstreamWs.send(data, (err) => {
            if (err) console.error('[C→U] Send error:', err.message);
            else console.log('[C→U] Message forwarded successfully');
          });
        } else {
          console.log('[BUFFER] Upstream not ready, buffering message');
          messageBuffer.push(data);
        }
      } else {
        console.error('[ERROR] upstreamWs is null!');
      }
    });

    upstreamWs.on('message', (data, isBinary) => {
      console.log('[U→] Received message from upstream, size=' + data.length + ', binary=' + isBinary);
      if (clientWs.readyState === 1) {
        console.log('[U→C] Forwarding to client...');
        clientWs.send(data, (err) => {
          if (err) console.error('[U→C] Send error:', err.message);
          else console.log('[U→C] Message forwarded successfully');
        });
      }
    });

    clientWs.on('close', () => {
      console.log('[CLIENT] Disconnected');
      if (pingInterval) clearInterval(pingInterval);
      if (upstreamWs) upstreamWs.close();
    });

  } catch (error) {
    console.error('[ERROR]', error.message);
    clientWs.close(1011, 'proxy error');
  }
});
