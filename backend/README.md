# Domain agents backend

Catalog and saved-agent operations use gRPC with a GraphQL adapter. The backend
also serves an HTTP chat webhook.
`docker/Dockerfile` builds the backend and UI targets. Docker Compose runs
five core services: `backend` (Python gRPC plus Node GraphQL and the agent
webhook), `ui`, `db` (MySQL 8.4), `redis` (short conversations), and `vector-db`
(PostgreSQL/pgvector for long-term semantic information). The temporary TriNet
mock adds `trinet-mock` (payroll API) and `trinet-ui`. The `evidence-capture`
service supplies optional headless-browser screenshots for incident reports.

## Start the stack

Install Docker Desktop with Linux containers and Compose v2, then start its
engine. On Windows, use `docker desktop start` or open Docker Desktop. Host Python
and Node are not required. See the [root quick start](../README.md).

On macOS, the same stack can run with Podman; follow the
[Podman setup and commands](../docker/README.md#macos-with-podman).

From the repository root, start the **UI, backend, and MySQL database**:

```bash
docker compose -f docker/docker-compose.yaml up --build -d --wait db backend ui
docker compose -f docker/docker-compose.yaml ps
```

Redis and PostgreSQL start as backend dependencies; all five core services should
report `healthy`. The shared Dockerfile builds `backend`
and `ui`; MySQL uses its official image. `docker/docker-compose.local.yaml` uses the same
configuration if explicitly selected with `-f`. Dockerfiles, Compose files,
ignore rules, and Docker helper scripts are centralized in [docker/](../docker/README.md).
Run commands from the repository root to load its `.env`.

- UI: http://localhost:5173/ai_studio/ (mount path set by `STUDIO_BASE_PATH`)
- GraphQL and Sandbox: http://localhost:4000/
- Agent webhook: `POST http://localhost:4000/webhook/<domain>/<agentId>` (see Agent model calls)
- gRPC: localhost:50051, service `ai_studio_agents.ai_studio`
- MySQL: `db:3306` inside Docker; no host database port is published.
- Redis: `redis:6379`; PostgreSQL/pgvector: `vector-db:5432`, both internal only.

The optional TriNet demo adds `trinet-mock` and `trinet-ui`. To include them, run
`docker compose -f docker/docker-compose.yaml up --build -d --wait` without a service list. Its UI is at
http://localhost:5174/trinet/ and its payroll API is at http://localhost:4100/.
Start these services for the payrun UI and webhook payroll context.

MySQL initializes the `payroll` database and development user. Override
`MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD`, and `MYSQL_ROOT_PASSWORD`
in your environment or a root `.env` file. Defaults are for local development.
The backend waits for MySQL, applies migrations, syncs the catalog, then starts
both API processes. If either API process exits, the backend stops the other
and exits so Docker can restart it. Its health check queries GraphQL through
gRPC to MySQL. The UI proxies `/ai_studio/graphql` and `/ai_studio/webhook/...`
to the backend under the default mount path.

To rebuild, inspect logs, stop, and resume the core services:

```sh
docker compose -f docker/docker-compose.yaml up --build -d --wait db backend ui
docker compose -f docker/docker-compose.yaml logs --tail=100 ui backend db redis vector-db
docker compose -f docker/docker-compose.yaml stop ui backend db redis vector-db
docker compose -f docker/docker-compose.yaml up -d --wait db backend ui
```

`docker compose -f docker/docker-compose.yaml down` removes this project's containers and network while retaining
the database volumes. Avoid `down -v` when saved agents must be preserved. Existing
MySQL volumes retain the credentials used at initialization; changing `.env`
does not update the database user's password.

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
Model chat is available through `ChatAgent` and the UI's **Chat with agent** action.

External API execution, alerts, and outbound webhook delivery are not implemented.
Agents answer questions through the chat webhook when their model is connected.
Payrun RAG returns calculated evidence even without a model; generic chat without
a configured model acknowledges the question.

Each model file in `Model_config/` may carry an optional `details` object used by
the UI model library: `license` (`open-source`, `commercial`, or `demo`), `vendor`,
`context_window`, `description`, `strengths`, `best_for`, and `benchmarks`
(published scores only, each `{name, score, source}` with an https source link).
A template may list the models it offers in a top-level `models` array (it must
include its default `config.model`); without it every enabled model is offered.
Creating or updating an agent with a model its template does not offer is rejected.
`services.json` also lists four demo notification/observability tools
(`slack-webhook`, `email-notification`, `alert-manager`, `opensearch-sink`) with no
live endpoint until their `*_BASE_URL` variables are set.

`trinet_mock/` is a temporary GraphQL service that mocks the TriNet payroll API,
with editable draft payruns. It isn't part of Agent Studio or the catalog service.
See [trinet_mock/README.md](trinet_mock/README.md).

MySQL persists in the `mysql_data` named volume. `docker compose -f docker/docker-compose.yaml down` retains
it; `down -v` deletes it. The former SQLite `backend_data` volume is not deleted
or imported automatically by Compose. Export existing domains/groups and agents
before switching databases if they must be retained. The model rename migration
preserves records within an existing database; moving SQLite data to MySQL is a
separate export/import operation. Standalone Python runs without `MYSQL_HOST`
continue to use SQLite at `DATABASE_PATH` for development and isolated tests.

Provision another domain with:

```bash
docker compose -f docker/docker-compose.yaml exec backend python manage.py create_domain hr --label "Human Resources" --domain HR
```

## Agent model calls

The chat webhook (`POST /webhook/<domain>/<agentId>` with `{ question, context?, sessionId?, requestId? }`,
served by the backend's GraphQL process) follows one rule: code decides, the model
explains. Fact questions are answered from the payroll data in code; payrun questions
then go to the RAG pipeline (when Redis is configured) and Anomaly Detection review
questions to the anomaly pipeline, which always calculates evidence first, even without a
model connection. Other questions go to the agent's model with a checked reply; without a
connected model they get an acknowledgement that names what is missing.
Code is in `graphql/`:

| Step | File | What it does |
| --- | --- | --- |
| Computed answers | `factAnswers.js` | Answers fact questions (totals, employee lookups, counts, comparisons, findings) exactly from the data, with no model call, even when no model is connected; 58 of the 64 bank questions |
| Conversation | `redisStore.js` | Restores recent turns and employee/topic focus from an expiring Redis session |
| Retrieval and answer | `rag/` | Intent model, local embeddings, persistent pgvector documents, filtered KNN and a separate answer model |
| Payroll data | `payrunContext.js` | Loads the current run and configurable history from `TRINET_API_URL`; RAG defaults to 100 runs, anomaly baselines use up to six |
| Pre-processing | `anomalyPreprocessor.js` | Groups lines by employee ID, computes historical medians and payment differences, and creates review findings |
| Anomaly orchestration | `anomalyPipeline.js` | Initializes one `ChatModel` per request, passes calculated evidence, and handles unavailable models |
| Post-processing | `rag/postprocessor.js`, `anomalyPostprocessor.js` | Validates model JSON, citations and finding references, retains calculated evidence, and formats the chat response |
| Severity | `findingPolicy.js` | Gives each finding a severity (critical, warning, info) and the dollars at risk |
| Answer cache | `answerCache.js` | The same first question on the same payrun version returns the same model answer word for word (in memory, 30 minutes) |
| Context scope | `contextScope.js` | Sends the model only the pay lines the question needs (named employees, flagged ones, or the whole run when it is small) |
| Prompt | `agentPrompt.js` | Agent description and instructions, guardrails (answer only from the data, never change payroll), payroll data, question |
| Model call | `modelRuntime.js` | OpenAI-compatible `chat/completions` request; measures latency and tokens/s; maps provider errors (bad token, no credits, rate limit, overloaded, model not served) to clear messages |
| Reply check | `replyCheck.js` | Every employee ID and dollar amount in the model's reply must be in the data it was sent; otherwise the reply gets a "Check before acting" note |
| Automatic incidents | `incidentTrigger.js` | For agents with alerts enabled: new critical findings are handed to the domain's Incident Report agent (once per finding); warnings are returned as suggestions |

Replies say how they were produced: `answeredBy` is `payroll-data` or `model`, with
`cached` and `check` for model answers, and `incidentAlert` when alerts are enabled.
`context.answerMode = "model"` always asks the model and never raises incidents (the
benchmark script uses it).

Models with provider `huggingface` use the Hugging Face router
(`https://router.huggingface.co/v1`, override with `HF_INFERENCE_BASE_URL`) and the
token in `HF_TOKEN`. Create a fine-grained User Access Token with the permission
"Make calls to Inference Providers" and put `HF_TOKEN=...` in the root `.env`
(git-ignored); only the backend container reads it and it is never sent to the
browser. Provider availability, account access and inference credits depend on
your Hugging Face account. See the [HF chat API documentation](https://huggingface.co/docs/inference-providers/tasks/chat-completion).
New Anomaly Detection agents default to **Llama 3.3 70B**. Select it explicitly
when updating an older saved demo agent. A demo agent does not
automatically switch models when a token is added. After changing `.env`, run
`docker compose -f docker/docker-compose.yaml up -d --force-recreate backend`
from the repository root.

For a token stored in `backend/.env`, use
`docker compose -f docker/docker-compose.yaml --env-file backend/.env up -d --force-recreate --no-deps --wait backend`.
Keep that `--env-file` option for subsequent starts/recreates. If root `.env`
also contains database settings, pass `--env-file .env --env-file backend/.env`
to preserve them. Both files are ignored by Git and excluded from Docker images.

Free-tier providers use provider `openai-compatible`: each model names the
environment variables for its endpoint and key, and is usable once the key is set in
the root `.env` (`docker-compose.yaml` passes them to the backend with the public
endpoints as defaults).

| Model ID | Provider | Key in `.env` | Free limits (check the provider) |
| --- | --- | --- | --- |
| `groq-gpt-oss-120b`, `groq-qwen-3-8-27b` | [Groq](https://console.groq.com/keys) | `GROQ_API_KEY` | About 30 requests/min and 1,000/day per model, no card |
| `gemini-flash-lite` | [Google AI Studio](https://aistudio.google.com/apikey) | `GEMINI_API_KEY` | Per-model limits in AI Studio; free-tier prompts may be used by Google |
| `openrouter-qwen-3-8-27b` | [OpenRouter](https://openrouter.ai/keys) | `OPENROUTER_API_KEY` | 20/min, 50/day (1,000/day after $10 of purchased credit) |
| `ollama-local` | [Ollama](https://ollama.com) on your machine | none; set `OLLAMA_BASE_URL=http://host.docker.internal:11434/v1` | Unlimited; quality depends on the model you pull |

Use mock payroll data only with free tiers. Parameters in a model's `parameters`
(for example `reasoning_effort`) are passed to the provider as they are.

Successful model replies add `model`, `metrics` (`latencyMs`, `promptTokens`,
`completionTokens`, `tokensPerSecond`, `provider`), and `context` (`payrunId`,
`characters` and `scope` sent to the model, `error`) to the JSON. `npm run test:webhook` in `graphql/` tests these
modules against local stand-in servers. To compare models on the Evaluation suites
(checks against the planted anomalies in payrun PR-2026-09-B, plus latency and
tokens/s), with the stack up:

```bash
node scripts/benchmark-models.mjs --dry-run                    # planned calls only
node scripts/benchmark-models.mjs --out docs/model-benchmark.md  # real, billed calls
```

`node scripts/benchmark-models.mjs --bank --models llama-3-3-70b` runs the 64-question bank
(`ui-payroll-agent/src/questionBank.js`: totals, comparisons, anomalies, employees, taxes,
deductions, hours, departments, payments, payroll concepts, out-of-scope requests) and
reports a pass rate per category. Findings so far are in
[docs/model-evaluation-findings.md](../docs/model-evaluation-findings.md).

### Agent-to-agent: incident reports

An agent can hand its conversation to an agent created from the **Incident Report** template:
`POST /webhook/<domain>/<incidentAgentId>` with `context: { page: "payrun", payrunId, employeeId,
task: "incident-report", handoff: { fromAgent, conversation } }` (the TriNet assistant's
"Create incident report" action does this). `graphql/incidentReport.js` then:

1. **Collects evidence** from the payroll API: one item per anomaly finding for the employees the
   conversation discussed within the selected employee scope (all eligible findings if it names none), each with a pay-line snapshot, the
   employee's history, the source, a timestamp, and the amount at risk where computable.
   The `evidence-capture` service (`evidence_capture/`, Playwright headless Chromium) then opens
   the payroll UI read-only and screenshots each finding's pay rows and Edit Employee Pay drawer
   (`POST <EVIDENCE_CAPTURE_URL>/capture`); the images are attached to the evidence and
   embedded in the report. It never edits payroll. If the service is unavailable, the report
   is still created and says why there are no screenshots.
2. **Writes the report**: the agent's model writes Summary, Impact, and Recommended actions when
   connected; otherwise the report is built from the evidence. The evidence table is always
   appended from the collected data.
3. **Emails it** through the email notification tool: `POST <EMAIL_API_BASE_URL>/notifications/email`
   to `INCIDENT_EMAIL_TO`. Without `EMAIL_API_BASE_URL` the reply says the email was not sent.

The response carries `incident` (ID, severity, evidence, total at risk, Markdown report, email
status, screenshot count).

### Employee anomaly pipeline

With RAG enabled (the Docker default), all payrun questions use the architecture
in [AGENTS.md](AGENTS.md#overall-application-flow):
Redis session -> payroll preprocessing -> intent model -> filtered pgvector KNN
-> the agent's answer model -> citation/finding validation -> Redis -> chatbox.

PostgreSQL's `payroll_history_documents` table persists historical documents and
384-dimensional MiniLM vectors; stable content IDs avoid re-embedding unchanged
history. Retrieval uses [pgvector cosine distance](https://github.com/pgvector/pgvector#querying)
within the eligible source set, domain/service, employee and topic. It never uses
the retrieved subset to recompute financial baselines. Local embeddings require
no API key; the first request downloads public weights to `embedding_cache`.

Set `RAG_INTENT_MODEL_ID` for the first model (default
`Qwen/Qwen2.5-72B-Instruct`) and select the answer model on the agent. Both hosted
stages use backend `HF_TOKEN`. Missing credentials use explicit intent rules and
calculated comparisons. `RAG_TOP_K` defaults to 6; `RAG_HISTORY_LIMIT` defaults
to 100 (maximum 500), with a response flag when the source limit is reached.
Set `RAG_ENABLED=false` to use the previous webhook pipeline.

Preload all completed historical payruns (including employees absent from the
current run) independently of a conversation:

```sh
docker compose -f docker/docker-compose.yaml --env-file backend/.env exec backend node graphql/rag/ingest-history.js --domain payroll-services --service payrun
```

`PayrollHistoryIngestor` reads `payruns(status: COMPLETED)` from `TRINET_API_URL`,
validates source records, and writes earnings, overtime and deduction/tax documents
with local MiniLM embeddings to PostgreSQL. `--domain` and `--service` must match
the agent's scope. Repeated runs reuse unchanged document IDs; changed content gets
a new revision. The command reports inserted/existing counts and accepts `--dry-run`
for a preview. It does not call a hosted model or change payroll. Re-run it after
new history arrives; there is no background scheduler. If indexing fails midway,
the command exits unsuccessfully and can be safely rerun to resume missing inserts.

Preloaded documents use the same IDs as query-time indexing. Chat still fetches
current source history to constrain retrieval to eligible periods and revisions;
the retrieval window remains `RAG_HISTORY_LIMIT`. Stale versions, future periods,
other companies and employees outside the question's scope do not enter the answer.

Redis retains at most 20 recent turns plus focus, with an inactivity timeout of
`CHAT_SESSION_TTL_SECONDS` (default 1800). Return `session.id` as `sessionId` for
follow-ups; reuse a `requestId` only when retrying the same request. Sessions are
bound to browser cookie, domain, agent, channel and payrun/employee context.
Expired or conflicting sessions require **New chat**. Browser binding is not
authentication. Redis has no local disk persistence; PostgreSQL's `vector_data`
volume survives restarts and has no automatic document expiry.

Replies include `session` and `retrieval`: intent status, historical source IDs,
employee/payrun/topic metadata, cosine distances, citation flags and retrieval
status (`completed`, `no_results`, `unavailable`). Unavailable retrieval returns
calculated evidence without calling the answer model. With no matching history,
the model can answer from current employee data and must identify the history
limitation without inventing previous payments.

`PayrollAnswerPostprocessor` consumes the raw model response inside the backend.
It validates the answer text, retrieved source IDs and complete finding coverage,
then returns `analysis.modelAnswer: { summary, sourceIds, findings }` alongside
the formatted `reply`. Finding entries contain `findingId`, `explanation` and
`reviewAction`. Invalid output sets `modelAnswer` to null and retains calculated
evidence. Both GraphQL and webhook chat receive the postprocessed response.
The model prompt includes only the employee scope resolved from the UI/query:
current hours, earnings, taxes, deductions, payment method and employment details,
plus historical documents and deterministic comparisons.

Use the payrun webhook for an agent whose `templateId` is `anomaly-detection`:

```json
{
  "question": "How does this employee's payment compare with their history?",
  "context": { "page": "payrun", "payrunId": "PR-2026-09-B", "employeeId": "E1002" }
}
```

Omit `employeeId` to analyze everyone in the run. An unknown employee is rejected.
The server loads payroll data; submitted amounts are never used as evidence.
Only completed runs with earlier pay dates and nonoverlapping earlier periods,
matching company, currency and frequency, qualify. Employees are matched by ID
and pay type, with multiple lines summed per payrun. The median uses at most six
runs; zero, one or two samples are reported as insufficient or limited history.
Missing numeric values are excluded, never treated as zero.

Both the absolute and percentage thresholds must be met (a zero baseline uses
only the absolute threshold). These are initial review rules, not a trained
statistical model or proof of an incorrect payment:

| Metric | Absolute change | Percentage change |
| --- | --- | --- |
| Gross / net pay | 100 currency units | 25% |
| Overtime | 10 hours | 50% |
| Bonus | 100 currency units | 50% |
| Health / 401k / garnishment | 25 currency units | 25% |

Negative net pay, multiple payment lines and pay after a termination preceding
the current period also create review findings. Final pay and split payments may
be legitimate. Monetary comparisons use cents; the current implementation assumes
currencies with two decimal places.

The response adds `analysis` with `employees`, `findings`, `thresholds`,
`historyPayrunIds`, `modelStatus` and `modelMessage`. Each finding retains current
values, median, difference, percentage (null for zero baseline), source payrun
IDs and sample count. The model returns JSON comments referencing every finding
exactly once. Post-processing rejects malformed, missing, extra or duplicate
finding references and never lets the model replace calculated evidence.
Narrative explanations and suggested checks are model-generated, not independently
verified facts. They are labeled separately and no payroll writes occur.

`modelStatus` is `completed`, `not_configured`, `unavailable`, `invalid_response`,
`not_needed` or `context_limit`. Provider errors/timeouts preserve the calculated
report; unavailable payroll data returns an error instead of a fabricated result.
For RAG input larger than 60,000 characters (40,000 in the legacy pipeline), calculated findings remain available
and the user is asked to select an employee for model explanations. The model
receives only that employee's evidence when an employee is selected. Raw tokens
and upstream error bodies are never returned. Tests use simulated providers;
a real inference call requires your own configured token.

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
shared mutable model instance; the GraphQL adapter persists session state in Redis.
Changing the selected model refreshes
its snapshot; other edits retain the model snapshot. Removing/disabling the model
in the catalog prevents further chat. Snapshot configuration changes otherwise
require selecting a new model configuration.

```graphql
mutation Chat($input: ChatAgentInput!) {
  chatAgent(input: $input) { agentId modelId output demo session retrieval analysis }
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
and the submitted conversation to 100,000. The GraphQL adapter stores recent
history in Redis and returns `session.id`; supply it as `input.sessionId` on
follow-ups. The UI keeps that ID in sessionStorage across reloads, though displayed
messages reset. Optional `input.context` with `page: "payrun"`, `payrunId` and
`employeeId` uses payroll RAG. Direct gRPC remains stateless. Responses render as
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

The merged model catalog also supports `huggingface` through `HuggingFaceChatModel`,
using the same `HF_TOKEN` and optional `HF_INFERENCE_BASE_URL` as the payrun webhook.
The direct chat route uses the persisted snapshot and restored history; the payrun
webhook remains a separate integration with payroll context and model metrics.
Migration 0007 joins the agent-info and model-catalog migration branches.

### Container checks

```bash
docker compose -f docker/docker-compose.yaml -f docker/docker-compose.dev.yaml up --build -d --wait db backend ui
```

The dev override mounts source; UI changes hot reload. Restart `backend` after
changing Python, GraphQL, or template files. Rebuild after dependency changes.

```bash
docker compose -f docker/docker-compose.yaml exec backend python manage.py check
docker compose -f docker/docker-compose.yaml exec backend python manage.py validate_templates
docker compose -f docker/docker-compose.yaml exec backend python manage.py makemigrations --check --dry-run
docker compose -f docker/docker-compose.yaml exec -e MYSQL_HOST= -e DATABASE_PATH=/tmp/check.sqlite3 backend python manage.py test registry
docker compose -f docker/docker-compose.yaml run --rm --no-deps ui npm run build
docker compose -f docker/docker-compose.yaml run --rm --no-deps ui npm run lint
```

Backend tests cover template scoping, agent validation, registry filtering, actual
gRPC requests, and preservation of records during the domain migration. UI
contract tests live in `ui-payroll-agent/tests/contract.test.js` and compare the
backend schema, mock schema, and UI operations. Run `node --test tests/contract.test.js` from the UI directory after installing dependencies in
both Node packages. Browser tests are `npm run test:browser` from that directory.
The old GraphQL test file and test Dockerfile are intentionally removed.

`docker/docker-compose.test.yaml` starts the same five core services with temporary MySQL, Redis and PostgreSQL
data directories and no published ports. It is isolated under `payroll-api-test`.

RAG unit tests use simulated providers. Run real session and vector storage checks
against the running local Redis and PostgreSQL services with:

```sh
docker compose -f docker/docker-compose.yaml run --rm --no-deps -e RUN_STORAGE_TESTS=1 backend node --test graphql/storage.integration.test.js
```

## Troubleshooting

```bash
docker compose -f docker/docker-compose.local.yaml logs --tail=100 db backend
docker inspect payroll-local-backend-1 --format '{{json .State.Health}}'
```

A dependency error is downstream of the unhealthy service; inspect that service's
logs first. The backend requires both API processes and a working database.
Do not point Compose at the removed per-directory Dockerfiles.
