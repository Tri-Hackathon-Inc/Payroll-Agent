const { digest } = require('../redisStore');

const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

// Shared by background/manual ingestion and query-time indexing. Document IDs do not depend on a chat.
function completedPayrunDocuments(run, { domainName, service }, { allowed, payTypes, snapshot } = {}) {
  if (!run || run.status !== 'COMPLETED' || typeof run.id !== 'string' || !run.id
    || !validDate(run.payDate) || !validDate(run.periodStart) || !validDate(run.periodEnd) || run.periodStart > run.periodEnd
    || !['company', 'currency', 'frequency'].every(key => typeof run[key] === 'string' && run[key].trim())
    || !Array.isArray(run.lines) || run.lines.some(line => !line || typeof line.employeeId !== 'string' || !line.employeeId)) {
    throw new Error('Completed payroll history requires valid dates, company, currency, frequency and employee IDs.');
  }
  const scope = digest([domainName, service, run.company, run.currency, run.frequency]);
  snapshot = snapshot || digest(run);
  const grouped = new Map(), docs = [];
  for (const line of run.lines) {
    if (allowed && !allowed.has(line.employeeId)) continue;
    if (!grouped.has(line.employeeId)) grouped.set(line.employeeId, []);
    grouped.get(line.employeeId).push(line);
  }
  for (const [employeeId, lines] of grouped) {
    const expectedTypes = payTypes?.get(employeeId);
    if (payTypes && (expectedTypes?.size !== 1 || lines.some(line => !expectedTypes.has(line.payType)))) continue;
    const summary = `Employee ${employeeId} (${lines[0].name}); completed payrun ${run.id}, paid ${run.payDate}, currency ${run.currency}.`;
    const topics = {
      earnings: lines.map(line => ({ gross: line.gross, net: line.net, earnings: line.earnings })),
      overtime: lines.map(line => ({ hours: line.hours, overtimePay: line.earnings?.overtime })),
      deductions: lines.map(line => ({ deductions: line.deductions, taxes: line.taxes })),
    };
    for (const [topic, values] of Object.entries(topics)) {
      const text = `${summary} ${topic}: ${JSON.stringify(values)}.`;
      const id = digest([scope, run.id, employeeId, topic, text]);
      docs.push({ id, scope, snapshot, employeeId, payrunId: run.id, payDate: run.payDate,
        lineIds: lines.map(line => line.lineId).filter(Boolean), topic, text, revision: digest(text) });
    }
  }
  return docs;
}

function historyDocuments(context, evidence, { domainName, service }) {
  const current = context.current;
  const seen = new Set();
  const runs = context.history.filter(run => {
    const eligible = run.id !== current.id && !seen.has(run.id) && run.status === 'COMPLETED'
      && validDate(run.payDate) && run.payDate < current.payDate
      && validDate(run.periodEnd) && run.periodEnd < current.periodStart
      && run.company === current.company && run.currency === current.currency && run.frequency === current.frequency;
    seen.add(run.id);
    return eligible;
  });
  const snapshot = digest([current.id, current.version, runs]);
  const allowed = new Set(evidence.employees.map(employee => employee.employeeId));
  const payTypes = new Map();
  for (const line of current.lines) {
    if (!payTypes.has(line.employeeId)) payTypes.set(line.employeeId, new Set());
    payTypes.get(line.employeeId).add(line.payType);
  }
  return runs.flatMap(run => completedPayrunDocuments(run, { domainName, service }, { allowed, payTypes, snapshot }));
}

module.exports = { historyDocuments, completedPayrunDocuments };
