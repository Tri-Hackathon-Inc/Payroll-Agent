# UI Implementation Tracker

Tracks every screen and component described in the RFCs against what has been built. Sourced from the three RFC decks:
- `Agent_Studio_Payroll_Architecture_4_Agents.pptx`
- `Agent_Template_Studio_High_Quality_Editable.pptx`
- `Agent_Template_Studio_Page5_Replaced_RealTime_Anomaly.pptx`

---

## 1. Agent Studio — Shell & Navigation

The top-level shell for building and managing agents. Has a sidebar/tab nav with six sections.

| Item | Status |
|---|---|
| [x] Agent list view (`/agents`) | Done |
| [x] Create / Edit agent form (`/agents/new`, `/agents/:id`) | Done |
| [ ] **Templates** tab — browse reusable agent templates | Not started |
| [ ] **My Agents** tab — list of agents created by the user | Not started |
| [ ] **Tools & APIs** tab — browse / manage available tools | Not started |
| [ ] **Models** tab — browse approved models | Not started |
| [ ] **Agent Registry** tab — view all registered agents across services | Not started |
| [ ] **Evaluation** tab — review agent performance / run evals | Not started |

---

## 2. Create Agent Form — Field Completeness

The form exists but is missing several fields called out in the RFC.

| Field | Status |
|---|---|
| [x] Agent name | Done |
| [x] Domain (HR / Payroll / Time off) | Done |
| [x] Description | Done |
| [x] Instructions / prompt | Done |
| [x] Starting questions | Done |
| [ ] **Model type** — dropdown to select the approved LLM for this agent | Not started |
| [ ] **Agent type** — Summarizer / General Query / Anomaly Detection / Incident Generator | Not started |
| [ ] **Page to attach** — which payrun page this agent lives on | Not started |
| [ ] **Tools attached** — multi-select from approved payroll tools and APIs | Not started |
| [ ] **Roles access** — which roles can use this agent | Not started |
| [ ] **Services visibility** — which services can discover this agent | Not started |

---

## 3. Template Marketplace

A catalog of reusable agent templates. Users pick a template before configuring for their domain, rather than building from scratch. This is the starting point for creating any new agent.

| Item | Status |
|---|---|
| [ ] Template catalog page — grid of template cards | Not started |
| [ ] Template card — shows name, runtime badge (REAL-TIME / OFFLINE / INTERACTIVE / EVENT-DRIVEN), capability bullets, and "Use Template" CTA | Not started |
| [ ] Search / filter templates | Not started |
| [ ] **Anomaly Detection** template card | Not started |
| [ ] **Summarizer** template card | Not started |
| [ ] **General Query** template card | Not started |
| [ ] **Incident Generator** template card | Not started |
| [ ] Selecting a template pre-fills the agent config form (runtime type locked, relevant tools pre-suggested) | Not started |

---

## 4. Payrun Service — Agent Window

The Payrun page needs an embedded Agent Window. The service dynamically discovers which agents are available to it (via `GET /payrun/list-agents`) and lets the user open one.

| Item | Status |
|---|---|
| [ ] Available agents panel on the Payrun page — lists agents with type badge and "Open" button | Not started |
| [ ] Agent Window component — opens inline or as a side panel when an agent is selected | Not started |
| [ ] Agent Window header — shows selected agent name and type | Not started |
| [ ] Agent Window input — prompt / message input with send action | Not started |
| [ ] Agent Window response area — renders agent output | Not started |
| [ ] Switch between agents without leaving the page | Not started |

---

## 5. General Query Agent UI

An interactive chat interface in the Agent Window for asking contextual questions about a payrun.

| Item | Status |
|---|---|
| [ ] Message thread — user messages and agent responses in a conversation layout | Not started |
| [ ] Payrun context passed with each prompt (current payrun ID, pay period, etc.) | Not started |
| [ ] Streaming or polling for responses | Not started |
| [ ] Empty state with suggested questions | Not started |

---

## 6. Summarizer Agent UI

Shows a structured payrun summary with totals, a change log, and an action panel for updating employee data directly.

| Item | Status |
|---|---|
| [ ] Summary card — Total Employees, Total Gross Pay, Total Net Pay, New Hires, Terminations, Changes this payrun | Not started |
| [ ] Changes list — grouped by type (pay rate / location / department / new hire / termination) with "View All" link | Not started |
| [ ] **Take Action panel** — "Update Employee" form: employee picker, change type, new value, effective date, submit via PEO API | Not started |
| [ ] "Ask a Question" entry point into General Query from within the Summarizer view | Not started |
| [ ] Real-time paycheck refresh after a data update flows through Kafka → DCP → UI | Not started |

---

## 7. Anomaly Detection Agent UI

A live alert panel that surfaces anomalies as payrun data is entered. Requires a persistent connection to the backend.

| Item | Status |
|---|---|
| [ ] Anomaly alert badge/count on the Payrun page tab | Not started |
| [ ] Real-time alert panel — anomaly cards appear as the agent detects issues | Not started |
| [ ] Anomaly card — Employee, Earning Type, Amount, Historical Avg, Deviation %, Severity (High / Med / Low) | Not started |
| [ ] Actions on each anomaly: **View Details**, **Explain**, **Create Incident** | Not started |
| [ ] WebSocket or SSE connection management (open on page load, close on leave, reconnect on drop) | Not started |
| [ ] Dismiss / acknowledge an anomaly | Not started |

---

## 8. Incident Generator Agent UI

Triggered when a user reports an issue or when an anomaly is escalated. The agent reproduces the scenario, collects evidence, and creates a routed incident.

| Item | Status |
|---|---|
| [ ] "Create Incident" entry point from anomaly card and from general chat | Not started |
| [ ] Reproduction step-progress view — animated checklist of steps the agent is running (Login → Change → Run → Verify) | Not started |
| [ ] Evidence panel — screenshot thumbnail + log excerpt with expected vs actual values | Not started |
| [ ] Incident preview card — severity badge, summary, steps, evidence | Not started |
| [ ] Confirm & route action — sends incident to responsible engineering team | Not started |

---

## 9. Agent Discovery — Payrun Integration

How the Payrun service knows which agents exist for it. Must be config-driven, not hard-coded.

| Item | Status |
|---|---|
| [ ] Payrun page calls `GET /payrun/list-agents` on load and renders the available agents dynamically | Not started |
| [ ] `GET /payrun/get-agent/{id}` used to load metadata before opening Agent Window | Not started |
| [ ] `POST /payrun/{agent-id}/prompts` used to send user input to the selected agent | Not started |
| [ ] No agent hard-coded in the UI — all agents are discovered at runtime | Not started |

---

## Summary

| Area | Done | Total |
|---|---|---|
| Agent Studio Shell & Nav | 2 | 8 |
| Create Agent Form Fields | 5 | 11 |
| Template Marketplace | 0 | 8 |
| Payrun Agent Window | 0 | 6 |
| General Query UI | 0 | 4 |
| Summarizer UI | 0 | 5 |
| Anomaly Detection UI | 0 | 6 |
| Incident Generator UI | 0 | 5 |
| Agent Discovery / Payrun Integration | 0 | 4 |
| **Total** | **7** | **57** |
