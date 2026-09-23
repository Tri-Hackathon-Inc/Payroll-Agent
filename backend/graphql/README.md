# GraphQL and gRPC service

The JavaScript GraphQL adapter exposes exactly six backend capabilities:

| GraphQL operation | gRPC method |
| --- | --- |
| `templates` | `ListTemplates` |
| `template(id)` | `GetTemplate` |
| `businesses` | `ListBusinesses` |
| `businessAgents(businessName)` | `GetBusinessAgents` |
| `createAgent(input)` | `CreateAgent` |
| `updateAgent(input)` | `UpdateAgent` |

There are no REST routes. All operations use the
`payroll.templates.v1.TemplateCatalog` gRPC service. Model and external API choices
are returned with template details, rather than through separate operations.

## Local Apollo setup

The Apollo host and its settings are in the ignored `backend/local_server/`
folder, which is excluded from Docker builds:

- `apollo.js` configures the local Apollo host and Sandbox.
- `apollo-settings.json` holds `grpcAddress`, `host`, and `port` defaults.
- `studio/settings.py` holds Django settings used by the gRPC backend.

Provision this local folder separately on a fresh checkout. With the gRPC
backend running, use Node 22+ and run from `backend/graphql/`:

```bash
npm ci
API_TEST_MODE=true npm start
```

`GRPC_ADDRESS`, `HOST`, and `PORT` override the local JSON defaults. Reusable
GraphQL schema and gRPC client code remain in this tracked directory.

## Temporary Apollo server

From the repository root:

```bash
docker compose -f docker-compose.test.yaml up --build
```

Open <http://localhost:4000/> in Apollo Sandbox. This URL accepts GraphQL requests;
it is not a REST endpoint. The server waits for gRPC readiness before listening. Both containers mount
`backend/local_server/` read-only at runtime; Docker files stay outside the
ignored folder and local settings are not copied into images.
The backend migrates and synchronizes its temporary SQLite database on startup,
including the initial `payroll-services` business. Stopping the backend discards
this test database, including any agents created there.

After JSON edits, restart the backend to synchronize templates again. After code
edits, rebuild the stack. Normal service deployments should set `DATABASE_PATH`
to persistent storage. The temporary host requires `API_TEST_MODE=true` and Node
22+ outside Docker. Only Apollo's port is published, on host loopback; gRPC uses
plaintext inside the isolated test network.

## Select a business and configure a template

```graphql
query ConfigureAgent {
  businesses { name label domain }
  templates { id name description version }
  template(id: "anomaly-detection") {
    id
    name
    config
    modelConfig { id name provider modelId parameters }
    service { id name method path }
    attachedServices { id name method path }
    modelOptions { id name provider modelId parameters }
    serviceOptions { id name domain method path }
  }
}
```

The UI uses `config` as form defaults and `modelOptions`/`serviceOptions` as
selectable values. `modelConfig`, `service`, and `attachedServices` describe the
currently selected defaults. Option arrays are populated by `template(id)`;
`templates` lists catalog entries without those option arrays.

## Create an agent

```graphql
mutation CreatePayrollAgent {
  createAgent(input: {
    businessName: "payroll-services"
    templateId: "anomaly-detection"
    name: "Payroll payment review"
    config: {
      instructions: "Review unusual payments and explain the evidence."
      capabilities: {
        alerts: { enabled: true, severity: "critical" }
        webhooks: { enabled: true, url: "https://example.com/payroll-events" }
      }
    }
  }) {
    id name businessName templateId templateVersion config createdAt updatedAt
  }
}
```

Only overridden properties need to be supplied inside `config`; `{}` accepts
all template defaults. Object properties merge recursively and arrays replace
the previous value. Unknown properties or invalid configuration are rejected.
Configuration JSON uses the same snake_case keys as template files, such as
`attached_services`; GraphQL's typed fields use camelCase.

## List and update business agents

```graphql
query PayrollAgents {
  businessAgents(businessName: "payroll-services") {
    id name templateId templateVersion config createdAt updatedAt
  }
}
```

Use the returned agent ID in the update mutation:

```graphql
mutation UpdatePayrollAgent($id: ID!) {
  updateAgent(input: {
    id: $id
    businessName: "payroll-services"
    name: "Updated payroll review"
    config: { capabilities: { alerts: { severity: "warning" } } }
  }) {
    id name config updatedAt
  }
}
```

Updates merge into saved agent settings and preserve omitted properties. The
agent must belong to the specified business. Neither the business nor source
template can be changed through this mutation. Lists for existing businesses
without agents return `[]`; unknown businesses/agents/templates return
`NOT_FOUND`. Invalid configuration returns `BAD_USER_INPUT` (gRPC
`INVALID_ARGUMENT`). Business filtering is not an authorization mechanism.

## Adapter implementation and checks

`schema.js` exports `typeDefs`, `resolvers`, and `catalogRpc`. Register the schema
with a GraphQL host and provide context:

```js
const { createGrpcDataSource } = require('./client');
const grpc = createGrpcDataSource(process.env.GRPC_ADDRESS || 'localhost:50051');
const context = async ({ req }) => ({
  dataSources: { grpc },
  context: { headers: req.headers },
});
// Close grpc with grpc.close() when the host shuts down.
```

The adapter reuses gRPC clients with a default five-second deadline. Supply
`{ credentials, timeoutMs }` as the second argument to `createGrpcDataSource`
when needed. Only `authorization` and `x-request-id` metadata are forwarded;
the current service does not enforce authentication. Protobuf Struct values are
encoded/decoded without renaming configuration keys.

Run `npm ci` and `npm test` in this directory to test the production GraphQL
resolvers against a temporary gRPC server and database. The test uses the
repository's `.venv/bin/python`; set `PYTHON` to override it. Provision local
Django settings first, or set `DJANGO_SETTINGS_MODULE` to another settings module.
