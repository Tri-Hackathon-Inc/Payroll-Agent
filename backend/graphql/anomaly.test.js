const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AnomalyPreprocessor } = require('./anomalyPreprocessor');
const { AnomalyPostprocessor } = require('./anomalyPostprocessor');
const { answerQuestion } = require('./webhook');

const line = (employeeId, gross, overrides = {}) => ({ employeeId, lineId: `${employeeId}-line`, name: employeeId,
  payType: 'salary', employmentStatus: 'active', gross, net: gross * 0.75,
  hours: { overtime: 0 }, earnings: { bonus: 0 }, deductions: { health: 100, retirement401k: 100, garnishment: 0 }, ...overrides });
const run = (id, lines, overrides = {}) => ({ id, company: 'Test', currency: 'USD', frequency: 'semi-monthly',
  status: 'COMPLETED', periodStart: '2026-09-01', periodEnd: '2026-09-15', payDate: '2026-09-18', lines, ...overrides });
const current = (lines, overrides = {}) => run('current', lines, {
  status: 'PENDING_APPROVAL', periodStart: '2026-09-16', periodEnd: '2026-09-30', payDate: '2026-10-05', ...overrides });
const process = (now, history, options) => new AnomalyPreprocessor().process(now, history, options);
const history = [run('a', [line('E1', 1000)]), run('b', [line('E1', 1200)], { payDate: '2026-09-04', periodEnd: '2026-08-31' }),
  run('c', [line('E1', 9000)], { payDate: '2026-08-20', periodEnd: '2026-08-15' })];
const model = { id: 'llama', name: 'Llama', modelId: 'meta-llama/Llama-3.3-70B-Instruct', provider: 'huggingface',
  credentialEnv: 'HF_TOKEN', endpointEnv: 'HF_INFERENCE_BASE_URL', parameters: { max_tokens: 4096 } };
const input = { agent: { name: 'Review', template_id: 'anomaly-detection' }, config: { model: 'llama', instructions: 'Review pay.' },
  model, question: 'What changed?', invocation: { page: 'payrun', payrunId: 'current', employeeId: 'E1' } };
const loadContext = async () => ({ current: current([line('E1', 2400), line('PRIVATE-E2', 5000)]), history });
const env = { HF_TOKEN: 'test-secret' };
const response = body => ({ ok: true, json: async () => body });
const comments = findings => JSON.stringify({ findings: findings.map(f => ({ findingId: f.id,
  explanation: 'The calculated change exceeds the configured threshold.', reviewAction: 'Check the approved pay adjustment.' })) });

test('median history is grouped by employee ID and excludes incomplete, future, overlapping and incompatible runs', () => {
  const unrelated = run('unrelated', [line('E2', 10000, { name: 'Same name' })]);
  const invalid = [run('pending', [line('E1', 1)], { status: 'PENDING_APPROVAL' }),
    run('future', [line('E1', 1)], { payDate: '2026-11-01' }),
    run('overlap', [line('E1', 1)], { periodEnd: '2026-09-20' }),
    ...['currency', 'company', 'frequency'].map(key => run(key, [line('E1', 1)], { [key]: 'different' })),
    run('type', [line('E1', 1, { payType: 'hourly' })])];
  const result = process(current([line('E1', 2400)]), [...history, history[0], unrelated, ...invalid]);
  const gross = result.findings.find(f => f.code === 'gross_change');
  assert.equal(gross.evidence.baseline, 1200);
  assert.equal(gross.evidence.delta, 1200);
  assert.equal(gross.evidence.percentChange, 100);
  assert.equal(gross.evidence.historyCount, 3);
  assert.deepEqual(gross.evidence.history.map(h => h.payrunId), ['a', 'b', 'c']);
});

test('employee selection excludes all other employees, and rejects unknown or malformed IDs', () => {
  const now = current([line('E1', 2400), line('E2', 100)]);
  const result = process(now, history, { employeeId: 'E1' });
  assert.equal(result.employees.length, 1);
  assert.ok(result.findings.every(f => f.employeeId === 'E1'));
  assert.throws(() => process(now, history, { employeeId: 'missing' }), /not in this payrun/);
  assert.throws(() => process(now, history, { employeeId: 123 }), /nonempty string/);
});

test('multiple lines are aggregated, cent arithmetic is stable, and zero baselines do not invent percentages', () => {
  const now = current([line('E1', 0.1), line('E1', 0.2, { lineId: 'second', earnings: { bonus: 500 } })]);
  const result = process(now, [run('a', [line('E1', 0.3)])]);
  assert.equal(result.employees[0].current.gross, 0.3);
  assert.ok(!result.findings.some(f => f.code === 'gross_change'));
  assert.equal(result.findings.find(f => f.code === 'multiple_lines').evidence.lineCount, 2);
  const bonus = result.findings.find(f => f.code === 'bonus_change');
  assert.equal(bonus.evidence.baseline, 0);
  assert.equal(bonus.evidence.percentChange, null);
});

test('no history and missing values stay explicit; new hires are not treated as zero-pay history', () => {
  const result = process(current([line('new', 1000, { employmentStatus: 'new-hire', net: null })]), history);
  assert.equal(result.employees[0].historyStatus, 'insufficient');
  assert.deepEqual(result.employees[0].missingFields, ['net']);
  assert.deepEqual(result.findings, []);
  const answer = new AnomalyPostprocessor().process(result);
  assert.match(answer.reply, /Insufficient history/);
  assert.doesNotMatch(answer.reply, /No configured thresholds/);
});

test('negative net, deductions, overtime and terminated pay are review indicators', () => {
  const result = process(current([line('E1', 1000, { net: -10, hours: { overtime: 40 },
    employmentStatus: 'terminated', terminationDate: '2026-09-10',
    deductions: { health: 0, retirement401k: 100, garnishment: 0 } })]), [history[0]]);
  for (const code of ['net_change', 'overtimeHours_change', 'health_change', 'negative_net', 'terminated_payment']) {
    assert.ok(result.findings.some(f => f.code === code), code);
  }
  assert.equal(result.employees[0].historyStatus, 'limited');
});

test('normal payments produce no finding and only the latest six completed runs are compared', () => {
  const runs = Array.from({ length: 9 }, (_, i) => run(`h${i}`, [line('E1', 1000)], { payDate: `2026-09-${String(i + 1).padStart(2, '0')}` }));
  const result = process(current([line('E1', 1000)]), runs);
  assert.equal(result.employees[0].historyCount, 6);
  assert.deepEqual(result.findings, []);
});

test('postprocessing rejects hallucinated, incomplete and malformed output without losing evidence', () => {
  const evidence = process(current([line('E1', 2400)]), history);
  for (const text of ['not json', '{"findings":[]}', '{"findings":[{"findingId":"invented","explanation":"x","reviewAction":"x"}]}',
    comments(evidence.findings).replace('"explanation":', '"current":1,"explanation":')]) {
    const result = new AnomalyPostprocessor().process(evidence, { text, modelStatus: 'completed' });
    assert.equal(result.analysis.modelStatus, 'invalid_response');
    assert.equal(result.analysis.findings.length, evidence.findings.length);
    assert.match(result.reply, /historical median 1200 USD/);
    assert.ok(result.analysis.findings.every(f => f.modelComment === null));
  }
});

test('anomaly webhook preprocesses, calls HF with a server token, and postprocesses employee-specific JSON', async () => {
  let seen;
  const result = await answerQuestion(input, { loadContext, env, fetchImpl: async (url, options) => {
    seen = { url, ...options, body: JSON.parse(options.body) };
    const prompt = JSON.parse(seen.body.messages[1].content);
    assert.doesNotMatch(options.body, /PRIVATE-E2|test-secret/);
    return response({ choices: [{ message: { content: comments(prompt.evidence.findings) } }], usage: { completion_tokens: 100 } });
  } });
  assert.equal(seen.url, 'https://router.huggingface.co/v1/chat/completions');
  assert.equal(seen.headers.Authorization, 'Bearer test-secret');
  assert.deepEqual(seen.body.response_format, { type: 'json_object' });
  assert.equal(result.analysis.modelStatus, 'completed');
  assert.match(result.reply, /Model explanation:/);
  assert.equal(result.analysis.findings[0].evidence.current, 2400);
  assert.equal(result.context.employeeId, 'E1');
  assert.doesNotMatch(JSON.stringify(result), /test-secret/);
});

test('missing keys, token rejection, timeout and malformed provider content preserve the calculated report', async () => {
  const cases = [
    { env: {}, fetchImpl: () => { throw new Error('Must not call provider'); }, status: 'not_configured' },
    { env, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: 'test-secret secret payroll' }) }), status: 'unavailable' },
    { env, fetchImpl: async () => { throw Object.assign(new Error('test-secret'), { name: 'TimeoutError' }); }, status: 'unavailable' },
    { env, fetchImpl: async () => response({ choices: [{ message: { content: 'unexpected text' } }] }), status: 'invalid_response' },
    { env, fetchImpl: async () => response({ choices: [{ message: { content: { bad: true } } }] }), status: 'unavailable' },
  ];
  for (const item of cases) {
    const result = await answerQuestion(input, { ...item, loadContext });
    assert.equal(result.analysis.modelStatus, item.status);
    assert.ok(result.analysis.findings.length);
    assert.doesNotMatch(JSON.stringify(result), /test-secret|secret payroll/);
  }
});

test('payroll load failure or absent payrun fails without making an unsupported model claim', async () => {
  await assert.rejects(answerQuestion(input, { env, loadContext: async () => { throw new Error('private details'); } }), /Payroll history could not be loaded/);
  await assert.rejects(answerQuestion(input, { env, loadContext: async () => null }), /Open a payrun/);
});
