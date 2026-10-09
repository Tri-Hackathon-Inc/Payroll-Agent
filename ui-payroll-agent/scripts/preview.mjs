import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { BASE } from './settings.mjs';
import { startMockServer } from '../mock/server.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const root = resolve('dist/browser');
await stat(resolve(root, 'index.html')).catch(() => { throw new Error('Build Agent Studio before previewing: npm run build'); });
const mock = process.env.GRAPHQL_MODE === 'mock' ? await startMockServer() : null;
const target = mock ? `http://127.0.0.1:${mock.address().port}` : process.env.API_PROXY_TARGET || 'http://127.0.0.1:4000';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === BASE.slice(0, -1) && BASE !== '/') { res.writeHead(302, { Location: `${BASE}${url.search}` }); return res.end(); }
    if (!url.pathname.startsWith(BASE)) { res.writeHead(404); return res.end(); }
    const route = url.pathname.slice(BASE.length);
    const api = ['graphql', 'webhook', 'auth', 'agents', 'events', 'anomalies', 'agent-messages'].find(prefix => route === prefix || route.startsWith(`${prefix}/`));
    if (api) {
      const upstream = new URL(`${route === 'graphql' ? '/' : '/' + route}${url.search}`, target);
      const proxy = (upstream.protocol === 'https:' ? httpsRequest : httpRequest)(upstream, { method: req.method, headers: { ...req.headers, host: upstream.host } }, reply => {
        res.writeHead(reply.statusCode || 502, reply.headers); reply.pipe(res);
      });
      proxy.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Backend unavailable.'); });
      req.pipe(proxy); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
    const file = resolve(root, decodeURIComponent(route || 'index.html'));
    if (!file.startsWith(`${root}${sep}`)) { res.writeHead(404); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { res.writeHead(404); res.end('Not found.'); }
});
server.listen(Number(option('--port', '4173')), option('--host', '127.0.0.1'), () => console.log(`Agent Studio preview: http://${option('--host', '127.0.0.1')}:${option('--port', '4173')}${BASE}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { mock?.close(); server.close(); });
