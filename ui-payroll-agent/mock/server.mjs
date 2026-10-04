import { createServer } from 'node:http';
import { createMockExecutor, mockWebhook } from './graphqlMock.js';

export async function startMockServer() {
  const execute = createMockExecutor();
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path.startsWith('/webhook/')) { req.url = path.slice('/webhook'.length); return await mockWebhook(execute, req, res); }
      if (req.method !== 'POST' || !['/', '/graphql'].includes(path)) { res.writeHead(404); return res.end('{}'); }
      let body = '';
      for await (const part of req) body += part;
      res.end(JSON.stringify(await execute(JSON.parse(body))));
    } catch { res.writeHead(400); res.end(JSON.stringify({ errors: [{ message: 'Invalid request.' }] })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}
