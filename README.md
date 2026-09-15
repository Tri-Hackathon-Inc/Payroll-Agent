# Payroll Agent Studio

A tool for creating, configuring, and attaching AI agents to payroll workflows. Built with Django (backend) and React/Vite (frontend), containerised with Docker.

## Run with Docker

```bash
docker compose up --build
```

- UI: http://localhost:5173/agents
- API: http://localhost:8000/api/agents/

Stop the application with:

```bash
docker compose down
```

## Development

The frontend is built with React and Vite. The backend uses Django REST Framework and SQLite.

---

## What's been built

- Agent CRUD — create, list, and edit agents via a form UI backed by a Django REST API
- Client-side routing (no router library) with loading states and error handling
- Docker Compose setup for local development

---

## What's next

### Backend

**Add `model_used` and `agent_type` to the Agent model** — `difficulty: 1/5`
The current `AgentBuilder` model stores name, domain, description, and instructions, but is missing two key fields from the RFC: which LLM model the agent uses and what type of agent it is (Summarizer, General Query, Anomaly Detection). This is a straightforward model + migration change followed by wiring the new fields into the existing create/update view.

**`GET /api/agents/by-service/:service` endpoint** — `difficulty: 1/5`
The RFC requires a way to look up which agent is attached to a given service (e.g. the Payrun service). Needs a service-to-agent mapping table and a simple read endpoint.

**Agent-to-service attachment** — `difficulty: 2/5`
A mechanism to bind a specific agent to a payrun service so the payrun page knows which agent to load. Requires a join table (agent ↔ service), a write endpoint, and some sense of what "services" exist.

**Tools attachment** — `difficulty: 3/5`
Agents should have tools attached to them (e.g. a payroll data fetcher, a historical data lookup). Needs a `Tool` model, a many-to-many relationship to `AgentBuilder`, and API endpoints for managing the attachment. The tool execution layer comes later.

**Summarizer Agent — backend logic** — `difficulty: 3/5`
An endpoint that, given an employee and a payrun, fetches the relevant payrun data and produces a structured summary. Requires integrating an LLM call and mapping payrun data fields into a prompt.

**General Query Agent — backend logic** — `difficulty: 3/5`
A conversational endpoint that accepts a user message and payrun context and returns an LLM-generated answer. Needs session/context management so follow-up questions work correctly.

**Anomaly Detection Agent — backend logic** — `difficulty: 4/5`
The most complex agent type. Requires a long-running connection (WebSocket or SSE), access to historical payrun data, and a comparison layer that flags anomalies in real time. Needs robust error handling and a well-defined alerting schema.

**Agent Factory / model provider integration** — `difficulty: 4/5`
The RFC calls for a pluggable agent factory so that different model configs can be swapped in per agent. Requires abstracting the current LLM call behind a factory pattern and supporting model config storage per agent.

---

### Frontend

**Add model picker and agent type selector to the Create/Edit form** — `difficulty: 1/5`
The form currently has name, domain, description, instructions, and questions. It needs two more fields: a model type dropdown and an agent type selector (Summarizer / General Query / Anomaly Detection). Straightforward UI addition once the backend fields exist.

**Tools attachment UI** — `difficulty: 2/5`
A multi-select or tag-style picker in the Create/Edit form for attaching tools to an agent. Needs to fetch available tools from the backend and POST the selection on save.

**Payrun landing page — Agent Window** — `difficulty: 2/5`
The Payrun list/landing page needs an Agent Window component that appears when an agent is attached to that service. Should show which agent is active and provide an entry point to interact with it.

**Summarizer page** — `difficulty: 2/5`
A dedicated view that calls the Summarizer Agent endpoint for a given employee + payrun and renders the structured summary. Mostly a data-fetch-and-display problem once the backend endpoint exists.

**General Query chat UI** — `difficulty: 3/5`
A chat interface wired to the General Query Agent endpoint. Needs a message thread, input box, streaming or polling for responses, and enough context passing (current payrun, employee) to make answers relevant.

**Anomaly Detection real-time UI** — `difficulty: 4/5`
A live alert/flag panel on the Payrun page that opens a WebSocket or SSE connection to the Anomaly Detection Agent and displays flagged anomalies as they arrive. Needs a good UX for dismissing, acknowledging, or drilling into an alert.

**Optional: re-route from Payrun page to Agent Studio** — `difficulty: 1/5`
The RFC mentions optionally routing users from the Payrun page directly to the Agent Studio to create a new agent. A simple navigation link or redirect.

---

### Infrastructure / DevX

**Environment config** — `difficulty: 1/5`
Secrets and service URLs (DB connection, API keys, model endpoints) are likely hardcoded or absent. Move these into `.env` files with Docker Compose `env_file` support and document the required vars.

**Database migrations in Docker** — `difficulty: 1/5`
Ensure `manage.py migrate` runs automatically on container startup so new contributors don't hit a blank DB.

**Tests for existing API** — `difficulty: 2/5`
`agent_builder/tests.py` exists but coverage is minimal. Add tests for the create/update upsert logic, validation error cases, and the by-service lookup once it's built.
