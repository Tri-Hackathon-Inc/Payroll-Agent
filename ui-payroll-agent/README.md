# Agent Studio UI

React/Vite UI for choosing a business, browsing templates, and creating or editing
agents through GraphQL and gRPC. Business selection is included in the URL, and
agent lists are filtered by business. See the [backend README](../backend/README.md)
for business provisioning, GraphQL examples, and backend configuration.

## Run in containers

Install Docker with Compose v2 and start the Docker engine. Provision the ignored
`backend/local_server/` folder as described in
[backend local settings](../backend/README.md#local-settings). Host Python and Node
are not required.

From the **repository root**:

```bash
docker compose -f docker-compose.local.yaml up --build -d --wait
docker compose -f docker-compose.local.yaml ps
```

Open [Agent Studio](http://localhost:5173/ai-studio). The command starts the UI,
Apollo GraphQL host, and gRPC backend together. Migrations seed Payroll Services.

| Setting | Container value |
| --- | --- |
| `GRAPHQL_MODE` | `backend` |
| `API_PROXY_TARGET` | `http://apollo:4000` |
| Browser URL | `http://localhost:5173/ai-studio` |
| Apollo Sandbox | `http://localhost:4000/` |

The UI proxies `/graphql` to Apollo's root endpoint; Apollo calls gRPC. There are
no REST calls. Settings stay in the ignored local folder and are mounted at
runtime. Agents persist in the backend's named Docker volume.

After UI code changes, rebuild. To inspect logs or stop the stack:

```bash
docker compose -f docker-compose.local.yaml up --build -d --wait
docker compose -f docker-compose.local.yaml logs -f ui apollo
docker compose -f docker-compose.local.yaml down
```

Press Ctrl+C to stop following logs. `down` retains saved agents. See
[backend container instructions](../backend/README.md#run-in-containers) for
volume management, template synchronization, and troubleshooting. The default
`docker-compose.yaml` describes an older setup; use the local file shown above.

## Run without containers

Start gRPC and Apollo using
[backend local setup](../backend/README.md#run-without-containers). Then, using
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

First [provision a business](../backend/README.md#create-a-business), such as
Payroll Services. Refresh the UI after adding a business.

1. Choose **Payroll Services** from the business cards or selector.
2. Select **Anomaly Detection → Use Template**.
3. Name the agent **Payroll Anomaly Review**.
4. Customize instructions, starting questions, model, primary/attached APIs,
   page attachment, alerts, and webhook settings.
5. Select **Create agent**, then find it under **My Agents**.
6. Select **Edit agent**, change settings, and select **Save changes**. Reload
   the page to verify persistence.
7. Switch businesses to see only that business's agents.

The form loads defaults and options from `getTemplate(id)`. Saving calls
`createAgent` or `updateAgent`; lists come from `getBusinessAgents(businessName)`.
Validation failures preserve form values. Back/forward navigation and bookmarked
agent URLs retain their business context. Agents created directly through
GraphQL appear in the same lists.

Saving stores configuration. Model execution, anomaly monitoring, external API
calls, and alert/webhook delivery are not active yet.

## Standalone mock mode

From `ui-payroll-agent/`:

```bash
GRAPHQL_MODE=mock npm run dev
```

The mock follows `graphql/schema.graphql` and reads `mock/data.json`. It includes
Payroll Services and Payroll Demo to demonstrate separate agent lists. Saved
agents are held in memory and reset when Vite restarts; they are not written to
SQLite. Backend validation remains authoritative in backend mode.

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
businesses through the Django command and creates test agents. Set `PYTHON` if
the interpreter is not the repository's `.venv/bin/python`, and set
`API_PROXY_TARGET` if Apollo uses another address.

For basic checks inside the running UI container, from the repository root:

```bash
docker compose -f docker-compose.local.yaml exec ui npm run lint
docker compose -f docker-compose.local.yaml exec ui npm run build
```

## Troubleshooting

- **Cannot load businesses:** confirm backend and Apollo are running. Inside
  Docker the proxy target is `http://apollo:4000`; outside Docker it defaults to
  `http://127.0.0.1:4000`.
- **Saved agent disappeared:** check whether Vite was started in mock mode or
  the backend used the temporary API test stack instead of persistent storage.
- **Port 5173 is occupied:** stop the existing Vite process or change the host
  port mapping to `127.0.0.1:5174:5173` and use that browser port.
- **A new business is missing:** refresh the page after provisioning it.
