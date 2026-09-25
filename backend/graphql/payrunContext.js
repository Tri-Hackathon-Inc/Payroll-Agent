// Loads current payroll and configurable completed history (six runs by default). Raw data feeds anomaly
// preprocessing; the compact text representation is for other agent templates.

const PAYRUN_FIELDS = `id name company frequency payDate periodStart periodEnd status currency version
  totals { employees gross taxes deductions net }
  lines { lineId employeeId name department payType employmentStatus terminationDate hours { regular overtime }
    earnings { regular overtime bonus reimbursement } gross
    taxes { federal state socialSecurity medicare } deductions { health retirement401k garnishment } net paymentMethod }`;
const QUERY = `query AgentContext($id: ID!, $historyLimit: Int!) {
  payrun(id: $id) { ${PAYRUN_FIELDS} }
  payrunHistory(limit: $historyLimit, before: $id) { ${PAYRUN_FIELDS} }
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

// Raw runs are retained for analysis; the text cap applies only to generic chat prompts.
async function loadPayrunContext(invocation, { endpoint = process.env.TRINET_API_URL, fetchImpl = fetch, historyLimit = 6 } = {}) {
  if (invocation?.page !== 'payrun' || !invocation.payrunId || !endpoint) return null;
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { id: invocation.payrunId, historyLimit: Math.max(1, Math.min(historyLimit, 500)) } }),
    signal: AbortSignal.timeout(10000),
  });
  const body = await response.json();
  if (!response.ok || body.errors?.length || !body.data?.payrun) {
    throw new Error('The requested payrun and history could not be loaded.');
  }
  const sections = [formatRun(body.data.payrun, 'Current payrun')];
  const history = body.data.payrunHistory || [];
  history.forEach((previous, index) => sections.push(formatRun(previous,
    index === 0 ? 'Previous completed payrun (history)' : 'Earlier completed payrun (history)')));
  let text = sections.join('\n\n');
  if (text.length > MAX_CONTEXT_CHARS) text = `${text.slice(0, MAX_CONTEXT_CHARS)}\n[context truncated]`;
  return { text, payrunId: invocation.payrunId, current: body.data.payrun, history };
}

module.exports = { loadPayrunContext, formatRun, PAYRUN_FIELDS };
