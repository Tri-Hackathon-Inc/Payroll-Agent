const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildInteraction } = require('./interactionLog');
const { logInteraction } = require('./webhook');
const { detectSignals } = require('./payrunContext');

const fixture = require('./fixtures/payrun-PR-2026-09-B.json');
const payrunContext = { signals: detectSignals(fixture.payrun, fixture.payrunHistory) };
const invocation = { page: 'payrun', payrunId: 'PR-2026-09-B' };

test('a computed answer is recorded with the payrun findings and dollars at risk', () => {
  const record = buildInteraction({ question: 'Which payments need review?', invocation, source: 'trinet-payrun-mock',
    config: { model: 'poc-demo' }, payrunContext, latencyMs: 21.6,
    answer: { answeredBy: 'payroll-data', intent: 'payrun', metrics: { latencyMs: 20 }, session: { id: 'secret-session' } },
    incidentAlert: { raised: { incident: { id: 'INC-1' } }, suggested: [{}, {}, {}] } });
  assert.equal(record.answeredBy, 'payroll-data');
  assert.equal(record.latencyMs, 22);
  assert.equal(record.modelLatencyMs, null, 'no model time for a computed answer');
  assert.deepEqual(record.findings, { critical: 4, warning: 3, info: 1 });
  assert.ok(record.amountAtRisk > 0);
  assert.equal(record.incidentId, 'INC-1');
  assert.equal(record.suggestedCount, 3);
  assert.match(record.sessionId, /^[0-9a-f]{32}$/);
  assert.notEqual(record.sessionId, 'secret-session', 'session IDs are stored hashed');
});

test('model answers record tokens and the reply check; errors and acknowledgements are labelled', () => {
  const model = buildInteraction({ question: 'Why?', invocation, config: {}, latencyMs: 1200,
    answer: { answeredBy: 'model', model: { id: 'groq-gpt-oss-120b' }, metrics: { latencyMs: 1000, promptTokens: 1649, completionTokens: 339 },
      check: { checked: true, ok: false, unverifiedAmounts: ['$55,000'], unknownEmployees: [] } } });
  assert.equal(model.modelId, 'groq-gpt-oss-120b');
  assert.deepEqual([model.modelLatencyMs, model.promptTokens, model.completionTokens], [1000, 1649, 339]);
  assert.deepEqual([model.checkStatus, model.unverifiedCount], ['flagged', 1]);
  assert.equal(model.findings, null, 'no findings when the payrun was not loaded');

  const cached = buildInteraction({ question: 'Why?', answer: { answeredBy: 'model', cached: true, metrics: { latencyMs: 1000 } } });
  assert.equal(cached.modelLatencyMs, null, 'a cached answer made no model call');
  assert.equal(buildInteraction({ question: 'Hi', answer: { reply: 'received' } }).answeredBy, 'acknowledged');
  const failed = buildInteraction({ question: 'Hi', config: { model: 'groq-gpt-oss-120b' }, error: new Error('rate limit') });
  assert.deepEqual([failed.answeredBy, failed.modelId, failed.error], ['error', 'groq-gpt-oss-120b', 'rate limit']);
  assert.equal(buildInteraction({ question: 'x'.repeat(900) }).question.length, 500);
  const fingerprint = reply => buildInteraction({ question: 'Q', answer: { answeredBy: 'model', reply } }).answerHash;
  assert.match(fingerprint('Gross is $62,504.00.'), /^[0-9a-f]{32}$/);
  assert.equal(fingerprint('Gross is  $62,504.00.\n'), fingerprint('gross is $62,504.00.'), 'whitespace and case are not a different answer');
  assert.notEqual(fingerprint('Gross is $62,504.00.'), fingerprint('Gross is $62,000.00.'));
  assert.equal(failed.answerHash, '');
});

test('recording returns the interaction ID, and a failed write never breaks the chat', async () => {
  let sent;
  const id = await logInteraction({ domainName: 'payroll-services', agentId: 'a1', context: {}, question: 'Q', answer: { answeredBy: 'model' },
    record: async (root, args) => { sent = args; return 'answer-1'; } });
  assert.equal(id, 'answer-1');
  assert.equal(sent.domainName, 'payroll-services');
  assert.equal(sent.data.question, 'Q');
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await logInteraction({ domainName: 'd', agentId: 'a', context: {}, question: 'Q',
      record: async () => { throw new Error('gRPC down'); } }), null);
  } finally {
    console.warn = warn;
  }
});
