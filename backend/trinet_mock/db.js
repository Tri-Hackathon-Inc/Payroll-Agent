// SQLite storage for the mock TriNet payroll API, using Node's built-in node:sqlite. Creates
// the tables in schema.sql and seeds them from seed/payruns.json when the database is empty.
// Rows store money in cents; the objects returned here use dollars, like the GraphQL schema.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const SEED_PATH = path.join(__dirname, 'seed', 'payruns.json');

const toCents = dollars => (dollars === null || dollars === undefined ? null : Math.round(dollars * 100));
const toDollars = cents => (cents === null ? null : cents / 100);

const PAYRUN_TOTALS = [
  ['employees', 'total_employees', false],
  ['gross', 'total_gross_cents', true],
  ['taxes', 'total_taxes_cents', true],
  ['deductions', 'total_deductions_cents', true],
  ['employerTaxes', 'total_employer_taxes_cents', true],
  ['net', 'total_net_cents', true],
];

// [object path, column, stored in cents]. The order is the column order for inserts.
const LINE_FIELDS = [
  ['lineId', 'line_id'], ['employeeId', 'employee_id'], ['name', 'name'], ['department', 'department'],
  ['payType', 'pay_type'], ['employmentStatus', 'employment_status'], ['hireDate', 'hire_date'],
  ['terminationDate', 'termination_date'], ['hourlyRate', 'hourly_rate_cents', true],
  ['periodSalary', 'period_salary_cents', true], ['paymentMethod', 'payment_method'],
  ['hours.regular', 'regular_hours'], ['hours.overtime', 'overtime_hours'],
  ['earnings.regular', 'regular_pay_cents', true], ['earnings.overtime', 'overtime_pay_cents', true],
  ['earnings.bonus', 'bonus_cents', true], ['earnings.reimbursement', 'reimbursement_cents', true],
  ['gross', 'gross_cents', true],
  ['taxes.federal', 'federal_tax_cents', true], ['taxes.state', 'state_tax_cents', true],
  ['taxes.socialSecurity', 'social_security_cents', true], ['taxes.medicare', 'medicare_cents', true],
  ['deductions.health', 'health_cents', true], ['deductions.retirement401k', 'retirement_401k_cents', true],
  ['deductions.garnishment', 'garnishment_cents', true], ['net', 'net_cents', true],
];

const read = (object, key) => key.split('.').reduce((value, part) => value?.[part], object);

function toLine(row) {
  const line = { hours: {}, earnings: {}, taxes: {}, deductions: {} };
  for (const [key, column, cents] of LINE_FIELDS) {
    const value = cents ? toDollars(row[column]) : row[column];
    const [group, field] = key.split('.');
    if (field) line[group][field] = value;
    else line[key] = value;
  }
  return line;
}

const lineValues = line => LINE_FIELDS.map(([key, , cents]) => (cents ? toCents(read(line, key)) : read(line, key) ?? null));

function toPayrun(row) {
  return {
    id: row.id, name: row.name, company: row.company, frequency: row.frequency, currency: row.currency,
    periodStart: row.period_start, periodEnd: row.period_end, payDate: row.pay_date, status: row.status,
    version: row.version, updatedAt: row.updated_at,
    totals: Object.fromEntries(PAYRUN_TOTALS.map(([key, column, cents]) => [key, cents ? toDollars(row[column]) : row[column]])),
  };
}

const totalValues = totals => PAYRUN_TOTALS.map(([key, , cents]) => (cents ? toCents(totals[key]) : totals[key]));

function toEmployee(row) {
  return {
    employeeId: row.employee_id, name: row.name, department: row.department, payType: row.pay_type,
    withholding: { federal: row.federal_withholding, state: row.state_withholding },
    retirementRate: row.retirement_rate,
  };
}

function openDatabase(databasePath = ':memory:') {
  if (databasePath !== ':memory:') fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);

  const lineColumns = LINE_FIELDS.map(([, column]) => column);
  const insertEmployee = db.prepare(`INSERT INTO employees (employee_id, name, department, pay_type,
    federal_withholding, state_withholding, retirement_rate) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const insertPayrun = db.prepare(`INSERT INTO payruns (id, name, company, frequency, currency, period_start,
    period_end, pay_date, status, version, updated_at, ${PAYRUN_TOTALS.map(([, column]) => column).join(', ')})
    VALUES (${Array(11 + PAYRUN_TOTALS.length).fill('?').join(', ')})`);
  const insertLine = db.prepare(`INSERT INTO pay_lines (payrun_id, position, ${lineColumns.join(', ')})
    VALUES (${Array(2 + lineColumns.length).fill('?').join(', ')})`);
  const updateLine = db.prepare(`UPDATE pay_lines SET ${lineColumns.slice(1).map(column => `${column} = ?`).join(', ')}
    WHERE line_id = ?`);
  const bumpPayrun = db.prepare(`UPDATE payruns SET version = version + 1, updated_at = ?,
    ${PAYRUN_TOTALS.map(([, column]) => `${column} = ?`).join(', ')} WHERE id = ? AND version = ?`);

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function seed() {
    const { payruns, employees } = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
    for (const item of employees) {
      insertEmployee.run(item.employeeId, item.name, item.department, item.payType,
        item.withholding.federal, item.withholding.state, item.retirementRate);
    }
    for (const run of payruns) {
      insertPayrun.run(run.id, run.name, run.company, run.frequency, run.currency, run.periodStart, run.periodEnd,
        run.payDate, run.status, run.version, run.updatedAt ?? null, ...totalValues(run.totals));
      run.lines.forEach((line, position) => insertLine.run(run.id, position, ...lineValues(line)));
    }
  }

  if (!db.prepare('SELECT COUNT(*) AS count FROM payruns').get().count) transaction(seed);

  return {
    listPayruns(status) {
      const rows = status
        ? db.prepare('SELECT * FROM payruns WHERE status = ? ORDER BY pay_date DESC').all(status)
        : db.prepare('SELECT * FROM payruns ORDER BY pay_date DESC').all();
      return rows.map(toPayrun);
    },
    getPayrun(id) {
      const row = db.prepare('SELECT * FROM payruns WHERE id = ?').get(id);
      return row ? toPayrun(row) : null;
    },
    // Completed runs, newest first, paid before `beforeDate` when given.
    listCompletedPayruns({ limit, beforeDate }) {
      return db.prepare(`SELECT * FROM payruns WHERE status = 'completed' AND (? IS NULL OR pay_date < ?)
        ORDER BY pay_date DESC LIMIT ?`).all(beforeDate ?? null, beforeDate ?? null, limit ?? -1).map(toPayrun);
    },
    getLines(payrunId) {
      return db.prepare('SELECT * FROM pay_lines WHERE payrun_id = ? ORDER BY position').all(payrunId).map(toLine);
    },
    getEmployee(employeeId) {
      const row = db.prepare('SELECT * FROM employees WHERE employee_id = ?').get(employeeId);
      return row ? toEmployee(row) : null;
    },
    getEmployeeLines(employeeId) {
      return db.prepare(`SELECT pay_lines.*, payruns.pay_date AS run_pay_date, payruns.status AS run_status
        FROM pay_lines JOIN payruns ON payruns.id = pay_lines.payrun_id
        WHERE pay_lines.employee_id = ? ORDER BY payruns.pay_date DESC, pay_lines.position`).all(employeeId)
        .map(row => ({ payrunId: row.payrun_id, payDate: row.run_pay_date, status: row.run_status, line: toLine(row) }));
    },
    // Saves one recalculated line and the run's totals, only if the run is still at
    // `expectedVersion`. Returns false when someone else saved first.
    saveLine({ payrunId, expectedVersion, line, totals }) {
      return transaction(() => {
        const bumped = bumpPayrun.run(new Date().toISOString(), ...totalValues(totals), payrunId, expectedVersion);
        if (!bumped.changes) return false;
        updateLine.run(...lineValues(line).slice(1), line.lineId);
        return true;
      });
    },
    reset() {
      transaction(() => {
        db.exec('DELETE FROM pay_lines; DELETE FROM payruns; DELETE FROM employees;');
        seed();
      });
    },
    close: () => db.close(),
  };
}

module.exports = { openDatabase };
