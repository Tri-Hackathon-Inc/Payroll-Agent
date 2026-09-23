# GraphQL catalog bindings

This JavaScript module exposes every RPC in `registry/servicers.py` as a GraphQL
query. The UI owns its query documents and field selections.

| GraphQL query | gRPC call |
| --- | --- |
| `templates` | `ListTemplates` |
| `template(id: ID!)` | `GetTemplate` |
| `modelConfigs` | `ListModelConfigs` |
| `services` | `ListServices` |

Run `npm install` in this directory. Supply the exported schema and resolvers to
your JavaScript GraphQL server using its usual schema registration:

```js
const { createGrpcDataSource } = require('./client');
const { typeDefs, resolvers } = require('./schema');

const grpc = createGrpcDataSource(process.env.GRPC_ADDRESS || 'localhost:50051');
// Register { typeDefs, resolvers } with ApolloServer.
// Supply this context function to startStandaloneServer:
const context = async ({ req }) => ({
  dataSources: { grpc },
  context: { headers: req.headers },
});
// Call grpc.close() when the host shuts down.
```

Each query resolver receives `(root, args, { dataSources, context })`, awaits
`dataSources.grpc.call(protoPath, packageName, serviceName, method, request, getGrpcMetadata(context))`,
and returns the response fields. For this proto, the package is
`payroll.templates.v1` and the service is `TemplateCatalog`. Errors are converted
to GraphQL errors in the resolver's `catch` block.

The data source reuses its gRPC clients and uses plaintext for local development.
Pass `{ credentials }` as its second argument when connecting with TLS. Calls
have a five-second deadline, configurable via `{ timeoutMs }` in the same options.
`getGrpcMetadata(context)` forwards only `authorization` and `x-request-id` from
the request headers. The current catalog servicer does not enforce authentication.

Response fields match the Python GraphQL schema's camelCase names. Configuration
and model parameters are JSON scalars; models and services expose selectable
fields. Protobuf Struct values are decoded without renaming keys in JSON data.
There are no mutations because the current servicer defines only read operations.

Register these schema/resolver bindings with a JavaScript GraphQL host to serve
queries through gRPC. The Django backend exposes the catalog through its gRPC
servicer and has no HTTP routes.

## Temporary Apollo server

From the repository root:

```bash
docker compose -f docker-compose.test.yaml up --build
```

Open <http://localhost:4000/> to explore the schema and run queries in Apollo
Sandbox. The same URL accepts GraphQL HTTP requests. For example:

```graphql
query Catalog {
  templates {
    id
    name
    config
    modelConfig { id modelId parameters }
    attachedServices { id name path }
  }
  template(id: "summarizer") { id name service { id name } }
  modelConfigs { id name provider enabled }
  services { id name method path }
}
```

Or call it from the command line:

```bash
curl http://localhost:4000/ \
  -H 'Content-Type: application/json' \
  --data '{"query":"{ templates { id name } }"}'
```

Apollo loads `schema.js` and sends resolver calls to `backend:50051`. It waits for
gRPC readiness before opening its HTTP listener. The backend creates and seeds a
temporary SQLite database on startup; stopping the container discards that database.
After editing template JSON, run `docker compose -f docker-compose.test.yaml restart backend`.
After code changes, rerun `up --build`.

This stack is only for local manual testing. Only Apollo's port is published, on
the host loopback address; the gRPC connection uses plaintext inside Docker's
network through the explicit `--insecure-for-testing` flag. `server.js`
requires `API_TEST_MODE=true`, and the stack is separate from the default Compose
file. No automated tests are included. Node 22+ is required when running Apollo
outside Docker. The embedded Sandbox UI loads assets from Apollo; curl works
without those browser assets.

Stop and remove the temporary containers:

```bash
docker compose -f docker-compose.test.yaml down
```

The host uses Apollo's [standalone server](https://www.apollographql.com/docs/apollo-server/api/standalone)
and [local landing-page plugin](https://www.apollographql.com/docs/apollo-server/api/plugin/landing-pages).
