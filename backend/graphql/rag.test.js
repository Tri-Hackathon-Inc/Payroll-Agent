const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PayrollRagPipeline, parseAnswer } = require('./rag/pipeline');
const { historyDocuments } = require('./rag/documents');
const { validateIntent, rules, resolveIntent } = require('./rag/intent');
const { AnomalyPreprocessor } = require('./anomalyPreprocessor');
const { vectorLiteral } = require('./rag/vectorStore');
const { PayrollAnswerPostprocessor } = require('./rag/postprocessor');

const line = (employeeId, gross, overtime = 0) => ({ employeeId, lineId: employeeId, name: employeeId === 'E1001' ? 'Maya Chen' : 'Luis Ortega',
  payType: 'hourly', employmentStatus: 'active', gross, net: gross * .7, hours: { regular: 80, overtime },
  earnings: { regular: gross, overtime: 10 * overtime, bonus: 0, reimbursement: 0 },
  deductions: { health: 100, retirement401k: 100, garnishment: 0 }, taxes: { federal: 100, state: 10, socialSecurity: 10, medicare: 10 } });
const current = { id: 'now', company: 'Demo', currency: 'USD', frequency: 'semi-monthly', version: 1,
  payDate: '2026-10-05', periodStart: '2026-09-16', periodEnd: '2026-09-30', status: 'PENDING_APPROVAL', lines: [line('E1001', 1000), line('E1002', 4000, 46)] };
const history = [1, 2, 3].map(i => ({ ...current, id: `old-${i}`, payDate: `2026-09-0${i}`, periodStart: '2026-08-16', periodEnd: '2026-08-31', status: 'COMPLETED', lines: [line('E1001', 1000), line('E1002', 2000, 4)] }));
const context = { current, history };
const args = { config: { service: 'payrun', instructions: 'Explain payroll evidence.' }, domainName: 'payroll-services',
  invocation: { page: 'payrun', payrunId: 'now' }, question: 'Why is Luis Ortega overtime higher?',
  model: { id: 'llama', name: 'Llama', provider: 'huggingface', modelId: 'answer-model', credentialEnv: 'HF_TOKEN', endpointEnv: 'HF_INFERENCE_BASE_URL' } };

function dependencies(options = {}) {
  let indexed;
  return { env: { HF_TOKEN: 'test-token', RAG_INTENT_MODEL_ID: 'intent-model' }, loadContext: async () => context,
    vectorStore: {
      indexDocuments: async docs => { indexed = docs; },
      search: async ({ employeeIds, topics }) => indexed.filter(doc => (!employeeIds.length || employeeIds.includes(doc.employeeId))
        && (!topics.length || topics.includes(doc.topic))).slice(0, 6).map(doc => ({ ...doc, distance: .1 })),
    },
    fetchImpl: async (url, request) => {
      const body = JSON.parse(request.body), input = JSON.parse(body.messages[1].content);
      const content = body.model === 'intent-model'
        ? { intent: 'explain_change', employeeIds: ['E1002'], topics: ['overtime'], searchQuery: 'Luis Ortega historical overtime hours' }
        : { answer: 'Overtime increased compared with the historical payments.', sourceIds: [input.sources[0].id],
          findings: input.evidence.findings.map(f => ({ findingId: f.id, explanation: 'Overtime exceeds its historical median.', reviewAction: 'Review approved time entries.' })) };
      options.onCall?.(body, input);
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) };
    }, ...options };
}

test('RAG uses separate intent and answer calls, employee/topic-filtered documents, and stable full-history evidence', async () => {
  const calls = [];
  const reply = await new PayrollRagPipeline(dependencies({ onCall: (body, input) => calls.push({ model: body.model, input }) })).run(args);
  assert.deepEqual(calls.map(call => call.model), ['intent-model', 'answer-model']);
  assert.equal(reply.analysis.modelStatus, 'completed');
  assert.ok(reply.retrieval.sources.every(source => source.employeeId === 'E1002' && source.topic === 'overtime'));
  assert.equal(reply.analysis.employees.length, 1);
  assert.equal(reply.analysis.findings[0].evidence.baseline, 4);
  assert.equal(reply.analysis.findings[0].evidence.historyCount, 3);
  assert.ok(reply.reply.startsWith('Overtime increased'));
  assert.equal(reply.analysis.modelAnswer.summary, 'Overtime increased compared with the historical payments.');
  assert.deepEqual(reply.analysis.modelAnswer.sourceIds, reply.retrieval.sources.filter(source => source.cited).map(source => source.id));
  assert.equal(calls[1].input.currentPayrun.employees.length, 1);
  assert.equal(calls[1].input.currentPayrun.employees[0].taxes.federal, 100);
  assert.equal(calls[1].input.currentPayrun.employees[0].hours.overtime, 46);
  assert.ok(reply.retrieval.sources.some(source => source.cited));
  assert.doesNotMatch(JSON.stringify(calls[1].input), /Maya Chen|test-token/);
});

test('follow-up rules retain employee focus and change the requested topic when intent inference is disconnected', async () => {
  const reply = await new PayrollRagPipeline(dependencies({ env: {} })).run({ ...args, question: 'What about their deductions?',
    conversation: { focus: { employeeIds: ['E1002'], topics: ['overtime'] }, history: [{ role: 'user', content: args.question }, { role: 'assistant', content: 'Overtime increased.' }] } });
  assert.deepEqual(reply.focus, { employeeIds: ['E1002'], topics: ['deductions'] });
  assert.equal(reply.retrieval.intent.status, 'rules');
  assert.ok(reply.retrieval.sources.every(source => source.topic === 'deductions' && source.employeeId === 'E1002'));
  assert.equal(reply.analysis.modelStatus, 'not_configured');
});

test('untrusted intent output cannot broaden an explicit employee selection', async () => {
  const reply = await new PayrollRagPipeline(dependencies()).run({ ...args, invocation: { ...args.invocation, employeeId: 'E1001' }, question: 'Explain this payment' });
  assert.equal(reply.retrieval.intent.status, 'rules_fallback');
  assert.deepEqual(reply.focus.employeeIds, ['E1001']);
  assert.ok(reply.retrieval.sources.every(source => source.employeeId === 'E1001'));
  assert.throws(() => validateIntent({ intent: 'anomaly_review', searchQuery: 'hi', employeeIds: ['foreign'], topics: [] }, [{ employeeId: 'E1001' }]), /Invalid intent/);
});

test('unavailable retrieval never calls the answer model and preserves deterministic review', async () => {
  const models = [];
  const reply = await new PayrollRagPipeline(dependencies({ onCall: body => models.push(body.model),
    vectorStore: { indexDocuments: async () => { throw new Error('private postgres details'); } } })).run(args);
  assert.deepEqual(models, ['intent-model']);
  assert.equal(reply.retrieval.status, 'unavailable');
  assert.equal(reply.retrieval.indexedDocuments, null);
  assert.match(reply.reply, /Overtime hours changed/);
  assert.doesNotMatch(reply.reply, /private postgres/);
});

test('unknown answer citations and missing finding comments are rejected', async () => {
  assert.throws(() => parseAnswer('{"answer":"Invented","sourceIds":["other"],"findings":[]}', [{ id: 'real' }]), /Invalid citations/);
  const deps = dependencies();
  const originalFetch = deps.fetchImpl;
  deps.fetchImpl = async (url, request) => JSON.parse(request.body).model === 'intent-model' ? originalFetch(url, request)
    : { ok: true, json: async () => ({ choices: [{ message: { content: '{"answer":"Invented","sourceIds":["other"],"findings":[]}' } }] }) };
  const reply = await new PayrollRagPipeline(deps).run(args);
  assert.equal(reply.analysis.modelStatus, 'invalid_response');
  assert.equal(reply.analysis.modelAnswer, null);
  assert.doesNotMatch(reply.reply, /Invented/);
  assert.ok(reply.retrieval.sources.every(source => !source.cited));
});

test('history document identities are stable, versioned on edits, and exclude future and cross-company data', () => {
  const evidence = new AnomalyPreprocessor().process(current, history);
  const scope = { domainName: 'payroll-services', service: 'payrun' };
  const first = historyDocuments(context, evidence, scope);
  assert.equal(first.length, 18);
  const later = historyDocuments({ ...context, current: { ...current, version: 2 } }, evidence, scope);
  assert.deepEqual(first.map(d => d.id), later.map(d => d.id));
  const edited = structuredClone(context);
  edited.history[0].lines[0].gross += 100;
  assert.notEqual(first[0].id, historyDocuments(edited, evidence, scope)[0].id);
  const excluded = historyDocuments({ current, history: [...history, { ...history[0], id: 'future', payDate: '2027-01-01' },
    { ...history[0], id: 'company', company: 'Foreign' }] }, evidence, scope);
  assert.equal(excluded.length, first.length);
  assert.notEqual(first[0].scope, historyDocuments(context, evidence, { ...scope, domainName: 'other' })[0].scope);
});

test('embedding serialization rejects corrupt dimensions, and all-employees queries clear inherited focus', () => {
  assert.throws(() => vectorLiteral([NaN], 1), /Invalid embedding/);
  assert.throws(() => vectorLiteral([1], 2), /Invalid embedding/);
  assert.equal(vectorLiteral([.1, .2], 2), '[0.1,0.2]');
  assert.deepEqual(rules('Review all employees', [], null, { employeeIds: ['E1002'], topics: ['overtime'] }).employeeIds, []);
});

test('an explicit all-employees question overrides a model retaining earlier employee focus', async () => {
  const intent = await resolveIntent({ question: 'Review overtime for all employees',
    employees: [{ employeeId: 'E1001' }, { employeeId: 'E1002' }], previousFocus: { employeeIds: ['E1002'] } }, dependencies());
  assert.equal(intent.status, 'model');
  assert.deepEqual(intent.employeeIds, []);
});

test('an employee without history still gets a model response grounded in current payrun information', async () => {
  const calls = [];
  const reply = await new PayrollRagPipeline(dependencies({
    loadContext: async () => ({ current, history: [] }),
    fetchImpl: async (url, request) => {
      const body = JSON.parse(request.body), input = JSON.parse(body.messages[1].content);
      calls.push(body.model);
      const content = body.model === 'intent-model'
        ? { intent: 'payroll_summary', searchQuery: 'Luis current pay', employeeIds: ['E1002'], topics: [] }
        : { answer: 'Luis has 46 overtime hours in this payrun. No historical payments are available for comparison.', sourceIds: [], findings: [] };
      if (body.model === 'answer-model') {
        assert.equal(input.currentPayrun.employees.length, 1);
        assert.equal(input.currentPayrun.employees[0].employeeId, 'E1002');
        assert.equal(input.evidence.employees[0].historyStatus, 'insufficient');
        assert.equal(input.retrievalStatus, 'no_results');
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) };
    },
  })).run({ ...args, invocation: { ...args.invocation, employeeId: 'E1002' }, question: 'Summarize this employee current pay.' });
  assert.deepEqual(calls, ['intent-model', 'answer-model']);
  assert.equal(reply.analysis.modelStatus, 'completed');
  assert.deepEqual(reply.analysis.modelAnswer.sourceIds, []);
  assert.equal(reply.analysis.findings.length, 0);
  assert.match(reply.reply, /No historical payments are available/);
});

test('postprocessing rejects the entire narrative if its finding coverage is incomplete', () => {
  const evidence = new AnomalyPreprocessor().process(current, history, { employeeId: 'E1002' });
  const source = { id: 'source-1' };
  const output = new PayrollAnswerPostprocessor().process(evidence, [source], { modelStatus: 'completed',
    text: JSON.stringify({ answer: 'Do not display this unsupported narrative.', sourceIds: [source.id], findings: [] }) });
  assert.equal(output.analysis.modelStatus, 'invalid_response');
  assert.equal(output.analysis.modelAnswer, null);
  assert.deepEqual(output.citedSourceIds, []);
  assert.equal(output.analysis.findings.length, evidence.findings.length);
  assert.doesNotMatch(output.reply, /unsupported narrative/);
  assert.throws(() => parseAnswer(JSON.stringify({ answer: 'Hidden\u0000text', sourceIds: [], findings: [] }), []), /Invalid answer/);
});
