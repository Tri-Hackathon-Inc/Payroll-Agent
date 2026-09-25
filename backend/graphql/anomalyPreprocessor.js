// Deterministic evidence, calculated before inference. Monetary arithmetic uses cents.
const METRICS = {
  gross: { label: 'Gross pay', path: ['gross'], absolute: 100, percent: 25 },
  net: { label: 'Net pay', path: ['net'], absolute: 100, percent: 25 },
  overtimeHours: { label: 'Overtime hours', path: ['hours', 'overtime'], absolute: 10, percent: 50, unit: 'hours' },
  bonus: { label: 'Bonus', path: ['earnings', 'bonus'], absolute: 100, percent: 50 },
  health: { label: 'Health deduction', path: ['deductions', 'health'], absolute: 25, percent: 25 },
  retirement401k: { label: '401k deduction', path: ['deductions', 'retirement401k'], absolute: 25, percent: 25 },
  garnishment: { label: 'Garnishment', path: ['deductions', 'garnishment'], absolute: 25, percent: 25 },
};
const round = value => Math.round(value * 100) / 100;
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const badInput = message => Object.assign(new Error(message), { status: 400 });

function groupLines(lines) {
  const grouped = new Map();
  for (const line of lines) {
    if (!line || typeof line.employeeId !== 'string' || !line.employeeId) throw badInput('Payroll lines require an employee ID.');
    if (!grouped.has(line.employeeId)) grouped.set(line.employeeId, []);
    grouped.get(line.employeeId).push(line);
  }
  return grouped;
}

function values(lines) {
  return Object.fromEntries(Object.entries(METRICS).map(([key, metric]) => {
    const entries = lines.map(line => metric.path.reduce((value, part) => value?.[part], line));
    const valid = entries.every(value => typeof value === 'number' && Number.isFinite(value)
      && Math.abs(value) < 1e10);
    return [key, valid ? entries.reduce((total, value) => total + Math.round(value * 100), 0) / 100 : null];
  }));
}

function median(items) {
  const sorted = [...items].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
}

class AnomalyPreprocessor {
  process(current, history = [], { employeeId } = {}) {
    if (!current || !Array.isArray(current.lines) || !Array.isArray(history)
      || !validDate(current.payDate) || !validDate(current.periodStart)
      || !current.company || !current.currency || !current.frequency) {
      throw badInput('A payrun with dated periods, company, currency, frequency and employee lines is required.');
    }
    if (employeeId !== undefined && (typeof employeeId !== 'string' || !employeeId.trim())) {
      throw badInput('employeeId must be a nonempty string when supplied.');
    }
    const currentGroups = groupLines(current.lines);
    if (employeeId && !currentGroups.has(employeeId)) throw badInput('The selected employee is not in this payrun.');
    const seen = new Set();
    const eligible = history.filter(run => {
      if (!run || run.id === current.id || !run.id || seen.has(run.id) || run.status !== 'COMPLETED'
        || !validDate(run.payDate) || run.payDate >= current.payDate
        || !validDate(run.periodEnd) || run.periodEnd >= current.periodStart
        || run.company !== current.company || run.currency !== current.currency || run.frequency !== current.frequency
        || !Array.isArray(run.lines)) return false;
      seen.add(run.id);
      return true;
    }).sort((a, b) => b.payDate.localeCompare(a.payDate)).slice(0, 6)
      .map(run => ({ ...run, grouped: groupLines(run.lines) }));
    const findings = [], employees = [];
    for (const [id, lines] of currentGroups) {
      if (employeeId && id !== employeeId) continue;
      const name = lines[0].name || id;
      const payTypes = new Set(lines.map(line => line.payType));
      const samples = eligible.flatMap(run => {
        const previous = run.grouped.get(id);
        return previous?.length && payTypes.size === 1 && previous.every(line => payTypes.has(line.payType))
          ? [{ payrunId: run.id, payDate: run.payDate, values: values(previous) }] : [];
      });
      const currentValues = values(lines);
      const comparisons = {};
      const missingFields = [];
      const add = (code, label, evidence) => findings.push({
        id: `${id}:${code}`, employeeId: id, employeeName: name, code, label, severity: 'review',
        lineIds: lines.map(line => line.lineId).filter(Boolean), evidence,
      });
      for (const [metric, rule] of Object.entries(METRICS)) {
        const amount = currentValues[metric];
        if (amount === null) missingFields.push(metric);
        const available = samples.filter(sample => sample.values[metric] !== null);
        if (amount === null || !available.length) continue;
        const baseline = median(available.map(sample => sample.values[metric]));
        const delta = round(amount - baseline);
        const percentChange = baseline === 0 ? null : round(delta / Math.abs(baseline) * 100);
        const comparison = { metric, unit: rule.unit || current.currency, current: amount, baseline,
          delta, percentChange, historyCount: available.length,
          history: available.map(sample => ({ payrunId: sample.payrunId, payDate: sample.payDate, value: sample.values[metric] })) };
        comparisons[metric] = comparison;
        if (Math.abs(delta) >= rule.absolute && (baseline === 0 || Math.abs(percentChange) >= rule.percent)) {
          add(`${metric}_change`, `${rule.label} changed`, comparison);
        }
      }
      if (lines.length > 1) add('multiple_lines', 'Multiple payment lines; review for a possible duplicate', { lineCount: lines.length });
      if (currentValues.net !== null && currentValues.net < 0) add('negative_net', 'Negative net pay', { current: currentValues.net, unit: current.currency });
      const terminated = lines.find(line => line.employmentStatus === 'terminated'
        && validDate(line.terminationDate) && line.terminationDate < current.periodStart);
      if (terminated && currentValues.gross > 0) add('terminated_payment', 'Payment after termination; verify final pay', {
        terminationDate: terminated.terminationDate, current: currentValues.gross, unit: current.currency,
      });
      employees.push({ employeeId: id, name, historyCount: samples.length,
        historyStatus: samples.length === 0 ? 'insufficient' : samples.length < 3 ? 'limited' : 'available',
        missingFields, current: currentValues, comparisons });
    }
    return { payrunId: current.id, payDate: current.payDate, currency: current.currency,
      employeeId: employeeId || null, historyPayrunIds: eligible.map(run => run.id),
      method: 'Median of up to six earlier completed payruns, matched by employee ID, company, currency, frequency and pay type.',
      thresholds: Object.fromEntries(Object.entries(METRICS).map(([key, rule]) => [key, { absolute: rule.absolute, percent: rule.percent }])),
      employees, findings };
  }
}

module.exports = { AnomalyPreprocessor };
