// Pre-processing step: loads the payrun the agent was invoked on plus recent completed runs as
// history, runs deterministic checks for payroll anomalies ("signals"), and formats everything
// as compact text context for the model. The checks are generic rules comparing each employee
// with their own history; the model explains and prioritizes what they surface.

const { amountAtRisk, severityOf } = require('./findingPolicy');

const LINE_FIELDS = `lineId employeeId name department payType employmentStatus hireDate terminationDate hourlyRate periodSalary
  hours { regular overtime } earnings { regular overtime bonus reimbursement } gross
  taxes { federal state socialSecurity medicare } deductions { health retirement401k garnishment } net paymentMethod`;
const PAYRUN_FIELDS = `id name company frequency payDate periodStart periodEnd status currency version
  totals { employees gross taxes deductions employerTaxes net } lines { ${LINE_FIELDS} }`;
const QUERY = `query AgentContext($id: ID!, $historyLimit: Int!) {
  payrun(id: $id) { ${PAYRUN_FIELDS} }
  payrunHistory(limit: $historyLimit, before: $id) { ${PAYRUN_FIELDS} }
}`;
const MAX_CONTEXT_CHARS = 12000;

const money = value => Math.round(value * 100) / 100;
const taxTotal = taxes => taxes.federal + taxes.state + taxes.socialSecurity + taxes.medicare;

// Values each employee had in the history runs, keyed by employee ID.
function historyByEmployee(historyRuns) {
  const history = new Map();
  for (const run of historyRuns) {
    for (const line of run.lines) {
      if (!history.has(line.employeeId)) history.set(line.employeeId, []);
      history.get(line.employeeId).push(line);
    }
  }
  return history;
}

const dollars = value => `$${money(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = value => `${value >= 0 ? '+' : '-'}${dollars(Math.abs(value))}`;

function range(values, unit = '', format = money) {
  if (!values.length) return 'no history';
  const low = money(Math.min(...values)), high = money(Math.max(...values));
  return low === high ? `${format(low)}${unit}` : `${format(low)}–${format(high)}${unit}`;
}

// Generic checks; each returns a short, factual finding with its amount at risk and severity
// (findingPolicy). Thresholds are deliberately loose so normal variation (a few overtime hours,
// small bonuses) is not flagged.
function detectSignals(run, historyRuns) {
  const history = historyByEmployee(historyRuns);
  const signals = [];
  const add = (line, kind, detail) => signals.push({ employeeId: line.employeeId, name: line.name, kind, detail });
  const counts = new Map();
  for (const line of run.lines) counts.set(line.employeeId, (counts.get(line.employeeId) || 0) + 1);
  const reported = new Set();

  for (const line of run.lines) {
    const past = history.get(line.employeeId) || [];
    const outlier = (label, current, pastValues, { ratio, minIncrease, unit = '', format = dollars }) => {
      if (!pastValues.length) return;
      const highest = Math.max(...pastValues);
      if (current - highest >= minIncrease && current > highest * ratio) {
        add(line, `${label} outlier`, `${label} ${format(current)}${unit} vs ${range(pastValues, unit, format)} in the last ${pastValues.length} runs`);
      }
    };
    if (counts.get(line.employeeId) > 1 && !reported.has(line.employeeId)) {
      add(line, 'duplicate payment', `${counts.get(line.employeeId)} pay lines for the same employee in this run (gross ${dollars(line.gross)} each)`);
    }
    reported.add(line.employeeId);
    outlier('overtime', line.hours.overtime, past.map(item => item.hours.overtime), { ratio: 2, minIncrease: 10, unit: 'h', format: money });
    outlier('bonus', line.earnings.bonus, past.map(item => item.earnings.bonus), { ratio: 3, minIncrease: 1000 });
    outlier('reimbursement', line.earnings.reimbursement, past.map(item => item.earnings.reimbursement), { ratio: 3, minIncrease: 500 });
    for (const [field, label] of [['health', 'health deduction'], ['retirement401k', '401(k) deduction']]) {
      const pastValues = past.map(item => item.deductions[field]);
      if (pastValues.length && pastValues.every(value => value > 0) && line.deductions[field] === 0) {
        add(line, `${label} missing`, `${label} is $0 this run vs ${range(pastValues, '', dollars)} in the last ${pastValues.length} runs`);
      }
    }
    if (line.gross > 0 && line.taxes.federal === 0 && line.taxes.state === 0) {
      add(line, 'no tax withholding', `federal and state withholding are both $0 on gross ${dollars(line.gross)}`);
    }
    if (line.terminationDate && line.gross > 0 && line.terminationDate < run.periodEnd) {
      const whole = line.terminationDate < run.periodStart;
      add(line, 'paid after termination', `terminated ${line.terminationDate} but paid gross ${dollars(line.gross)} for ${run.periodStart} to ${run.periodEnd}${whole ? ' (entire period after termination)' : ''}`);
    }
    if (!past.length) add(line, 'new hire', `first pay run${line.hireDate ? ` (hired ${line.hireDate})` : ''}`);
  }
  return signals.map(signal => {
    const amount = amountAtRisk(signal.kind, run.lines.filter(line => line.employeeId === signal.employeeId), history.get(signal.employeeId) || []);
    return { ...signal, amountAtRisk: amount, severity: severityOf(signal.kind, amount) };
  });
}

// Aggregates computed in code so the model never has to add up lines itself.
function payrunFacts(run, historyRuns) {
  if (!run.lines.length) return ['No employee pay lines are available in this scope.'];
  const facts = [];
  const unique = new Set(run.lines.map(line => line.employeeId));
  facts.push(`${run.lines.length} pay lines for ${unique.size} unique employees${run.lines.length > unique.size ? ' (some employees have more than one line)' : ''}.`);
  const previous = historyRuns[0];
  if (previous?.totals) {
    const p = previous.totals, t = run.totals;
    facts.push(`Compared with the previous run ${previous.id}: gross ${dollars(t.gross)} vs ${dollars(p.gross)} (${signed(t.gross - p.gross)}), `
      + `net pay ${dollars(t.net)} vs ${dollars(p.net)} (${signed(t.net - p.net)}), pay lines ${t.employees} vs ${p.employees}.`);
    const before = new Map();
    for (const line of previous.lines) before.set(line.employeeId, (before.get(line.employeeId) || 0) + line.gross);
    const now = new Map();
    for (const line of run.lines) now.set(line.employeeId, { name: line.name, gross: (now.get(line.employeeId)?.gross || 0) + line.gross });
    const changes = [...now].map(([id, item]) => ({ id, name: item.name, change: item.gross - (before.get(id) || 0), isNew: !before.has(id) }))
      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, 3);
    facts.push(`Largest gross pay changes per employee vs ${previous.id}: ${changes.map(item => `${item.id} ${item.name} ${signed(item.change)}${item.isNew ? ' (not in previous run)' : ''}`).join('; ')}.`);
  }
  const departments = new Map();
  for (const line of run.lines) {
    const item = departments.get(line.department) || { lines: 0, gross: 0 };
    departments.set(line.department, { lines: item.lines + 1, gross: item.gross + line.gross });
  }
  facts.push(`Gross by department (highest first): ${[...departments].sort((a, b) => b[1].gross - a[1].gross)
    .map(([name, item]) => `${name} ${dollars(item.gross)} (${item.lines} line${item.lines === 1 ? '' : 's'})`).join('; ')}.`);
  // Counts are per unique employee (an employee with two pay lines counts once).
  const people = [...new Map(run.lines.map(line => [line.employeeId, line])).values()];
  const count = key => Object.entries(people.reduce((acc, line) => ({ ...acc, [line[key]]: (acc[line[key]] || 0) + 1 }), {}))
    .map(([name, n]) => `${n} ${name}`).join(', ');
  const names = list => list.map(line => `${line.employeeId} ${line.name}`).join(', ');
  facts.push(`Employees by pay type: ${count('payType')}. By employment status: ${count('employmentStatus')}.`);
  facts.push(`Employees by payment method: ${Object.entries(people.reduce((acc, line) => ({ ...acc, [line.paymentMethod]: [...(acc[line.paymentMethod] || []), line] }), {}))
    .map(([method, list]) => `${method} ${list.length} (${names(list)})`).join('; ')}.`);
  const sum = pick => money(run.lines.reduce((total, line) => total + pick(line), 0));
  facts.push(`Employee tax withholding in total: federal ${dollars(sum(line => line.taxes.federal))}, state ${dollars(sum(line => line.taxes.state))}, `
    + `Social Security ${dollars(sum(line => line.taxes.socialSecurity))}, Medicare ${dollars(sum(line => line.taxes.medicare))}`
    + `${run.totals.employerTaxes != null ? `; employer taxes ${dollars(run.totals.employerTaxes)}` : ''}.`);
  facts.push(`Deductions in total: health ${dollars(sum(line => line.deductions.health))}, 401(k) ${dollars(sum(line => line.deductions.retirement401k))}, `
    + `garnishments ${dollars(sum(line => line.deductions.garnishment))}.`);
  facts.push(`Earnings in total: regular ${dollars(sum(line => line.earnings.regular))}, overtime pay ${dollars(sum(line => line.earnings.overtime))}, `
    + `bonuses ${dollars(sum(line => line.earnings.bonus))}, reimbursements ${dollars(sum(line => line.earnings.reimbursement))}; `
    + `regular hours ${sum(line => line.hours.regular)}h.`);
  const overtime = new Map();
  for (const line of run.lines.filter(item => item.hours.overtime > 0)) {
    const item = overtime.get(line.employeeId) || { name: line.name, hours: 0, lines: 0 };
    overtime.set(line.employeeId, { ...item, hours: item.hours + line.hours.overtime, lines: item.lines + 1 });
  }
  const totalOvertime = [...overtime.values()].reduce((sum, item) => sum + item.hours, 0);
  facts.push(overtime.size
    ? `Overtime: ${money(totalOvertime)}h in total; ${[...overtime].sort((a, b) => b[1].hours - a[1].hours)
      .map(([id, item]) => `${id} ${item.name} ${money(item.hours)}h${item.lines > 1 ? ` across ${item.lines} lines` : ''}`).join(', ')}.`
    : 'No overtime this run.');
  const top = run.lines.reduce((best, line) => (line.gross > best.gross ? line : best));
  const topNet = run.lines.reduce((best, line) => (line.net > best.net ? line : best));
  facts.push(`Highest gross pay: ${top.employeeId} ${top.name} ${dollars(top.gross)}. Highest net pay: ${topNet.employeeId} ${topNet.name} ${dollars(topNet.net)}.`);
  return facts;
}

function formatEmployee(line, past) {
  const withHistory = (label, value, pick, unit = '') =>
    `${label} ${money(value)}${unit}${past.length ? ` (last ${past.length} runs: ${range(past.map(pick), unit)})` : ''}`;
  const dates = [line.hireDate && `hired ${line.hireDate}`, line.terminationDate && `terminated ${line.terminationDate}`].filter(Boolean).join(', ');
  return `- ${line.employeeId} ${line.name} (${line.department}, ${line.payType}, ${line.employmentStatus}${dates ? `, ${dates}` : ''}): `
    + [withHistory('gross', line.gross, item => item.gross),
      line.payType === 'hourly' && line.hourlyRate != null ? `rate ${dollars(line.hourlyRate)}/h` : line.periodSalary != null ? `salary ${dollars(line.periodSalary)} per period` : null,
      `regular ${line.hours.regular}h (${dollars(line.earnings.regular)})`,
      `overtime pay ${dollars(line.earnings.overtime)}`,
      withHistory('overtime', line.hours.overtime, item => item.hours.overtime, 'h'),
      withHistory('bonus', line.earnings.bonus, item => item.earnings.bonus),
      withHistory('reimbursement', line.earnings.reimbursement, item => item.earnings.reimbursement),
      `federal tax ${money(line.taxes.federal)}, state tax ${money(line.taxes.state)}, Social Security ${money(line.taxes.socialSecurity)}, Medicare ${money(line.taxes.medicare)}, total employee tax ${money(taxTotal(line.taxes))}`,
      withHistory('health', line.deductions.health, item => item.deductions.health),
      `401(k) ${money(line.deductions.retirement401k)}, garnishment ${money(line.deductions.garnishment)}`,
      `net ${money(line.net)}, ${line.paymentMethod}`].filter(Boolean).join('; ');
}

// employeeIds limits the pay lines to the employees a question is about (see contextScope.js);
// the totals, facts, and findings always cover the whole run.
function formatContext(run, historyRuns, { employeeIds = null } = {}) {
  const history = historyByEmployee(historyRuns);
  const signals = detectSignals(run, historyRuns);
  const shown = employeeIds ? run.lines.filter(line => employeeIds.includes(line.employeeId)) : run.lines;
  const t = run.totals;
  return [
    `Current payrun ${run.id} "${run.name}" (${run.company}): ${run.frequency ? `${run.frequency} run, ` : ''}period ${run.periodStart} to ${run.periodEnd}, pay date ${run.payDate}, status ${run.status}, ${run.currency}.`,
    `Totals: ${t.employees} pay lines, gross ${money(t.gross)}, employee taxes ${money(t.taxes)}, deductions ${money(t.deductions)}, ${t.employerTaxes != null ? `employer taxes ${money(t.employerTaxes)}, ` : ''}net pay ${money(t.net)}.`,
    `History: ${historyRuns.length ? historyRuns.map(item => `${item.id} (paid ${item.payDate})`).join(', ') : 'none'}.`,
    'Payrun facts (computed exactly from the pay lines):',
    ...payrunFacts(run, historyRuns).map(fact => `- ${fact}`),
    shown.length === run.lines.length ? 'Pay lines in this run (history ranges in parentheses):'
      : shown.length ? `Pay lines for the employees this question is about (${shown.length} of ${run.lines.length}; history ranges in parentheses):`
        : `Pay lines: not needed for this question (${run.lines.length} lines in the run).`,
    ...shown.map(line => formatEmployee(line, history.get(line.employeeId) || [])),
    signals.length ? 'Findings from automated checks (verify against the lines above):' : 'Automated checks found nothing unusual.',
    ...signals.map(item => `- ${item.employeeId} ${item.name}: ${item.kind} (${item.severity}${item.amountAtRisk != null ? `, ${dollars(item.amountAtRisk)} at risk` : ''}): ${item.detail}.`),
  ].join('\n');
}

// Scope the text and incident evidence as well as the RAG model inputs. Payroll totals
// must describe the selected employee, rather than retaining totals for the entire run.
function scopePayrun(run, employeeId) {
  if (!employeeId) return run;
  const lines = run.lines.filter(line => line.employeeId === employeeId);
  const sum = pick => money(lines.reduce((total, line) => total + pick(line), 0));
  return { ...run, lines, totals: { employees: lines.length, gross: sum(line => line.gross), net: sum(line => line.net),
    taxes: sum(line => taxTotal(line.taxes)),
    deductions: sum(line => line.deductions.health + line.deductions.retirement401k + line.deductions.garnishment) } };
}

// Keep complete raw current/history records for RAG and calculated comparisons, plus
// scoped text, signals and a payrun alias for generic chat and incident reports.
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
  const { payrun, payrunHistory = [] } = body.data;
  const scoped = scopePayrun(payrun, invocation.employeeId);
  if (invocation.employeeId && !scoped.lines.length) {
    throw Object.assign(new Error('The selected employee is not in this payrun.'), { status: 400 });
  }
  const scopedHistory = payrunHistory.map(run => scopePayrun(run, invocation.employeeId)).filter(run => run.lines.length);
  let text = formatContext(scoped, scopedHistory);
  if (text.length > MAX_CONTEXT_CHARS) text = `${text.slice(0, MAX_CONTEXT_CHARS)}\n[context truncated]`;
  return { text, payrunId: invocation.payrunId, signals: detectSignals(scoped, scopedHistory),
    current: payrun, payrun: scoped, history: payrunHistory };
}

module.exports = { loadPayrunContext, detectSignals, formatContext, payrunFacts, historyByEmployee, dollars, money, MAX_CONTEXT_CHARS, PAYRUN_FIELDS };
