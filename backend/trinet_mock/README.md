# Mock TriNet payroll API (temporary)

This is a stand-in for the TriNet payroll API, to use until the agent is embedded in
the real TriNet UI. It's an Apollo GraphQL service, the same stack as the Agent
Studio API, but it's separate from Agent Studio and from its Django/gRPC backend.
It serves the sample payruns for the mock TriNet UI
([ui-trinet-mock](../../ui-trinet-mock/README.md)), and you can edit pay lines on
draft payruns.

```bash
cd backend/trinet_mock
npm ci
npm start                                             # GraphQL and Sandbox at http://127.0.0.1:4100/ (in-memory database)
DATABASE_PATH=/tmp/trinet_mock.sqlite3 npm start      # keep data in a SQLite file
npm test
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `4100` | Listen address |
| `DATABASE_PATH` | unset (in memory) | SQLite database file. It's created and seeded from `seed/payruns.json` on first start, and reused after that. |

It needs Node 22.13 or later, for the built-in `node:sqlite` module, so no database
library is installed. Both Compose stacks run it as `trinet-mock`, with the database
at `/data/trinet_mock.sqlite3` in the `trinet_data` volume.

Docker configuration is centralized in [docker/](../../docker/README.md). From the
repository root, start the full demo with
`docker compose -f docker/docker-compose.yaml up --build -d --wait`.

## Tables

The mock has its own SQLite database, separate from Agent Studio's
`template_catalog.sqlite3`. The tables are defined in [schema.sql](schema.sql) and
created on startup:

| Table | One row per | Notes |
| --- | --- | --- |
| `employees` | Employee | Pay type, withholding setup (federal and state rates), and 401(k) rate |
| `payruns` | Payrun | Period, pay date, status, `version`, and the run's totals |
| `pay_lines` | Pay line in a run | Hours, earnings, taxes, deductions, net pay, and payment method. It references `payruns` and `employees`. |

- Money is stored as integer cents (columns ending in `_cents`), and hours as REAL.
  The API returns dollars.
- An employee can have more than one line in a run, as with the planted duplicate
  payment, so each line has its own `line_id` and a `position` within the run.
- A save updates the line and the run's totals in one transaction. It only goes
  through if the run's `version` is unchanged, so two people saving at the same time
  can't both succeed.
- `resetPayrollData` clears the tables and reloads the seed.
- There are no migrations yet. The schema uses `CREATE TABLE IF NOT EXISTS`, so
  after changing a table, delete the database file (or the `trinet_data` volume) to
  recreate it.

## Schema

The full schema is in [schema.graphql](schema.graphql).

| Operation | Returns |
| --- | --- |
| `payruns(status: PayrunStatus)` | Runs, newest first. `status` is `PENDING_APPROVAL` or `COMPLETED`. |
| `payrun(id)` | One run with its pay lines |
| `payrunHistory(limit, before)` | Completed runs, newest first, optionally only those older than `before` |
| `employeePayHistory(employeeId)` | The employee and their pay lines across runs |
| `updatePayLine(input)` | Edits one pay line on a draft run and returns the updated run |
| `resetPayrollData` | Restores the seed data |

Errors use the same `extensions.code` values as Agent Studio's API (`NOT_FOUND`,
`BAD_USER_INPUT`), plus `CONFLICT`.

## Editing pay lines

```graphql
mutation {
  updatePayLine(input: {
    payrunId: "PR-2026-09-B", lineId: "PR-2026-09-B-L04", expectedVersion: 1,
    earnings: { bonus: 2500 }
  }) { version totals { gross net } lines { lineId gross net } }
}
```

- Only the fields you pass change. You can edit `hours { regular overtime }`,
  `earnings { bonus reimbursement }`, `deductions { health garnishment }`, and
  `paymentMethod` (`Direct Deposit` or `Live Check`).
- Only draft (`PENDING_APPROVAL`) runs can be edited. Editing a completed run
  returns `CONFLICT`.
- Hours are 0–200 and amounts are 0–1,000,000. Salaried (exempt) lines can't have
  overtime. Either mistake returns `BAD_USER_INPUT`.
- `expectedVersion` is optional. If it doesn't match the run's current `version`,
  the edit is rejected with `CONFLICT` and `extensions.currentVersion`, so a UI can
  avoid overwriting someone else's edit.

Each edit recalculates the line and then the run:

- **Earnings:** hours × rate for hourly lines (overtime at 1.5×), or the period
  salary for salaried lines.
- **Taxes:** from the employee's withholding setup (the `employees` table), plus FICA
  at 6.2% and 1.45%.
- **401(k):** from the employee's `retirement_rate`.
- **Net pay** and the run's totals, including employer taxes, which match the
  employee's FICA.

Each edit also increments the run's `version`. Health and garnishment are entered
values and are kept as they are. Recalculating the seed reproduces it exactly.

## Sample data

[seed/payruns.json](seed/payruns.json) is loaded into the tables when the database is
empty. It has three completed semi-monthly runs (Aug–Sep
2026) for a fictional company, plus the draft **PR-2026-09-B**. The draft contains
planted anomalies for testing detection and summaries, and Agent Studio's evaluation
suites check for them:

- Luis Ortega (E1002): 46 overtime hours, against 2–6 in history.
- Daniel Brooks (E1004): $25,000 bonus, against $620–$850 in history.
- Aisha Karim (E1005): paid twice (duplicate line).
- Tom Becker (E1006): full salary after termination on 2026-09-12.
- Grace Liu (E1007): health deduction dropped to $0.
- Sam Patel (E1008): $1,850 reimbursement, against $0–$35 in history.
- Jordan Reyes (E1009): new hire with no federal or state withholding. His employee
  record has no withholding set up, so edits don't add taxes, and the anomaly stays
  in place.

Every line has a stable `lineId` (for example `PR-2026-09-B-L05`), because one
employee is deliberately paid twice.

## Agent tools

The payroll tools in `backend/templates/services.json` (`payrun`, `payrun-history`,
`employee-details`) are still defined as REST paths. Agent execution isn't active
yet. When it is, those tool definitions need to map to this schema's queries
(`payrun`, `payrunHistory`, `employeePayHistory`).
