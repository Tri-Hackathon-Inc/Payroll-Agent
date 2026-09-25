// Local-only Apollo host. Reusable bindings remain in ../graphql/.
const path = require('node:path');
const { createRequire } = require('node:module');
const graphqlRequire = createRequire(path.join(__dirname, '../graphql/package.json'));
const settings = require('./apollo-settings.json');
const http = require('node:http');
const { ApolloServer, HeaderMap } = graphqlRequire('@apollo/server');
const { ApolloServerPluginLandingPageLocalDefault } = graphqlRequire('@apollo/server/plugin/landingPage/default');
const { createGrpcDataSource } = require('./grpc-client');
const { typeDefs, resolvers, catalogRpc } = require('../graphql/aistudio');
const { isWebhookRequest, handleWebhook } = require('../graphql/webhook');

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
    const httpServer = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const context = { dataSources: { grpc }, context: { headers: req.headers } };
      try {
        if (isWebhookRequest(url.pathname)) await handleWebhook(req, res, url.pathname, context);
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
