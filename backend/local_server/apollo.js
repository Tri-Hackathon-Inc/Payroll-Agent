// Local-only Apollo host. Reusable bindings remain in ../graphql/.
const path = require('node:path');
const { createRequire } = require('node:module');
const graphqlRequire = createRequire(path.join(__dirname, '../graphql/package.json'));
const settings = require('./apollo-settings.json');
const { ApolloServer } = graphqlRequire('@apollo/server');
const { startStandaloneServer } = graphqlRequire('@apollo/server/standalone');
const { ApolloServerPluginLandingPageLocalDefault } = graphqlRequire('@apollo/server/plugin/landingPage/default');
const { createGrpcDataSource } = require('../graphql/client');
const { typeDefs, resolvers, catalogRpc } = require('../graphql/schema');

async function main() {
  if (process.env.API_TEST_MODE !== 'true') {
    throw new Error('This temporary server requires API_TEST_MODE=true. Use docker-compose.test.yaml.');
  }

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
    const { url } = await startStandaloneServer(server, {
      listen: { host: process.env.HOST || settings.host, port: Number(process.env.PORT || settings.port) },
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
