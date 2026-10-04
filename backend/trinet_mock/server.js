// Temporary GraphQL mock of the TriNet payroll API (Apollo Server, like the Agent Studio API).
// Data lives in its own SQLite database (schema.sql) at DATABASE_PATH, seeded from
// seed/payruns.json on first start; without DATABASE_PATH it is in memory and resets on restart.
const { ApolloServer } = require('@apollo/server');
const { startStandaloneServer } = require('@apollo/server/standalone');
const { openDatabase } = require('./db');
const { typeDefs, resolvers } = require('./schema');
const { createEventNotifier } = require('./events');

function createApolloServer() {
  return new ApolloServer({ typeDefs, resolvers, introspection: true });
}

// Keep GraphQL transport and paycheck REST writes on the same public port.
async function startPayrollServer({ store, events, port = 4100, host = '127.0.0.1' }) {
  const http = require('node:http');
  const apollo = createApolloServer();
  const upstream = await startStandaloneServer(apollo, {
    listen: { host: '127.0.0.1', port: 0 }, context: async () => ({ store, events }),
  });
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const match = /^\/payruns\/([^/]+)\/paychecks\/([^/]+)\/?$/.exec(pathname);
    if (!match) {
      const proxy = http.request(new URL(req.url, upstream.url), { method: req.method, headers: req.headers }, response => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      });
      proxy.on('error', () => { res.writeHead(502); res.end(); });
      req.pipe(proxy);
      return;
    }
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (!['POST', 'PUT'].includes(req.method)) {
      res.setHeader('Allow', 'POST, PUT'); return send(405, { message: 'Use POST or PUT.' });
    }
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 128 * 1024) return send(413, { message: 'Request too large.' });
        chunks.push(chunk);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString()); }
      catch { return send(400, { message: 'Body must be JSON.' }); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) return send(400, { message: 'Body must be a JSON object.' });
      const result = await apollo.executeOperation({
        query: 'mutation($input: UpdatePayLineInput!) { updatePayLine(input: $input) { id version } }',
        variables: { input: { ...input, payrunId: decodeURIComponent(match[1]), lineId: decodeURIComponent(match[2]) } },
      }, { contextValue: { store, events } });
      const body = result.body.singleResult;
      if (body.errors) {
        const error = body.errors[0];
        return send({ CONFLICT: 409, NOT_FOUND: 404 }[error.extensions?.code] || 400, { message: error.message });
      }
      return send(200, body.data.updatePayLine);
    } catch (error) { return send(400, { message: error.message }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return { url: `http://${host}:${server.address().port}/`,
    stop: async () => { await new Promise(resolve => server.close(resolve)); await apollo.stop(); } };
}

async function main() {
  const databasePath = process.env.DATABASE_PATH || ':memory:';
  const store = openDatabase(databasePath);
  const events = createEventNotifier();
  const { url } = await startPayrollServer({ store, events,
    host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 4100) });
  console.log(`Mock TriNet payroll GraphQL API and Sandbox: ${url} (database: ${databasePath}; change events: ${events.enabled ? 'on' : 'off'})`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { createApolloServer, startPayrollServer };
