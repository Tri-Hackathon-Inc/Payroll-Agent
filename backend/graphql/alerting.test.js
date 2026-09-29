// Tests for what goes to the model (contextScope) and the severity-based incident trigger
// (findingPolicy, incidentTrigger, webhook raiseIncidents), on the sample payrun PR-2026-09-B.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectSignals, formatContext } = require('./payrunContext');
const { scopeContext, selectEmployees } = require('./contextScope');
const { severityOf, amountAtRisk } = require('./findingPolicy');
const { createIncidentStore, planIncidents } = require('./incidentTrigger');
const { raiseIncidents } = require('./webhook');
const sample = require('./fixtures/payrun-PR-2026-09-B.json');

const context = {
  payrunId: sample.payrun.id, payrun: sample.payrun, history: sample.payrunHistory,
  signals: detectSignals(sample.payrun, sample.payrunHistory), text: formatContext(sample.payrun, sample.payrunHistory),
};
const severities = () => Object.fromEntries(context.signals.map(signal => [`${signal.employeeId} ${signal.kind}`, signal.severity]));

test('each finding has a severity and amount at risk from one shared policy', () => {
  assert.deepEqual(severities(), {
    'E1002 overtime outlier': 'warning',
    'E1004 bonus outlier': 'critical', // $24,150 at risk is above the $5,000 limit.
    'E1005 duplicate payment': 'critical',
    'E1006 paid after termination': 'critical',
    'E1007 health deduction missing': 'warning',
    'E1008 reimbursement outlier': 'warning',
    'E1009 no tax withholding': 'critical',
    'E1009 new hire': 'info',
  });
  assert.equal(context.signals.find(signal => signal.kind === 'bonus outlier').amountAtRisk, 24150);
  assert.equal(severityOf('reimbursement outlier', 5000.01), 'critical');
  assert.equal(amountAtRisk('overtime outlier', [], []), null);
  assert.match(context.text, /E1005 Aisha Karim: duplicate payment \(critical, \$2,197\.00 at risk\)/);
});

test('the model gets only the pay lines a question needs; totals, facts, and findings stay', () => {
  const scoped = question => scopeContext(context, question);
  const concept = scoped('What is FICA?');
  assert.equal(concept.scope.linesSent, 0);
  assert.doesNotMatch(concept.text, /E1001/);
  assert.match(concept.text, /Totals: 10 pay lines/);

  const named = scoped("Why are Daniel Brooks's taxes so high this run?");
  assert.deepEqual([named.scope.kind, named.scope.linesSent], ['named employees', 1]);
  assert.match(named.text, /- E1004 Daniel Brooks \(Sales/);
  assert.doesNotMatch(named.text, /- E1001 Maya Chen \(/);
  assert.match(named.text, /Payrun facts[\s\S]*Findings from automated checks/);

  const review = scoped('Which employees look risky and why?');
  assert.equal(review.scope.kind, 'flagged employees');
  assert.doesNotMatch(review.text, /- E1001 Maya Chen \(/, 'unflagged employees are left out');
  assert.equal(scoped('What will the weather be tomorrow?').scope.kind, 'whole run', 'a small run is sent whole');

  const large = { ...context, payrun: { ...context.payrun, lines: Array.from({ length: 5 }, () => context.payrun.lines).flat() } };
  assert.equal(selectEmployees('Tell me something interesting.', large).kind, 'flagged employees', 'a large run sends flagged lines');
});

test('critical findings are raised once, warnings are suggested, and alerts can be turned off', () => {
  const plan = planIncidents({ signals: context.signals, alerts: { enabled: true, severity: 'warning' } });
  assert.deepEqual(plan.toRaise.map(signal => signal.employeeId), ['E1004', 'E1005', 'E1006', 'E1009']);
  assert.deepEqual(plan.suggested.map(signal => signal.employeeId), ['E1002', 'E1007', 'E1008']);
  assert.deepEqual(planIncidents({ signals: context.signals, alerts: { enabled: true, severity: 'critical' } }).suggested, []);
  assert.equal(planIncidents({ signals: context.signals, alerts: { enabled: false, severity: 'warning' } }), null);
  assert.deepEqual(planIncidents({ signals: context.signals, alerts: { enabled: true }, raised: new Set(['E1005|duplicate payment']) })
    .toRaise.map(signal => signal.employeeId), ['E1004', 'E1006', 'E1009'], 'already-raised findings are skipped');
});

test('an anomaly agent hands new critical findings to the Incident Report agent automatically', async () => {
  const store = createIncidentStore();
  const reports = [];
  const deps = {
    store,
    loadContext: async () => context,
    findIncidentAgent: async () => ({ agent: { id: 'inc-1', name: 'Incident bot' }, config: {}, model: null }),
    createReport: async request => { reports.push(request); return { reply: 'Incident INC-1 created.', incident: { id: 'INC-1', severity: 'critical' } }; },
  };
  const request = { agent: { name: 'Anomaly bot' }, config: { capabilities: { alerts: { enabled: true, severity: 'warning' } } },
    invocation: { page: 'payrun', payrunId: 'PR-2026-09-B' }, domainName: 'payroll-services', question: 'Which payments need review?' };

  const first = await raiseIncidents(request, deps);
  assert.equal(first.raised.incident.id, 'INC-1');
  assert.deepEqual(first.raised.findings.map(item => item.employeeId), ['E1004', 'E1005', 'E1006', 'E1009']);
  assert.deepEqual(first.suggested.map(item => item.employeeId), ['E1002', 'E1007', 'E1008']);
  const handoff = reports[0].invocation.handoff;
  assert.equal(handoff.trigger, 'automatic');
  assert.match(handoff.conversation[0].text, /4 critical findings[\s\S]*E1005 Aisha Karim: duplicate payment/);
  assert.doesNotMatch(handoff.conversation[0].text, /Luis Ortega/, 'warnings are not raised automatically');

  const second = await raiseIncidents(request, deps);
  assert.equal(second.raised, null, 'the same findings are not raised twice');
  assert.equal(second.alreadyRaised, 4);
  assert.equal(second.review, true, 'a review question shows suggestions and raised incidents');
  assert.equal((await raiseIncidents({ ...request, question: 'What is FICA?' }, deps)).review, false, 'other questions do not');
  assert.equal(reports.length, 1);

  const noAgent = await raiseIncidents(request, { ...deps, store: createIncidentStore(), findIncidentAgent: async () => null });
  assert.match(noAgent.note, /no Incident Report agent/);
  assert.equal(await raiseIncidents({ ...request, invocation: { ...request.invocation, answerMode: 'model' } }, deps), null, 'benchmarks never raise incidents');
});

test('concurrent triggers raise each finding once, and a failed incident releases its claim for a retry', async () => {
  const store = createIncidentStore();
  let reports = 0, fail = true;
  const deps = {
    store,
    loadContext: async () => context,
    findIncidentAgent: async () => ({ agent: { id: 'inc-1', name: 'Incident bot' }, config: {}, model: null }),
    createReport: async () => {
      if (fail) throw new Error('capture service down');
      reports += 1;
      await new Promise(resolve => setTimeout(resolve, 10));
      return { reply: 'ok', incident: { id: `INC-${reports}` } };
    },
  };
  const request = { agent: { name: 'Monitor' }, config: { capabilities: { alerts: { enabled: true, severity: 'critical' } } },
    invocation: { page: 'payrun', payrunId: 'PR-2026-09-B' }, domainName: 'payroll-services', reason: 'pay line changed', trigger: 'realtime' };
  const failed = await raiseIncidents(request, deps);
  assert.match(failed.note, /could not be created: capture service down/);
  assert.equal((await store.raisedKeys('payroll-services', 'PR-2026-09-B')).size, 0, 'the claim is released');

  fail = false;
  const [first, second] = await Promise.all([raiseIncidents(request, deps), raiseIncidents(request, deps)]);
  assert.equal(reports, 1, 'only one of two simultaneous triggers raises the incident');
  assert.equal([first, second].filter(result => result.raised).length, 1);
  assert.equal([first, second].find(result => !result.raised).alreadyRaised, 4);
});

test('the Postgres store claims findings with one atomic insert', async () => {
  const { createPostgresIncidentStore } = require('./incidentTrigger');
  const statements = [];
  const pool = { query: async (text, values) => {
    statements.push(text.replace(/\s+/g, ' ').trim());
    return { rows: /RETURNING/.test(text) ? values[2].slice(1).map(key => ({ finding_key: key })) : [] };
  } };
  const store = createPostgresIncidentStore(pool);
  assert.deepEqual(await store.claim('d', 'PR', ['E1|a', 'E2|b']), ['E2|b'], 'only newly inserted keys are claimed');
  assert.match(statements[0], /^CREATE TABLE IF NOT EXISTS payroll_incident_findings/);
  assert.match(statements[1], /INSERT INTO payroll_incident_findings .* ON CONFLICT DO NOTHING RETURNING finding_key/);
});
