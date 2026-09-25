const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { callModel, ModelUnavailable } = require('./modelRuntime');
const { loadPayrunContext } = require('./payrunContext');
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
  const result = await callModel(model, [{ role: 'user', content: 'hi' }], { env });
  assert.equal(seen.url, '/v1/chat/completions');
  assert.equal(seen.headers.authorization, 'Bearer hf_test');
  assert.equal(seen.body.model, 'Qwen/Qwen2.5-72B-Instruct');
  assert.equal(seen.body.max_tokens, 256);
  assert.equal(result.text, 'E1001 is paid double.');
  assert.equal(result.metrics.completionTokens, 40);
  assert.ok(result.metrics.latencyMs >= 0 && result.metrics.tokensPerSecond > 0);
});

test('callModel explains missing credentials, unsupported providers, and provider errors', async () => {
  await assert.rejects(callModel(model, [], { env: {} }), /not connected: set HF_TOKEN/);
  await assert.rejects(callModel({ ...model, provider: 'aws-bedrock' }, [], { env: { HF_TOKEN: 'x' } }), /no runtime integration/);
  for (const [status, message] of [[401, /token was rejected/], [402, /no inference credits/], [429, /rate limit/]]) {
    const url = await standIn(() => ({ status, json: { error: 'upstream says no' } }));
    await assert.rejects(callModel(model, [], { env: { HF_TOKEN: 'x', HF_INFERENCE_BASE_URL: url } }),
      error => error instanceof ModelUnavailable && message.test(error.message) && !error.message.includes('x '));
  }
});

test('payrun context loads the current run and the previous completed run', async () => {
  let seen;
  const endpoint = await standIn(request => {
    seen = request.body;
    return { json: { data: { payrun: run('PR-B', 'PENDING_APPROVAL', 9000), payrunHistory: [run('PR-A', 'COMPLETED', 4500)] } } };
  });
  assert.equal(await loadPayrunContext({ page: 'chat' }, { endpoint }), null);
  const context = await loadPayrunContext({ page: 'payrun', payrunId: 'PR-B' }, { endpoint });
  assert.equal(seen.variables.id, 'PR-B');
  assert.equal(context.payrunId, 'PR-B');
  assert.match(context.text, /Current payrun: PR-B/);
  assert.match(context.text, /Previous completed payrun \(history\): PR-A/);
  // gross | employee taxes | health | 401k | garnishment
  assert.match(context.text, /E1001 \| Maya Chen .* \| 9000 \| 215 \| 120 \| 200 \| 0 \|/);
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
  assert.match(prompt[1].content, /Current payrun: PR-B[\s\S]*Question: Which payments need review\?/);
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
