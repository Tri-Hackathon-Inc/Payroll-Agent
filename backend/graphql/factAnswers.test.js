const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { answerFromData } = require('./factAnswers');
const { checkReply } = require('./replyCheck');
const { createAnswerCache } = require('./answerCache');
const { detectSignals, formatContext } = require('./payrunContext');
const { answerQuestion } = require('./webhook');

// The sample payrun PR-2026-09-B and its three history runs, as the payroll API returns them.
const fixture = require('./fixtures/payrun-PR-2026-09-B.json');
const context = (payrun = fixture.payrun) => ({
  payrunId: payrun.id, payrun, history: fixture.payrunHistory,
  signals: detectSignals(payrun, fixture.payrunHistory), text: formatContext(payrun, fixture.payrunHistory),
});

// Local stand-in for the model provider.
const servers = [];
async function standIn(handler) {
  const server = http.createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(handler()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
after(() => servers.forEach(server => server.close()));

// Questions whose answer needs reasoning or general knowledge, so the model answers them.
const MODEL_QUESTIONS = [
  "Why are Daniel Brooks's taxes so high this run?", 'What is FICA?', 'How is overtime pay usually calculated?',
  'What is the difference between gross pay and net pay?', 'What does a semi-monthly pay frequency mean?',
  'What will the weather be tomorrow?',
];

const BANK = require('node:path').join(__dirname, '../../ui-payroll-agent/src/questionBank.js');
const hasBank = require('node:fs').existsSync(BANK); // The UI is not inside the backend image.

test('every question-bank answer computed from the data passes its checks; the rest go to the model', { skip: !hasBank && 'question bank not present' }, async () => {
  const { QUESTION_BANK } = await import(BANK);
  const toModel = [];
  for (const item of QUESTION_BANK.flatMap(group => group.questions)) {
    const answer = answerFromData(item.prompt, context());
    if (!answer) { toModel.push(item.prompt); continue; }
    const reply = answer.reply.toLowerCase();
    for (const check of item.checks) {
      const passed = check.anyOf ? check.anyOf.some(term => reply.includes(term.toLowerCase()))
        : !check.noneOf.some(term => reply.includes(term.toLowerCase()));
      assert.ok(passed, `${item.prompt} -> ${check.label}\n${answer.reply}`);
    }
  }
  assert.deepEqual(toModel, MODEL_QUESTIONS);
});

test('computed answers are identical every time and handle rephrasing', () => {
  const ask = question => answerFromData(question, context())?.reply;
  assert.equal(ask('Which payments need review?'), ask('Which payments need review?'));
  assert.match(ask('what is the take-home pay of E1002'), /E1002 Luis Ortega's net pay this run is \$3,251\.96\./);
  assert.match(ask("Ortega's overtime hours?"), /46 overtime hours/);
  assert.match(ask('Any red flags in this payrun?'), /7 issues for 7 employees/);
  assert.match(ask("What is Aisha Karim's net pay?"), /\$2,939\.06 across 2 pay lines/);
  assert.match(ask('Who is paid by direct deposit?'), /^7 employees are paid by direct deposit/);
});

test('ambiguous questions are left to the model rather than guessed', () => {
  const ask = question => answerFromData(question, context());
  assert.equal(ask('Compare Maya Chen and Priya Nair.'), null, 'several employees');
  assert.equal(ask('What about his taxes?'), null, 'a follow-up about someone named earlier');
  assert.equal(ask("What is John Smith's net pay?"), null, 'not an employee in this payrun');
  assert.equal(ask('Explain the overtime rules for Luis Ortega.'), null, 'general guidance');
  assert.equal(ask('Write a poem about payroll.'), null);
  assert.equal(answerFromData('What is the total gross pay?', null), null, 'no payroll data');
});

test('the reply check accepts figures from the data and flags invented ones', () => {
  const ok = checkReply('E1004 Daniel Brooks has a $25,000.00 bonus; gross is $62,504.', context());
  assert.equal(ok.ok, true);
  const bad = checkReply('E1004 Daniel Brooks is $24,100.00 above his highest bonus; E9999 was also paid.', context());
  assert.deepEqual(bad.unverifiedAmounts, ['$24,100.00']);
  assert.deepEqual(bad.unknownEmployees, ['E9999']);
  assert.equal(checkReply('Anything.', null).checked, false);
});

test('facts are answered without a model; model answers are checked, cached, and refreshed when the payrun changes', async () => {
  const agent = { id: 'a1', name: 'Payroll bot' };
  const config = { model: 'groq', service: 'payrun', instructions: 'Answer.' };
  const invocation = { page: 'payrun', payrunId: 'PR-2026-09-B' };
  const noModel = await answerQuestion({ agent, config, model: null, question: 'What is the total net pay?', invocation },
    { loadContext: async () => context() });
  assert.equal(noModel.answeredBy, 'payroll-data');
  assert.equal(noModel.reply, 'The total net pay for PR-2026-09-B is $44,610.40.');

  let calls = 0;
  const url = await standIn(() => { calls += 1; return { choices: [{ message: { content: `Brooks pays more tax because of the $25,000.00 bonus (call ${calls}); $999.00 extra.` } }] }; });
  const model = { id: 'groq', name: 'GPT-OSS', provider: 'openai-compatible', modelId: 'openai/gpt-oss-120b',
    endpointEnv: 'GROQ_BASE_URL', credentialEnv: 'GROQ_API_KEY', parameters: {} };
  const deps = payrun => ({ env: { GROQ_API_KEY: 'k', GROQ_BASE_URL: url }, loadContext: async () => context(payrun), cache: createAnswerCache() });
  const shared = deps();
  const question = "Why are Daniel Brooks's taxes so high?";
  const first = await answerQuestion({ agent, config, model, question, invocation }, shared);
  const again = await answerQuestion({ agent, config, model, question: `  why are daniel brooks's taxes so HIGH `, invocation }, shared);
  assert.equal(calls, 1, 'the repeated question is served from the cache');
  assert.equal(again.reply, first.reply);
  assert.equal(again.cached, true);
  assert.deepEqual(again.context.scope, first.context.scope, 'a cached answer still says what was sent');
  assert.equal(again.sent, undefined);
  assert.match(first.reply, /\n\nCheck before acting: \$999\.00 is not in the payroll data/);

  const edited = { ...fixture.payrun, version: fixture.payrun.version + 1 };
  await answerQuestion({ agent, config, model, question, invocation }, { ...shared, loadContext: async () => context(edited) });
  assert.equal(calls, 2, 'a new payrun version is answered afresh');

  const benchmark = await answerQuestion({ agent, config, model, question: 'What is the total net pay?', invocation: { ...invocation, answerMode: 'model' } }, shared);
  assert.equal(benchmark.answeredBy, 'model', 'answerMode "model" always asks the model');
});

test('review questions get the automated findings; one selected employee drills down; concepts skip retrieval', async () => {
  const anomalyAgent = { id: 'ad', name: 'Anomaly bot', templateId: 'anomaly-detection' };
  const config = { model: 'groq', service: 'payrun', instructions: 'Flag unusual payments.' };
  const invocation = { page: 'payrun', payrunId: 'PR-2026-09-B' };
  let modelCalls = 0;
  const url = await standIn(() => { modelCalls += 1; return { choices: [{ message: { content: 'FICA funds Social Security and Medicare (general guidance).' } }] }; });
  const model = { id: 'groq', name: 'GPT-OSS', provider: 'openai-compatible', modelId: 'openai/gpt-oss-120b',
    endpointEnv: 'GROQ_BASE_URL', credentialEnv: 'GROQ_API_KEY', parameters: {} };
  const deps = { env: { GROQ_API_KEY: 'k', GROQ_BASE_URL: url, REDIS_URL: 'redis://unused' }, loadContext: async () => context(),
    cache: createAnswerCache() };

  const review = await answerQuestion({ agent: anomalyAgent, config, model, question: 'Is anyone paid twice in this payrun?', invocation }, deps);
  assert.equal(review.answeredBy, 'payroll-data');
  assert.match(review.reply, /^Yes: 1 employee is paid more than once/);

  const concept = await answerQuestion({ agent: anomalyAgent, config, model, question: 'What is FICA?', invocation }, deps);
  assert.equal(concept.answeredBy, 'model', 'not the RAG or anomaly pipeline');
  assert.equal(modelCalls, 1);

  const { AnomalyDetectionPipeline } = require('./anomalyPipeline');
  const run = AnomalyDetectionPipeline.prototype.run;
  AnomalyDetectionPipeline.prototype.run = async () => ({ reply: 'drill-down' });
  try {
    const drill = await answerQuestion({ agent: anomalyAgent, config, model, question: 'Is anything unusual?',
      invocation: { ...invocation, employeeId: 'E1004' } }, { ...deps, env: { ...deps.env, REDIS_URL: '' } });
    assert.equal(drill.answeredBy, 'anomaly-pipeline', 'one selected employee gets the per-employee comparison');
  } finally {
    AnomalyDetectionPipeline.prototype.run = run;
  }
});

test('a first RAG question is cached per payrun version; follow-ups with history are not', async () => {
  const { PayrollRagPipeline } = require('./rag/pipeline');
  const run = PayrollRagPipeline.prototype.run;
  let calls = 0;
  PayrollRagPipeline.prototype.run = async () => { calls += 1; return { reply: `answer ${calls}`, analysis: { modelStatus: 'completed' } }; };
  try {
    const args = { agent: { id: 'g', name: 'Query bot', templateId: 'general-query' }, config: { model: 'groq', instructions: 'Answer.' },
      model: { id: 'groq', name: 'GPT-OSS' }, question: 'Why did taxes change for the sales team?', invocation: { page: 'payrun', payrunId: 'PR-2026-09-B' } };
    const deps = { env: { REDIS_URL: 'redis://unused' }, loadContext: async () => context(), cache: createAnswerCache() };
    const first = await answerQuestion(args, deps);
    const again = await answerQuestion({ ...args, question: '  why did TAXES change for the sales team? ' }, deps);
    assert.equal(again.reply, first.reply);
    assert.equal(again.cached, true);
    const followUp = await answerQuestion({ ...args, conversation: { history: [{ role: 'user', content: 'Earlier question' }] } }, deps);
    assert.equal(followUp.cached, false);
    assert.equal(calls, 2);
    const edited = { ...fixture.payrun, version: 2 };
    await answerQuestion(args, { ...deps, loadContext: async () => context(edited) });
    assert.equal(calls, 3, 'a new payrun version is answered afresh');
  } finally {
    PayrollRagPipeline.prototype.run = run;
  }
});
