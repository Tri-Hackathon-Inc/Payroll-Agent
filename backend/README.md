# Domain agents backend

The API is gRPC with a GraphQL adapter. There are no REST endpoints.
One root `Dockerfile` builds the backend and UI targets. Docker Compose runs
exactly three services: `backend` (Python gRPC plus Node GraphQL), `ui`, and `db`
(MySQL 8.4). PostgreSQL is not used.

## Start the stack

From the repository root:

```bash
docker compose -f docker-compose.local.yaml up --build -d --wait --remove-orphans
docker compose -f docker-compose.local.yaml ps
```

The default `docker compose up --build -d --wait` uses the same configuration.
`--remove-orphans` removes the former standalone Apollo container during upgrade;
it does not delete database volumes.

- UI: http://localhost:5173/ai-studio
- GraphQL and Sandbox: http://localhost:4000/
- gRPC: localhost:50051, service `ai_studio_agents.ai_studio`
- MySQL: `db:3306` inside Docker; no host database port is published.

MySQL initializes the `payroll` database and development user. Override
`MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD`, and `MYSQL_ROOT_PASSWORD`
in your environment or a root `.env` file. Defaults are for local development.
The backend waits for MySQL, applies migrations, syncs the catalog, then starts
both API processes. If either API process exits, the backend stops the other
and exits so Docker can restart it. Its health check queries GraphQL through
gRPC to MySQL. The UI proxies `/graphql` to the backend.

`backend/local_server/` is tracked and included in the backend image. Fresh
clones do not need separately provisioned settings. Credentials remain in
environment variables. No OS-specific paths or platform overrides are required.

## Domain API

| GraphQL | gRPC | Result |
| --- | --- | --- |
| `listDomains` | `ListDomains` | Available domains |
| `getDomainAgentsTemplates(domainName)` | `GetDomainAgentsTemplates` | Templates matching that domain's catalog category |
| `listTemplates(serviceName: String!)` | `ListTemplates(ServiceName)` | Templates filtered by primary service ID, e.g. `payrun`; service name is required |
| `getTemplate(id)` | `GetTemplate` | Template defaults and model/service choices |
| `createAgent(input)` | `CreateAgent` | Saved configured agent |
| `updateAgent(input)` | `UpdateAgent` | Updated saved agent |
| `chatAgent(input)` | `ChatAgent` | Text reply from the saved agent's model |
| `getServiceAgentRegistry(serviceName, domainName)` | `GetServiceAgentRegistry` | Saved agents filtered by service and/or domain |

Domain records have a stable `name` (such as `payroll-services`), display `label`,
and catalog category in `domain` (such as `Payroll`). Migration `0004_domain`
renames the old group model and agent relationship without deleting saved agents.
Existing identifiers remain valid, while GraphQL inputs now use `domainName`
and protobuf fields use `domain_name`. Old business query names are removed.

```graphql
query Catalog {
  listDomains { name label domain }
  getDomainAgentsTemplates(domainName: "payroll-services") {
    id name description version config
  }
  getTemplate(id: "anomaly-detection") {
    id config modelConfig { id modelId }
    modelOptions { id name provider modelId }
    serviceOptions { id name domain }
  }
}
```

Create an agent from a template and configuration overrides:

```graphql
mutation Create($input: CreateAgentInput!) {
  createAgent(input: $input) {
    id name domainName templateId templateVersion config createdAt
  }
}
```

Input contains `domainName`, `templateId`, `name`, and `config`. Set
`config.model` to an enabled model configuration ID from `modelOptions`;
`config.service` identifies the primary external service. Supply `config: {}`
to retain the template defaults. Objects merge recursively; arrays are replaced.
Updates take `id`, `domainName`, `name`, and `config` and merge with saved settings.
They cannot move an agent between domains or change its source template.

```graphql
query Registry {
  getServiceAgentRegistry(serviceName: "payrun", domainName: "payroll-services") {
    id name domainName templateId config
  }
}
```

`serviceName` is a service identifier such as `payrun` or `diagnostics`, not its
display label. Registry membership follows the saved primary `config.service`;
attached services do not determine membership. `domainName` is an optional
additional filter. Omit `serviceName` to list all agents in a domain (My Agents);
omit both to list all saved agents. Unknown nonempty identifiers return
`NOT_FOUND`. Invalid configurations return `BAD_USER_INPUT` in GraphQL and
`INVALID_ARGUMENT` in gRPC. Domain filtering is not authentication.

## Catalog and persistence

JSON in `templates/`, `templates/Model_config/`, and `templates/services.json`
is the authoritative template/model/service catalog. `sync_templates` validates
and projects it into the database. Agent configuration and template version are
snapshots and survive catalog changes. Domain and service categories must match.
External API execution, alerts, and webhook delivery are not implemented.
Model chat is available through `ChatAgent` and the UI's **Chat with agent** action.

MySQL persists in the `mysql_data` named volume. `docker compose down` retains
it; `down -v` deletes it. The former SQLite `backend_data` volume is not deleted
or imported automatically by Compose. Export existing domains/groups and agents
before switching databases if they must be retained. The model rename migration
preserves records within an existing database; moving SQLite data to MySQL is a
separate export/import operation. Standalone Python runs without `MYSQL_HOST`
continue to use SQLite at `DATABASE_PATH` for development and isolated tests.

Provision another domain with:

```bash
docker compose exec backend python manage.py create_domain hr --label "Human Resources" --domain HR
```

## Development and checks

### Agent creation and chat

`CreateAgent` / `createAgent` delegates to `AgentFactory`, which calls the
`TemplateInterface` implementation (`CatalogTemplate`) to merge template defaults
with UI input and validates the result before writing the `agent_info` table.
The existing API remains GraphQL over gRPC; there is no REST `/create-agent` route.

The row stores the agent name, domain, template ID/version, effective `config`
(including `created_by`, `service`, `attached_services`, and instructions), and
`model_config` (catalog ID, name, provider model ID, parameters, credential and
endpoint environment variable names). UI callers select `config.model`; model
metadata is resolved on the server. Credentials themselves are never stored.
Migration 0005 renames the existing table and backfills snapshots without deleting
agents. Agents whose model was already removed get an empty snapshot and need an
enabled model selected before chat.

`AgentChat` loads this row scoped to the requested domain. `ModelRuntimeFactory`
initializes a fresh provider client for each request from the saved snapshot,
then `ModelRuntime.generate(messages)` returns assistant text. There is no
shared mutable model or conversation state. Changing the selected model refreshes
its snapshot; other edits retain the model snapshot. Removing/disabling the model
in the catalog prevents further chat. Snapshot configuration changes otherwise
require selecting a new model configuration.

```graphql
mutation Chat($input: ChatAgentInput!) {
  chatAgent(input: $input) { agentId modelId output demo }
}
```

Example variables:

```json
{
  "input": {
    "agentId": "<saved-agent-uuid>",
    "domainName": "payroll-services",
    "message": "Summarize this information",
    "history": []
  }
}
```

History accepts at most 20 complete user/assistant turns; system instructions
always come from the saved agent. Each message is limited to 10,000 characters
and the submitted conversation to 100,000. History is held in the browser until
navigation/reload; the UI sends the most recent 20 turns. Responses render as
text. The demo provider is an explicitly labeled echo, not an LLM.

For a real local model, edit `templates/Model_config/local-open-source.json`:
set `enabled: true`, set `model_id` to your deployed model, and configure the
environment variable named by `endpoint_env` to the server's `/v1` base URL
(for example `http://host.docker.internal:8080/v1`). Set the configured credential
variable if authentication is required; otherwise set `credential_env` to `""`.
Pass these environment variables to the backend container using a Compose
override, rebuild/restart, and select this model in the agent editor. Merely
adding a variable to a root `.env` does not inject it into the container.

`CompatibleChatModel` uses the non-streaming `/chat/completions` format supported
by servers such as [llama.cpp](https://github.com/ggml-org/llama.cpp/tree/master/tools/server#readme).
Its HTTP timeout is 45 seconds; the chat gRPC deadline is 60 seconds. Missing
configuration, timeouts, and provider failures return safe errors. Services
selected on an agent are stored metadata, not callable model tools yet.

### Container checks

```bash
docker compose -f docker-compose.yaml -f docker-compose.dev.yaml up --build -d --wait
```

The dev override mounts source; UI changes hot reload. Restart `backend` after
changing Python, GraphQL, or template files. Rebuild after dependency changes.

```bash
docker compose exec backend python manage.py check
docker compose exec backend python manage.py validate_templates
docker compose exec backend python manage.py makemigrations --check --dry-run
docker compose exec -e MYSQL_HOST= -e DATABASE_PATH=/tmp/check.sqlite3 backend python manage.py test registry
docker compose run --rm --no-deps ui npm run build
docker compose run --rm --no-deps ui npm run lint
```

Backend tests cover template scoping, agent validation, registry filtering, actual
gRPC requests, and preservation of records during the domain migration. UI
contract tests live in `ui-payroll-agent/tests/contract.test.js` and compare the
backend schema, mock schema, and UI operations. Run `node --test tests/contract.test.js` from the UI directory after installing dependencies in
both Node packages. Browser tests are `npm run test:browser` from that directory.
The old GraphQL test file and test Dockerfile are intentionally removed.

`docker-compose.test.yaml` starts the same three services with a temporary MySQL
data directory and no published ports. It is isolated under `payroll-api-test`.

## Troubleshooting

```bash
docker compose -f docker-compose.local.yaml logs --tail=100 db backend
docker inspect payroll-local-backend-1 --format '{{json .State.Health}}'
```

A dependency error is downstream of the unhealthy service; inspect that service's
logs first. The backend requires both API processes and a working database.
Do not point Compose at the removed per-directory Dockerfiles.
