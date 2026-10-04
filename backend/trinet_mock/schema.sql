-- Tables for the temporary mock TriNet payroll API (SQLite, separate from Agent Studio's
-- database). Money is stored in integer cents; hours as REAL. Applied by db.js on startup.

CREATE TABLE IF NOT EXISTS employees (
  employee_id          TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  department           TEXT NOT NULL,
  pay_type             TEXT NOT NULL CHECK (pay_type IN ('salary', 'hourly')),
  -- Employee withholding setup, as rates of taxable pay (0 = not set up).
  federal_withholding  REAL NOT NULL,
  state_withholding    REAL NOT NULL,
  retirement_rate      REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS payruns (
  id                          TEXT PRIMARY KEY,
  name                        TEXT NOT NULL,
  company                     TEXT NOT NULL,
  frequency                   TEXT NOT NULL,
  currency                    TEXT NOT NULL,
  period_start                TEXT NOT NULL,
  period_end                  TEXT NOT NULL,
  pay_date                    TEXT NOT NULL,
  status                      TEXT NOT NULL CHECK (status IN ('pending-approval', 'completed')),
  -- Increments on every saved edit; used to reject conflicting saves.
  version                     INTEGER NOT NULL DEFAULT 1,
  updated_at                  TEXT,
  -- Totals are recalculated from the pay lines on every edit.
  total_employees             INTEGER NOT NULL,
  total_gross_cents           INTEGER NOT NULL,
  total_taxes_cents           INTEGER NOT NULL,
  total_deductions_cents      INTEGER NOT NULL,
  total_employer_taxes_cents  INTEGER NOT NULL,
  total_net_cents             INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS payruns_by_pay_date ON payruns (pay_date DESC);

-- One row per pay line. An employee can have several lines in one run (for example a
-- duplicate payment), so lines have their own ID and a position within the run.
CREATE TABLE IF NOT EXISTS pay_lines (
  line_id                 TEXT PRIMARY KEY,
  payrun_id               TEXT NOT NULL REFERENCES payruns (id) ON DELETE CASCADE,
  position                INTEGER NOT NULL,
  employee_id             TEXT NOT NULL REFERENCES employees (employee_id),
  -- Employee details as of this run.
  name                    TEXT NOT NULL,
  department              TEXT NOT NULL,
  pay_type                TEXT NOT NULL CHECK (pay_type IN ('salary', 'hourly')),
  employment_status       TEXT NOT NULL CHECK (employment_status IN ('active', 'new-hire', 'terminated')),
  hire_date               TEXT,
  termination_date        TEXT,
  hourly_rate_cents       INTEGER,
  period_salary_cents     INTEGER,
  payment_method          TEXT NOT NULL CHECK (payment_method IN ('Direct Deposit', 'Live Check')),
  regular_hours           REAL NOT NULL,
  overtime_hours          REAL NOT NULL,
  regular_pay_cents       INTEGER NOT NULL,
  overtime_pay_cents      INTEGER NOT NULL,
  bonus_cents             INTEGER NOT NULL,
  reimbursement_cents     INTEGER NOT NULL,
  gross_cents             INTEGER NOT NULL,
  federal_tax_cents       INTEGER NOT NULL,
  state_tax_cents         INTEGER NOT NULL,
  social_security_cents   INTEGER NOT NULL,
  medicare_cents          INTEGER NOT NULL,
  health_cents            INTEGER NOT NULL,
  retirement_401k_cents   INTEGER NOT NULL,
  garnishment_cents       INTEGER NOT NULL,
  net_cents               INTEGER NOT NULL,
  UNIQUE (payrun_id, position)
);

CREATE INDEX IF NOT EXISTS pay_lines_by_employee ON pay_lines (employee_id);
