const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ConversationStore } = require('./redisStore');
const { runQuestionFlow, questionCatalogue } = require('./rag/questionFlow');
const fixture = require('./fixtures/payrun-PR-2026-09-B.json');

const args = { agent: { id: 'agent-1', name: 'Payroll review', templateId: 'anomaly-detection' },
  config: { service: 'payrun', questions: ['Why did overtime change for this employee?'], instructions: 'Explain the evidence.' },
  domainName: 'payroll-services', question: 'Why did Luis Ortega work more overtime?',
  invocation: { page: 'payrun', payrunId: fixture.payrun.id, employeeId: 'E1002' },
  model: { id: 'answer', name: 'Answer', provider: 'huggingface', modelId: 'answer-model', credentialEnv: 'HF_TOKEN' } };

function memoryRedis() {
  const values = new Map();
  return { values, get: async key => values.get(key), expire: async () => 1,
    set: async (key, value, options) => { if (options?.NX && values.has(key)) return null; values.set(key, value); return 'OK'; },
    eval: async (script, { keys, arguments: valuesIn }) => {
      if (values.get(keys[0]) !== valuesIn[0]) return 0;
      if (keys.length === 2) values.set(keys[1], valuesIn[1]); else values.delete(keys[0]);
      return 1;
    } };
}
function harness() {
  const client = memoryRedis(), store = new ConversationStore({ client });
  const calls = { payroll: 0, models: [], searches: [] };
  let docs;
  const deps = {
    env: { HF_TOKEN: 'unit-test-only' },
    questionStore: { indexQuestions: async () => {}, search: async ({ questions }) => questions.slice(0, 3).map(item => ({ ...item, distance: .1 })) },
    loadContext: async () => { calls.payroll++; return { current: fixture.payrun, history: fixture.payrunHistory.map(run => ({
      ...fixture.payrun, ...run, status: 'COMPLETED', periodStart: '2026-08-01', periodEnd: '2026-08-15',
      lines: run.lines.map(line => ({ ...fixture.payrun.lines.find(current => current.employeeId === line.employeeId), ...line })),
    })) }; },
    vectorStore: { indexDocuments: async items => { docs = items; }, search: async options => {
      calls.searches.push(options);
      return docs.filter(item => options.employeeIds.includes(item.employeeId) && options.topics.includes(item.topic)).slice(0, 3).map(item => ({ ...item, distance: .2 }));
    } },
    fetchImpl: async (url, request) => {
      const body = JSON.parse(request.body), data = JSON.parse(body.messages[1].content); calls.models.push({ body, data });
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ answer: 'Overtime increased relative to the supplied historical payments.',
        sourceIds: data.sources.map(item => item.id), findings: data.evidence.findings.map(item => ({ findingId: item.id,
          explanation: 'The supplied evidence shows a historical difference.', reviewAction: 'Review approved timesheets.' })) }) } }] }) };
    },
  };
  const options = { scope: { domainName: args.domainName, agentId: args.agent.id, owner: 'browser', channel: 'payroll' },
    context: args.invocation, question: args.question, requestId: 'propose' };
  const run = (overrides = {}, flowArgs = args, dependencies = deps) => store.run({ ...options, ...overrides },
    state => runQuestionFlow({ ...flowArgs, confirmation: overrides.confirmation }, state, dependencies));
  return { client, calls, deps, options, run };
}

test('query matching pauses before payroll retrieval and LLM; confirmation retrieves scoped history and processes one answer call', async () => {
  const h = harness();
  const proposal = await h.run();
  assert.equal(proposal.status, 'confirmation_required');
  assert.equal(proposal.questionMapping.candidates[0].text, args.config.questions[0]);
  assert.equal(h.calls.payroll, 0); assert.equal(h.calls.models.length, 0); assert.equal(h.calls.searches.length, 0);
  const key = `payroll:session:${proposal.session.id}`;
  assert.deepEqual(JSON.parse(h.client.values.get(key)).history, []);
  const confirmation = { mappingId: proposal.questionMapping.id, questionId: proposal.questionMapping.candidates[0].id };
  const options = { sessionId: proposal.session.id, requestId: 'confirm', confirmation };
  const answer = await h.run(options);
  assert.equal(answer.status, 'answered');
  assert.equal(answer.analysis.modelStatus, 'completed');
  assert.equal(answer.mappedQuestion.text, args.config.questions[0]);
  assert.equal(h.calls.models.length, 1); // No intent LLM before or after confirmation.
  assert.match(h.calls.searches[0].query, /Why did overtime change/);
  assert.deepEqual(h.calls.searches[0].employeeIds, ['E1002']);
  assert.ok(answer.retrieval.sources.every(item => item.employeeId === 'E1002' && item.topic === 'overtime'));
  assert.equal(h.calls.models[0].data.mappedQuestion.text, args.config.questions[0]);
  assert.ok(h.calls.models[0].data.sources.length);
  assert.match(answer.reply, /Historical sources:\n1\. Payrun/);
  assert.deepEqual(answer.analysis.modelAnswer.sources.map(item => item.id), answer.analysis.modelAnswer.sourceIds);
  const state = JSON.parse(h.client.values.get(key));
  assert.equal(state.pendingQuestion, null); assert.equal(state.history.length, 2);
  assert.equal(state.history[0].content, args.question);
  assert.equal(state.history[1].content, answer.reply, 'only the postprocessed answer is saved');
  assert.equal((await h.run(options)).reply, answer.reply);
  assert.equal(h.calls.models.length, 1, 'a retried confirmation cannot run a second model call');
});

test('confirmation discards invalid model citations before saving the reply to the conversation', async () => {
  const h = harness(), proposal = await h.run();
  const confirmation = { mappingId: proposal.questionMapping.id, questionId: proposal.questionMapping.candidates[0].id };
  const originalFetch = h.deps.fetchImpl;
  h.deps.fetchImpl = async (...input) => {
    const response = await originalFetch(...input), body = await response.json();
    const value = JSON.parse(body.choices[0].message.content);
    value.answer = 'UNSUPPORTED MODEL NARRATIVE';
    value.sourceIds = ['invented-source'];
    body.choices[0].message.content = JSON.stringify(value);
    return { ...response, json: async () => body };
  };
  const result = await h.run({ sessionId: proposal.session.id, requestId: 'invalid-confirm', confirmation });
  assert.equal(result.status, 'answered');
  assert.equal(result.analysis.modelStatus, 'invalid_response');
  assert.equal(result.analysis.modelAnswer, null);
  assert.ok(result.analysis.findings.length);
  assert.ok(result.retrieval.sources.every(source => !source.cited));
  assert.doesNotMatch(result.reply, /UNSUPPORTED MODEL NARRATIVE|invented-source/);
  const state = JSON.parse(h.client.values.get(`payroll:session:${proposal.session.id}`));
  assert.equal(state.history[1].content, result.reply);
  assert.doesNotMatch(JSON.stringify(state), /UNSUPPORTED MODEL NARRATIVE|invented-source/);
  assert.equal(h.calls.models.length, 1);
});

test('confirmation rejects forged, stale, cross-browser and changed-scope requests without running retrieval', async () => {
  const h = harness(), proposal = await h.run();
  const options = { sessionId: proposal.session.id, requestId: 'confirm',
    confirmation: { mappingId: proposal.questionMapping.id, questionId: proposal.questionMapping.candidates[0].id } };
  const bad = [
    { ...options, confirmation: { ...options.confirmation, questionId: 'forged' } },
    { ...options, confirmation: { ...options.confirmation, mappingId: 'forged' } },
    { ...options, scope: { ...h.options.scope, owner: 'other-browser' } },
    { ...options, context: { ...args.invocation, employeeId: 'E1001' } },
  ];
  for (const input of bad) await assert.rejects(h.run(input), error => [400, 409].includes(error.status));
  await assert.rejects(h.run(options, { ...args, question: 'Different query' }), /expired or changed/);
  await assert.rejects(h.run(options, { ...args, config: { ...args.config, instructions: 'Changed configuration' } }), /expired or changed/);
  await assert.rejects(h.run(options, args, { ...h.deps, now: () => Date.now() + 11 * 60 * 1000 }), /expired or changed/);
  assert.equal(h.calls.payroll, 0); assert.equal(h.calls.models.length, 0);
  await h.run({ sessionId: proposal.session.id, requestId: 'replacement' });
  await assert.rejects(h.run(options), /expired or changed/);
});

test('failed question lookup has no fallback inference and cannot save a fabricated proposal', async () => {
  const h = harness();
  await assert.rejects(h.run({}, args, { ...h.deps, questionStore: { indexQuestions: async () => { throw new Error('secret database detail'); } } }),
    error => error.status === 503 && !error.message.includes('secret database detail'));
  assert.equal([...h.client.values.keys()].filter(key => !key.endsWith(':lock')).length, 0);
  assert.equal(h.calls.payroll, 0);
  await assert.rejects(runQuestionFlow(args, { history: [] }, h.deps), /requires conversation storage/);
});

test('catalogue combines configured and shared questions, deduplicates and isolates agent/domain scopes', () => {
  const questions = questionCatalogue({ ...args, config: { ...args.config, questions: ['Which payments need review?', '  Which payments need review?  '] } });
  assert.equal(questions.filter(item => item.text === 'Which payments need review?').length, 1);
  assert.ok(questions.some(item => item.text === 'What is the total net pay for this payrun?'));
  assert.notEqual(questions[0].scope, questionCatalogue({ ...args, domainName: 'other-domain' })[0].scope);
  assert.notEqual(questions[0].scope, questionCatalogue({ ...args, agent: { ...args.agent, id: 'other-agent' } })[0].scope);
});
