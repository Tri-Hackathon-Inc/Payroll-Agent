# Agent Studio UI

React/Vite UI for choosing a service and domain, browsing templates, and creating
agents through GraphQL and gRPC. Agent Studio is a single page at `/ai_studio/`; the
left panel switches views in place and the URL does not change. See the [backend README](../backend/README.md)
for domain provisioning, GraphQL examples, and backend configuration.

# chat window

The chat experience is available at http://localhost:5173/ai_studio/?view=chat&domain=payroll-services.

1. Type @ to load and select a domain using the listDomains GraphQL query.
2. After choosing a domain, the chat calls getServiceAgentRegistry to display only the agents configured for that domain.
3. Select an agent to reveal its configured starter questions as clickable pills.
Users can send either a starter question or any custom message.
4. The chat sends the message to the webhook at `/ai_studio/webhook/<domain>/<agentId>`.

## Run in containers

Install Docker with Compose v2 and start the Docker engine. Host Python and Node are
not required; see the [backend README](../backend/README.md#start-the-stack).

For macOS with Podman, use the shared
[Podman setup and commands](../docker/README.md#macos-with-podman).

From the **repository root**:

```bash
docker compose -f docker/docker-compose.yaml up --build -d --wait db backend ui
docker compose -f docker/docker-compose.yaml ps db backend ui
```

Open [Agent Studio](http://localhost:5173/ai_studio/). The command starts the UI, the
backend (gRPC plus GraphQL), MySQL, Redis, and PostgreSQL/pgvector. All five core services should become healthy;
migrations seed Payroll Services automatically. See the [root README](../README.md)
for Docker Desktop startup and database persistence.

The TriNet mock is optional. Run `docker compose -f docker/docker-compose.yaml up --build -d --wait` without
a service list to also start `trinet-mock` and `trinet-ui`, then open
http://localhost:5174/trinet/. Use this full demo for **Open in payrun** and payroll
context. `docker/docker-compose.local.yaml` selects the same configuration as the default.

| Setting | Container value |
| --- | --- |
| `GRAPHQL_MODE` | `backend` |
| `API_PROXY_TARGET` | `http://backend:4000` |
| Browser URL | `http://localhost:5173/ai_studio/` |
| GraphQL Sandbox | `http://localhost:4000/` |

The UI proxies `graphql` and `webhook` under its mount path to the backend's GraphQL
process, which calls gRPC for agent data. Agents persist in MySQL.

After UI code changes, rebuild. To inspect logs or stop the stack:

```bash
docker compose -f docker/docker-compose.yaml up --build -d --wait db backend ui
docker compose -f docker/docker-compose.yaml logs --tail=100 ui backend db
docker compose -f docker/docker-compose.yaml stop ui backend db
docker compose -f docker/docker-compose.yaml up -d --wait db backend ui
```

Use `docker compose -f docker/docker-compose.yaml down` to remove this project's containers and network; the
`mysql_data` volume retains saved agents. Avoid `down -v` to keep that data.
See [backend container instructions](../backend/README.md#start-the-stack) for
configuration and troubleshooting. The Compose files build local source images;
no GitHub Container Registry login is required for this workflow.

## Plug into another host

The UI is self-contained: it uses only bundled assets (Bootstrap, Bootstrap Icons, system
fonts) and makes no requests outside its own origin. Every URL it serves or calls is
derived from one setting, `STUDIO_BASE_PATH` (default `/ai_studio/`):

| Path under the base | What it is |
| --- | --- |
| `<base>` | Agent Studio page (`?view=chat` opens the chat window) |
| `<base>graphql` | GraphQL, proxied to `API_PROXY_TARGET` (backend) |
| `<base>webhook/<domain>/<agentId>` | Agent webhook, proxied to the backend |

The left panel's **TriNet Payruns** link opens the separate mock TriNet UI
(`VITE_TRINET_MOCK_URL`, default `http://localhost:5174/trinet/`).

To mount the UI elsewhere, set the path and point the host's reverse proxy at the UI
container with the path unchanged; nothing in the code needs editing:

```bash
STUDIO_BASE_PATH=/paycalendar/ai_studio/ docker compose -f docker/docker-compose.yaml up -d --wait
```

```nginx
location /paycalendar/ai_studio/ {
    proxy_pass http://<ui-container>:5173;   # no trailing slash: keep the full path
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;  # Vite dev server live reload
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

`ALLOWED_HOSTS` (comma-separated) restricts which Host headers the dev server accepts; by
default any host is allowed so it works behind a proxy. The Playwright suite runs under any
mount with `STUDIO_BASE_PATH=/paycalendar/ai_studio/ npx playwright test`.

## Run without containers

Start only the backend and database in Docker (`docker compose -f docker/docker-compose.yaml up -d --wait db backend`
from the repository root; see the [backend README](../backend/README.md#start-the-stack)).
Then, using Node 22+, run from `ui-payroll-agent/`:

```bash
npm ci
npm run dev
```

Open http://localhost:5173/ai_studio/. Backend mode is the default, forwarding
`/graphql` to `http://127.0.0.1:4000/`. To change it, copy `.env.example` to `.env`
in this directory and set `API_PROXY_TARGET`. Restart Vite after changing these
settings.

## Create an agent

Migrations seed the **Payroll Services** domain; provision others with `create_domain`
(see the [backend README](../backend/README.md#catalog-and-persistence)). Refresh the UI
after adding a domain.

Agent Studio is a single page at `/ai_studio/`; the URL does not change while you work.

1. The page opens on **Choose a service**. Select **Payroll** (services without a domain
   and templates in the backend show **Coming soon**).
2. **Payroll Services** is preselected in the **Domain** selector. Under
   **Payroll templates**, select **Anomaly Detection → Use Template**.
3. The form opens below the cards. Name the agent **Payroll Anomaly Review**.
4. Customize instructions, starting questions, model, primary/attached APIs,
   and page attachment.
5. Select **Create agent**. A confirmation appears on the same page and the
   form closes, ready for the next agent. Clicking outside the form also closes it.

Agents can be tested through **Chat with agent** in **My Agents**. Agents attached to the
`payrun` page appear in the **TriNet Payruns** app (left panel). **My Agents** is the admin
view: every agent grouped by service and domain, with search and an **Open in payrun**
link for payrun agents. The left panel also switches to **Tools & APIs**, **Models**, and
**Evaluation**; **Services** returns to the service cards.

Saving stores configuration. Select **Chat with agent** under **My Agents** to
send messages to the saved model. New Anomaly Detection agents default to Llama
3.3 70B through the backend Hugging Face connection. The optional demo model
echoes messages and is clearly labeled. Configure provider credentials for generation (see
the backend README). Redis retains recent turns for follow-ups, with a 30-minute
inactivity timeout by default. The session ID survives a reload in sessionStorage;
the displayed transcript resets. **New chat** starts a new conversation.
Add a payrun ID under **Payroll context for historical comparisons** to use
historical documents stored in PostgreSQL/pgvector, intent classification and
a separate answer model. Failed requests retain the message for retry.
Scheduled anomaly monitoring and alert/webhook delivery are not active yet.

The form loads defaults and options from `getTemplate(id)`. Submitting calls
`createAgent`. Validation failures preserve form values. The separate webhook chat window is at
`/ai_studio/?view=chat&domain=<name>`.

Agents also answer through the payrun webhook when their model is
connected (see the backend README, Agent model calls); anomaly monitoring, external
API calls, and alert/webhook delivery are not active yet.

## Standalone mock mode

From `ui-payroll-agent/`:

```bash
GRAPHQL_MODE=mock npm run dev
```

The mock follows `graphql/schema.graphql` and reads `mock/data.json`. It includes
Payroll Services and Payroll Demo to demonstrate separate agent lists. Saved
agents are held in memory and reset when Vite restarts; they are not written to
SQLite. Backend validation remains authoritative in backend mode.

## TriNet Payruns link

**TriNet Payruns** at the bottom of the sidebar opens the mock TriNet payroll UI in a
new tab (`VITE_TRINET_MOCK_URL`, default `http://localhost:5174/trinet/`). That's a
separate, temporary app ([ui-trinet-mock](../ui-trinet-mock/README.md)) that stands
in for the real TriNet UI. It uses Agent Studio only through its public API, the
same way TriNet will: `listDomains` and `getServiceAgentRegistry`, plus the chat webhook
with `context: { page: "payrun", payrunId, ... }`.

**Tools & APIs** lists the tools the domain's templates offer (`serviceOptions`), in two
groups: **Data sources** (what agents read) and **Actions** (what they can send or record).
Each tool has one status:

- **Live:** the runtime calls it today. The payroll data sources are read through the
  TriNet payroll API (`TRINET_API_URL`).
- **Live when configured:** called only when its endpoint is set, for example email
  through `EMAIL_API_BASE_URL`.
- **Catalog only:** defined in `backend/templates/services.json`, but not called yet. The
  page shows its planned endpoint.

Each tool is a card showing its status, a one-line description, and how templates use it
by default. Selecting a card opens a dialog with the details:

- how agents reach the tool, or its planned endpoint if it isn't wired yet
- the templates that use it, as their primary API or as an attached tool
- the agents in the selected domain that use it
- its entry in the service catalog

Esc, the close button, or a click outside the dialog closes it. The runtime statuses are
kept in `TOOL_INFO` in `src/ToolsPage.jsx`, so update that map when you wire up a tool.

**Evaluation** runs golden test cases (`src/evaluationSuites.js`) for the Anomaly
Detection, Summarizer, and General Query templates against PR-2026-09-B. Each
prompt goes through the agent's webhook, and the reply is graded by keyword checks
for the planted anomalies and totals (see the
[sample data](../backend/trinet_mock/README.md#sample-data)). Until agent execution
is active, the stub replies fail almost every check. Results are kept only until
you leave the page.

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
domains through the `create_domain` command and creates test agents. Set `PYTHON` if
the interpreter is not the repository's `.venv/bin/python`, and set
`API_PROXY_TARGET` if the GraphQL server uses another address.

For basic checks inside the running UI container, from the repository root:

```bash
docker compose -f docker/docker-compose.local.yaml exec ui npm run lint
docker compose -f docker/docker-compose.local.yaml exec ui npm run build
```

## Troubleshooting

- **Cannot load domains:** confirm the backend is running and healthy. Inside
  Docker the proxy target is `http://backend:4000`; outside Docker it defaults to
  `http://127.0.0.1:4000`.
- **Saved agent disappeared:** check whether Vite was started in mock mode or
  the backend used the temporary API test stack instead of persistent storage.
- **Port 5173 is occupied:** stop the existing Vite process or change the host
  port mapping to `127.0.0.1:5174:5173` and use that browser port.
- **A new domain is missing:** refresh the page after provisioning it.
