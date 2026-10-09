// Pay recalculation and pay-line edits for the mock TriNet payroll API. The recalculation is
// pure; updatePayLine reads and saves through the database store (db.js).
const { GraphQLError } = require('graphql');

const FICA = { socialSecurity: 0.062, medicare: 0.0145 };
const OVERTIME_MULTIPLIER = 1.5;
const MAX_HOURS = 200;
const MAX_AMOUNT = 1_000_000;
const PAYMENT_METHODS = ['Direct Deposit', 'Live Check'];
const EDITABLE = {
  hours: ['regular', 'overtime'],
  earnings: ['bonus', 'reimbursement'],
  deductions: ['health', 'garnishment'],
};

const round = value => Math.round(value * 100) / 100;
const total = values => round(Object.values(values).reduce((sum, value) => sum + value, 0));
const fail = (message, code, extensions = {}) => { throw new GraphQLError(message, { extensions: { code, ...extensions } }); };

// Recalculate earnings, taxes, 401(k), and net pay from hours, rates, and the employee's
// withholding setup. Health and garnishment deductions are entered values and are kept.
function recalculateLine(line, employee) {
  const hourly = line.payType === 'hourly';
  const earnings = {
    ...line.earnings,
    regular: hourly ? round(line.hours.regular * line.hourlyRate) : line.periodSalary,
    overtime: hourly ? round(line.hours.overtime * line.hourlyRate * OVERTIME_MULTIPLIER) : 0,
  };
  const gross = total(earnings);
  const taxable = gross - earnings.reimbursement;
  const taxes = {
    federal: round(taxable * employee.withholding.federal),
    state: round(taxable * employee.withholding.state),
    socialSecurity: round(taxable * FICA.socialSecurity),
    medicare: round(taxable * FICA.medicare),
  };
  const deductions = { ...line.deductions, retirement401k: round(taxable * employee.retirementRate) };
  return { ...line, earnings, gross, taxes, deductions, net: round(gross - total(taxes) - total(deductions)) };
}

// Employer FICA matches the employee's Social Security and Medicare withholding.
function recalculateTotals(run) {
  const sum = pick => round(run.lines.reduce((value, line) => value + pick(line), 0));
  return {
    employees: run.lines.length,
    gross: sum(line => line.gross),
    taxes: sum(line => total(line.taxes)),
    deductions: sum(line => total(line.deductions)),
    employerTaxes: sum(line => line.taxes.socialSecurity + line.taxes.medicare),
    net: sum(line => line.net),
  };
}

// GraphQL already rejects unknown fields and wrong types; this checks ranges and pay rules.
// Null input fields mean "leave unchanged".
function readChanges(input, line) {
  const changes = {};
  for (const [group, fields] of Object.entries(EDITABLE)) {
    for (const field of fields) {
      const value = input[group]?.[field];
      if (value === undefined || value === null) continue;
      const max = group === 'hours' ? MAX_HOURS : MAX_AMOUNT;
      if (!Number.isFinite(value) || value < 0 || value > max) fail(`${group}.${field} must be from 0 to ${max}.`, 'BAD_USER_INPUT');
      if (group === 'hours' && field === 'overtime' && value > 0 && line.payType !== 'hourly') {
        fail('Exempt (salaried) employees do not earn overtime.', 'BAD_USER_INPUT');
      }
      (changes[group] ||= {})[field] = value;
    }
  }
  if (input.paymentMethod !== undefined && input.paymentMethod !== null) {
    if (!PAYMENT_METHODS.includes(input.paymentMethod)) fail(`paymentMethod must be one of: ${PAYMENT_METHODS.join(', ')}.`, 'BAD_USER_INPUT');
    changes.paymentMethod = input.paymentMethod;
  }
  return changes;
}

function updatePayLine(store, input) {
  const run = store.getPayrun(input.payrunId) || fail(`Payrun ${input.payrunId} was not found.`, 'NOT_FOUND');
  const lines = store.getLines(run.id);
  const index = lines.findIndex(line => line.lineId === input.lineId);
  if (index === -1) fail(`Pay line ${input.lineId} was not found in ${run.id}.`, 'NOT_FOUND');
  if (run.status !== 'pending-approval') fail('Completed payrolls are locked and cannot be edited.', 'CONFLICT');
  const changes = readChanges(input, lines[index]);
  const expectedVersion = input.expectedVersion ?? run.version;
  const conflict = () => fail('This payroll was changed by someone else. Reload and try again.', 'CONFLICT',
    { currentVersion: store.getPayrun(run.id).version });
  if (expectedVersion !== run.version) conflict();
  const line = structuredClone(lines[index]);
  for (const group of Object.keys(EDITABLE)) Object.assign(line[group], changes[group]);
  if (changes.paymentMethod) line.paymentMethod = changes.paymentMethod;
  lines[index] = recalculateLine(line, store.getEmployee(line.employeeId));
  // The version check is repeated inside the save's transaction, so concurrent saves can't both win.
  if (!store.saveLine({ payrunId: run.id, expectedVersion, line: lines[index], totals: recalculateTotals({ lines }) })) conflict();
  return store.getPayrun(run.id);
}

module.exports = { updatePayLine, recalculateLine, recalculateTotals, fail };
