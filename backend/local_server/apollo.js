// Local-only Apollo host. Reusable bindings remain in ../graphql/.
const path = require('node:path');
const { createRequire } = require('node:module');
const graphqlRequire = createRequire(path.join(__dirname, '../graphql/package.json'));
const settings = require('./apollo-settings.json');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { ApolloServer, HeaderMap } = graphqlRequire('@apollo/server');
const { ApolloServerPluginLandingPageLocalDefault } = graphqlRequire('@apollo/server/plugin/landingPage/default');
const { createGrpcDataSource } = require('./grpc-client');
const { typeDefs, resolvers, catalogRpc } = require('../graphql/aistudio');
const { isWebhookRequest, handleWebhook } = require('../graphql/webhook');
const { isEventsRequest, handleEvents, startPayrollMonitor } = require('../graphql/payrollEvents');
const { viewerFor, createAuthHandler, isAuthRequest } = require('../graphql/access');
const { isAgentRequest, handleAgent } = require('../graphql/agents');

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

// Forward a plain Node request to Apollo (GraphQL at any path other than /webhook/...).
async function handleGraphQL(server, req, res, url, context) {
  const headers = new HeaderMap();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  const raw = await readBody(req);
  let body = raw;
  if (raw && headers.get('content-type')?.includes('application/json')) {
    try { body = JSON.parse(raw); } catch { body = raw; }
  }
  const result = await server.executeHTTPGraphQLRequest({
    httpGraphQLRequest: { method: req.method.toUpperCase(), headers, search: url.search, body },
    context: async () => context,
  });
  for (const [key, value] of result.headers) res.setHeader(key, value);
  res.statusCode = result.status || 200;
  if (result.body.kind === 'complete') return res.end(result.body.string);
  for await (const chunk of result.body.asyncIterator) res.write(chunk);
  res.end();
}

async function main() {
  const grpc = createGrpcDataSource(process.env.GRPC_ADDRESS || settings.grpcAddress);
  const server = new ApolloServer({
    typeDefs,
    resolvers,
    introspection: true,
    plugins: [
      ApolloServerPluginLandingPageLocalDefault({ embed: true }),
      { async serverWillStart() {
        return { async serverWillStop() { grpc.close(); } };
      } },
    ],
  });

  try {
    await grpc.waitForReady(catalogRpc.protoPath, catalogRpc.packageName, catalogRpc.serviceName);
    await server.start();
    // Real-time anomaly detection: checks each payroll change reported to /events/payroll.
    const monitor = startPayrollMonitor({ context: { dataSources: { grpc }, context: { headers: {} } } });
    console.log(`Real-time payroll monitor started (${monitor.kind} queue)`);
    const handleAuth = createAuthHandler();
    console.log(`Agent Studio access: ${process.env.STUDIO_ADMIN_KEY ? 'admin key required for admin features' : 'open (STUDIO_ADMIN_KEY not set)'}`);
    // Names only, never values: an empty list means every model answer will fail.
    const modelKeys = ['HF_TOKEN', 'GROQ_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_BASE_URL'].filter(name => process.env[name]);
    if (modelKeys.length) console.log(`Model providers configured: ${modelKeys.join(', ')}`);
    else console.warn('WARNING: no model keys are set (HF_TOKEN, GROQ_API_KEY, ...); model answers will fail. Start the stack with docker/compose.sh so .env is loaded.');
    const httpServer = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      // Bind session IDs to an opaque browser cookie as well as the domain and agent.
      const cookieOwner = req.headers.cookie?.match(/(?:^|;\s*)payroll_client=([a-f0-9]{64})(?:;|$)/)?.[1];
      const sessionOwner = cookieOwner || randomBytes(32).toString('hex');
      if (!cookieOwner) res.setHeader('Set-Cookie', `payroll_client=${sessionOwner}; HttpOnly; SameSite=Lax; Path=/`);
      const context = { dataSources: { grpc }, context: { headers: req.headers, sessionOwner, viewer: viewerFor(req.headers) } };
      try {
        if (isAuthRequest(url.pathname)) await handleAuth(req, res, url.pathname);
        else if (isAgentRequest(url.pathname)) await handleAgent(req, res, url.pathname, context);
        else if (isWebhookRequest(url.pathname)) await handleWebhook(req, res, url.pathname, context);
        else if (isEventsRequest(url.pathname)) await handleEvents(req, res, url, context);
        else await handleGraphQL(server, req, res, url, context);
      } catch (error) {
        console.error(error);
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Internal server error.' }));
      }
    });
    const host = process.env.HOST || settings.host;
    const port = Number(process.env.PORT || settings.port);
    await new Promise(resolve => httpServer.listen(port, host, resolve));
    console.log(`GraphQL API and Sandbox: http://${host}:${port}/ (chat webhook: /webhook/<domain>/<agentId>)`);
  } catch (error) {
    grpc.close();
    throw error;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
