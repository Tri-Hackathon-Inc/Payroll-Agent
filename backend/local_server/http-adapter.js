// HTTP/SSE transport only. Python owns validation, permissions and agent execution.
const { catalogRpc } = require('../graphql/aistudio');
const { encodeStruct, decodeStruct, getGrpcMetadata } = require('../graphql/client');

const webhookPath = /^\/webhook\/([^/]+)\/([^/]+)\/?$/;
const agentPath = /^\/agents\/([^/]+)\/([^/]+)\/?$/;
const isHttpRequest = path => webhookPath.test(path) || agentPath.test(path)
  || ['/auth/admin', '/auth/logout', '/events/payroll', '/events/preview', '/events/stream'].includes(path);

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128 * 1024) throw Object.assign(new Error('Request too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid JSON object');
    return body;
  }
  catch { throw Object.assign(new Error('Body must be JSON.'), { status: 400 }); }
}

function addCookie(res, cookie) {
  const current = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(Array.isArray(current) ? current : current ? [current] : []), cookie]);
}

async function handleHttp(req, res, url, context) {
  const grpc = context.dataSources.grpc;
  const metadata = getGrpcMetadata(context.context);
  const call = (method, input, struct = true) => grpc.call(catalogRpc.protoPath, catalogRpc.packageName, catalogRpc.serviceName,
    method, struct ? encodeStruct(input) : input, metadata).then(value => struct ? decodeStruct(value) : value);
  const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body == null ? '' : JSON.stringify(body)); };
  try {
    const expected = url.pathname === '/events/stream' ? 'GET' : agentPath.test(url.pathname) ? 'DELETE' : 'POST';
    if (req.method !== expected) { res.setHeader('Allow', expected); return send(405, { message: `Use ${expected}.` }); }
    if (url.pathname === '/events/stream') {
      const stream = grpc.stream(catalogRpc.protoPath, catalogRpc.packageName, catalogRpc.serviceName, 'WatchPayrollEvents',
        encodeStruct({ domainName: url.searchParams.get('domain') || '', payrunId: url.searchParams.get('payrunId') || '' }), metadata);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(': connected\n\n');
      stream.on('data', value => {
        const event = decodeStruct(value);
        const accepted = res.write(event.type === 'heartbeat' ? ': heartbeat\n\n' : `event: payroll\ndata: ${JSON.stringify(event)}\n\n`);
        if (!accepted) stream.pause();
      });
      res.on('drain', () => stream.resume());
      res.on('close', () => stream.cancel());
      stream.on('error', () => res.end());
      stream.on('end', () => res.end());
      return;
    }
    const match = agentPath.exec(url.pathname);
    if (match) {
      await call('DeleteAgent', { domain_name: decodeURIComponent(match[1]), id: decodeURIComponent(match[2]) }, false);
      return send(204, null);
    }
    const body = await readJson(req);
    if (url.pathname.startsWith('/auth/')) {
      const result = await call('Authenticate', { ...body, action: url.pathname === '/auth/logout' ? 'logout' : 'login' });
      if (result.cookie) addCookie(res, result.cookie);
      return send(200, result.body);
    }
    if (url.pathname === '/events/payroll') return send(202, await call('PublishPayrollEvent', body));
    if (url.pathname === '/events/preview') return send(200, await call('PreviewPayrollChange', body));
    const webhook = webhookPath.exec(url.pathname);
    return send(200, await call('ExecuteAgent', { ...body, domainName: decodeURIComponent(webhook[1]), agentId: decodeURIComponent(webhook[2]), channel: 'payroll' }));
  } catch (error) {
    const mapped = { 3: 400, 4: 504, 5: 404, 7: 403, 8: 429, 9: 400, 10: 409, 11: 410, 14: 503, 16: 401 }[error.code];
    const status = error.status || mapped || 502;
    return send(status, { message: error.status ? error.message : mapped ? error.details : 'Backend service unavailable.' });
  }
}

module.exports = { isHttpRequest, handleHttp };
