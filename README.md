# Agent Studio

Create agents from templates, save their configuration in MySQL, and chat with
their selected model. The UI calls a GraphQL adapter backed by Python gRPC.

## Start the UI, backend, and database

Install Docker Desktop with Linux containers and Docker Compose v2. Start Docker
Desktop and wait for its engine to be ready. Host Python and Node are not required.
On Windows, you can start Docker Desktop from PowerShell:

```powershell
docker desktop start
```

All Docker configuration lives in [docker/](docker/README.md). Run these commands
from the **repository root** so Compose reads the root `.env`:

```sh
docker compose -f docker/docker-compose.yaml up --build -d --wait db backend ui
docker compose -f docker/docker-compose.yaml ps
```

The command builds the UI and backend images and starts MySQL, Redis, and
PostgreSQL/pgvector as dependencies: five healthy core services. The backend applies database migrations
and syncs the template catalog automatically. Migrations seed **Payroll Services**.

| Service | Contents | Access |
| --- | --- | --- |
| `ui` | React/Vite Agent Studio | [Open Agent Studio](http://localhost:5173/ai_studio/) |
| `backend` | GraphQL, agent webhook, and Python gRPC in one container | [GraphQL Sandbox](http://localhost:4000/); gRPC at `localhost:50051` |
| `db` | MySQL 8.4, including the `agent_info` table | `db:3306` on the Docker network; no host database port |
| `redis` | Short conversation sessions with a 30-minute inactivity timeout | `redis:6379` inside Docker |
| `vector-db` | PostgreSQL 17 + pgvector for long-term historical documents and embeddings | `vector-db:5432` inside Docker |

The UI uses backend mode and proxies `/ai_studio/graphql` to the backend. Open
**Payroll → Anomaly Detection → Use Template** to create an agent, then use
**My Agents → Chat with agent**. Anomaly Detection defaults to Llama 3.3 70B;
model replies require the provider configuration described in
the [backend README](backend/README.md#agent-model-calls).

## Employee payment anomaly detection

Start all eight services so the assistant can load payroll history and capture incident evidence:

```sh
docker compose -f docker/docker-compose.yaml up --build -d --wait
```

In Agent Studio, create or edit an **Anomaly Detection** agent and select
**Llama 3.3 70B**. Create a [Hugging Face access token](https://huggingface.co/settings/tokens)
with **Make calls to Inference Providers** permission. Add `HF_TOKEN=your_token`
to the root `.env` locally (create it if missing; preserve existing values).
Never put the token in agent configuration, browser code, or Git. Apply it with:

```sh
docker compose -f docker/docker-compose.yaml up -d --force-recreate backend
```

If the token is in `backend/.env`, include that file explicitly when recreating
or starting services:

```sh
docker compose -f docker/docker-compose.yaml --env-file backend/.env up -d --force-recreate --no-deps --wait backend
```

Keep `--env-file backend/.env` on subsequent `up` commands so the token remains
loaded. If a root `.env` also supplies database settings, load both in order with
`--env-file .env --env-file backend/.env`.

Open the [TriNet payrun](http://localhost:5174/trinet/?domain=payroll-services&payrun=PR-2026-09-B),
choose **Payroll Assistant**, select your agent and an employee (or all employees),
then ask which payments need review. The backend compares each employee with up
to six earlier completed payruns and returns calculated differences plus model
explanations. Missing history is identified. If the model is disconnected or its
response is invalid, calculated findings still appear with an explicit status.
Selecting the optional demo model provides calculated findings without model explanations.
Agent Studio chat also supports optional payrun and employee IDs for this flow.

The answer model receives the selected employees' current payrun details and
historical evidence. The backend validates its JSON, citations and finding IDs
before displaying the response. `analysis.modelAnswer` exposes the validated
summary, source IDs and finding explanations for custom chat rendering. Employees
without history can receive a current-payrun answer that identifies that limitation.

Payrun questions use two model stages: query intent, then a grounded answer.
Historical documents are embedded locally with MiniLM and retained in PostgreSQL
with pgvector. Intent and employee/topic filters select relevant documents using
cosine KNN. Calculated payroll baselines use the complete comparison window,
independently of the retrieved subset. The chat shows its historical sources.

Redis keeps recent turns and employee/topic context for follow-up questions.
Sessions expire after 30 minutes of inactivity; **New chat** clears the UI's
session reference. Redis is temporary; semantic history persists in `vector_data`.
Embedding weights are downloaded on first use and cached in `embedding_cache`.
No embedding API key is required. `HF_TOKEN` connects the two hosted model stages;
without it the app uses labeled intent rules and calculated comparisons.

Optional settings in the root `.env` are `CHAT_SESSION_TTL_SECONDS` (1800),
`RAG_INTENT_MODEL_ID` (`Qwen/Qwen2.5-72B-Instruct`), `RAG_TOP_K` (6),
`RAG_HISTORY_LIMIT` (100), and `VECTOR_DB_PASSWORD`. Set the database password
before first initialization; existing volumes retain their original credentials.
See [the two application flows](backend/AGENTS.md#overall-application-flow).

See [the pipeline and response format](backend/README.md#employee-anomaly-pipeline)
for thresholds, history matching and API usage.

## Preload historical context into PostgreSQL

With the stack running, load all completed payruns from the configured payroll
API into pgvector before users start chatting:

```sh
docker compose -f docker/docker-compose.yaml --env-file backend/.env exec backend node graphql/rag/ingest-history.js --domain payroll-services --service payrun
```

This stores historical earnings, overtime, taxes and deductions as semantic
documents with local embeddings. The command reports payrun, employee and document
counts, plus inserted and existing records. Repeat it after historical data changes;
unchanged documents are reused. Add `--dry-run` to preview counts without writes.
Omit `--env-file backend/.env` if you keep all settings in the root `.env` instead.
Retrieval continues to enforce the current employee, company and historical period
filters before passing documents to the answer model.

## Manage the containers

Rebuild and restart after source changes:

```sh
docker compose -f docker/docker-compose.yaml up --build -d --wait db backend ui
```

Inspect health and logs:

```sh
docker compose -f docker/docker-compose.yaml ps
docker compose -f docker/docker-compose.yaml logs --tail=100 ui backend db redis vector-db
```

Stop or resume the five core services:

```sh
docker compose -f docker/docker-compose.yaml stop ui backend db redis vector-db
docker compose -f docker/docker-compose.yaml up -d --wait db backend ui
```

To remove this project's containers and network:

```sh
docker compose -f docker/docker-compose.yaml down
```

MySQL data in `mysql_data` and semantic history in `vector_data` persist across
rebuilds and `down`. Do not add `-v` if you want to retain them. Redis conversations
are cleared when its container restarts.

## Optional configuration and TriNet demo

Local defaults work without an `.env` file. A root `.env` can override
`MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_ROOT_PASSWORD`, and
`STUDIO_BASE_PATH` (default `/ai_studio/`). MySQL initialization settings apply
when its data volume is first created. Keep existing database credentials when
reusing a populated volume. `HF_TOKEN` and `HF_INFERENCE_BASE_URL` configure
Hugging Face model calls in the backend. Keep credentials out of Git.

The TriNet mock payroll API, UI and incident evidence capture are optional. Start the entire eight-service
demo when you need **Open in payrun** or payroll context:

```sh
docker compose -f docker/docker-compose.yaml up --build -d --wait
```

The additional services are `trinet-mock` ([payroll API](http://localhost:4100/)),
`trinet-ui` ([payrun UI](http://localhost:5174/trinet/)), and `evidence-capture`
(internal incident screenshots). Payroll data uses the
separate `trinet_data` volume. `docker/docker-compose.local.yaml` selects the same
configuration as the default Compose file.

For UI hot reload and mounted backend source:

```sh
docker compose -f docker/docker-compose.yaml -f docker/docker-compose.dev.yaml up --build -d --wait db backend ui
```

Restart `backend` after Python, GraphQL, or template changes; rebuild after
dependency changes. If Docker reports a missing engine pipe, start Docker Desktop
and retry. If a container is unhealthy, inspect its logs with the commands above.

See the [backend README](backend/README.md), [UI README](ui-payroll-agent/README.md),
and [backend agent instructions](backend/AGENTS.md) for API details and checks.
