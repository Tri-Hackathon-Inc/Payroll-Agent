// Temporary GraphQL mock of the TriNet payroll API (Apollo Server, like the Agent Studio API).
// Data lives in its own SQLite database (schema.sql) at DATABASE_PATH, seeded from
// seed/payruns.json on first start; without DATABASE_PATH it is in memory and resets on restart.
const { ApolloServer } = require('@apollo/server');
const { startStandaloneServer } = require('@apollo/server/standalone');
const { openDatabase } = require('./db');
const { typeDefs, resolvers } = require('./schema');

function createApolloServer() {
  return new ApolloServer({ typeDefs, resolvers, introspection: true });
}

async function main() {
  const databasePath = process.env.DATABASE_PATH || ':memory:';
  const store = openDatabase(databasePath);
  const { url } = await startStandaloneServer(createApolloServer(), {
    listen: { host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 4100) },
    context: async () => ({ store }),
  });
  console.log(`Mock TriNet payroll GraphQL API and Sandbox: ${url} (database: ${databasePath})`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { createApolloServer };
