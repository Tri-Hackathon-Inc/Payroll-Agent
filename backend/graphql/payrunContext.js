// Pre-processing step: loads the payrun the agent was invoked on (and the previous completed run
// as history for anomaly checks) from the payroll API and formats it as compact text context.

const PAYRUN_FIELDS = `id name company payDate periodStart periodEnd status currency
  totals { employees gross taxes deductions net }
  lines { employeeId name department payType employmentStatus hours { regular overtime }
    earnings { regular overtime bonus reimbursement } gross
    taxes { federal state socialSecurity medicare } deductions { health retirement401k garnishment } net paymentMethod }`;
const QUERY = `query AgentContext($id: ID!) {
  payrun(id: $id) { ${PAYRUN_FIELDS} }
  payrunHistory(limit: 1, before: $id) { ${PAYRUN_FIELDS} }
}`;
const MAX_CONTEXT_CHARS = 12000;

const money = value => Math.round(value * 100) / 100;
const taxTotal = taxes => taxes.federal + taxes.state + taxes.socialSecurity + taxes.medicare;

function formatRun(run, label) {
  const t = run.totals;
  const rows = run.lines.map(line => [
    line.employeeId, line.name, line.department, line.payType, line.employmentStatus,
    line.hours.regular, line.hours.overtime, money(line.earnings.bonus), money(line.earnings.reimbursement),
    money(line.gross), money(taxTotal(line.taxes)), money(line.deductions.health), money(line.deductions.retirement401k),
    money(line.deductions.garnishment), money(line.net), line.paymentMethod,
  ].join(' | '));
  return [
    `${label}: ${run.id} "${run.name}" (${run.company}), period ${run.periodStart} to ${run.periodEnd}, pay date ${run.payDate}, status ${run.status}, currency ${run.currency}.`,
    `Totals: ${t.employees} employees, gross ${money(t.gross)}, taxes ${money(t.taxes)}, deductions ${money(t.deductions)}, net ${money(t.net)}.`,
    'Lines (employeeId | name | department | payType | status | regular hours | overtime hours | bonus | reimbursement | gross | employee taxes | health deduction | 401k deduction | garnishment | net | payment):',
    ...rows,
  ].join('\n');
}

// Returns { text, payrunId } or null when there is no payrun context to load.
async function loadPayrunContext(invocation, { endpoint = process.env.TRINET_API_URL, fetchImpl = fetch } = {}) {
  if (invocation?.page !== 'payrun' || !invocation.payrunId || !endpoint) return null;
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { id: invocation.payrunId } }),
    signal: AbortSignal.timeout(10000),
  });
  const body = await response.json();
  if (!response.ok || body.errors?.length || !body.data?.payrun) {
    throw new Error(body.errors?.[0]?.message || `Payroll API returned HTTP ${response.status}.`);
  }
  const sections = [formatRun(body.data.payrun, 'Current payrun')];
  const previous = body.data.payrunHistory?.[0];
  if (previous) sections.push(formatRun(previous, 'Previous completed payrun (history)'));
  let text = sections.join('\n\n');
  if (text.length > MAX_CONTEXT_CHARS) text = `${text.slice(0, MAX_CONTEXT_CHARS)}\n[context truncated]`;
  return { text, payrunId: invocation.payrunId };
}

module.exports = { loadPayrunContext, formatRun };
