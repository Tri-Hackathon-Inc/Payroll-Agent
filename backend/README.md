# Business agents backend

The backend manages reusable templates and configured agents grouped by business.
GraphQL calls a Django-backed gRPC service with SQLite persistence. There are no
REST endpoints. See [AGENTS.md](AGENTS.md) for architecture and flow diagrams and
[the UI README](../ui-payroll-agent/README.md) for the browser workflow.

| GraphQL operation | gRPC operation |
| --- | --- |
| `listTemplates` | `ListTemplates` |
| `getTemplate(id)` | `GetTemplate` |
| `listBusinesses` | `ListBusinesses` |
| `getBusinessAgents(businessName)` | `GetBusinessAgents` |
| `createAgent(input)` | `CreateAgent` |
| `updateAgent(input)` | `UpdateAgent` |

These six operations belong to `payroll.templates.v1.TemplateCatalog`. Model
and external API choices are included in template details.

## Local settings


All Django server settings and the Apollo host live in `backend/local_server/`:

```text
local_server/
  __init__.py
  studio/
    __init__.py
    settings.py
    asgi.py
    wsgi.py
  apollo.js
  apollo-settings.json
```

This folder is tracked in Git and included in fresh clones. It remains excluded from Docker build contexts and is mounted read-only at runtime. Keep credentials in environment variables; the committed settings contain local development defaults only. Django defaults to `local_server.studio.settings`,
or uses an explicit `DJANGO_SETTINGS_MODULE`. The integration tests require
these settings too. Apollo defaults are in `apollo-settings.json`; `GRPC_ADDRESS`,
`HOST`, and `PORT` override them.

The Django settings must honor `DATABASE_PATH` and use `backend/templates` as
the default catalog directory. The supplied local setup already does this.

## Run in containers

Install Docker with Compose v2 and start the Docker engine. Host Python and Node
are not required. The local settings are included in the checkout. Run these commands
from the **repository root**:

```bash
docker compose version
test -f backend/local_server/studio/settings.py
test -f backend/local_server/apollo.js
test -f backend/local_server/apollo-settings.json
docker compose -f docker-compose.local.yaml config --quiet
docker compose -f docker-compose.local.yaml up --build -d --wait
docker compose -f docker-compose.local.yaml ps
```

This starts all three services:

| Service | Purpose | Address |
| --- | --- | --- |
| `backend` | gRPC and SQLite | `backend:50051` inside Docker |
| `apollo` | GraphQL adapter and Sandbox | http://localhost:4000/ |
| `ui` | Agent Studio | http://localhost:5173/ai-studio |

Backend startup applies migrations, synchronizes templates, and starts gRPC.
Apollo waits for the backend health check; the UI waits for Apollo. The UI
forwards `/graphql` to `http://apollo:4000`, and Apollo uses `backend:50051`.
Only ports 4000 and 5173 are published, on host loopback.

The local settings folder is mounted read-only at runtime and is never copied
into images. No `.env` file is required for this Compose stack. Use
`docker-compose.local.yaml`; the default `docker-compose.yaml` describes an older
published-image setup. This is a local development stack using Vite, the Apollo
test host, and plaintext gRPC within Docker's network.

### Persistence and updates

SQLite is stored at `/data/template_catalog.sqlite3` in the `backend_data` named
volume for the `payroll-local` project. Agents and businesses survive restarts,
rebuilds, and `down`. The host's `backend/template_catalog.sqlite3` is not imported.

Template files are mounted from the host. After editing them:

```bash
docker compose -f docker-compose.local.yaml exec backend python manage.py validate_templates
docker compose -f docker-compose.local.yaml exec backend python manage.py sync_templates
```

After local Django/Apollo settings changes, restart the services. Application
code is copied into images, so rebuild after code changes:

```bash
docker compose -f docker-compose.local.yaml restart backend apollo
docker compose -f docker-compose.local.yaml up --build -d --wait
```

### Logs and stopping

```bash
docker compose -f docker-compose.local.yaml logs -f backend apollo ui
docker compose -f docker-compose.local.yaml down
```

Press Ctrl+C to stop following logs. `down` retains the database volume. Only to
intentionally delete this stack's saved businesses and agents, use:

```bash
docker compose -f docker-compose.local.yaml down --volumes
```

### Other container modes

The API-only test stack uses temporary storage, discarded when the backend stops:

```bash
docker compose -f docker-compose.test.yaml up --build
```

The default backend Docker target validates templates and exits. The `api-test`
target runs gRPC. To run validation by itself with local settings mounted:

```bash
docker build -t payroll-backend-validator backend
docker run --rm --mount type=bind,source="$PWD/backend/local_server",target=/app/local_server,readonly payroll-backend-validator
```

## Run without containers

With local settings provisioned, use Python 3.11+ and Node 22+. From the repository
root, initialize the database and start gRPC:

```bash
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.lock
python backend/manage.py validate_templates
python backend/manage.py migrate
python backend/manage.py sync_templates
python backend/manage.py rungrpc
```

In another terminal, start Apollo:

```bash
cd backend/graphql
npm ci
API_TEST_MODE=true npm start
```

Defaults are `127.0.0.1:50051` for gRPC and http://localhost:4000/ for Apollo.
The backend database defaults to `backend/template_catalog.sqlite3`. If overriding
`DATABASE_PATH`, use the same value for every management command and the server.
Non-loopback gRPC listeners require TLS unless `--insecure-for-testing` is used.

## Create a business

Migrations seed **Payroll Services** (`payroll-services`) in the `Payroll` domain.
The management command safely reuses it or provisions another business:

```bash
# Containers, from the repository root:
docker compose -f docker-compose.local.yaml exec backend python manage.py create_business payroll-services --label "Payroll Services" --domain Payroll

# Without containers, with the Python environment activated:
python backend/manage.py create_business payroll-services --label "Payroll Services" --domain Payroll
```

Use a different slug such as `payroll-demo` and label such as `Payroll Demo` to
create another business. The command preserves existing labels and refuses to
change an existing business's domain. This is administrative provisioning, not
a seventh public API. Refresh the UI after adding a business.

## Configure an Anomaly Detection agent

Run the following queries and mutations in Apollo Sandbox at
http://localhost:4000/.


```graphql
query GetAgentConfiguration {
  listBusinesses { name label domain }
  listTemplates { id name description version }
  getTemplate(id: "anomaly-detection") {
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
currently selected defaults. Option arrays are populated by `getTemplate(id)`;
`listTemplates` lists catalog entries without those option arrays.

### Create an agent

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

### List and update business agents

```graphql
query GetPayrollAgents {
  getBusinessAgents(businessName: "payroll-services") {
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

Each create mutation makes a new agent. Use the returned ID to update it. In
Sandbox, set the update query variables to `{"id": "<returned-agent-uuid>"}`.
For the equivalent UI steps, see [Create and edit agents](../ui-payroll-agent/README.md#create-and-edit-agents).

## Author templates

These JSON files are the source of truth for the template catalog. The loader reads
them directly; no API server, database, or seeding is needed.

```text
templates/
  anomaly-detection.json
  summarizer.json
  general-query.json
  failure-investigation.json
  services.json
  Model_config/
    poc-demo.json
    local-open-source.json
```

Each template has `id`, `name`, `description`, `version`, and an out-of-the-box
`config`. To add another use case, copy a template JSON file, choose a unique ID,
change the defaults, and save it in this directory. Increment `version` when
changing a published template. Files must be valid JSON (no comments).

| Template config field | Meaning |
| --- | --- |
| `description`, `instructions`, `questions` | Agent intent, prompt, and starting questions |
| `domain` | Domain shared with its selected services |
| `model` | ID from a file in `Model_config/` |
| `service` | Service to expose/attach this agent to |
| `page` | Page attachment label |
| `attached_services` | Service IDs supplying context or tools |
| `capabilities.alerts` | Enabled flag and info/warning/critical severity |
| `capabilities.webhooks` | Enabled flag and HTTPS destination |
| `created_by`, `roles` | Plain metadata; no authentication or access checks |

`Model_config/` contains one file per model. `poc-demo` is usable for configuration
without a live model. To configure a real deployment, edit `local-open-source.json`:
set your model ID/provider/parameters and enable it. `endpoint_env` and
`credential_env` name environment variables for a future runtime integration.
They never contain raw credentials. Disabled models are listed for transparency
but cannot be referenced as an enabled template default.

`services.json` defines service IDs, domain, HTTP method, path, and `base_url_env`.
For example, attaching `payrun-history` declares a GET to the base URL referenced
by `PAYRUN_API_BASE_URL` plus `/payruns/history`. Path placeholders such as
`{employee_id}` describe runtime inputs; this POC does not resolve or call them.

Example environment names for your deployment:

```text
PAYRUN_API_BASE_URL
EMPLOYEE_API_BASE_URL
DIAGNOSTICS_API_BASE_URL
LOCAL_MODEL_BASE_URL
LOCAL_MODEL_API_KEY
```

The loader returns file contents, not environment variable values. Keep credentials
out of these files. All included service routes are examples to replace with your
actual service contracts. `enabled` means selectable configuration, not a successful
connectivity check.

File changes are reflected the next time you load or validate the catalog. Run
`sync_templates` to update the catalog served by gRPC/GraphQL. These files define
reusable defaults; `CreateAgent` saves user-configured instances separately under
a business. Template changes do not overwrite saved agent configuration. Agent
execution is not implemented.

You can point `TEMPLATE_CONFIG_DIR` at another directory with this same structure.
Invalid JSON, duplicate IDs, invalid defaults, or broken model/service references
raise `CatalogError`; the validation command reports the error and exits unsuccessfully.

## GraphQL adapter

`graphql/schema.js` exports `typeDefs`, `resolvers`, and `catalogRpc`.
`graphql/client.js` exports `createGrpcDataSource`. Register the bindings with a
GraphQL host and supply context containing `dataSources.grpc` and
`context.headers`. Call `grpc.close()` at shutdown. The local Apollo host already
provides this wiring.

Clients are reused with a default five-second deadline. The second argument to
`createGrpcDataSource` accepts `{ credentials, timeoutMs }`. Only `authorization`
and `x-request-id` headers are forwarded as gRPC metadata. Protobuf Struct
encoding preserves configuration keys; typed GraphQL fields use camelCase.
Apollo hosts the backend GraphQL schema in `graphql/schema.js`; Django has no
GraphQL adapter or HTTP routes.

## Checks

From the repository root with the Python environment activated:

```bash
python backend/manage.py check
python backend/manage.py test registry
cd backend/graphql
npm ci
npm test
```

The GraphQL integration test creates a temporary database and real gRPC server.
It uses `.venv/bin/python` at the repository root; set `PYTHON` to override it.
Local Django settings, or an explicit `DJANGO_SETTINGS_MODULE`, are required.

For the running container stack:

```bash
docker compose -f docker-compose.local.yaml exec backend python manage.py check
docker compose -f docker-compose.local.yaml exec backend python manage.py test registry
```

## Troubleshooting

- **Missing local settings:** pull the latest branch containing `backend/local_server/`. Compose
  refuses to create a missing settings directory.
- **`docker: 'compose' is not a docker command` on WSL:** start Docker Desktop
  on Windows. In **Settings → General**, enable the WSL 2 engine if the option
  is shown. Under **Settings → Resources → WSL Integration**, enable your Ubuntu
  distribution and select **Apply**. Reopen the Ubuntu terminal and check
  `docker compose version` and `docker info`. A broken plugin symlink under
  `/usr/local/lib/docker/cli-plugins/` pointing into `/mnt/wsl/docker-desktop/`
  indicates that Desktop's integration is unavailable. See
  [Docker's WSL setup](https://docs.docker.com/desktop/features/wsl/).
- **No Compose on native Linux:** follow
  [Docker's Compose plugin installation](https://docs.docker.com/compose/install/linux/).
- **Port conflict:** stop host Vite/Apollo processes or change only the host side
  of a published port, for example `127.0.0.1:4002:4000`.
- **Backend unhealthy:** inspect backend logs for migration, settings, or catalog
  validation errors.
- **Apollo cannot reach gRPC:** inside Docker, use `backend:50051`, not localhost.
- **UI cannot load businesses:** check Apollo/UI logs and the proxy configuration
  in the [UI README](../ui-payroll-agent/README.md).

This backend stores configuration. Agent execution, model/API calls, and
alert/webhook delivery are not implemented. Authentication and authorization
are not implemented; creator/role metadata and business filtering do not enforce
access control.
