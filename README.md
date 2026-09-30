# Run the containers

Run from the repository root. Use Docker or Podman, one at a time.
Install Docker Desktop with Compose v2, or Podman with `podman-compose`.

## 1. Starter

Agent Studio (`ui-payroll-agent`) uses Angular with TypeScript components and
separate HTML templates in `src/app/`. The TriNet demo remains a separate UI.
Containers include Node 22; local Angular development requires Node 22.12+ or
Node 24. `backend/graphql/` contains only the JavaScript GraphQL-to-gRPC adapters.
Python services in `backend/` own question matching, historical retrieval,
model calls, response validation, sessions, access checks and real-time monitoring.
Node manifests are at `backend/`; the HTTP/SSE transport is in `backend/local_server/`.
Payrun questions default to selecting a matched question before retrieval and inference.
Unsaved payroll edits receive read-only historical checks; saved edits trigger the monitor.

Python services live directly under `backend/`: `agents/`, `agent_factory/`,
`template/`, `model/`, `pipelines/`, and `runtime/`. Contracts live alongside
implementations in each component's `interface.py`; anomaly contracts live in
`agents/anomaly_detection/interface.py`. There are no `registry/` or `interfaces/`
wrapper folders. The `agents/` folder owns runtime composition and saved-agent
chat, with `anomaly_detection/` for detector logic and the investigation agent,
`question/` for question matching, and `response/` for citation/finding validation
and answer formatting. Shared runtime helpers remain in `runtime/`, catalog
operations live in `template/`, and Python tests and fixtures live in `tests/`.
Shared Django persistence lives in `storage/models.py`, and gRPC definitions
and handlers live in `api/`.
Django retains the `registry` app label to preserve existing tables and migration
history; this folder reorganization changes neither the schema nor deployment.
`POST /agents` accepts `domainName`, `templateId`,
`name` and `config`, invokes the domain-aware Python factory, and returns the saved
agent with HTTP 201. Optional `config.pipelines` controls question selection,
retrieval and response formatting; `config.model_parameters` supplies validated
model overrides. See [backend configuration and API details](backend/AGENTS.md#interfaces-and-configurable-execution).

**Docker:** start Docker Desktop.

```sh
docker desktop start
```

**Podman on macOS:** create a VM once. Skip if one already exists.

```sh
podman machine init --cpus 4 --memory 8192 --disk-size 50
```

Start the VM if it is stopped.

```sh
podman machine start
```

## 2. Load

Start the UI, backend, databases and supporting services.
Keep credentials in `backend/.env`, or create an empty file for defaults.

**Docker:** build and start all services. Loads both `.env` files automatically.

```sh
bash docker/compose.sh up --build -d --wait
```

Plain `docker compose -f docker/...` commands must pass every settings file with
`--env-file`; otherwise model keys stay empty and every model answer fails.

**Podman:** build and start all services. Loads both `.env` files automatically.

```sh
bash docker/podman.sh up --build -d
```

For Docker settings in both files, use `--env-file .env --env-file backend/.env`.

### Where to access the backend

After the containers start, the backend HTTP host is **http://localhost:4000**.
Open the GraphQL Sandbox in your browser to explore the API, or send requests to
the endpoints below.

| Service | Address on your computer |
| --- | --- |
| GraphQL API and Sandbox | [http://localhost:4000/](http://localhost:4000/) |
| Agent chat webhook (POST) | `http://localhost:4000/webhook/<domainName>/<agentId>` |
| Delete a saved agent (DELETE) | `http://localhost:4000/agents/<domainName>/<agentId>` |
| gRPC API (use a gRPC client) | `localhost:50051` |
| Agent Studio UI | [http://localhost:5173/ai_studio/](http://localhost:5173/ai_studio/) |
| GraphQL through the Studio proxy | `http://localhost:5173/ai_studio/graphql` |

For the chat webhook, replace `<domainName>` with the agent's domain (for example,
`payroll-services`) and `<agentId>` with its saved agent ID. Send a JSON body such
as `{"question":"What is the total net pay?","context":{"page":"payrun","payrunId":"PR-2026-09-B"}}`
with `Content-Type: application/json`, using a payrun ID from your data.

Other containers on the Compose network reach the backend at `http://backend:4000`
(gRPC: `backend:50051`). The published backend ports bind to `127.0.0.1`, so these
local URLs work only on the computer running the stack. Access from another
computer requires a separately configured shared host; this repository does not
configure a public backend URL. The Studio paths above use the default
`STUDIO_BASE_PATH=/ai_studio/`.

### Delete an agent

In **My Agents**, select **Delete** beside an agent and confirm. Deletion requires
the `manageAgents` feature (enabled for admins by default). The agent disappears
from the registry and can no longer be invoked. Its recorded interaction metrics
remain available.

API clients can call `DELETE /agents/<domainName>/<agentId>` on the backend host.
No request body is needed. With admin authentication enabled, include the admin
session cookie obtained from `POST /auth/admin`. Success returns `204 No Content`;
invalid IDs return `400`, missing permission returns `403`, and an absent agent
or a domain mismatch returns `404`. Repeating a successful deletion returns `404`.
GraphQL clients can use `deleteAgent(id: ID!, domainName: String!): Boolean!`;
this mutation applies the same permission and domain checks.

### Reload after adding or changing files

Source files are copied into images, so adding or changing them requires a rebuild.
With the stack running, use one command below to rebuild and replace the app
containers. Databases and Redis stay running.

**Docker: rebuild and reload apps.**

```sh
docker compose -f docker/docker-compose.yaml --env-file backend/.env up --build --force-recreate --no-deps -d --wait backend ui trinet-mock trinet-ui evidence-capture
```

**Podman: rebuild and reload apps.**

```sh
bash docker/podman.sh up --build --force-recreate --no-deps -d backend ui trinet-mock trinet-ui evidence-capture
```

### Develop Agent Studio locally

From `ui-payroll-agent/`, install dependencies with `npm ci`, then use:

```sh
npm run dev
npm run build
npm test
npm run test:browser
```

The Angular development server runs on port 5173 and proxies GraphQL, chat,
authentication, agent deletion, and event streams to `API_PROXY_TARGET`
(default `http://127.0.0.1:4000`). Set `GRAPHQL_MODE=mock` in the shell or
`ui-payroll-agent/.env` for the in-memory API. Browser tests use this mock by
default and need a Playwright Chromium installation (`npx playwright install chromium`),
or `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` pointing to an installed Chrome binary.

`STUDIO_BASE_PATH` controls the UI mount path for development and production
builds. `TRINET_MOCK_URL` controls the link to the separate payroll UI. Both
settings are public UI configuration; provider credentials belong in the backend.
Production output is in `ui-payroll-agent/dist/browser/`. Serve it under the
configured base path with the same API proxy routes. `npm run lint` runs the
Angular compiler's strict TypeScript and HTML template checks.

### Agent UI templates at runtime

The Payroll Assistant is an Angular UI template owned by Agent Studio. Its
TypeScript components and HTML templates live in
`ui-payroll-agent/src/ui-templates/payrun-assistant/`. The payrun page discovers
and loads it when the assistant opens; chat rendering is no longer bundled into
the TriNet React application.

| Runtime resource | Default Studio URL |
| --- | --- |
| UI template registry | `http://localhost:5173/ai_studio/ui-templates/manifest.json` |
| Payrun assistant entry | `http://localhost:5173/ai_studio/ui-templates/payrun-assistant/index.html` |

`npm run dev` and `npm run build` compile the runtime template before starting or
building Studio. Restart the development command after editing a runtime template.
Production output includes `dist/browser/ui-templates/`; publish that directory
alongside Studio's assets. Rebuild the `ui` and `trinet-ui` containers to apply this
change. Future template changes require rebuilding only the Studio UI.

The TriNet host uses `/trinet/agent-studio/ui-templates/manifest.json` through the
existing `AGENT_STUDIO_TARGET` proxy. The iframe and its GraphQL/webhook requests
share that proxy, so the browser needs no backend hostname or CORS configuration.
Angular's `studio.architect.serve.options.allowedHosts` in `angular.json` includes
the internal `ui` hostname, since the TriNet proxy sends `Host: ui:5173`. Add other
trusted proxy hostnames to that array when needed. Angular's CLI treats
`--allowed-hosts` as a boolean, so hostname lists must be configured in that file.
Relative asset URLs also support a custom `STUDIO_BASE_PATH`. If deploying behind
another host, proxy the entire Studio mount, including `ui-templates/`, on the
host's origin.

The manifest selects the `payrun-assistant` template for the `payrun` page. Its
versioned `agent-ui-v1` message contract is:

- The host adds a unique `instance` query parameter to the entry URL.
- The iframe sends `{ protocol: "agent-ui-v1", instance, type: "ready" }`.
- The host replies with `type: "context"` and `context: { domain, payrun: { id,
  employees: [{ employeeId, name }] }, employeeId, open, studioUrl }`, and resends
  it when the selection or panel visibility changes.
- The iframe emits `type: "employee-change"` with `employeeId`, or `type: "close"`.

Both sides check the message origin, source window, and instance ID. The host
sends identifiers and employee labels; the backend fetches payroll evidence.
The runtime lists saved agents attached to `config.page === "payrun"` and keeps
chat sessions separate by domain, agent, payrun, and employee. Loading failures
show a retry action without blocking the payrun page.

Run the host/runtime browser checks after `npm ci` in both UI directories:

```sh
cd ui-payroll-agent
npm run build
npx playwright test --config playwright.runtime.config.js
```

### Stop and remove containers

Stop and remove this project's containers and network. Keep database volumes and images.

**Docker:**

```sh
docker compose -f docker/docker-compose.yaml --env-file backend/.env down
```

**Podman:**

```sh
bash docker/podman.sh down
```

## 3. Troubleshooting

**Docker:** check the engine, settings, container status and logs.

```sh
docker info
docker compose -f docker/docker-compose.yaml --env-file backend/.env config --quiet
docker compose -f docker/docker-compose.yaml --env-file backend/.env ps --all
docker compose -f docker/docker-compose.yaml --env-file backend/.env logs --tail=100
```

**Podman:** check the VM, engine, settings, container status and logs.

```sh
podman machine list
podman info
bash docker/podman.sh config --quiet
bash docker/podman.sh ps
bash docker/podman.sh logs --tail=100
```

If the engine is stopped, repeat Starter. For service errors, check logs.
If a port is busy, stop the other stack.
