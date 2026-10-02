# Backend overview

The backend manages reusable agent templates and user-configured agents grouped
by domain, such as **Payroll Services** (`payroll-services`). It is a **gRPC
service with GraphQL adapters**. Django has no HTTP routes; names such as
“list-template” refer to service operations. The Node process hosts GraphQL, HTTP and SSE transport only. `graphql/` contains
only `aistudio.js` and `client.js`; no business logic, tests, manifests or assets
belong there. Python owns execution behind gRPC, including the chat webhook flow.

## Interfaces and configurable execution

Python services live directly under `backend/`. Each component keeps its
contracts in its own `interface.py`, alongside the implementation. There are no
`registry/` or `interfaces/` wrapper folders.

```text
backend/
|-- agents/         # interface.py, agent.py, chat.py, metrics.py
|   |-- communication/ # shared discovery, persisted response handoffs and receiver contracts
|   |-- anomaly_detection/
|   |   |-- interface.py
|   |   |-- components.py # registered domain/component factories and config
|   |   |-- domains/ # domain-specific identity, loading and investigation
|   |   |-- features/ # enricher and feature-store contracts and implementations
|   |   |-- tools/ # read-only investigation evidence contracts
|   |   |-- ingestion/ # domain-neutral event delivery boundary
|   |   |-- feedback.py # append-only human feedback
|   |   |-- agent.py # detection, persistence and explicit Review orchestration
|   |   |-- logic.py # historical detection
|   |   |-- draft.py # transient unsaved checks
|   |   |-- investigation.py # read-only model explanation and validation
|   |   |-- models.py # persisted AnomalyCase
|   |   `-- rules.py # finding policy
|   |-- question/   # logic.py, payroll_questions.json
|   `-- response/   # logic.py: citation and finding validation
|-- agent_factory/  # interface.py, factory.py
|-- template/       # interface.py, config.py, services.py, catalog.py, configuration.py
|-- model/          # interface.py, model.py, runtime.py
|-- pipelines/      # interface.py, config.py, payroll.py
|-- runtime/        # execution, events, sessions and payroll helpers
|-- storage/
|   |-- apps.py
|   |-- models.py
|   |-- management/
|   `-- migrations/
|-- api/
|   |-- servicers.py
|   `-- proto/
`-- tests/          # Python and JavaScript tests
    `-- fixtures/
```

Contract modules use only standard-library imports and never import Django,
persistence models, transport adapters or provider SDKs. Implementations depend
on these contracts. Each service and the test directory is a Python package with
`__init__.py`. Shared Django definitions live in `storage/models.py`; the real
`AnomalyCase` model lives with its agent in `agents/anomaly_detection/models.py`
and is imported by `storage/models.py` for app registration. Shared
catalog operations live in
`template/services.py`, `template/catalog.py` and `template/configuration.py`.
The Django app's Python package is `storage`, while its app label remains
`registry` for database compatibility. Keep that label, historical migration
references and existing table names unchanged: this move does not require a
schema migration or reset of persisted agents. The subsequent
`0010_anomaly_case` migration adds the anomaly case table; preserve existing
database volumes and apply migrations normally.

`agents/` groups the configured-agent runtime with anomaly detection, question
matching and response validation. Shared payroll retrieval and execution helpers
remain in `runtime/`; `pipelines/payroll.py` composes these services. These module
boundaries support independent implementations. They do not introduce separately
deployed services or change execution behavior. The existing gRPC boundary supports
a separately deployed Python runtime; local Compose still supervises Node and
Python together.

Creation follows `POST /agents` (or GraphQL `createAgent`) -> gRPC `CreateAgent`
-> `AgentFactory` -> domain-aware `TemplateConfig` -> validated database record.
`AgentFactory.load` rehydrates a `ConfiguredAgent` from its saved snapshot and checks
the domain and current model availability. An `anomaly-detection` template instead
loads `AnomalyDetectionAgent`, which owns checks and explicit human review.
`ConfiguredAgent` composes an optional
query pipeline, a `ModelInterface`, and a response pipeline. No generated Python
class or executable code is stored in the database.

The creation request uses `domainName`, `templateId`, `name`, and `config`; success
returns HTTP 201 with the saved agent, effective config and model snapshot.
For example:

```json
{
  "domainName": "payroll-services",
  "templateId": "general-query",
  "name": "Paycheck questions",
  "config": {
    "model": "poc-demo",
    "questions": ["Why did my net pay change?"],
    "pipelines": {
      "query": {
        "enabled": true,
        "questionMatching": true,
        "includeSharedQuestions": false,
        "candidateLimit": 3,
        "confirmationTtlSeconds": 600,
        "historyLimit": 100,
        "retrievalLimit": 6
      },
      "response": {"enabled": true, "includeDetails": true}
    },
    "model_parameters": {"temperature": 0.2, "max_tokens": 1024}
  }
}
```

`config.questions` is persisted with the agent and semantically indexed in pgvector.
Question matching defaults to including the shared question library; disable
`includeSharedQuestions` to restrict it to saved questions. Candidate count is 1-5,
confirmation lifetime 60-3600 seconds, history limit 1-500, and retrieval limit 1-20.
Defaults are shown above, except that shared questions are included by default.
`RAG_HISTORY_LIMIT` and `RAG_TOP_K` supply deployment defaults when omitted;
creation saves their resolved values. Old saved agents resolve missing settings
at runtime without a database migration.

With `query.questionMatching: false`, payroll retrieval uses the submitted question
directly. With `query.enabled: false`, execution uses instructions and conversation
without loading payroll or proposing questions. Default payroll execution retains
the selection -> historical retrieval -> enriched model call sequence.
`response.includeDetails: false` omits detailed explanations while retaining the
brief answer, findings, citations and comparison data. `response.enabled: false`
disables optional presentation processing; grounded payroll answers still require
citation and finding validation. Neither setting bypasses evidence validation.
Model overrides allow only `temperature` (0-2), `top_p` (0-1) and `max_tokens`
(integer 1-32768); endpoints and credentials remain catalog/environment settings.

## Supported capabilities

| Capability | gRPC operation | GraphQL operation |
| --- | --- | --- |
| List templates by primary service ID | `ListTemplates(ServiceName)` | `listTemplates(serviceName)` |
| Get template properties and configuration choices | `GetTemplate` | `getTemplate(id)` |
| Create a configured agent for a domain | `CreateAgent` | `createAgent(input)` |
| Update a configured agent within its domain | `UpdateAgent` | `updateAgent(input)` |
| Delete a configured agent within its domain | `DeleteAgent` | `deleteAgent(id, domainName)` |
| Chat with a saved agent | `ExecuteAgent` (sessions); `ChatAgent` (stateless) | `chatAgent(input)` |
| List domains | `ListDomains` | `listDomains` |
| List templates for a domain | `GetDomainAgentsTemplates` | `getDomainAgentsTemplates(domainName)` |
| List saved agents for a service or domain | `GetServiceAgentRegistry` | `getServiceAgentRegistry(domainName: ...)` |
| Agent metrics for the admin view | `GetAgentMetrics` | `agentMetrics(domainName, agentId?, sinceHours?)` |
| Rate an answer (thumbs up/down) | `RateInteraction` | `rateAnswer(input)` |
| Record an answered question (webhook only) | `RecordInteraction` | none; `recordInteraction` in `graphql/aistudio.js` |
| List latest saved anomaly checks | `ListAnomalies` | none; HTTP `GET /anomalies?domain=&payrunId=` |
| Explicitly investigate an anomaly | `ReviewAnomaly` | none; HTTP `POST /anomalies/review` |
| Discover recipients or hand off a saved agent response | `CommunicateAgents` | none; HTTP `POST /agent-messages` |

These are the public operations; metrics and interaction operations serve the Agent Metrics view. Model and external API choices are included
in template details rather than exposed as separate list operations.

## Domain, template, and agent

- **Domain:** a named group of agents with a domain. Migrations seed Payroll
  Services with the `Payroll` domain. Additional domains can be provisioned
  with the `create_domain` management command; there is no domain creation API.
- **Template:** reusable defaults, such as Anomaly Detection, Summarizer, General
  Query, or Failure Investigation. A template contains instructions, starting
  questions, model configuration, primary and attached external APIs, page
  attachment, creator/role metadata, alerts, and webhook settings.
- **Agent:** a saved instance created from a template and the user's overrides.
  It has a UUID, name, domain, source template ID/version, effective
  configuration, and creation/update timestamps.

`GetTemplate` and `ListTemplates` supply `config` defaults, resolved `model_config`,
`service`, `attached_services`, and enabled `model_options` and `service_options`. Service
options match the template's domain. The UI can use these properties to populate
its configurable form. The Angular Agent Studio UI uses this contract in both backend and mock modes;
see the [overall application flow](#overall-application-flow) for the domain/agent walkthrough.

## Overall application flow

There are four flows:

| Flow | Trigger | Result |
| --- | --- | --- |
| Query flow | A user submits a question to a saved agent in the UI | For payrun queries, the backend semantically matches existing questions, waits for selection, retrieves historical payments, calls the answer model, and postprocesses the result. |
| Agent creation and service attachment flow | A user chooses a template, model, primary service, attached services and host page | `AgentFactory` saves the validated agent and service associations in `agent_info`; the host UI discovers the saved agent through the registry. No model call occurs during creation. |
| Anomaly check and Review flow | A saved change, unsaved preview, or anomaly-agent chat requests a check | Saved checks combine rules/statistics and the configured decision model. Unsaved previews skip inference. Explicit Review invokes the investigation LLM with validated citations and findings. |
| AD-to-Incident Report flow | An admin selects Report to Incident Agent after a completed investigation | The shared communication service transfers saved context to an eligible recipient, reconstructs the incident headlessly, captures snapshots and stores the report bundle. |

### 1. Query flow end to end: UI -> backend -> models -> UI

For templates other than Anomaly Detection, the payrun webhook and GraphQL
`chatAgent` with payrun context require Redis and
use this two-stage semantic search flow. The first search returns existing
questions for user selection. Only after selection does historical retrieval run,
followed by one answer-model call with the enriched context. Agent Studio chat
without a payrun uses the standalone gRPC model runtime described below.

```mermaid
flowchart TD
    UI["Payroll Assistant or Agent Studio: submit question and context"] --> API["UI proxy -> Apollo webhook or chatAgent"]
    API --> Setup["Validate request, load agent/model and restore session"]
    Setup -->|gRPC registry and template lookup| MySQL[("MySQL: saved agent and model catalog")]
    Setup <-->|with_conversation| Redis[("Redis: recent turns, context and focus")]
    Setup --> Match["Embed query and rank configured/shared questions"]
    Match <--> Questions[("PostgreSQL + pgvector: question embeddings")]
    Match --> Propose["Store pending candidates in Redis; return question list"]
    Propose --> Select["User selects a question"]
    Select --> Confirm["Validate mapping, expiry, configuration and session scope"]
    Confirm --> Load["TRINET_API_URL: fetch current payrun and historical payments"]
    Load --> Evidence["Preprocess: validate data and calculate employee comparisons"]
    Evidence --> Filters["Resolve confirmed question, employee scope and topics without an intent LLM"]
    Filters --> Docs["Build eligible historical documents by employee, payrun and topic"]
    Docs --> Embed["Local MiniLM embeddings: 384 dimensions"]
    Embed --> Index["Reuse existing vectors; insert new documents and embeddings"]
    Index --> PG[("PostgreSQL + pgvector: historical semantic memory")]
    Index --> KNN["Embed search query; filter and rank eligible documents with cosine KNN"]
    PG --> KNN
    KNN --> Answer["Selected agent model: enriched context -> structured answer and finding comments"]
    Evidence --> Answer
    Answer --> Validate["Postprocess: validate JSON, citations and finding coverage; format answer, sources and calculated review"]
    Validate --> Save["Save completed turn and updated focus in Redis"]
    Save --> Redis
    Save --> Reply["Return API response; UI renders answer, findings and historical sources"]
    Reply --> Followup["Follow-up question with returned session ID"]
    Followup --> API
```

The backend owns model initialization and credentials. It creates request-local
model clients; conversation state lives in Redis. The browser sends question and
context identifiers and retains the returned `session.id` in `sessionStorage`.
For example, the Payroll Assistant sends this first-turn body to
`POST /webhook/payroll-services/<agentId>` through the UI proxies:

```json
{
  "question": "Why is this employee's overtime higher than previous payruns?",
  "context": {
    "page": "payrun",
    "payrunId": "PR-2026-09-B",
    "employeeId": "E1002"
  },
  "requestId": "7bdac347-1fcb-4522-9590-e6262087e4db"
}
```

The first response has `status: "confirmation_required"`, a `questionMapping`
with up to three candidates, and a `session.id`. Submit the original question,
same context, returned session ID, a new request ID, and
`confirmation: { mappingId: questionMapping.id, questionId: selectedCandidate.id }`.
Mappings expire after ten minutes and are bound to the browser, domain, agent,
payrun, employee, original query and current agent configuration. A proposal does
not call the payroll API or an LLM and is not saved as a completed conversation turn.

For a follow-up such as "What about their deductions?", send `sessionId` with
the returned ID, the same context and a new `requestId`; each new query goes through
question selection again. Recent turns and saved employee/topic focus resolve
references. An explicit UI employee selection takes precedence. Agent Studio
uses GraphQL `chatAgent(input)` with `agentId`, `domainName` and `message` in place
of the webhook URL parameters and `question`.

| Step | Implementation and behavior |
| --- | --- |
| 1. Resolve request and session | `runtime/execution.py` or `graphql/aistudio.js` resolves the saved agent within its domain and the selected model from current template options through gRPC. `runtime/sessions.py` restores scoped messages and focus. Both adapters call Python ExecuteAgent, which resolves the agent before opening the session. |
| 2. Match and select a question | `agents/question/logic.py` combines configured and shared questions. Python `VectorStore` indexes their embeddings in `payroll_agent_vectors` (kind `questions`) and ranks them by cosine distance. Return candidates and wait for a valid selection before retrieval or inference. |
| 3. Load and preprocess payroll | After selection, `runtime/payroll.py` fetches source data. `preprocess` computes baselines and findings. The pipeline resolves employees and topics from the confirmed question and conversation without an intent-model call. |
| 4. Index historical context | `runtime/retrieval.py` builds earnings, overtime and deduction documents. `runtime/retrieval.py` uses local FastEmbed `sentence-transformers/all-MiniLM-L6-v2` with CPU ONNX inference and 384 dimensions. Stable content IDs avoid re-embedding unchanged documents. First use downloads public weights to `embedding_cache`; no embedding API key is needed. |
| 5. Retrieve with filters and KNN | `runtime/retrieval.py` embeds the search query and uses parameterized SQL with pgvector cosine distance. Filter by domain/service/company scope, eligible historical IDs, embedding version, employee selection and topic. Default `RAG_TOP_K=6`, maximum 20; this is exact KNN. |
| 6. Generate the answer | `pipelines/payroll.py` calls the `ModelInterface` implemented by `model/model.py`, which resolves the selected provider through `ModelRuntimeFactory`. The prompt includes the confirmed question, original query, instructions, current employee details, recent turns, retrieved documents and calculated evidence. Hosted calls use backend-only credentials such as `HF_TOKEN`. |
| 7. Postprocess | `postprocess` in `agents/response/logic.py` validates JSON, supplied source IDs and exactly one valid comment per calculated finding. It deduplicates citations, resolves their metadata from retrieved history, and formats the summary, historical sources and calculated review. Invalid model output is discarded as a whole; calculated evidence remains available. |
| 8. Save and display | `with_conversation` appends the question and final reply, saves resolved focus and refreshes session expiry. The API returns the response contract below; `ui-payroll-agent/src/ui-templates/payrun-assistant/payrun-assistant.component.ts` or `agent-chat.component.ts` renders it and retains the session ID for follow-ups. |

Historical retrieval considers up to `RAG_HISTORY_LIMIT=100` runs (maximum 500);
`retrieval.historyLimitReached` signals that the fetch limit was reached. Only
earlier, completed, non-overlapping history matching company, currency, frequency
and pay type is eligible. The anomaly baseline independently uses up to six
compatible historical runs. Never recalculate baseline amounts from a KNN subset.

Redis holds at most 20 recent user/assistant turns and trims older pairs when
history exceeds approximately 60,000 characters. Session scope includes the
domain, agent, entry point and server-issued browser cookie; payrun/employee
context cannot change within a session. Requests are serialized per session and
the most recent `requestId` with the same question/context can be retried without
another inference call. Expired sessions return HTTP 410 or GraphQL
`SESSION_EXPIRED`; changed scope returns HTTP 409 or GraphQL `SESSION_CONFLICT`.
Completed fallback reports are saved as turns; requests that throw an error are
not appended. The UI's **New chat** action clears its session reference so the
next question creates a new session. Redis expires old sessions after 30 minutes
of inactivity by default (`CHAT_SESSION_TTL_SECONDS=1800`). The cookie provides
session isolation, not authentication.

PostgreSQL stores long-term document IDs, scopes and embeddings in
`payroll_agent_vectors`, keyed by document ID and embedding model version.
There is no conversation transcript or expiry in this table. Redis has no disk
persistence in the local Compose stack; PostgreSQL uses the `vector_data` volume.
MySQL continues to store the catalog and domains, with configured agents in
`agent_info`. The payroll API remains the source of truth: each query reloads
history, and KNN returns only IDs eligible in that current source snapshot.
Preloaded vectors do not provide an offline fallback when the payroll API fails.

#### Historical data preload

**Payroll API completed payruns -> validate and build employee/topic documents
-> local embeddings -> PostgreSQL scoped IDs and pgvector vectors -> reuse
on subsequent queries.**

`storage/management/commands/ingest_payroll_history.py` preloads completed payroll history independently
of a question. It validates the complete source before indexing and uses the
same document builder and vector store as the query path, including historical
employees not present in a current run. From the repository root with the services running:

```sh
docker compose -f docker/docker-compose.yaml --env-file backend/.env exec backend python manage.py ingest_payroll_history --domain payroll-services --service payrun
```

Match the domain/service arguments to the saved agent. Omit the `--env-file`
option when using root `.env` only. `--dry-run` validates and reports counts without
writes. Reruns reuse existing embeddings and index changed content under new IDs;
partial failures are resumable. This command reads all completed runs exposed by
the payroll API and does not invoke hosted models or mutate payments. It is manual,
not a scheduled import. Query-time source validation and the historical fetch limit
still govern which stored documents may enter a model prompt.

| UI entry point | API and processing | Response |
| --- | --- | --- |
| TriNet Payroll Assistant | `POST /webhook/<domainName>/<agentId>` with `question`, `context`, optional `sessionId` and `requestId` -> Redis -> payroll RAG | `agent`, `reply`, `analysis`, `retrieval`, `session`, `model`, `metrics`, `context` |
| Agent Studio with payrun context | GraphQL `chatAgent(input)` with `context.payrunId` -> Redis -> payroll RAG | `agentId`, `modelId`, `output`, `demo`, `analysis`, `retrieval`, `session` |
| Agent Studio without payrun context | GraphQL `chatAgent(input)` -> gRPC `ExecuteAgent` -> Redis with restored history in Python -> saved model runtime | `output`, `demo`, `session` |
| Agent Studio webhook chat window | `POST /webhook/<domainName>/<agentId>` -> Redis -> generic prompt with restored recent turns; anomaly agents run saved checks or ask for payrun selection, without invoking the investigation LLM | `reply`, `session` |

Failed question matching returns an error before payroll retrieval or inference.
Missing answer credentials, failed historical retrieval, or invalid model output
return calculated comparisons with explicit status. The public payrun adapters
always require question selection, including when `RAG_ENABLED=false`; that flag
is retained for deployment compatibility and no longer changes execution. There is no direct intent-model shortcut. Direct gRPC callers
retain the stateless history-in/history-out contract.

### Components and startup

```mermaid
flowchart LR
    Studio["Agent Studio UI :5173"] --> Proxy["Agent Studio API proxy"]
    TriNet["TriNet payrun UI :5174"] -->|Agent requests| Proxy
    TriNet -->|Payroll requests via TriNet proxy| Payroll["TriNet mock GraphQL :4100"]
    Proxy --> Apollo["Backend: Node Apollo :4000"]
    Apollo --> GRPC["Backend: Python gRPC :50051"]
    GRPC <--> DB[("MySQL: catalog, domains, agent_info")]
    Files["Template, model and service JSON"] --> Sync["Startup: migrate and sync_templates"]
    Sync --> DB
    GRPC <--> Redis[("Redis: expiring conversation sessions")]
    GRPC --> Pipeline["PayrollRagPipeline"]
    Pipeline -->|Current run and history| Payroll
    Payroll <--> PayrollDB[("TriNet payroll SQLite")]
    Pipeline <--> PG[("PostgreSQL + pgvector: historical semantic memory")]
    Pipeline --> Embed["Local MiniLM embedding model"]
    Pipeline -->|Answer call after question selection| Model["Hosted model provider API"]
    GRPC -->|Standalone chat| Model
```

`backend/local_server/run_backend.py` migrates and synchronizes the catalog before
starting gRPC and Apollo. MySQL persists in `mysql_data`; mock payroll data in
`trinet_data`; semantic documents and vectors in `vector_data`. Embedding weights
are cached in `embedding_cache`. Redis conversations are temporary.
Hosted model credentials enter only the backend through environment variables.

Agent Studio proxies `/ai_studio/graphql` and `/ai_studio/webhook/...` to Apollo.
TriNet proxies `/trinet/graphql` to the payroll API and
`/trinet/agent-studio/...` through Agent Studio, including the runtime UI template
registry at `ui-templates/manifest.json`. The payrun page embeds the Angular
`payrun-assistant` template from that registry and passes payrun/employee selection
through the versioned `agent-ui-v1` message contract (see the root README). The
host no longer bundles the assistant implementation. `STUDIO_BASE_PATH` controls the
Agent Studio mount.

### 2. Agent creation and service attachment flow end to end

**Choose template -> configure agent and services -> validate with AgentFactory
-> save agent_info -> discover the agent for its service/page -> start querying.**

Agent Studio loads domains and their templates, then `agent-editor.component.ts` fetches
`getTemplate(id)` to populate defaults and enabled model/service choices. The
current UI uses `getDomainAgentsTemplates(domainName)` for discovery. API clients
can also use `listTemplates(serviceName: "payrun")`; this argument is the primary
service ID. Creation uses GraphQL `createAgent(input)` -> gRPC `CreateAgent`;
`POST /agents` is also available through the HTTP-to-gRPC adapter. Both paths use the same Python permissions, validation and persistence.

Service attachment is saved as part of `createAgent(input)` or
`updateAgent(input)`. The primary service, additional service references, and
page attachment are separate configuration fields:

| UI field | Saved field in `agent_info.config` | Purpose |
| --- | --- | --- |
| Primary external API | `service`, for example `"payrun"` | Associates the agent with its primary service. The registry's `serviceName` filter matches this field. |
| Attached external APIs | `attached_services`, for example `["payrun-history", "employee-details"]` | Records additional services selected for the agent. These IDs do not participate in the registry's primary-service filter. |
| Page attachment | `page`, for example `"payrun"` | Lets the host UI select agents for a particular screen. The TriNet Payroll Assistant filters for this value. |

```mermaid
sequenceDiagram
    participant UI as Agent Studio
    participant Host as Host service UI / Payroll Assistant
    participant API as Apollo / aistudio.js
    participant RPC as gRPC / servicers.py
    participant Factory as AgentFactory
    participant Template as TemplateInterface / CatalogTemplate
    participant DB as MySQL
    UI->>API: listDomains, getDomainAgentsTemplates(domainName), getTemplate(id)
    API->>RPC: ListDomains, GetDomainAgentsTemplates, GetTemplate
    RPC->>DB: Read catalog and domain
    DB-->>RPC: Catalog records and domain
    RPC-->>API: Defaults, enabled model options and service options
    API-->>UI: Template selection and configuration form data
    UI->>UI: Set model, primary service, attached services and page
    UI->>API: createAgent(input)
    API->>RPC: CreateAgent with config encoded as protobuf Struct
    RPC->>Factory: services.create_agent delegates to create
    Factory->>Template: configure(template_id, UI overrides)
    Template-->>Factory: Template metadata and merged configuration
    Factory->>Factory: Validate model, enabled services, matching domain and capabilities
    alt Invalid configuration
        Factory-->>RPC: Validation error, no agent inserted
        RPC-->>API: INVALID_ARGUMENT
        API-->>UI: BAD_USER_INPUT, keep form values for correction
    else Valid configuration
        Factory->>DB: Transaction: insert agent_info and resolved model snapshot
        DB-->>Factory: Saved agent UUID, configuration and timestamps
        Factory-->>RPC: Agent record
        RPC-->>API: CreateAgent response
        API-->>UI: Decode config, return saved agent
        UI->>UI: Close editor and show creation confirmation
    end
    Note over UI,Host: After successful creation, My Agents and host UIs discover the saved record
    Host->>API: getServiceAgentRegistry(domainName, optional serviceName)
    API->>RPC: GetServiceAgentRegistry
    RPC->>DB: Filter agents by domain and optional config.service
    DB-->>RPC: Matching saved agents and configuration
    RPC-->>API: Agent list
    API-->>Host: Agents available for selection
    Host->>Host: Apply page attachment filter and display agents
    Note over Host: Selecting an agent and submitting a question starts the query flow
```

The GraphQL mutation takes `domainName`, `templateId`, `name` and `config` inside
`input`. For example, these variables select a model and attach an AD agent to
the payrun service/page; omitted configuration comes from the template:

```json
{
  "input": {
    "domainName": "payroll-services",
    "templateId": "anomaly-detection",
    "name": "Employee Payrun Review",
    "config": {
      "model": "llama-3-3-70b",
      "created_by": "payroll-user",
      "service": "payrun",
      "attached_services": ["payrun-history", "employee-details"],
      "page": "payrun"
    }
  }
}
```

`api/servicers.py` delegates to `template.services.create_agent`, then
`AgentFactory.create` in `agent_factory/factory.py`. It calls the domain-aware `TemplateConfig.resolve`; its `TemplateInterface`
implementation, `CatalogTemplate.configure`, recursively merges defaults with
the submitted overrides. `config.model` is the catalog selection ID; the server
resolves the provider's `model_id` and model name. `config.created_by` records
creator metadata supplied in configuration; it is not authenticated identity.
Every primary or attached service must exist, be enabled and match the agent's
domain category; duplicate attached service IDs are rejected. Validation failure
prevents the database write.

The transaction writes one configured agent to MySQL:

| Stored field | Source and purpose |
| --- | --- |
| `id`, `name`, `domain_id` | Generated UUID, submitted name and validated domain association. |
| `template_id`, `template_version` | Source template identity and version at creation. |
| `config` | Merged instructions, selected catalog model ID, creator/role metadata, service IDs, page and other settings. |
| `model_config` | Snapshot of model name, provider, provider model ID, parameters and credential/endpoint environment variable names. No API key value is stored. |
| `created_at`, `updated_at` | Persistence timestamps returned to the UI. |

Creation does not initialize or call the model, write a Redis conversation or
ingest PostgreSQL history. Those actions belong to the query or preload flows.
A separate attach API or registration call to the external service is not
required. These associations are configuration metadata; arbitrary catalog
services are not automatically
invoked as model tools. The anomaly pipeline currently obtains payroll data
through its explicit `TRINET_API_URL` integration.

For example, a host service can find its agents using:

```graphql
query {
  getServiceAgentRegistry(domainName: "payroll-services", serviceName: "payrun") {
    id
    name
    templateId
    config
  }
}
```

The current TriNet UI requests the domain's agents without `serviceName`, then
filters `config.page === "payrun"` in `ui-payroll-agent/src/ui-templates/payrun-assistant/payrun-assistant.component.ts`. A host that needs
service-specific discovery should supply `serviceName` as shown above. Attaching
`payrun-history` as an additional API does not make the agent a primary
`payrun-history` registry match.

To change an attachment, `updateAgent(input)` merges the new `service`,
`attached_services` or `page` into the saved configuration, validates it, and
updates the same row. Arrays replace the previous selection. Registry lookups
reflect the new primary service; reopening the Payroll Assistant reloads agents
and reapplies its page filter. Changing the selected model refreshes its model
snapshot; changing only service/page attachments preserves the snapshot.

### General Query chat and predefined questions

The Payroll Assistant chat lists the domain's General Query agents attached to
the `payrun` page. It excludes anomaly agents, including agents with configured
anomaly components. AD retains its scanning, explicit Review, model pipeline and
incident handoff UI; My Agents does not offer a chat tab for AD. General Query
owns free-text chat, suggested questions and the searchable predefined question
library. Its My Agents chat view also offers the saved predefined questions.
The employee scope selector is available for every payrun agent. Selecting or
saving an employee's pay on the payroll screen carries that employee into the
assistant; closing and reopening the panel retains the selection. Changing the
payrun clears it. Keep the scope visible and send `context.employeeId` for a
selected employee, including when using a suggested question such as "Which
payments need review?". Choosing **All employees** explicitly clears this filter.
All public payrun questions use question selection followed by the RAG flow,
including those sent through Agent Studio's optional payrun context.
The preprocessor flags payment, overtime, bonus and deduction
changes, duplicate lines, negative net pay and post-termination payments.

Both payrun adapters first return `status: "confirmation_required"` and
`questionMapping`; after selection they return `status: "answered"`, the
`mappedQuestion`, `analysis` (employees, findings, thresholds and model
status), `retrieval` (intent, source IDs, payrun/employee/topic metadata and
distances), and `session`. The webhook returns final text as `reply` alongside
`agent`, `model`, `metrics` and `context`. GraphQL returns `output`, `agentId`,
`modelId` and `demo`; its `ChatReply` does not expose the webhook's `model`,
`metrics` or `context` fields.

The answer model returns JSON with `answer`, `sourceIds` and `findings` before
postprocessing. The prompt requests one or two short sentences, aiming for at
most 60 words while preserving essential uncertainty. The final `reply`/`output`
contains the accepted summary; `analysis.details` retains cited source labels
and the complete calculated review for the UI's expandable details. Model
fallbacks also return a short status summary with the calculated review in details.
`analysis.modelAnswer` contains the validated summary, deduplicated source IDs,
retrieved source metadata (`sources`) and finding comments for custom rendering,
or null if inference did not produce an accepted answer. The TriNet panel
displays expandable historical sources. Raw provider output is not sent directly
to the chat window.

For a single employee, `analysis.payComparison` supplies source-calculated
previous/current period cards in Agent Studio and the embedded Payroll Assistant.
`runtime/payroll.py` aggregates split lines in cents, including gross,
federal/state tax, FICA, benefits, 401(k), garnishments and net pay. It selects the
latest eligible employee payrun from the full validated history, independently
of the semantic top-K and the anomaly median. Missing amounts remain null, and
`reconciled` indicates whether the displayed components account for both net
amounts. This calculated comparison also enters the answer prompt. The shared
`pay-comparison.component` displays period dates, change amounts and the accepted
model summary, with the full text review available on expansion. Cards remain
available when model output is rejected; broad employee queries retain text replies.

| `analysis.modelStatus` | Behavior |
| --- | --- |
| `completed` | Answer citations and finding comments passed structural/reference validation. Model prose accompanies calculated evidence. |
| `not_configured` | The answer model or its credential is missing; calculated comparisons remain available. |
| `not_needed` | Historical retrieval was unavailable; show the available calculated report. |
| `context_limit` | RAG input exceeds 60,000 characters; request an employee selection for inference. |
| `unavailable` | The answer provider failed or timed out; preserve calculated evidence. |
| `invalid_response` | Reject invalid model text, citations or finding references; preserve calculated evidence. |

`retrieval.status` separately reports `completed`, `no_results` or
`unavailable`. Missing payrun data or invalid employee selection returns an
error. Without RAG, the original anomaly path uses a 40,000-character input
limit and skips inference if there are no findings.

When retrieval succeeds with no matching historical documents, the answer model
may explain the current employee's payrun information. Its prompt requires an
explicit history limitation and an empty source list. Missing history alone does
not skip inference. Current employee details are filtered by the same resolved
employee scope as the evidence; never include other employees in a scoped prompt.

Chat writes short-term session data to Redis and historical semantic documents to
PostgreSQL. Ordinary chat never modifies payroll or sends alerts. Reference validation does
not establish that model-written financial explanations are factually correct;
calculated evidence stays separately labeled.

### Standalone Agent Studio chat

The GraphQL adapter restores Redis history, then calls gRPC `ChatAgent` with
the current message and recent turns. `AgentChat.reply` validates the saved
agent and initializes a fresh `ModelRuntimeFactory` runtime for each request.
Saved instructions form the system message. The successful reply is appended to
the Redis session; failed turns are not appended.

Without payrun context, this path uses the saved model snapshot and does not
fetch payroll data. Adding a payrun ID in the chat panel routes through the Node
RAG pipeline, which resolves model settings from the current template options.
Keep this distinction explicit when changing either runtime.

The demo provider echoes standalone messages and returns calculated comparisons
without answer-model prose for payrun RAG. Supplying `HF_TOKEN` does not change
an agent's selected model. Direct gRPC requests remain stateless; Python ExecuteAgent owns
session persistence.

### Incident report handoff from chat

The docked Payroll Assistant keeps messages while hidden and offers a question
library. After an answer, the user can explicitly hand the active conversation
to a saved Incident Report agent. Send only messages for the current agent,
payrun and employee scope, together with `context.task = "incident-report"`,
`context.employeeId` and `context.handoff`. The webhook handles this request
before normal Redis chat processing so the handoff payload is preserved.
`runtime/incidents.py` loads scoped payroll signals, optionally requests read-only
screenshots from `evidence-capture`, and writes a report. It sends email only
when `EMAIL_API_BASE_URL` is configured; the response reports delivery status.
Ordinary chat requests continue through the RAG/session flow above.

### 4. AD-to-Incident Report flow through the shared communication service

The current payroll flow is:

```mermaid
flowchart TD
    Read["Open payrun or employee paycheck: latest API response"] --> Features["Generate features and calculate findings"]
    Features --> Jev["Jev decision model; show scanning status"]
    Jev --> Review["REVIEW: wait for admin to select Review"]
    Review --> Investigation["Investigation LLM and response validation"]
    Investigation --> Conclusion["Concise conclusion; employee issues; Download Report"]
    Conclusion --> Click["Admin selects Report to Incident Agent"]
    Click --> A2A["Shared agent communication service: validate and claim handoff"]
    A2A --> Recipient["Incident Report agent receives saved response and evidence"]
    Recipient --> Capture["Headless browser reconstructs the saved payroll version"]
    Capture --> Store["Capture snapshots, generate report, persist artifact folder"]
```

Keep the two human actions separate: **Review** authorizes investigation, and
**Report to Incident Agent** authorizes the incident pipeline. No page load,
discovery request, Jev decision or completed investigation automatically creates
an incident. The latter action becomes enabled when an eligible Incident Report
agent exists; otherwise the UI explains that one must be attached in My Agents.
Multiple eligible recipients are presented for selection.

`agents/communication/service.py` owns the shared internal A2A handoff boundary.
This is the application's versioned envelope, not an implementation of an external
A2A interoperability specification. Add new agent integrations through
`register_publisher` and `register_receiver`, with the dependency-free
`ResponseContext` and `Receiver` contracts in `communication/interface.py`.
Publishers resolve trusted, saved responses; receivers consume their context as
data. Keep discovery, access checks and duplicate prevention in the shared service.
The existing direct chat incident command above remains a separate legacy path.

`POST /agent-messages` delegates to gRPC `CommunicateAgents`. Both `DISCOVER` and
`SEND` require a browser session and `testAgents` permission. The request names
`domainName`, sender `agentId`, `capability`, `responseType`, `responseId`, and
`expectedVersion`; `SEND` also names `targetAgentId`. An optional `service`
defaults to the sender's primary service. The initial registered publisher is
`anomaly-investigation`; the receiver capability is `incident-report` for payruns.
Discovery requires the same domain and an enabled service attached to both agents,
and enforces the viewer's model/tool restrictions. Attachment can be primary or
additional; this differs from the primary-only service registry filter.

`anomaly_detection/handoff.py` resolves the sender-owned `AnomalyCase`. Only
completed, validated, non-dismissed investigations may be handed off. Delivery
rechecks the source version and anomaly component settings. Clients cannot replace
saved conclusions or evidence with request text. The envelope includes sender,
recipient, domain, service, source reference/version, entity identity and the saved
response (summary, finding explanations, citations and employee scope).

`AgentMessage` in `storage/models.py`, introduced by migration
`0013_agent_messages`, records requester hash, provenance, status and result.
Its deterministic identity includes the source version, sender, recipient,
service, capability and receiver version. Claim the message before invoking the
receiver. Duplicate requests return its recorded status/result. Failed or
interrupted handoffs are retained for inspection, never automatically replayed;
a receiver pipeline change may advance its version to distinguish new work.

`communication/incident.py` passes saved evidence to `runtime/incidents.py` with
`notify=False`: this flow creates a report without email or Slack delivery.
The `evidence_capture/server.js` headless browser receives the saved payroll
snapshot and intercepts API requests to reconstruct that version. It prevents
capture from making live payroll reads, edits, or triggering further scans.
Capture affected employee pay rows and paycheck panels, plus payrun-wide evidence;
reuse employee images across repeated findings. Capture errors must remain visible
as warnings, and must not be reported as successful screenshots.

`communication/artifacts.py` stores a bundle under
`.local-data/incidents/<handoff-id>/` on the host. Compose bind-mounts this folder
at `/incident-artifacts`; `INCIDENT_ARTIFACT_ROOT` selects the backend storage root.
Each bundle contains `report.md`, `evidence.json`, `handoff.json`,
`source-snapshot.json`, `manifest.json`, and deduplicated JPEG/PNG files in
`snapshots/`. The manifest records screenshot hashes and capture status. Stored
Markdown uses relative image paths, and returned evidence uses file references
instead of repeated base64 images. Preserve these folders across rebuilds; they
contain payroll data and remain outside Git under the ignored `.local-data/` tree.
The UI shows the saved folder, snapshot count, report download and capture warnings.
Incident documents begin with a short issue title, expected system behavior and
the impacted service/domain/payrun version, followed by the investigation, evidence
and an explicit evidence-snapshots section. `runtime/incident_document.py` supplies
these required fields for both model-written and calculated reports. Expected
behavior is labeled as a review expectation; do not invent company policies or
claim that approval records were provided. Missing captures must be stated.

## Configuration and persistence rules

Agent deletion uses `services.delete_agent` through the `DeleteAgent` gRPC method.
Both the GraphQL `deleteAgent(id, domainName)` mutation and HTTP
`DELETE /agents/<domainName>/<agentId>` require `manageAgents`. Deletion validates
the UUID and domain, removes the saved agent, and preserves interaction metrics
and template records. The HTTP adapter returns 204 on success, 400 for invalid IDs,
403 for missing permission, and 404 for missing agents or domain mismatches.
The My Agents page confirms deletion and removes the row only after success.

Template JSON in `templates/`, models in `templates/Model_config/`, and external
API definitions in `templates/services.json` are authoritative for the catalog.
`template/catalog.py` loads them and `template/configuration.py` validates them.
`sync_templates` transactionally updates the database catalog, including removal
of catalog records no longer in the files.

Creating an agent recursively merges the submitted `config` object into the
chosen template's defaults. Updating merges into the agent's saved configuration.
Omitted properties are retained, arrays are replaced, and nested settings can be
changed individually. Supply `{}` to retain all existing defaults/settings.

Both writes require a nonempty name and validate model/service references,
service domains, capability settings, and HTTPS webhook URLs. The domain,
template, and agent configuration must have compatible domains. Updates require
both the agent ID and its domain name; they do not move agents between
domains or change the source template.

Saved agents retain their template version and effective configuration when
catalog files change or templates are removed. Catalog synchronization never
removes domains or agents. Model/service IDs remain references; later edits
are validated against the current catalog.

`DATABASE_PATH` selects the SQLite file (default:
`backend/template_catalog.sqlite3`). `TEMPLATE_CONFIG_DIR` overrides the catalog
directory. Credentials stay outside JSON; configuration stores environment
variable names only.

`AgentFactory` uses `TemplateInterface`/`CatalogTemplate` to merge and validate UI
configuration, then writes `agent_info`. `model_config` snapshots model name,
provider, model ID, parameters, and environment variable names; `config` retains
the user (`created_by`), primary service and attached services. Migration 0005
preserves existing agents and backfills available model snapshots.

`AgentChat` loads a saved agent in its domain and creates a fresh `ModelRuntime`
for each request. `CompatibleChatModel` supports a configured compatible model
server; `DemoModel` explicitly echoes messages without inference. Chat history
is restored by Python from Redis (direct gRPC callers supply it).
Model selection changes refresh
the snapshot; other edits retain it. The catalog model must still be enabled.

General execution of arbitrary catalog services as model tools is not implemented. Explicit incident handoffs and configured automatic alerts support email and Slack delivery. Payroll context retrieval and model provider
calls are implemented through the flows above. `runtime/execution.py` must load the
agent within the requested domain before executing it. For Anomaly Detection,
calculate evidence before deciding whether inference can run, and preserve that
evidence when the model is unavailable. Other templates acknowledge missing
model configuration.
`context.employeeId` scopes anomaly evidence and model inputs to one employee;
omit it to analyze all employees. Match history by employee ID, company, currency,
frequency and pay type. Exclude future, overlapping and incomplete runs. Missing
values and insufficient history must remain explicit. Preserve calculated values
and source payrun IDs during post-processing; never accept model-supplied amounts
or invented finding IDs. Model prose is labeled separately and is not verified
financial evidence. Do not mutate payroll from this pipeline.
Keep provider credentials server-side (`HF_TOKEN`, `GROQ_API_KEY`,
`GEMINI_API_KEY` or `OPENROUTER_API_KEY`); never persist them in agent records,
put them in `VITE_` variables, log them, or return raw provider errors. Creating a
token requires the user's provider account. The model dropdown must select a real
enabled provider model; setting a token must not silently change saved agents.
By default, public payrun questions use question confirmation and historical retrieval before the
answer model. Agent pipeline configuration can disable question matching or payroll preprocessing as described below. Calculations and comparison cards remain available when inference fails.
Legacy JavaScript fact-answer and response-cache shortcuts have been retired. Other
templates with alerts enabled use `agents/anomaly_detection/rules.py` and
`runtime/incidents.py`; PostgreSQL claims prevent duplicate incidents. Anomaly
Detection uses the explicit Review workflow below.
Every answer is recorded for the Agent Metrics view: `runtime/execution.py` builds the
record (how it was answered, response time, model tokens, reply check, the payrun's findings
and dollars at risk, incidents) and `agents/metrics.py` stores it in `agent_interaction` and
aggregates it; replies carry an `interactionId` for `rateAnswer` feedback. Records hold
measurements only (no credentials or pay lines; Redis session IDs are hashed), benchmark runs
are excluded from the metrics, and a failed metrics write never breaks a chat.

### Anomaly detection and explicit Review

The common agent uses registered components in `agents/anomaly_detection/components.py`.
`interface.py` defines generic entity identity and domain/investigation contracts;
`features/interface.py` and `tools/interface.py` define feature and evidence contracts.
`PayrollFeatureEnricher` calculates historical comparisons and policy inputs;
`PayrollAnomalyDetector` (`logic.py`) classifies those features without model calls
or delivery. For compatibility, direct detector callers can still pass payroll
context, which delegates enrichment to the payroll component. Its state is the loaded,
comparable payroll history, not a rolling wall-clock window. It returns a versioned
`payroll.anomaly` or `payroll.checked` result with evidence and warning/critical
findings; severity is rule-based, not an invented probability score.
The common agent normalizes the decision to `NORMAL` or `REVIEW`, with critical
severity retained separately. Legacy persisted `CRITICAL` cases remain readable.
`AnomalyDetectionAgent` (`agents/anomaly_detection/agent.py`) owns detection,
persisted cases, and investigation. Saved checks can invoke the configured decision
model, then persist an `AnomalyCase` without calling the investigation LLM.
Only a human's `POST /anomalies/review` with `action: "REVIEW"`
authorizes investigation of that case. The agent validates its domain, agent,
browser session, permission, and current payroll version, claims the review,
then invokes its selected model using the saved evidence. Completed reviews are
reused; failed or abandoned work requires another explicit Review to retry.
`investigation.py` validates citations and finding coverage before returning a
brief explanation. Review never changes payroll or sends incidents. Normal
checks still reach the UI but cannot invoke investigation. Unsaved previews use
the agent's `draft.py` and detector without persistence or model calls.

Payroll investigations use their configured primary model and a bounded Hugging
Face backup in `anomaly_detection/fallback.py`. The default backup is
`Qwen/Qwen3-235B-A22B-Instruct-2507`, using `HF_TOKEN` and Hugging Face's router.
`AD_HF_FALLBACK=false` disables it; `AD_HF_BACKUP_MODEL` changes the model.
Provider failures or invalid responses can switch to this backup within the
authorized Review. One correction attempt is allowed, with the same finding and
citation validation. Record actual attempts, active model/provider, fallback cause
and final failure category. Identify the failing provider in user-facing errors:
HTTP 402 means payment required for that request, not proof about another provider's
balance. OpenRouter Codex is no longer the investigation backup.

Component selection is saved as `config.anomaly`: `profile`, `featureStore`,
`enricher`, `detector`, `tools`, `investigator`, and `decisionModel`. Existing payroll agents resolve
the defaults shown in the root README. A specialized profile's category must match
the saved agent's domain category; the reusable `records` profile accepts any
registered category. JSON selects only registered names, never module paths,
endpoints or credentials. `config.model` and `model_parameters` remain independent.
To add a domain, register a `DomainProfile` using `register_profile` in trusted
startup code, then provide its matching domain/template/service catalog entries.
The profile supplies factories for a `DomainInterface`, enricher, detector,
investigator and evidence tools. Register another feature-store factory through
`register_feature_store`; its implementation supplies `get(namespace, key)` and
`put(namespace, key, features)`. Registration must finish before workers accept
requests, consistently in every process. These are code extension points, not
an API for uploading executable agents.

`features/store.py` implements an immutable MySQL snapshot cache and a no-cache
option. Cache keys include the source content, entity/version, scope, component
settings and enricher version; namespaces separate domains and agents. Cache reads
do not replace current-source validation. Increment the enricher version when
its calculation changes. Transient checks never access the persistent cache.
`0011_anomaly_components` adds the cache and audit tables plus entity type without
renaming existing columns. The old internal `payrun_id`/`payrun_version` columns
store generic entity identity/version for compatibility; public responses provide
`entityId`/`entityType`, with `payrunId` retained only for payroll cases. No TTL or
automatic retention pruning is configured for feature snapshots or audit records.

Changing components requires a new check before reviewing an existing case.
Domain evidence tools run only within the claimed human Review. The shipped
payroll tools use saved current/history snapshots; external Employee, Tax, Policy
RAG and Audit API connectors are extension points, not simulated integrations.
The current model runtime does not execute model-selected arbitrary tool calls.
Each new investigator owns its prompt, privacy handling and response validation.

`POST /anomalies/feedback` / `RecordAnomalyFeedback` requires the same permission,
session, domain and agent checks as Review. Supply `anomalyId`, `expectedVersion`,
UUID `requestId`, `action: "CONFIRMED" | "DISMISSED"` and optional `note` (2,000
characters maximum), plus `domainName` and `agentId`. Completed investigations can
receive feedback. Pending or failed cases can also be dismissed with a required
reason, without invoking investigation; investigating cases cannot be dismissed.
Confirmation still requires completed investigation. `presentation.py` derives
admin summaries from persisted findings, separating model availability from payroll
risk and preserving raw evidence. Exact request retries are idempotent and conflicting reuse is
rejected. Review claims/outcomes and human decisions append `AnomalyAudit` rows.
This records the browser-session hash, not an authenticated individual identity.
Feedback does not retrain models, change thresholds, invoke inference or update
source payroll. The Review UI displays the latest human decision.

The current event transport remains Redis Streams. Detection runs in the worker;
investigation runs only through the human Review request to the same agent.
`ingestion/events.py` accepts `{domainName, agentId, entityType, entityId, version}`.
Its `ingest` loads the matching domain source and calls the same agent; `deliver`
invokes a consumer-supplied acknowledgment only after successful handling.
Unacknowledged failures must be retried/dead-lettered by the hosting consumer;
replayed older events check the latest source and deduplicate persisted cases.
The caller is a trusted backend consumer and owns event authentication and tenant
routing. The payroll HTTP/Redis adapter processes historical payroll profiles and
normalizes current payruns for Payroll-category agents using `profile: records`.
The latter calls `runtime/payroll.load_current`, not historical retrieval. A running
Kafka broker/client is not installed; no millisecond latency guarantee is made.

The `records` profile is the reusable incremental implementation. Leaves, Benefits,
Insurance and Payroll can submit `anomaly.recorded` payloads through
`POST /events/anomaly` (the existing Struct-based `PublishPayrollEvent` RPC handles
both contracts). `records.py` validates stable IDs, timestamps, versions and 1–30
numeric measurements. `streaming.py` commits accepted payloads to `AnomalyEvent`
before returning 202; the SQL inbox remains durable when Redis is unavailable.
`run_anomaly_worker` supports separate workers, in addition to the embedded drain.
Use `retry_anomaly_event` to retry a quarantined event after resolving its cause.

`features/rolling.py` owns a bounded window of 128 observations and incremental
moments. `AnomalyFeatureState` contains compact numeric samples, not source records;
`AnomalyRecord` tracks the latest processed source version. Keys isolate domain,
tenant, entity type, metric, unit and dimensions. Baselines are captured before
updating finalized observations and exclude the same record, future values and
equal timestamps. Revisions replace old contributions; non-finalized values do
not train the baseline. Event preparation is transactional, source/feature rows
are locked, and retries reuse stored baselines. Out-of-order queries use eligible
retained samples only; absent earlier observations remain explicit limitations.
`0012_anomaly_streaming` adds these tables without changing prior schema history.

`scoring.RecordDetector` composes rules, statistical scoring and an optional
`DecisionModelInterface`. Rule/statistical scores are heuristics, not calibrated probabilities.
`decision.DecisionModelDetector` composes a registered decision adapter after a domain
detector. Payroll and records default to the official TypeSafe Jev adapter in `jev.py`;
`decisionModel: "none"` disables it. Other profiles default to none. Jev uses
`JEV_PROVIDER` to select direct TypeSafe or OpenRouter routing. Direct TypeSafe
uses `TYPESAFE_API_KEY`; OpenRouter uses `OPENROUTER_API_KEY` and
`OPENROUTER_BASE_URL`. `JEV_MODEL` and `JEV_TIMEOUT_SECONDS` configure the decision
call. The local deployment routes Jev through OpenRouter; this is independent
of the Hugging Face investigation primary/backup.
Only saved source checks invoke this decision model; draft previews and pipeline
reads remain free of inference. The separate investigation LLM still requires Review.
The adapter sends compact generated features, validates the provider's Choice response,
and records probability, confidence and model version separately from rule scores.
It never removes calculated findings. Failed decisions retain rule/statistical evidence
and expose safe error statuses. Successful results are reused for an identical feature
key, including the adapter/model version; bump the decision pipeline cache version
when its question or feature mapping changes. Policy APIs, automatic retraining and
source-system mutations are not supplied. `domains/records.py` reuses the shared
review/audit workflow with strict citation/finding validation. Do not put names or
free-form source text in measurement dimensions; producers supply stable IDs.
Review verifies the latest accepted source version, including pending revisions.
Generic case listing and SSE must include tenant, entity type and entity ID;
existing domain/role permissions still apply, and producer identity belongs to
deployment authentication rather than the tenant string in a payload.

The common runtime recognizes configured anomaly components independently of
template ID. A new domain needs matching catalog entries and a saved agent with
`config.anomaly.profile: records`; it does not need a payroll-shaped context.
Examples are under `backend/examples/anomaly/`, with adoption steps in the root
README. Specialized code can register alternate component factories at startup.
Set `DomainProfile.event_type="anomaly.recorded"` when a custom profile uses the
same measurement contract and should be consumed by the durable record worker.
`ingest_anomaly_payroll_history` backfills finalized employee and company measures
without inference or historical review cards. Preserve the historical payroll
profile for existing payrun UIs; generic domain UIs use the entity APIs.

The payrun UI requires the user's explicit Review action after Jev responds.
Neither page load nor detection events authorize LLM investigation. Failed attempts
require explicit retries. `case_data` exposes decisionModel metadata for display.
Scanning SSE events precede model detection. The UI offers the full saved report
as a plain-language text download and keeps the visible investigation conclusion concise.
The AD panel can be minimized without changing its findings or review state.
Opening an employee paycheck clears the payrun conclusion from view and shows
only that employee's same-version case; closing it restores the payrun view.

UI reads with `payrun(monitor: true, domainName)` emit `payrun.loaded`; adding
`checkLineId` emits `paycheck.opened` with the server-resolved employee identity.
These events require a domain and version and route only to that domain's enabled
monitors. Paycheck opens fetch fresh source data and check only that employee;
the UI keeps scoped results separate from full-payrun analysis. Internal agent
reads omit `monitor`, preventing recursive events. Workers refetch current data
and retry if it is older than the triggering version.

Real-time anomaly detection (`runtime/events.py`): the payroll platform reports each
saved change to `POST /events/payroll` (the TriNet mock's `events.js` sends
`{ type: "payrun.changed", payrunId, version, lineId, employeeId }`; `PAYROLL_EVENTS_TOKEN`, when
set, must match the `X-Payroll-Events-Token` header). Events are queued on the Redis stream
`payroll:events` (consumer group `realtime-monitor`; an in-process queue without `REDIS_URL`)
and a worker in the Python gRPC process checks the payrun for every domain whose Anomaly Detection
agent has alerts enabled. These checks use rules and the configured decision model and persist the decision and findings
in MySQL; persistence failures cause event processing to retry. Suspicious results
wait for human Review, including critical findings. Each check is pushed to open
payrun pages over `GET /events/stream?domain=&payrunId=` (server-sent events, proxied as
`/ai_studio/events/stream`) and recorded for Agent Metrics with source `realtime-monitor`
(counted as checks, not questions). Python publishes checks through Redis pub/sub. The Node SSE adapter forwards a server-streaming gRPC subscription. Unsaved edits use `POST /events/preview` after a 400 ms typing pause; Python overlays validated editable inputs on a copy, compares history, and never saves the draft or sends incidents. Stale versions are rejected. Derived gross/net/tax/retirement amounts wait for payroll recalculation on save.

Admin and customer views (`runtime/access.py`): the GraphQL `viewer` query returns the role,
feature flags, and the customer allow-lists. With `STUDIO_ADMIN_KEY` set, an admin signs in with
it (`POST /auth/admin`, proxied as `/ai_studio/auth/admin`; limited to 10 attempts a minute),
which sets an HttpOnly, SameSite cookie holding an HMAC of the key (8 hours; rotating the key
signs everyone out); everyone else is a customer. Without the key the Studio is open (everyone
is admin). Flags per role (`ADMIN_FEATURES`, default all; `USER_FEATURES`, default the customer
set; "all", "none", or a list): customers get `createAgents`, `testAgents`, `agentTools`,
`usage`; admins also `manageAgents`, `tools`, `models`, `evaluation`, `metrics`.
`CUSTOMER_MODELS` and `CUSTOMER_TOOLS` limit the models and tools a customer may give an agent.
Python gRPC handlers enforce all of it (`createAgent`/`updateAgent` need `createAgents` or
`manageAgents` and, for customers, allowed choices; Studio `chatAgent` needs `testAgents`;
`agentMetrics` returns full metrics with `metrics` and usage only with `usage`; FORBIDDEN
otherwise). The Studio shows admins Services, the tool catalog, Models, My Agents, Evaluation,
and Agent Metrics; customers Services, their agents' tools (with Attach tool), My Agents
(playground), and Usage. The payrun page's chat webhook, answer feedback, and live alerts are
not gated. This is a shared admin key, not per-user accounts.

Privacy (`runtime/privacy.py`): employee names never reach a model. Before any model call
(generic answers, the RAG pipeline, the anomaly pipeline) each employee's name is replaced with
their employee ID in the payroll context, question, conversation, and retrieved documents; names
are restored in the reply's prose (for JSON replies only in `answer`, `explanation`, and
`reviewAction`, so IDs used as keys stay exact). Pay figures are kept because the model needs
them. `PII_MASKING=false` turns it off. Answers computed from the data use no model at all.

Slack alerts: when the Incident Report agent has the `slack-webhook` tool attached and
`SLACK_WEBHOOK_URL` (a Slack incoming-webhook URL, https only; secret) is set, each incident is
also posted to Slack as a short summary; the incident's `slack` field reports sent, not-sent, or
failed, next to `email`.
Domain filtering and role
metadata do not provide authentication or authorization.

## Local server and container setup

All Docker and Podman assets live in `docker/`. `docker/Dockerfile` builds the `backend`,
`ui`, `trinet-mock`, `trinet-ui` and `evidence-capture` targets using the repository root as context.
`docker/Dockerfile.dockerignore` excludes local dependencies, credentials, and
database files. Do not add Dockerfiles or Docker ignore files inside UI folders.
The core services are `backend` (gRPC and GraphQL together), `ui`, `db`
(MySQL 8.4), `redis`, and `vector-db` (PostgreSQL 17 with pgvector). There is no separate Apollo container. The Compose files also define
three optional demo services: `trinet-mock`, `trinet-ui` and `evidence-capture`.

From the repository root, with Docker Desktop's Linux engine running:

```sh
docker compose -f docker/docker-compose.yaml up --build -d --wait db backend ui
docker compose -f docker/docker-compose.yaml ps
docker compose -f docker/docker-compose.yaml logs --tail=100 ui backend db redis vector-db
```

On Windows, `docker desktop start` starts Docker Desktop if its engine is stopped.
On macOS, use the [Podman run command](../README.md): install
`podman` and `podman-compose`, initialize a VM once with `podman machine init`,
and run `podman machine start`. From the repository root,
`bash docker/podman.sh up --build -d db backend ui` starts the core services;
omit the service list for all eight. Use `bash docker/podman.sh ps` to check
health and `bash docker/podman.sh logs --tail=100 backend` for diagnostics.
The launcher selects the native Compose provider, loads root `.env` then
`backend/.env` when present, and explicitly passes the shared build ignore file.
Retain those settings for Podman builds and recreation; never copy credentials
into images. Keep registry-qualified image names for noninteractive Podman pulls.
Docker and Podman have separate data volumes but use the same host ports, so stop
the running copy before switching engines. Do not remove Podman machines or
volumes during routine restarts. The Podman launcher targets the main local stack.

Host Python and Node are not required for the container workflow. The expected
result is five healthy core containers; backend dependencies automatically start
Redis and PostgreSQL even when the command lists only `db backend ui`. Agent Studio is at
`http://localhost:5173/ai_studio/` (`STUDIO_BASE_PATH` controls the mount), GraphQL
is at `http://localhost:4000/`, and gRPC is at `localhost:50051`. MySQL is reachable
as `db:3306` within Docker and has no published host port. The UI uses backend
mode and proxies requests under its mount path to the backend.

Use the explicit core service list when only UI, backend, and DB are requested.
Running `docker compose -f docker/docker-compose.yaml up --build -d --wait` without that list starts all eight
services, including the TriNet demo at `http://localhost:5174/trinet/` and its
payroll API at `http://localhost:4100/`, plus the internal screenshot service.
The demo is needed for payrun context.
`docker/docker-compose.local.yaml` selects the same configuration as the default file.

Rebuild with the same startup command after code changes. For mounted development
source, use `docker compose -f docker/docker-compose.yaml -f docker/docker-compose.dev.yaml up --build -d --wait db backend ui`;
restart `backend` after Python, GraphQL, or template changes. Rebuild images after
dependency changes. Use `docker compose -f docker/docker-compose.yaml stop ui backend db redis vector-db` to stop the core
services and `docker compose -f docker/docker-compose.yaml up -d --wait db backend ui` to resume them.
`docker compose -f docker/docker-compose.yaml down` removes the project containers and network, retaining named
volumes. Never delete database volumes as part of a routine rebuild or upgrade.

Run these commands from the repository root so Compose reads the root `.env`.
If credentials were supplied in `backend/.env`, retain
`--env-file backend/.env` on every subsequent `up`/recreation command. Compose
does not load it automatically. If root `.env` also exists with deployment
settings, pass `--env-file .env --env-file backend/.env` in that order. Check
only credential presence, never print token values or resolved Compose config.
Keep project names (`payroll-local` / `payroll-api-test`) and volume names stable
when editing the Compose files. Local/test variants extend the main file in the
same directory. Development bind mounts resolve relative to `docker/`.
`docker/publish-images.sh` runs Bake from `docker/` with context `..`; it publishes
images and must not be run as part of local verification. Inspect its build
configuration with `docker buildx bake -f docker-compose.yaml --print` from `docker/`.

`local_server/run_backend.py` migrates and syncs the database, supervises both
API processes, and stops the sibling if one exits. `local_server/grpc-client.js`
provides Apollo's gRPC connection; `graphql/client.js` provides metadata, JSON conversion, and resolver helpers.

`backend/local_server/` is tracked and copied into the image. Its settings use
MySQL when `MYSQL_HOST` is set, otherwise SQLite for standalone development/tests.
Credentials come from environment variables. Domain records and agents persist
in the `mysql_data` Docker volume (`agent_info` stores configured agents). The
optional TriNet mock uses a separate `trinet_data` volume. PostgreSQL uses
`vector_data`; embeddings use `embedding_cache`; Redis sessions have no volume. MySQL credentials on
existing volumes must match their initialized values. Existing SQLite data is not automatically
imported; never delete the old volume as part of an upgrade.

Keep container instructions consistent with the [root README](../README.md).
It is the only project README. Organize Docker and Podman instructions into
Starter, Load (including rebuilds after file changes), then Troubleshooting,
with short explanations for the commands.
Do not add READMEs in subdirectories.

## Main files and checks

| File | Responsibility |
| --- | --- |
| `storage/models.py`, `storage/migrations/` | Catalog, domain, and agent persistence |
| `template/services.py` | Catalog operations, configuration merge, and catalog synchronization |
| `agents/interface.py`, `agent_factory/interface.py`, `template/interface.py`, `model/interface.py`, `pipelines/interface.py`, `agents/anomaly_detection/interface.py` | Dependency-free contracts colocated with their component implementations |
| `agent_factory/factory.py`, `template/config.py` | Domain-aware template resolution, persisted creation and agent rehydration |
| `agents/agent.py`, `model/model.py`, `pipelines/config.py` | Runtime composition, model interface implementation and validated settings |
| `agents/chat.py`, `model/runtime.py` | Saved agent chat and provider abstraction |
| `template/catalog.py`, `template/configuration.py` | JSON loading and validation |
| `api/proto/templates.proto`, `api/servicers.py` | gRPC contract and implementation |
| `graphql/aistudio.js`, `graphql/client.js` | GraphQL contract and gRPC adapter |
| `runtime/sessions.py` | Expiring conversations, scope checks and request serialization |
| `runtime/` | Execution, events, sessions, payroll evidence, local embeddings and pgvector KNN |
| `agents/anomaly_detection/` | Historical detector logic, investigation agent and finding rules |
| `agents/communication/`, `agents/anomaly_detection/handoff.py` | Shared internal A2A discovery/delivery, saved-response validation, incident receiver and artifact storage |
| `agents/question/` | Configured/shared question matching, confirmation and the shared question library |
| `agents/response/` | Citation and finding validation, fallback and concise response formatting |
| `storage/management/commands/ingest_payroll_history.py` | Repeatable preload of completed payroll history into PostgreSQL |
| `runtime/incidents.py`, `evidence_capture/server.js` | Explicit incident handoff, scoped evidence, screenshots and optional email delivery |
| `pipelines/payroll.py`, `runtime/payroll.py`, `agents/response/logic.py` | Employee history comparisons, model explanations, and response validation |
| `tests/test_agents.py`, `tests/test_domain_grpc.py`, `tests/test_domain_migration.py` | Persistence, validation, and GraphQL-to-gRPC workflow tests |
| `tests/test_agent_communication.py`, `tests/test_investigation_fallback.py` | Handoff permissions, scope/version checks, duplicate prevention, report artifacts and investigation backup routing |

From the repository root, after installing `backend/requirements.lock` into a
Python 3.11+ environment:

```bash
python backend/manage.py check
python backend/manage.py validate_templates
python backend/manage.py migrate
python backend/manage.py sync_templates
python backend/manage.py rungrpc
```

When changing the gRPC schema, regenerate its Python bindings from `backend/`
using the installed development dependencies:

```sh
python -m grpc_tools.protoc -I. --python_out=. --grpc_python_out=. api/proto/templates.proto
```

The gRPC listener defaults to `127.0.0.1:50051`. Non-loopback listeners require
TLS unless explicitly started with `--insecure-for-testing`.

Run backend tests with `python backend/manage.py test tests` (SQLite by default).
Run `npm test` from `backend/` for the JavaScript transport contracts. Python runtime, retrieval, session, privacy, preview and postprocessing tests are in `tests/test_runtime.py`. Node manifests and dependencies belong at `backend/`, outside `graphql/`. The Python migration uses a new embedding version and session serialization prefix; existing chats should start a new session. Old vector records and volumes remain intact. With the Compose services running, exercise real Redis and
pgvector using:

```sh
docker compose -f docker/docker-compose.yaml run --rm --no-deps -e RUN_STORAGE_TESTS=1 backend python manage.py test tests.test_runtime_storage --noinput
```

Cover history isolation, missing data, zero baselines, duplicated lines,
provider failures and invalid model output without calling a paid provider.
Run `node --test tests/contract.test.js` from `ui-payroll-agent/` after installing
Node dependencies. The sections above describe container setup, MySQL and API flows.
GraphQL adapter and Python tests live in `backend/tests/`; fixtures live in `tests/fixtures/`, and the shared question library lives in `agents/question/payroll_questions.json`.

`getDomainAgentsTemplates(domainName)` returns reusable templates, not saved agents.
`getServiceAgentRegistry(serviceName, domainName)` filters saved agents by their
primary `config.service` and optionally domain. Either filter can be omitted.
`config.model` in create/update requests selects an enabled model configuration.
