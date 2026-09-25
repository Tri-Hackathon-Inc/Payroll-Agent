# Mock TriNet payroll UI (temporary)

This is a stand-in for the real TriNet payroll screens, to use until the payroll
agent is embedded in TriNet. It's styled after `rfcs/payroll-ui-reference`. It's
separate from Agent Studio (`ui-payroll-agent`) on purpose: it uses Agent Studio
only through Agent Studio's public API, the same way the real TriNet UI will.

- **Payrolls:** the payroll list, with a status filter.
- **Payrun detail:** totals, the employee pay table with search, and an **Edit
  Employee Pay** drawer for editing and saving an employee's pay.
- **Payroll Assistant:** lists the selected domain's Agent Studio agents whose page
  attachment is `payrun`, and sends questions to them with the open payrun as
  context. On a payrun, the **Payroll Assistant** button at the right of the header
  opens it as a docked panel on the right (the page makes room, as in Microsoft Copilot
  or Salesforce Einstein). The button, the close button, or Esc closes it. The
  conversation is kept while the panel is closed and resets when another payrun opens.
  Four suggested questions sit above the input: the agent's starting questions first,
  then common payrun questions; asked ones drop out so new ones rotate in.
  **All questions** opens a searchable library of 64 questions in 11 categories
  (`src/questionLibrary.js`, kept equal to Agent Studio's question bank by the contract test).
  It closes on a click outside it, its close button, or Esc (Esc closes only the list).
- **Agent-to-agent handoff:** when the domain has an agent made from the **Incident Report**
  template, each answer offers **Create incident report**. The conversation is handed to that
  agent, which returns an incident card (severity, evidence, amount at risk, email status) with
  View and Download report. Each finding shows the headless-browser screenshots taken as
  evidence; click one to view it full size (a click outside it or Esc closes it). Incident agents are not listed in the chat agent picker.

URL: `/trinet/?domain=<agent-studio-domain>[&payrun=<id>]`. Agent Studio's
**TriNet Payruns** sidebar link opens this app.

## Backends

| Browser path | Proxied to | Used for |
| --- | --- | --- |
| `/trinet/graphql` | `TRINET_API_TARGET` (default `http://127.0.0.1:4100`) | Payroll data from the [mock TriNet payroll API](../backend/trinet_mock/README.md) |
| `/trinet/agent-studio/graphql` | `AGENT_STUDIO_TARGET` + `graphql` | `listDomains`, `getServiceAgentRegistry` |
| `/trinet/agent-studio/webhook/<domain>/<agentId>` | `AGENT_STUDIO_TARGET` + `webhook/...` | Asking an agent |

`AGENT_STUDIO_TARGET` defaults to Agent Studio's dev server
(`http://127.0.0.1:5173/ai_studio/`). That server serves the same API in both of its
modes: the backend's GraphQL server (`GRAPHQL_MODE=backend`) or its in-memory mock (`GRAPHQL_MODE=mock`).

The webhook body the Payroll Assistant sends:

```json
{ "source": "trinet-payrun-mock", "question": "Which payments need review?",
  "domain": { "name": "payroll-services", "label": "Payroll Services" },
  "agent": { "id": "<agent id>", "name": "Payrun Anomaly Check" },
  "context": { "page": "payrun", "payrunId": "PR-2026-09-B", "employeeId": null },
  "requestId": "<unique-request-id>" }
```

The backend restores recent conversation turns from Redis, interprets query intent,
and retrieves historical payroll documents from PostgreSQL/pgvector using filtered
KNN. A separate answer model explains retrieved sources and calculated comparisons.
Missing model credentials return calculated evidence with an explicit status.

Replies include `session.id`, sent back as `sessionId` on follow-ups. The UI retains
it in sessionStorage per domain, agent, payrun and employee selection. Sessions
expire after 30 minutes of inactivity by default. **New chat** starts a fresh
session. Expand **Historical sources** under a reply to see its retrieved records.
PostgreSQL retains documents and embeddings across restarts; Redis conversations
are temporary. See [the application flows](../backend/AGENTS.md#overall-application-flow).

## Run locally

Start the mock payroll API and Agent Studio first. Then run this app:

```bash
(cd backend/trinet_mock && npm ci && npm start)   # payroll API on :4100
(cd ui-payroll-agent && npm run dev)              # Agent Studio on :5173
cd ui-trinet-mock && npm ci && npm run dev        # http://localhost:5174/trinet/
```

Docker configuration is centralized in [docker/](../docker/README.md); this UI
folder contains no Docker files. From the repository root, run
`docker compose -f docker/docker-compose.yaml up --build -d --wait` to start the
full demo, including `trinet-mock`, `ui`, and `trinet-ui`.

## Checks

```bash
npm run lint
npm run build
npm test
```

`npm test` validates each GraphQL operation against the backend that serves it:
`backend/trinet_mock/schema.graphql` for payroll data and `backend/graphql/schema.js`
for Agent Studio. Like Agent Studio's contract test, it needs `npm ci` in
`backend/graphql/`.

## Edit and save

Click an employee's name to open **Edit Employee Pay**. On a **Draft** payroll you can
edit these fields:

- regular and overtime hours (hourly employees only)
- bonus and reimbursement
- health insurance and garnishment deductions
- payment method

**Save** sends only the fields you changed to the payroll API's `updatePayLine`
mutation (see [Editing pay lines](../backend/trinet_mock/README.md#editing-pay-lines)):

- The API recalculates regular and overtime pay, taxes, 401(k), net pay, and the
  run's totals. The page then shows the returned payrun and a confirmation with the
  new net pay.
- Save stays disabled until something changes. Invalid values, such as negative
  amounts or more than 200 hours, show a message next to the field and keep Save
  disabled.
- Each save sends the payroll's `version` as `expectedVersion`. If someone else saved
  the payroll after you opened the drawer, the save is rejected. **Reload payroll**
  fetches the latest data so you can try again.
- **Completed** payrolls are read-only, and the drawer shows a lock notice.

Edits are stored in the payroll API's SQLite database. To restore the sample data,
run `mutation { resetPayrollData }` against the API.
