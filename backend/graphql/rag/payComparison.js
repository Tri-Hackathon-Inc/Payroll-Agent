// UI comparison amounts are calculated from source pay lines, never from model output.
const FIELDS = [
  ['gross', 'Gross pay', 'earning', ['gross']],
  ['federal', 'Federal tax', 'withholding', ['taxes.federal']],
  ['state', 'State tax', 'withholding', ['taxes.state']],
  ['fica', 'FICA', 'withholding', ['taxes.socialSecurity', 'taxes.medicare']],
  ['health', 'Health benefits', 'withholding', ['deductions.health']],
  ['retirement401k', '401(k)', 'withholding', ['deductions.retirement401k']],
  ['garnishment', 'Garnishment', 'withholding', ['deductions.garnishment']],
  ['net', 'Net pay', 'net', ['net']],
];
const cents = value => Math.round(value * 100);
const difference = (current, previous) => current === null || previous === null ? null : (cents(current) - cents(previous)) / 100;

function sum(lines, paths) {
  if (!lines.length) return null;
  const values = lines.flatMap(line => paths.map(path => path.split('.').reduce((value, key) => value?.[key], line)));
  if (values.some(value => typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) >= 1e10)) return null;
  return values.reduce((total, value) => total + cents(value), 0) / 100;
}
function period(run) {
  return run ? { payrunId: run.id, periodStart: run.periodStart, periodEnd: run.periodEnd, payDate: run.payDate } : null;
}

function buildPayComparison(context, evidence, documents) {
  if (evidence.employees.length !== 1) return null;
  const employee = evidence.employees[0];
  // These IDs have already passed the historical company/currency/frequency/pay-type checks.
  // Choose from the full eligible history, not the semantic top-K or median baseline.
  const eligibleIds = new Set(documents.filter(item => item.employeeId === employee.employeeId).map(item => item.payrunId));
  const previous = context.history.filter(run => eligibleIds.has(run.id))
    .sort((a, b) => b.payDate.localeCompare(a.payDate) || b.periodEnd.localeCompare(a.periodEnd) || a.id.localeCompare(b.id))[0];
  const currentLines = context.current.lines.filter(line => line.employeeId === employee.employeeId);
  const previousLines = previous?.lines.filter(line => line.employeeId === employee.employeeId) || [];
  const rows = FIELDS.map(([key, label, kind, paths]) => {
    const current = sum(currentLines, paths), prior = sum(previousLines, paths);
    return { key, label, kind, current, previous: prior, delta: difference(current, prior) };
  });
  const overtime = { current: sum(currentLines, ['earnings.overtime']), previous: sum(previousLines, ['earnings.overtime']),
    currentHours: sum(currentLines, ['hours.overtime']), previousHours: sum(previousLines, ['hours.overtime']) };
  const reconciles = side => {
    if (rows.some(row => row[side] === null)) return false;
    const calculated = cents(rows[0][side]) - rows.filter(row => row.kind === 'withholding').reduce((total, row) => total + cents(row[side]), 0);
    return calculated === cents(rows.at(-1)[side]);
  };
  return { employeeId: employee.employeeId, employeeName: employee.name, currency: context.current.currency,
    current: period(context.current), previous: period(previous), rows, overtime,
    netChange: rows.at(-1).delta, reconciled: !!previous && reconciles('current') && reconciles('previous') };
}

module.exports = { buildPayComparison };
