// Minimal WebSocket reverse proxy for the development and preview environment.
//
// The browser connects to ws://<page-host>/ws (same origin as the Next.js page),
// and this proxy forwards the upgraded connection to the NestJS collaboration
// gateway. HTTP rewrites in Next.js cannot upgrade a connection, so without this
// hop the realtime channel would silently fall back to SSE polling.
//
// Usage: `node scripts/ws-proxy.mjs` (see `npm run dev`).
import http from 'node:http';
import net from 'node:net';

const listenPort = Number(process.env.WS_PUBLIC_PORT || 26288);
const nextPort = Number(process.env.WS_NEXT_PORT || 3000);
const apiPort = Number(process.env.WS_API_PORT || 25031);
const apiHost = process.env.WS_API_HOST || '127.0.0.1';

function isWebSocket(request) {
  return (request.headers.upgrade || '').toLowerCase() === 'websocket';
}

const server = http.createServer((request, response) => {
  // Non-upgrade requests are ordinary page/API traffic: hand them to Next.js.
  const proxy = http.request(
    {
      host: '127.0.0.1',
      port: nextPort,
      path: request.url,
      method: request.method,
      headers: { ...request.headers, host: `127.0.0.1:${nextPort}` },
    },
    (proxied) => {
      response.writeHead(proxied.statusCode || 502, proxied.headers);
      proxied.pipe(response);
    },
  );
  proxy.on('error', () => {
    response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('web_unavailable');
  });
  request.pipe(proxy);
});

server.on('upgrade', (request, socket, head) => {
  if (!isWebSocket(request) || !(request.url || '').startsWith('/ws')) {
    socket.destroy();
    return;
  }
  const upstream = net.connect(apiPort, apiHost, () => {
    const headerLines = [`${request.method} ${request.url} HTTP/1.1`];
    for (const [key, value] of Object.entries(request.headers)) {
      if (Array.isArray(value)) {
        for (const entry of value) headerLines.push(`${key}: ${entry}`);
      } else if (value !== undefined) {
        headerLines.push(`${key}: ${value}`);
      }
    }
    headerLines.push('', '');
    upstream.write(headerLines.join('\r\n'));
    if (head && head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  const close = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on('error', close);
  socket.on('error', close);
});

server.listen(listenPort, '0.0.0.0', () => {
  console.log(
    `[ws-proxy] listening on 0.0.0.0:${listenPort} → next 127.0.0.1:${nextPort}, websocket /ws → ${apiHost}:${apiPort}`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
