import { createServer, request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';

// Android Chrome can omit the browser WebSocket URL from /json/version.
// Keep its real protocol transport and expose discovery in the form CDP expects.
export async function startAndroidDevtools({ upstreamPort, port = 0 }) {
  const sockets = new Set();
  const server = createServer((request, response) => {
    const upstream = httpRequest({ hostname: '127.0.0.1', port: upstreamPort,
      path: request.url, method: 'GET', headers: { host: `127.0.0.1:${upstreamPort}` }, timeout: 5000 }, result => {
      const chunks = [];
      let size = 0;
      result.on('data', chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) { result.destroy(); response.destroy(); }
        else chunks.push(chunk);
      });
      result.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const host = `127.0.0.1:${server.address().port}`;
          const rewrite = value => {
            if (typeof value.webSocketDebuggerUrl === 'string') {
              const target = new URL(value.webSocketDebuggerUrl);
              value.webSocketDebuggerUrl = `ws://${host}${target.pathname}`;
            }
          };
          if (Array.isArray(data)) data.forEach(rewrite);
          else {
            rewrite(data);
            if (request.url === '/json/version' && typeof data.Browser === 'string' && !data.webSocketDebuggerUrl) {
              data.webSocketDebuggerUrl = `ws://${host}/devtools/browser`;
            }
          }
          response.writeHead(result.statusCode ?? 502, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          response.end(JSON.stringify(data));
        } catch { response.writeHead(502).end(); }
      });
      result.on('error', () => response.destroy());
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502).end(); else response.destroy(); });
    upstream.end();
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (request, socket, head) => {
    const upstream = createConnection({ host: '127.0.0.1', port: upstreamPort }, () => {
      const headers = Object.entries(request.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n');
      upstream.write(`GET ${request.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { endpoint: `http://127.0.0.1:${server.address().port}`,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
