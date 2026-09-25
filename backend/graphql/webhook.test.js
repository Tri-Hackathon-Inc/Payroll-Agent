const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { callModel, ModelUnavailable } = require('./modelRuntime');
const { loadPayrunContext, detectSignals, payrunFacts } = require('./payrunContext');
const { answerQuestion } = require('./webhook');

// Local stand-ins for the Hugging Face router (OpenAI-compatible) and the payroll GraphQL API.
const servers = [];
async function standIn(handler) {
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const reply = await handler({ headers: req.headers, url: req.url, body: body ? JSON.parse(body) : null });
    res.writeHead(reply.status || 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply.json));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
after(() => servers.forEach(server => server.close()));

const model = {
  id: 'qwen-2-5-72b', name: 'Qwen 2.5 · 72B', provider: 'huggingface', modelId: 'Qwen/Qwen2.5-72B-Instruct',
  endpointEnv: 'HF_INFERENCE_BASE_URL', credentialEnv: 'HF_TOKEN', parameters: { temperature: 0.2, max_tokens: 256 },
};
const line = (employeeId, name, gross) => ({
  employeeId, name, department: 'Engineering', payType: 'salary', employmentStatus: 'active',
  hours: { regular: 80, overtime: 0 }, earnings: { regular: gross, overtime: 0, bonus: 0, reimbursement: 0 },
  gross, taxes: { federal: 100, state: 40, socialSecurity: 60, medicare: 15 },
  deductions: { health: 120, retirement401k: 200, garnishment: 0 }, net: gross * 0.7, paymentMethod: 'Direct Deposit',
});
const run = (id, status, gross) => ({
  id, name: `Payroll ${id}`, company: 'Northwind Labs', payDate: '2026-10-05', periodStart: '2026-09-16', periodEnd: '2026-09-30',
  status, currency: 'USD', totals: { employees: 1, gross, taxes: 100, deductions: 50, net: gross * 0.7 }, lines: [line('E1001', 'Maya Chen', gross)],
});

test('callModel sends an OpenAI-compatible request and measures the answer', async () => {
  let seen;
  const url = await standIn(request => {
    seen = request;
    return { json: { choices: [{ message: { content: ' E1001 is paid double. ' } }], usage: { prompt_tokens: 120, completion_tokens: 40 } } };
  });
  const env = { HF_TOKEN: 'hf_test', HF_INFERENCE_BASE_URL: `${url}/v1` };
  const result = await callModel(model, [{ role: 'user', content: 'hi' }], { env, responseFormat: { type: 'json_object' } });
  assert.equal(seen.url, '/v1/chat/completions');
  assert.equal(seen.headers.authorization, 'Bearer hf_test');
  assert.equal(seen.body.model, 'Qwen/Qwen2.5-72B-Instruct');
  assert.equal(seen.body.max_tokens, 256);
  assert.equal(seen.body.stream, false);
  assert.deepEqual(seen.body.response_format, { type: 'json_object' });
  assert.equal(result.text, 'E1001 is paid double.');
  assert.equal(result.metrics.completionTokens, 40);
  assert.ok(result.metrics.latencyMs >= 0 && result.metrics.tokensPerSecond > 0);
});

test('callModel reaches free-tier providers and keyless local models, passing provider parameters through', async () => {
  let seen;
  const url = await standIn(request => {
    seen = request;
    return { json: { choices: [{ message: { content: 'Gross is $62,504.00.' } }] } };
  });
  const groq = { id: 'groq-gpt-oss-120b', name: 'GPT-OSS', provider: 'openai-compatible', modelId: 'openai/gpt-oss-120b',
    endpointEnv: 'GROQ_BASE_URL', credentialEnv: 'GROQ_API_KEY', parameters: { max_tokens: 4096, reasoning_effort: 'low' } };
  await assert.rejects(callModel(groq, [], { env: { GROQ_BASE_URL: url } }), /not connected: set GROQ_API_KEY/);
  await callModel(groq, [{ role: 'user', content: 'hi' }], { env: { GROQ_API_KEY: 'gsk_test', GROQ_BASE_URL: url } });
  assert.equal(seen.headers.authorization, 'Bearer gsk_test');
  assert.equal(seen.body.reasoning_effort, 'low');
  assert.equal(seen.body.stream, false);

  const ollama = { ...groq, id: 'ollama-local', modelId: 'llama3.2:3b', endpointEnv: 'OLLAMA_BASE_URL', credentialEnv: '', parameters: {} };
  await assert.rejects(callModel(ollama, [], { env: {} }), /not connected: set OLLAMA_BASE_URL/);
  const result = await callModel(ollama, [{ role: 'user', content: 'hi' }], { env: { OLLAMA_BASE_URL: url } });
  assert.equal(seen.headers.authorization, undefined);
  assert.equal(seen.body.model, 'llama3.2:3b');
  assert.equal(result.text, 'Gross is $62,504.00.');
});

test('callModel explains missing credentials, unsupported providers, and provider errors', async () => {
  await assert.rejects(callModel(model, [], { env: {} }), /not connected: set HF_TOKEN/);
  await assert.rejects(callModel({ ...model, provider: 'aws-bedrock' }, [], { env: { HF_TOKEN: 'x' } }), /no runtime integration/);
  for (const [status, message] of [[401, /token was rejected/], [402, /no inference credits/], [429, /rate limit/]]) {
    const url = await standIn(() => ({ status, json: { error: 'upstream says no' } }));
    await assert.rejects(callModel(model, [], { env: { HF_TOKEN: 'x', HF_INFERENCE_BASE_URL: url } }),
      error => error instanceof ModelUnavailable && message.test(error.message) && !error.message.includes('x '));
  }
  // Gemini's error shape: a one-item array.
  const url = await standIn(() => ({ status: 503, json: [{ error: { code: 503, message: 'High demand.' } }] }));
  await assert.rejects(callModel(model, [], { env: { HF_TOKEN: 'x', HF_INFERENCE_BASE_URL: url } }),
    error => /overloaded at the provider/.test(error.message) && !error.message.includes('High demand.'));
});

test('payrun context loads the run with recent history and formats each employee', async () => {
  let seen;
  const endpoint = await standIn(request => {
    seen = request.body;
    return { json: { data: { payrun: run('PR-B', 'PENDING_APPROVAL', 9000), payrunHistory: [run('PR-A', 'COMPLETED', 4500)] } } };
  });
  assert.equal(await loadPayrunContext({ page: 'chat' }, { endpoint }), null);
  const context = await loadPayrunContext({ page: 'payrun', payrunId: 'PR-B' }, { endpoint });
  assert.equal(seen.variables.id, 'PR-B');
  assert.match(seen.query, /payrunHistory\(limit: \$historyLimit/);
  assert.equal(seen.variables.historyLimit, 6);
  assert.equal(context.current, context.payrun);
  assert.equal(context.payrunId, 'PR-B');
  assert.match(context.text, /Current payrun PR-B/);
  assert.match(context.text, /History: PR-A/);
  assert.match(context.text, /E1001 Maya Chen .*gross 9000 \(last 1 runs: 4500\).*federal tax 100, state tax 40, Social Security 60, Medicare 15, total employee tax 215.*health 120/);
});

test('shared payroll loader preserves raw RAG fields and scopes incident text, signals and totals', async () => {
  const current = { ...run('PR-B', 'PENDING_APPROVAL', 0), frequency: 'semi-monthly', version: 7,
    lines: [{ ...line('E1001', 'Maya Chen', 9000), lineId: 'L1', hours: { regular: 80, overtime: 40 } },
      { ...line('E1002', 'Luis Ortega', 4000), lineId: 'L2' }] };
  const previous = { ...current, id: 'PR-A', status: 'COMPLETED', payDate: '2026-09-05',
    periodStart: '2026-08-16', periodEnd: '2026-08-31', lines: current.lines.map(item => ({ ...item, hours: { regular: 80, overtime: 2 } })) };
  let seen;
  const deps = { endpoint: 'http://payroll.test', historyLimit: 100, fetchImpl: async (url, request) => {
    seen = JSON.parse(request.body);
    return { ok: true, json: async () => ({ data: { payrun: current, payrunHistory: [previous] } }) };
  } };
  const context = await loadPayrunContext({ page: 'payrun', payrunId: 'PR-B', employeeId: 'E1001' }, deps);
  assert.equal(seen.variables.historyLimit, 100);
  assert.match(seen.query, /status currency version/);
  assert.match(seen.query, /lineId employeeId/);
  assert.equal(context.current, current);
  assert.equal(context.history[0], previous);
  assert.deepEqual(context.payrun.lines.map(item => item.employeeId), ['E1001']);
  assert.equal(context.payrun.totals.gross, 9000);
  assert.ok(context.signals.length > 0);
  assert.ok(context.signals.every(item => item.employeeId === 'E1001'));
  assert.doesNotMatch(context.text, /Luis Ortega|E1002/);
  await assert.rejects(loadPayrunContext({ page: 'payrun', payrunId: 'PR-B', employeeId: 'missing' }, deps), /not in this payrun/);
});

test('automated checks flag each kind of anomaly and leave normal pay alone', () => {
  const history = [1, 2, 3].map(n => ({ ...run(`PR-${n}`, 'COMPLETED', 4000), lines: [
    line('E1', 'Normal', 4000), { ...line('E2', 'Overtime', 3000), hours: { regular: 80, overtime: 4 } },
    { ...line('E3', 'Bonus', 4000), earnings: { regular: 4000, overtime: 0, bonus: 700, reimbursement: 0 } },
    line('E4', 'Health', 4000), line('E5', 'Leaver', 4000), line('E6', 'Twice', 2000),
    { ...line('E7', 'Expenses', 3000), earnings: { regular: 3000, overtime: 0, bonus: 0, reimbursement: 20 } },
  ] }));
  const current = { ...run('PR-4', 'PENDING_APPROVAL', 0), lines: [
    { ...line('E1', 'Normal', 4100), hours: { regular: 80, overtime: 3 } },
    { ...line('E2', 'Overtime', 5200), hours: { regular: 80, overtime: 44 } },
    { ...line('E3', 'Bonus', 29000), earnings: { regular: 4000, overtime: 0, bonus: 25000, reimbursement: 0 } },
    { ...line('E4', 'Health', 4000), deductions: { health: 0, retirement401k: 200, garnishment: 0 } },
    { ...line('E5', 'Leaver', 4000), terminationDate: '2026-09-10' },
    line('E6', 'Twice', 2000), line('E6', 'Twice', 2000),
    { ...line('E7', 'Expenses', 4800), earnings: { regular: 3000, overtime: 0, bonus: 0, reimbursement: 1800 } },
    { ...line('E8', 'Newbie', 4000), hireDate: '2026-09-16', taxes: { federal: 0, state: 0, socialSecurity: 248, medicare: 58 } },
  ] };
  const kinds = detectSignals(current, history).map(item => `${item.employeeId} ${item.kind}`);
  assert.deepEqual(kinds, [
    'E2 overtime outlier', 'E3 bonus outlier', 'E4 health deduction missing', 'E5 paid after termination',
    'E6 duplicate payment', 'E7 reimbursement outlier', 'E8 no tax withholding', 'E8 new hire',
  ]);
  assert.ok(!kinds.some(kind => kind.startsWith('E1 ')), 'normal variation is not flagged');
});

test('payrun facts compare with the previous run and count unique employees', () => {
  const previous = { ...run('PR-A', 'COMPLETED', 0), totals: { employees: 2, gross: 6000, taxes: 0, deductions: 0, net: 4200 },
    lines: [line('E1', 'Ann', 3000), line('E2', 'Bob', 3000)] };
  const current = { ...run('PR-B', 'PENDING_APPROVAL', 0), totals: { employees: 3, gross: 13000, taxes: 0, deductions: 0, net: 9100 }, lines: [
    { ...line('E1', 'Ann', 3000), department: 'Sales', hours: { regular: 80, overtime: 2 } },
    { ...line('E1', 'Ann', 3000), department: 'Sales', hours: { regular: 80, overtime: 2 } },
    { ...line('E2', 'Bob', 7000), payType: 'hourly', hours: { regular: 80, overtime: 30 } },
  ] };
  const facts = payrunFacts(current, [previous]).join('\n');
  assert.match(facts, /3 pay lines for 2 unique employees/);
  assert.match(facts, /gross \$13,000\.00 vs \$6,000\.00 \(\+\$7,000\.00\)/);
  assert.match(facts, /E2 Bob \+\$4,000\.00; E1 Ann \+\$3,000\.00/);
  assert.match(facts, /Engineering \$7,000\.00 \(1 line\); Sales \$6,000\.00 \(2 lines\)/);
  assert.match(facts, /Overtime: 34h in total; E2 Bob 30h, E1 Ann 4h across 2 lines/);
  assert.match(facts, /Highest gross pay: E2 Bob \$7,000\.00/);
});

test('answerQuestion acknowledges when the model is not connected', async () => {
  const answer = await answerQuestion({
    agent: { name: 'Anomaly bot' }, config: { model: 'qwen-2-5-72b', service: 'payrun' }, model,
    question: 'Anything unusual?', invocation: { page: 'payrun', payrunId: 'PR-B' },
  }, { env: {} });
  assert.match(answer.reply, /Anomaly bot received your question: "Anything unusual\?"/);
  assert.match(answer.reply, /Agent execution is not active: .*set HF_TOKEN/);
  assert.equal(answer.metrics, null);
});

test('answerQuestion sends instructions, payrun data, and the question to the model', async () => {
  let prompt;
  const modelUrl = await standIn(request => {
    prompt = request.body.messages;
    return { json: { choices: [{ message: { content: 'Maya Chen gross doubled from 4500 to 9000.' } }], usage: { completion_tokens: 12 } } };
  });
  const payrollUrl = await standIn(() => ({ json: { data: { payrun: run('PR-B', 'PENDING_APPROVAL', 9000), payrunHistory: [run('PR-A', 'COMPLETED', 4500)] } } }));
  const answer = await answerQuestion({
    agent: { name: 'Anomaly bot' }, model, question: 'Which payments need review?',
    config: { model: 'qwen-2-5-72b', service: 'payrun', description: 'Flags anomalies.', instructions: 'Compare payrun inputs against history.' },
    invocation: { page: 'payrun', payrunId: 'PR-B' },
  }, { env: { HF_TOKEN: 'hf_test', HF_INFERENCE_BASE_URL: modelUrl }, endpoint: payrollUrl });
  assert.equal(answer.reply, 'Maya Chen gross doubled from 4500 to 9000.');
  assert.equal(answer.model.modelId, 'Qwen/Qwen2.5-72B-Instruct');
  assert.equal(answer.context.payrunId, 'PR-B');
  assert.match(prompt[0].content, /Instructions: Compare payrun inputs against history\./);
  assert.match(prompt[0].content, /one-sentence direct answer[\s\S]*Never paste raw data lines/);
  assert.match(prompt[1].content, /Current payrun PR-B[\s\S]*Question: Which payments need review\?/);
});

test('answerQuestion still answers when the payroll context cannot be loaded', async () => {
  const modelUrl = await standIn(() => ({ json: { choices: [{ message: { content: 'No payroll data was provided.' } }] } }));
  const answer = await answerQuestion({
    agent: { name: 'Anomaly bot' }, model, question: 'Totals?',
    config: { model: 'qwen-2-5-72b', service: 'payrun', instructions: 'Answer.' }, invocation: { page: 'payrun', payrunId: 'PR-B' },
  }, { env: { HF_TOKEN: 'hf_test', HF_INFERENCE_BASE_URL: modelUrl }, loadContext: async () => { throw new Error('Payroll API down.') } });
  assert.equal(answer.reply, 'No payroll data was provided.');
  assert.equal(answer.context.error, 'Payroll API down.');
});

test('generic webhook follow-ups pass restored session history before the new question', async () => {
  let messages;
  const url = await standIn(request => {
    messages = request.body.messages;
    return { json: { choices: [{ message: { content: 'A follow-up answer.' } }] } };
  });
  const history = [{ role: 'user', content: 'Review Luis.' }, { role: 'assistant', content: 'Please select his payrun.' }];
  await answerQuestion({ agent: { name: 'General assistant' }, config: { instructions: 'Answer.' }, model,
    question: 'Which one?', conversation: { history } }, { env: { HF_TOKEN: 'test', HF_INFERENCE_BASE_URL: url } });
  assert.deepEqual(messages.slice(1, 3), history);
  assert.match(messages.at(-1).content, /Which one\?/);
});
