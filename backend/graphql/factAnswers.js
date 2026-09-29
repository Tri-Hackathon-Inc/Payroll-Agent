// Computed answers: questions whose answer is a fact in the payroll data (totals, employee
// lookups, counts, comparisons with the previous run, and the automated findings) are answered in
// code with no model call, so they are exact and word-for-word repeatable. Anything else returns
// null and goes to the model. Matching is deliberately strict: a question that is ambiguous,
// names several employees, or asks for an explanation beyond the findings is left to the model.
const { historyByEmployee, dollars, money } = require('./payrunContext');
const { AnomalyPreprocessor } = require('./anomalyPreprocessor');

// Why each automated finding matters, shown after the finding.
const WHY_IT_MATTERS = {
  'overtime outlier': 'confirm the extra hours were approved',
  'bonus outlier': 'confirm the bonus amount and its approval',
  'reimbursement outlier': 'check the receipts and approval for the reimbursement',
  'health deduction missing': 'the benefit deduction may have been missed or coverage ended',
  '401(k) deduction missing': 'the retirement contribution may have been skipped',
  'no tax withholding': 'taxes would be under-withheld; check the W-4 and state setup',
  'paid after termination': 'possible overpayment after the employee left',
  'duplicate payment': 'the employee would be paid twice for the period',
};
const PAY_RAISING = new Set(['overtime outlier', 'bonus outlier', 'reimbursement outlier', 'duplicate payment']);

const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
const who = employee => `${employee.employeeId} ${employee.name}`;
const list = items => (items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`);
const taxTotal = taxes => money(taxes.federal + taxes.state + taxes.socialSecurity + taxes.medicare);
const humanStatus = status => String(status || 'unknown').toLowerCase().replace(/_/g, ' ');

function normalize(question) {
  return question.toLowerCase().replace(/401\s*\(k\)/g, '401k').replace(/['’]s\b/g, '')
    .replace(/[^a-z0-9$.\s-]/g, ' ').replace(/\.(\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
}

// Sums numeric fields (including nested ones) of an employee's pay lines into one record.
function combine(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'number' && ['gross', 'net'].includes(key)) target[key] = money(target[key] + value);
    else if (value && typeof value === 'object') {
      for (const [inner, amount] of Object.entries(value)) target[key][inner] = money(target[key][inner] + amount);
    }
  }
}

function employeesOf(run) {
  const byId = new Map();
  for (const line of run.lines) {
    const existing = byId.get(line.employeeId);
    if (existing) { existing.lines += 1; combine(existing, line); continue; }
    byId.set(line.employeeId, { ...line, lines: 1, hours: { ...line.hours }, earnings: { ...line.earnings },
      taxes: { ...line.taxes }, deductions: { ...line.deductions } });
  }
  return [...byId.values()];
}

// Employees the question names, by full name, employee ID, or a first or last name that only one
// employee has.
function mentioned(q, employees) {
  const words = new Set(q.split(' '));
  const parts = employees.map(employee => employee.name.toLowerCase().split(' '));
  const unique = (word, index) => parts.filter(part => (index === 0 ? part[0] : part.at(-1)) === word).length === 1;
  return employees.filter((employee, i) => {
    const [first, last] = [parts[i][0], parts[i].at(-1)];
    return q.includes(employee.name.toLowerCase()) || words.has(employee.employeeId.toLowerCase())
      || (parts[i].length > 1 && words.has(last) && unique(last, 1)) || (words.has(first) && unique(first, 0));
  });
}

function findingLines(signals) {
  const byEmployee = new Map();
  for (const signal of signals) {
    if (!byEmployee.has(signal.employeeId)) byEmployee.set(signal.employeeId, { name: signal.name, parts: [] });
    const why = WHY_IT_MATTERS[signal.kind];
    byEmployee.get(signal.employeeId).parts.push(`${signal.kind}: ${signal.detail}${why ? ` - ${why}` : ''}`);
  }
  return [...byEmployee].map(([id, item]) => `- ${id} ${item.name}: ${item.parts.join('; ')}.`);
}

function build(context) {
  const run = context.payrun;
  const history = context.history || [];
  const employees = employeesOf(run);
  const pastById = historyByEmployee(history);
  const previous = history[0];
  const sum = pick => money(run.lines.reduce((total, line) => total + pick(line), 0));
  const issues = context.signals.filter(signal => signal.kind !== 'new hire');
  const infos = context.signals.filter(signal => signal.kind === 'new hire');
  const employeeCount = `${plural(employees.length, 'unique employee')} (${plural(run.lines.length, 'pay line')})`;
  const previousGross = id => money((previous?.lines || []).filter(line => line.employeeId === id).reduce((total, line) => total + line.gross, 0));
  const multiLine = employee => (employee.lines > 1 ? ` across ${employee.lines} pay lines` : '');
  return { run, history, employees, pastById, previous, sum, issues, infos, employeeCount, previousGross, multiLine };
}

// Read dated historical values, rather than answering a previous-payment question
// with the current amount. Eligibility is shared with the anomaly baselines.
function historicalEmployeeAnswer(q, employee, data) {
  if (/\b(why|explain|reason|how come)\b/.test(q)) return null;
  const fields = [
    ['gross pay', /\bgross\b/, [['gross']]],
    ['net pay', /\bnet\b|\btake[ -]home\b/, [['net']]],
    ['overtime hours', /\bovertime\b.*\bhours\b|\bhours\b.*\bovertime\b/, [['hours', 'overtime']], true],
    ['overtime pay', /\bovertime\b/, [['earnings', 'overtime']]],
    ['bonus', /\bbonus\w*\b/, [['earnings', 'bonus']]],
    ['health deduction', /\bhealth\b/, [['deductions', 'health']]],
    ['401(k) deduction', /\b401k\b|\bretirement\b/, [['deductions', 'retirement401k']]],
    ['garnishment', /\bgarnish\w*\b/, [['deductions', 'garnishment']]],
    ['reimbursement', /\breimburse\w*\b/, [['earnings', 'reimbursement']]],
    ['tax withholding', /\btax\w*\b|\bwithh\w*\b/, ['federal', 'state', 'socialSecurity', 'medicare'].map(key => ['taxes', key])],
  ];
  let selected = fields.filter(([, pattern]) => pattern.test(q));
  if (selected.some(([label]) => label === 'overtime hours')) selected = selected.filter(([label]) => label !== 'overtime pay');
  if (selected.length !== 1) return null;
  const [label, , paths, hours] = selected[0];
  const valueOf = lines => {
    const values = lines.flatMap(line => paths.map(path => path.reduce((value, key) => value?.[key], line)));
    return values.length && values.every(value => typeof value === 'number' && Number.isFinite(value))
      ? values.reduce((sum, value) => sum + Math.round(value * 100), 0) / 100 : null;
  };
  const format = value => value === null ? 'not available' : hours ? `${money(value)} hours` : dollars(value);
  let evidence;
  try { evidence = new AnomalyPreprocessor().process(data.run, data.history, { employeeId: employee.employeeId }); }
  catch { return null; }
  const runs = evidence.historyPayrunIds.map(id => data.history.find(run => run.id === id));
  const matching = run => run.lines.filter(line => line.employeeId === employee.employeeId && line.payType === employee.payType);
  const previousRun = /\b(previous|prior|last) (completed )?(payrun|pay run|run|period)\b/.test(q);
  if (previousRun && runs.length && !matching(runs[0]).length) {
    return `${who(employee)} has no matching payment in ${runs[0].id} (${runs[0].payDate}).`;
  }
  const available = runs.filter(run => matching(run).length);
  if (!available.length) return `No compatible completed historical payments are available for ${who(employee)}. I cannot compare their ${label} with an earlier payment.`;
  const count = Number(q.match(/\b(?:last|past|previous) (\d+)\b/)?.[1]);
  const single = previousRun || /\b(previous|prior|last) (payment|one)\b/.test(q);
  const chosen = available.slice(0, single ? 1 : count ? Math.min(count, 6) : 6);
  const current = valueOf(data.run.lines.filter(line => line.employeeId === employee.employeeId));
  const rows = chosen.map(run => `${run.id} (${run.payDate}): ${format(valueOf(matching(run)))}`);
  const compare = /\b(compar\w*|change\w*|difference|higher|lower|increase\w*|decrease\w*)\b/.test(q);
  const previousValue = valueOf(matching(chosen[0]));
  const difference = compare && chosen.length === 1 && current !== null && previousValue !== null
    ? ` Change: ${current >= previousValue ? '+' : '-'}${format(Math.abs(current - previousValue))}.` : '';
  const limit = count > chosen.length ? ` Only ${chosen.length} compatible earlier payruns are available in the loaded history.` : '';
  return `${who(employee)} — ${label}:\n${rows.map(row => `- ${row}`).join('\n')}`
    + (compare ? `\nCurrent ${data.run.id}: ${format(current)}.${difference}` : '') + limit;
}

// Answers about one named employee.
function employeeAnswer(q, employee, data) {
  if (/\b(history|historical|previous|prior|earlier|last (run|payrun|payment|period)|past (payments|runs)|trend\w*|compar\w*)\b/.test(q)
    || /\b(last|past|previous) \d+\b/.test(q)) return historicalEmployeeAnswer(q, employee, data);
  const { run, pastById, multiLine } = data;
  const signals = data.issues.concat(data.infos).filter(signal => signal.employeeId === employee.employeeId);
  const past = pastById.get(employee.employeeId) || [];
  const range = values => {
    if (!values.length) return null;
    const [low, high] = [Math.min(...values), Math.max(...values)];
    return low === high ? dollars(low) : `${dollars(low)}–${dollars(high)}`;
  };
  const pastGross = range(past.map(line => line.gross));

  if (/\bwhy\b/.test(q) && /\b(tax|taxes|withh\w*)\b/.test(q)) {
    const missing = signals.find(signal => signal.kind === 'no tax withholding');
    if (!missing) return null; // Explaining a tax amount needs the model.
    const isNew = signals.some(signal => signal.kind === 'new hire');
    return `${who(employee)} has no federal or state tax withheld: ${missing.detail}. `
      + (isNew ? `They are a new hire (first pay run${employee.hireDate ? `, hired ${employee.hireDate}` : ''}), so their withholding setup (W-4 and state form) is likely not entered yet; check it before approving.`
        : 'Check their W-4 and state withholding setup before approving.');
  }
  if (/\bwhy\b/.test(q) && /\b(higher|more|increase\w*|up|bigger|larger)\b/.test(q)) {
    const reasons = signals.filter(signal => PAY_RAISING.has(signal.kind));
    if (!reasons.length) return null;
    return [`${who(employee)}'s gross pay is ${dollars(employee.gross)}${multiLine(employee)}${pastGross ? ` vs ${pastGross} in the last ${past.length} runs` : ''}. The difference comes from:`,
      ...findingLines(reasons)].join('\n');
  }
  if (/\b(normal|usual|unusual|wrong|issue|issues|problem|problems|ok|okay|correct|right|anything|review)\b/.test(q)) {
    if (!signals.length) {
      return `Nothing unusual: the automated checks found no issues for ${who(employee)}. Their pay is normal and consistent with history`
        + ` (gross ${dollars(employee.gross)}${pastGross ? ` vs ${pastGross} in the last ${past.length} runs` : ''}).`;
    }
    const flagged = signals.filter(signal => signal.kind !== 'new hire');
    return [flagged.length ? `${who(employee)} needs review: the automated checks found ${plural(flagged.length, 'issue')}.`
      : `Nothing wrong was found for ${who(employee)}; they are a new hire (information only).`, ...findingLines(signals)].join('\n');
  }
  if (/\b(why|explain|how come|reason)\b/.test(q)) return null;

  const fields = [
    [/\bovertime hours\b|\bhours of overtime\b|\bhow many overtime\b|\bovertime\b.*\bhours\b/, () =>
      `${who(employee)} worked ${money(employee.hours.overtime)} overtime hours${multiLine(employee)} this run.`],
    [/\bovertime\b/, () => `${who(employee)} receives ${dollars(employee.earnings.overtime)} in overtime pay${multiLine(employee)} this run (${money(employee.hours.overtime)} overtime hours).`],
    [/\bregular hours\b/, () => `${who(employee)} is paid for ${money(employee.hours.regular)} regular hours${multiLine(employee)} this run.`],
    [/\bnet\b|\btake home\b|\btake-home\b/, () => `${who(employee)}'s net pay this run is ${dollars(employee.net)}${multiLine(employee)}.`],
    [/\bgross\b/, () => `${who(employee)}'s gross pay this run is ${dollars(employee.gross)}${multiLine(employee)}.`],
    [/\b(hourly )?rate\b|\bsalary\b/, () => (employee.payType === 'hourly' && employee.hourlyRate != null
      ? `${who(employee)} is paid hourly at ${dollars(employee.hourlyRate)}/hour.`
      : `${who(employee)} is salaried at ${dollars(employee.periodSalary)} per pay period, not paid hourly.`)],
    [/\b401k\b|\bretirement\b/, () => `${who(employee)}'s 401(k) deduction this run is ${dollars(employee.deductions.retirement401k)}${multiLine(employee)}.`],
    [/\bhealth\b/, () => `${who(employee)}'s health deduction this run is ${dollars(employee.deductions.health)}${multiLine(employee)}.`],
    [/\bgarnish\w*/, () => `${who(employee)}'s garnishment this run is ${dollars(employee.deductions.garnishment)}.`],
    [/\btax\w*\b|\bwithh\w*/, () => `${dollars(taxTotal(employee.taxes))} is withheld from ${who(employee)}'s pay for taxes${multiLine(employee)}: `
      + `federal ${dollars(employee.taxes.federal)}, state ${dollars(employee.taxes.state)}, Social Security ${dollars(employee.taxes.socialSecurity)}, Medicare ${dollars(employee.taxes.medicare)}.`],
    [/\bbonus\b/, () => `${who(employee)}'s bonus this run is ${dollars(employee.earnings.bonus)}.`],
    [/\breimburse\w*/, () => `${who(employee)}'s reimbursement this run is ${dollars(employee.earnings.reimbursement)}.`],
    [/\bdepartment\b|\bteam\b|\bwork in\b/, () => `${who(employee)} works in ${employee.department}.`],
    [/\bterminat\w*/, () => (employee.terminationDate ? `${who(employee)} was terminated on ${employee.terminationDate}.` : `${who(employee)} has no termination date; their status is ${employee.employmentStatus}.`)],
    [/\bhired?\b|\bstart date\b|\bjoin\w*/, () => (employee.hireDate ? `${who(employee)} was hired on ${employee.hireDate}.` : `The payroll data has no hire date for ${who(employee)}.`)],
    [/\bpayment method\b|\bpaid by\b|\bdirect deposit\b|\bcheck\b/, () => `${who(employee)} is paid by ${employee.paymentMethod}.`],
  ];
  const match = fields.find(([pattern]) => pattern.test(q));
  return match ? match[1]() : null;
}

// Answers about the payrun as a whole.
function payrunAnswer(q, data) {
  const { run, employees, previous, sum, issues, infos, employeeCount, previousGross } = data;
  const t = run.totals;
  const compares = /\b(previous|prior|last (payrun|pay run|run)|since|compare\w*|changed?|increase\w*|decrease\w*|differ\w*|vs)\b/.test(q);
  const listEmployees = items => list(items.map(who));
  const reviewList = () => (issues.length
    ? [`The automated checks found ${plural(issues.length, 'issue')} for ${plural(new Set(issues.map(item => item.employeeId)).size, 'employee')} in ${run.id}; review them before approving.`,
      ...findingLines(issues),
      ...(infos.length ? [`Information only: ${list(infos.map(item => `${item.employeeId} ${item.name} (${item.kind})`))}.`] : [])].join('\n')
    : `The automated checks found nothing unusual in ${run.id}.`);

  if (/\b(need|needs|require|requires) (review|attention|checking)\b|\bshould i (check|review|look at)\b|\bbefore approv\w*|\b(anything|something) (unusual|wrong|odd|suspicious)\b|\bred flags?\b|\banomal\w*|\bflagged\b/.test(q)) {
    return reviewList();
  }
  if (/\bpaid twice\b|\bduplicat\w*|\bdouble[- ]?(paid|payment)\b|\bpaid double\b/.test(q)) {
    const found = issues.filter(item => item.kind === 'duplicate payment');
    return found.length ? [`Yes: ${plural(found.length, 'employee is', 'employees are')} paid more than once in ${run.id}.`, ...findingLines(found)].join('\n')
      : `No: every employee has one pay line in ${run.id}.`;
  }
  if (/\bafter (their |the )?(termination|terminated)\b|\bterminated\b.*\bpaid\b|\bpaid after\b/.test(q)) {
    const found = issues.filter(item => item.kind === 'paid after termination');
    return found.length ? [`Yes: ${plural(found.length, 'employee is', 'employees are')} paid after their termination date.`, ...findingLines(found)].join('\n')
      : `No: nobody in ${run.id} is paid after a termination date.`;
  }
  if (/\bmissing\b/.test(q) && /\b(tax\w*|deduction\w*|withh\w*|401k|health)\b/.test(q)) {
    const found = issues.filter(item => /missing|no tax withholding/.test(item.kind));
    return found.length ? [`Yes: ${plural(found.length, 'tax or deduction is', 'taxes or deductions are')} missing compared with history.`, ...findingLines(found)].join('\n')
      : 'No: no taxes or deductions are missing compared with history.';
  }
  if (/\bno (federal|state)( income)? tax\b|\bno (federal |state )?(tax )?withh\w*|\bwithout (any )?(federal |state )?(tax|withh\w*)/.test(q)) {
    const field = /\bstate\b/.test(q) ? 'state' : 'federal';
    const found = employees.filter(employee => employee.gross > 0 && employee.taxes[field] === 0);
    return found.length ? `${plural(found.length, 'employee has', 'employees have')} no ${field} tax withheld: ${listEmployees(found)}.`
      : `Every employee has ${field} tax withheld this run.`;
  }

  if (compares && previous) {
    const change = (now, before) => `${now >= before ? 'up' : 'down'} ${dollars(Math.abs(now - before))}`;
    const changes = employees.map(employee => ({ employee, before: previousGross(employee.employeeId), isNew: !previous.lines.some(line => line.employeeId === employee.employeeId) }))
      .map(item => ({ ...item, delta: money(item.employee.gross - item.before) }))
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    const signedDelta = value => `${value >= 0 ? '+' : '-'}${dollars(Math.abs(value))}`;
    const changeLine = item => `- ${who(item.employee)}: gross ${dollars(item.employee.gross)} vs ${dollars(item.before)} (${signedDelta(item.delta)})${item.isNew ? ', not in the previous run' : ''}`;
    const newOnes = changes.filter(item => item.isNew).map(item => item.employee);
    if (/\bgross\b/.test(q) && !/\bnet\b/.test(q) && /\b(how much|by how much|increase\w*|decrease\w*|change\w*|differ\w*)\b/.test(q)) {
      return `Gross pay is ${dollars(t.gross)}, ${change(t.gross, previous.totals.gross)} from ${dollars(previous.totals.gross)} in ${previous.id}.`;
    }
    if (/\bnet\b/.test(q) && !/\bgross\b/.test(q) && /\b(how much|by how much|increase\w*|decrease\w*|change\w*|differ\w*)\b/.test(q)) {
      return `Net pay is ${dollars(t.net)}, ${change(t.net, previous.totals.net)} from ${dollars(previous.totals.net)} in ${previous.id}.`;
    }
    if (/\b(changed|change) the most\b|\b(biggest|largest) (change|increase|difference)\b/.test(q)) {
      const top = changes[0];
      return [`${who(top.employee)}'s pay changed the most since ${previous.id}: ${signedDelta(top.delta)}.`, ...changes.slice(0, 3).map(changeLine)].join('\n');
    }
    if (/\bnot in the (previous|prior|last)\b|\b(were|was)n?t in\b|\bnew (employees|people)\b|\bmissing from the (previous|prior|last)\b/.test(q)) {
      return newOnes.length ? `${plural(newOnes.length, 'employee was', 'employees were')} not in ${previous.id}: ${listEmployees(newOnes)}.`
        : `Every employee in ${run.id} was also in ${previous.id}.`;
    }
    if (/\bhow does\b.*\bcompare\b|\bwhat changed\b|\bwhat (is|are) the (differences?|changes?)\b|\bcompare\w*\b/.test(q)) {
      return [`Compared with ${previous.id}, gross pay is ${change(t.gross, previous.totals.gross)} (${dollars(t.gross)} vs ${dollars(previous.totals.gross)}) and net pay is ${change(t.net, previous.totals.net)} (${dollars(t.net)} vs ${dollars(previous.totals.net)}); pay lines ${t.employees} vs ${previous.totals.employees}.`,
        'Largest changes per employee:', ...changes.slice(0, 3).map(changeLine),
        ...(newOnes.length ? [`New since ${previous.id}: ${listEmployees(newOnes)}.`] : []),
        ...(issues.length ? [`The automated checks found ${plural(issues.length, 'issue')}; ask "Which payments need review?" for details.`] : [])].join('\n');
    }
    return null;
  }
  if (/\bfirst time\b|\bfirst pay\b|\bnew hires?\b|\bnewly hired\b/.test(q)) {
    const found = employees.filter(employee => !data.pastById.has(employee.employeeId));
    return found.length ? `${plural(found.length, 'employee is', 'employees are')} paid for the first time in ${run.id}: ${list(found.map(employee => `${who(employee)}${employee.hireDate ? ` (hired ${employee.hireDate})` : ''}`))}.`
      : `Nobody is paid for the first time in ${run.id}.`;
  }
  if (/\bterminat\w*/.test(q)) {
    const found = employees.filter(employee => employee.terminationDate || employee.employmentStatus === 'terminated');
    return found.length ? `${plural(found.length, 'employee was', 'employees were')} terminated: ${list(found.map(employee => `${who(employee)}${employee.terminationDate ? ` on ${employee.terminationDate}` : ''}`))}.`
      + (issues.some(item => item.kind === 'paid after termination') ? ' Note: the checks flag pay after a termination date; ask "Is anyone paid after their termination date?"' : '')
      : `Nobody in ${run.id} is terminated.`;
  }
  if (/\blive check\b|\bpaper check\b|\bby check\b/.test(q)) {
    const found = employees.filter(employee => /check/i.test(employee.paymentMethod));
    return found.length ? `${plural(found.length, 'employee is', 'employees are')} paid by live check: ${listEmployees(found)}.` : 'Nobody is paid by check this run.';
  }
  if (/\bdirect deposit\b/.test(q)) {
    const found = employees.filter(employee => /deposit/i.test(employee.paymentMethod));
    return `${plural(found.length, 'employee is', 'employees are')} paid by direct deposit: ${listEmployees(found)}.`;
  }
  if (/\bhourly\b/.test(q) && /\bsalar\w*/.test(q)) {
    const hourly = employees.filter(employee => employee.payType === 'hourly').length;
    return `${run.id} has ${hourly} hourly and ${employees.length - hourly} salaried employees (${plural(employees.length, 'unique employee')}).`;
  }
  if (/\bdepartment\b/.test(q)) {
    const costs = new Map();
    for (const line of run.lines) costs.set(line.department, money((costs.get(line.department) || 0) + line.gross));
    const named = [...costs.keys()].find(name => q.includes(name.toLowerCase()));
    if (named && !/\b(highest|most|largest|top|biggest)\b/.test(q)) return `The ${named} department costs ${dollars(costs.get(named))} in gross pay this run.`;
    if (/\b(highest|most|largest|top|biggest|costliest)\b/.test(q)) {
      const [top, cost] = [...costs].sort((a, b) => b[1] - a[1])[0];
      return `${top} has the highest payroll cost this run: ${dollars(cost)} in gross pay.`;
    }
    return null;
  }
  if (/\b(highest|most|largest|top|biggest)\b/.test(q)) {
    // Ranked by pay line (as in the payrun facts), so a duplicate line does not double a value.
    const top = (pick, label) => {
      const best = Math.max(...run.lines.map(pick));
      const found = employees.filter(employee => run.lines.some(line => line.employeeId === employee.employeeId && pick(line) === best));
      return `${list(found.map(who))} ${found.length === 1 ? 'has' : 'share'} the highest ${label}: ${dollars(best)}.`;
    };
    if (/\bhealth\b/.test(q)) return top(employee => employee.deductions.health, 'health deduction');
    if (/\b401k\b/.test(q)) return top(employee => employee.deductions.retirement401k, '401(k) deduction');
    if (/\bnet\b/.test(q)) return top(employee => employee.net, 'net pay');
    if (/\bgross\b|\bpaid\b|\bearn\w*/.test(q)) return top(employee => employee.gross, 'gross pay');
    return null;
  }
  if (/\bovertime\b/.test(q)) {
    const found = employees.filter(employee => employee.hours.overtime > 0).sort((a, b) => b.hours.overtime - a.hours.overtime);
    if (/\bwho\b|\bwhich employees\b/.test(q)) {
      return found.length ? `${plural(found.length, 'employee')} worked overtime this run: ${list(found.map(employee => `${who(employee)} (${money(employee.hours.overtime)} hours${data.multiLine(employee)})`))}.`
        : 'Nobody worked overtime this run.';
    }
    if (/\bhours\b/.test(q)) return `${money(sum(line => line.hours.overtime))} overtime hours were worked in total this run.`;
    if (/\bpay\b|\bhow much\b|\bcost\b/.test(q)) return `This payrun includes ${dollars(sum(line => line.earnings.overtime))} of overtime pay (${money(sum(line => line.hours.overtime))} hours).`;
    return null;
  }
  if (/\bregular hours\b/.test(q)) return `${money(sum(line => line.hours.regular))} regular hours are paid this run.`;
  if (/\bgarnish\w*/.test(q)) {
    const found = employees.filter(employee => employee.deductions.garnishment > 0);
    return found.length ? `${plural(found.length, 'employee has', 'employees have')} a wage garnishment: ${list(found.map(employee => `${who(employee)} (${dollars(employee.deductions.garnishment)})`))}.`
      : 'No garnishments: no employee has a wage garnishment this run ($0.00 in total).';
  }

  const totalAsked = /\b(total|how much|in total|overall|sum|all)\b/.test(q);
  if (/\bemployer tax\w*/.test(q)) return t.employerTaxes != null ? `Employer taxes total ${dollars(t.employerTaxes)} for ${run.id}.` : null;
  if (/\bsocial security\b|\bmedicare\b/.test(q) && totalAsked) {
    return `Social Security withholding totals ${dollars(sum(line => line.taxes.socialSecurity))} and Medicare ${dollars(sum(line => line.taxes.medicare))} this run.`;
  }
  if (/\bfederal\b/.test(q) && totalAsked) return `Federal income tax withheld totals ${dollars(sum(line => line.taxes.federal))} this run.`;
  if (/\bstate\b/.test(q) && /\btax\w*/.test(q) && totalAsked) return `State tax withheld totals ${dollars(sum(line => line.taxes.state))} this run.`;
  if (/\b(tax|taxes)\b/.test(q) && (totalAsked || /\bwithh\w*/.test(q))) {
    return `${dollars(t.taxes)} of employee tax is withheld in ${run.id}: federal ${dollars(sum(line => line.taxes.federal))}, state ${dollars(sum(line => line.taxes.state))}, `
      + `Social Security ${dollars(sum(line => line.taxes.socialSecurity))}, Medicare ${dollars(sum(line => line.taxes.medicare))}.`;
  }
  if (/\bhealth\b/.test(q) && totalAsked) return `Health insurance deductions total ${dollars(sum(line => line.deductions.health))} this run.`;
  if (/\b401k\b|\bretirement\b/.test(q) && totalAsked) return `401(k) deductions total ${dollars(sum(line => line.deductions.retirement401k))} this run.`;
  if (/\bdeductions?\b/.test(q) && totalAsked) {
    return `Deductions total ${dollars(t.deductions)} in ${run.id}: health ${dollars(sum(line => line.deductions.health))}, 401(k) ${dollars(sum(line => line.deductions.retirement401k))}, garnishments ${dollars(sum(line => line.deductions.garnishment))}.`;
  }
  if (/\bgross\b/.test(q) && (totalAsked || /\bthis (payrun|pay run|run)\b/.test(q))) return `The total gross pay for ${run.id} is ${dollars(t.gross)}.`;
  if (/\bnet\b/.test(q) && (totalAsked || /\bthis (payrun|pay run|run)\b/.test(q))) return `The total net pay for ${run.id} is ${dollars(t.net)}.`;
  if (/\bhow many (employees|people|workers|staff)\b/.test(q)) {
    const repeated = employees.filter(employee => employee.lines > 1);
    return `${run.id} pays ${employeeCount}${repeated.length ? `; ${list(repeated.map(employee => `${who(employee)} has ${employee.lines}`))}` : ''}.`;
  }
  if (/\bpay ?date\b|\bwhen\b.*\b(paid|pay day|payday)\b|\bwhen is (the )?pay\b/.test(q)) return `The pay date for ${run.id} is ${run.payDate}.`;
  if (/\b(pay )?period\b|\bcover\w*/.test(q)) return `${run.id} covers the pay period ${run.periodStart} to ${run.periodEnd}${run.frequency ? ` (${run.frequency})` : ''}.`;
  if (/\bstatus\b/.test(q)) return `${run.id} is ${humanStatus(run.status)} (status ${run.status}).`;
  if (/^(summari[sz]e|give me a summary|summary|overview)\b|\bsummar(y|ize|ise) (of )?this\b/.test(q)) {
    return [`${run.id} (${run.name}) pays ${employeeCount} on ${run.payDate}: gross ${dollars(t.gross)}, employee taxes ${dollars(t.taxes)}, deductions ${dollars(t.deductions)}, net ${dollars(t.net)}`
      + `${t.employerTaxes != null ? `, employer taxes ${dollars(t.employerTaxes)}` : ''}. Status: ${humanStatus(run.status)}.`,
    ...(previous ? [`Compared with ${previous.id}, gross is ${t.gross >= previous.totals.gross ? 'up' : 'down'} ${dollars(Math.abs(t.gross - previous.totals.gross))}.`] : []),
    issues.length ? `The automated checks found ${plural(issues.length, 'issue')} (${list([...new Set(issues.map(item => item.name))])}); ask "Which payments need review?" for details.`
      : 'The automated checks found nothing unusual.'].join('\n');
  }
  return null;
}

// Returns { reply, intent } when the question can be answered exactly from the data, else null.
function answerFromData(question, context) {
  if (!context?.payrun?.lines?.length) return null;
  const q = normalize(question);
  if (/^(please |can you |could you |would you )?(approve|submit|process|run|pay|change|update|edit|delete|fix|remove|cancel|reject)\b/.test(q)) {
    return { intent: 'action-declined', reply: "I can't take actions on payroll: I can only explain and flag. To approve or change this payrun, use the payroll page." };
  }
  if (/\bsocial security numbers?\b|\bssn\b|\bbank (account|details)\b|\baccount numbers?\b|\brouting numbers?\b|\b(home|mailing) address\b|\bdate of birth\b|\bphone numbers?\b/.test(q)) {
    return { intent: 'not-available', reply: 'That information is not available here: the payroll data I can see does not include Social Security numbers, bank details, addresses, or other personal identifiers.' };
  }
  // Definitions and general guidance are the model's job.
  if (/\b(mean|means|meaning|difference between|usually|typically|in general|definition|define|what is fica|explain)\b/.test(q)) return null;
  const data = build(context);
  const named = mentioned(q, data.employees);
  let reply;
  if (named.length > 1) return null;
  if (named.length === 1) reply = employeeAnswer(q, named[0], data);
  else if (/\b(he|she|his|her|him|they|their|them|that|those)\b/.test(q)) return null; // Resolve conversational references first.
  else reply = payrunAnswer(q, data);
  return reply ? { intent: named.length ? 'employee' : 'payrun', reply } : null;
}

module.exports = { answerFromData, normalize, mentioned, employeesOf };
