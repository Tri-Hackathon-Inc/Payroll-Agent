// Temporary local API host. The reusable bindings live in schema.js/client.js.
const { ApolloServer } = require('@apollo/server');
const { startStandaloneServer } = require('@apollo/server/standalone');
const { ApolloServerPluginLandingPageLocalDefault } = require('@apollo/server/plugin/landingPage/default');
const { createGrpcDataSource } = require('./client');
const { typeDefs, resolvers, catalogRpc } = require('./schema');

async function main() {
  if (process.env.API_TEST_MODE !== 'true') {
    throw new Error('This temporary server requires API_TEST_MODE=true. Use docker-compose.test.yaml.');
  }

  const grpc = createGrpcDataSource(process.env.GRPC_ADDRESS || 'localhost:50051');
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
    const { url } = await startStandaloneServer(server, {
      listen: { host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 4000) },
      context: async ({ req }) => ({
        dataSources: { grpc },
        context: { headers: req.headers },
      }),
    });
    console.log(`Temporary Apollo API and Sandbox: ${url}`);
  } catch (error) {
    grpc.close();
    throw error;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
