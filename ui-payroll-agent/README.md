# Agent Studio UI

React/Vite UI for choosing a domain, browsing templates, and creating or editing
agents through GraphQL and gRPC. Domain selection is included in the URL, and
agent lists are filtered by domain. See the [backend README](../backend/README.md)
for domain provisioning, GraphQL examples, and backend configuration.

## Run in containers

Install Docker with Compose v2 and start the Docker engine. The tracked
`backend/local_server/` defaults are included in the backend image. Host Python
and Node are not required.

From the **repository root**:

```bash
docker compose -f docker-compose.local.yaml up --build -d --wait
docker compose -f docker-compose.local.yaml ps
```

Open [Agent Studio](http://localhost:5173/ai-studio). The command starts the UI,
combined GraphQL/gRPC backend, and MySQL database. Migrations seed Payroll Services.

| Setting | Container value |
| --- | --- |
| `GRAPHQL_MODE` | `backend` |
| `API_PROXY_TARGET` | `http://backend:4000` |
| Browser URL | `http://localhost:5173/ai-studio` |
| Apollo Sandbox | `http://localhost:4000/` |

The UI proxies `/graphql` to Apollo's root endpoint; Apollo calls gRPC. There are
no REST calls. Agents persist in the MySQL named Docker volume.

After UI code changes, rebuild. To inspect logs or stop the stack:

```bash
docker compose -f docker-compose.local.yaml up --build -d --wait
docker compose -f docker-compose.local.yaml logs -f ui backend db
docker compose -f docker-compose.local.yaml down
```

Press Ctrl+C to stop following logs. `down` retains saved agents. See
[backend container instructions](../backend/README.md#start-the-stack) for
volume management, template synchronization, and troubleshooting. The default `docker-compose.yaml` starts the same three-service setup.

## Run without containers

Start gRPC and Apollo using
[backend setup](../backend/README.md). Then, using
Node 22+, run from `ui-payroll-agent/`:

```bash
npm ci
npm run dev
```

Open http://localhost:5173/ai-studio. Backend mode is the default, forwarding
`/graphql` to `http://127.0.0.1:4000/`. To change it, copy `.env.example` to `.env`
in this directory and set `API_PROXY_TARGET`. Restart Vite after changing these
settings.

## Create and edit agents

First [provision a domain](../backend/README.md#catalog-and-persistence), such as
Payroll Services. Refresh the UI after adding a domain.

1. Choose **Payroll Services** from the domain cards or selector.
2. Select **Anomaly Detection → Use Template**.
3. Name the agent **Payroll Anomaly Review**.
4. Customize instructions, starting questions, model, primary/attached APIs,
   page attachment, alerts, and webhook settings.
5. Select **Create agent**, then find it under **My Agents**.
6. Select **Edit agent**, change settings, and select **Save changes**. Reload
   the page to verify persistence.
7. Switch domains to see only that domain's agents.

The form loads defaults and options from `getTemplate(id)`. Saving calls
`createAgent` or `updateAgent`; lists come from `getServiceAgentRegistry(domainName: ...)`.
Validation failures preserve form values. Back/forward navigation and bookmarked
agent URLs retain their domain context. Agents created directly through
GraphQL appear in the same lists.

Saving stores configuration. Select **Chat with agent** under **My Agents** to
send messages to the saved model. The default demo model echoes messages and is
clearly labeled. Configure a compatible model server for real generation (see
the backend README). Chat history lasts until navigation or reload. Failed
requests retain the message for retry. Anomaly monitoring, external API calls,
and alert/webhook delivery are not active yet.

## Standalone mock mode

From `ui-payroll-agent/`:

```bash
GRAPHQL_MODE=mock npm run dev
```

The mock follows `graphql/schema.graphql` and reads `mock/data.json`. It includes
Payroll Services and Payroll Demo to demonstrate separate agent lists. Saved
agents are held in memory and reset when Vite restarts; they are not written to
a database. Backend validation remains authoritative in backend mode.

## Checks

From `ui-payroll-agent/`:

```bash
npm run lint
npm run build
npm test
npx playwright install chromium
npm run test:browser
```

The contract tests require the backend GraphQL dependencies to be installed
(`npm ci` in `backend/graphql/`). Browser tests start a mock Vite server. To test
against a running backend with an isolated database:

```bash
GRAPHQL_MODE=backend DATABASE_PATH=/absolute/path/to/test.sqlite3 npm run test:browser
```

Use the same `DATABASE_PATH` as that backend; the test provisions example
domains through the Django command and creates test agents. Set `PYTHON` if
the interpreter is not the repository's `.venv/bin/python`, and set
`API_PROXY_TARGET` if Apollo uses another address.

For basic checks inside the running UI container, from the repository root:

```bash
docker compose -f docker-compose.local.yaml exec ui npm run lint
docker compose -f docker-compose.local.yaml exec ui npm run build
```

## Troubleshooting

- **Cannot load domains:** confirm backend and Apollo are running. Inside
  Docker the proxy target is `http://backend:4000`; outside Docker it defaults to
  `http://127.0.0.1:4000`.
- **Saved agent disappeared:** check whether Vite was started in mock mode or
  the backend used the temporary API test stack instead of persistent storage.
- **Port 5173 is occupied:** stop the existing Vite process or change the host
  port mapping to `127.0.0.1:5174:5173` and use that browser port.
- **A new domain is missing:** refresh the page after provisioning it.

## Container layout and domain API

Build from the repository root with `docker compose -f docker-compose.local.yaml
up --build -d --wait --remove-orphans`. The single root Dockerfile builds backend
and UI targets; MySQL uses its official image. The three services are `backend`,
`ui`, and `db`. gRPC and GraphQL share the backend container.

The UI loads `listDomains`, then `getDomainAgentsTemplates(domainName)` when a
domain is selected. My Agents uses `getServiceAgentRegistry(domainName)`;
`serviceName` can additionally filter the registry by primary service ID.
Creation uses `createAgent` with `domainName`, `templateId`, `name`, and `config`.
The selected model is `config.model`. URL scoping is now `?domain=...`.
