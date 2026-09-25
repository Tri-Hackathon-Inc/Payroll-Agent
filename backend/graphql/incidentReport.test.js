const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createIncidentReport, collectEvidence } = require('./incidentReport');
const { detectSignals } = require('./payrunContext');

// Local stand-ins for the Hugging Face router and the email notification tool.
const servers = [];
async function standIn(handler) {
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const reply = await handler({ url: req.url, body: body ? JSON.parse(body) : null });
    res.writeHead(reply.status || 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply.json || {}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
after(() => servers.forEach(server => server.close()));

const line = (employeeId, name, gross, extra = {}) => ({
  employeeId, name, department: 'Engineering', payType: 'salary', employmentStatus: 'active', paymentMethod: 'Direct Deposit',
  hours: { regular: 80, overtime: 0 }, earnings: { regular: gross, overtime: 0, bonus: 0, reimbursement: 0 }, gross,
  taxes: { federal: 100, state: 40, socialSecurity: 60, medicare: 15 }, deductions: { health: 120, retirement401k: 200, garnishment: 0 },
  net: gross * 0.7, ...extra,
});
const history = [1, 2, 3].map(n => ({ id: `PR-${n}`, payDate: '2026-09-01', lines: [
  line('E1', 'Normal', 4000), line('E2', 'Twice', 2000), line('E3', 'Leaver', 4500),
  line('E4', 'Bonus', 3500, { earnings: { regular: 3500, overtime: 0, bonus: 800, reimbursement: 0 } }),
] }));
const payrun = { id: 'PR-9', periodStart: '2026-09-16', periodEnd: '2026-09-30', lines: [
  line('E1', 'Normal', 4000), line('E2', 'Twice', 2000), line('E2', 'Twice', 2000),
  line('E3', 'Leaver', 4500, { employmentStatus: 'terminated', terminationDate: '2026-09-12' }),
  line('E4', 'Bonus', 28500, { earnings: { regular: 3500, overtime: 0, bonus: 25000, reimbursement: 0 } }),
] };
const context = { payrunId: 'PR-9', text: 'Payroll data for PR-9', payrun, history, signals: detectSignals(payrun, history) };
const loadContext = async () => context;
const agent = { name: 'Incident bot' };
const config = { instructions: 'Write a concise incident report.' };
const model = { id: 'llama-3-3-70b', name: 'Llama 3.3 · 70B', provider: 'huggingface', modelId: 'meta-llama/Llama-3.3-70B-Instruct',
  endpointEnv: 'HF_INFERENCE_BASE_URL', credentialEnv: 'HF_TOKEN', parameters: {} };
const handoff = { fromAgent: 'Anomaly bot', conversation: [
  { role: 'user', text: 'Which payments need review?' },
  { role: 'agent', agent: 'Anomaly bot', text: 'E2 Twice is paid twice and E3 Leaver was paid after termination.' },
] };

test('evidence covers the employees discussed, with snapshots, history, and amounts at risk', () => {
  const evidence = collectEvidence(context, handoff.conversation, '2026-09-25T00:00:00.000Z');
  assert.deepEqual(evidence.map(item => [item.id, item.employeeId, item.finding, item.amountAtRisk]), [
    ['EV-1', 'E2', 'duplicate payment', 2000],
    ['EV-2', 'E3', 'paid after termination', 4500],
  ]);
  assert.equal(evidence[0].snapshot.payLines, 2);
  assert.equal(evidence[1].history.length, 3);
  const all = collectEvidence(context, [{ role: 'user', text: 'Create an incident report.' }], 'now');
  assert.deepEqual(all.map(item => item.employeeId), ['E2', 'E3', 'E4'], 'no names discussed: every finding');
  assert.equal(all[2].amountAtRisk, 24200, 'bonus above the highest past bonus');
});

test('without a model the report is built from the evidence and the email is reported as not sent', async () => {
  const result = await createIncidentReport({ agent, config, model, invocation: { page: 'payrun', payrunId: 'PR-9', handoff } },
    { loadContext, env: {}, now: () => new Date('2026-09-25T00:00:00Z') });
  const { incident } = result;
  assert.match(incident.id, /^INC-PR-9-/);
  assert.equal(incident.severity, 'critical');
  assert.equal(incident.totalAtRisk, 6500);
  assert.equal(incident.writtenBy, 'evidence');
  assert.match(incident.report, /## Summary\n2 findings affecting 2 employees; \$6,500\.00 at risk/);
  assert.match(incident.report, /Remove the duplicate pay line/);
  assert.match(incident.report, /\| EV-2 \| E3 Leaver \| paid after termination \|/);
  assert.equal(incident.email.status, 'not-sent');
  assert.match(result.reply, /Email not sent: EMAIL_API_BASE_URL is not set/);
});

test('with a model the handed-over conversation reaches it and the report is emailed', async () => {
  let prompt, email;
  const modelUrl = await standIn(request => {
    prompt = request.body.messages;
    return { json: { choices: [{ message: { content: '## Summary\nTwo issues.\n\n## Impact\n$6,500 at risk.\n\n## Recommended actions\n- Fix EV-1.' } }], usage: { completion_tokens: 20 } } };
  });
  const emailUrl = await standIn(request => { email = request; return { json: { ok: true } }; });
  const result = await createIncidentReport({ agent, config, model, invocation: { page: 'payrun', payrunId: 'PR-9', handoff } },
    { loadContext, env: { HF_TOKEN: 'hf_test', HF_INFERENCE_BASE_URL: modelUrl, EMAIL_API_BASE_URL: emailUrl, INCIDENT_EMAIL_TO: 'ops@example.com' } });
  assert.match(prompt[1].content, /Handed over by: Anomaly bot[\s\S]*E2 Twice is paid twice[\s\S]*\| EV-1 \| E2 Twice \|/);
  assert.equal(result.incident.writtenBy, 'Llama 3.3 · 70B');
  assert.match(result.incident.report, /## Impact\n\$6,500 at risk\.[\s\S]*## Evidence/);
  assert.equal(email.url, '/notifications/email');
  assert.equal(email.body.to, 'ops@example.com');
  assert.match(email.body.subject, /^\[CRITICAL\] INC-PR-9-/);
  assert.equal(result.incident.email.status, 'sent');
});

test('headless-browser screenshots are attached to each finding and embedded in the report', async () => {
  let request;
  const captureUrl = await standIn(req => {
    request = req.body;
    return { json: { capturedAt: '2026-09-25T00:00:01.000Z', captures: req.body.items.map(item => ({
      id: item.id, screenshots: [{ label: 'Pay row', dataUrl: `data:image/jpeg;base64,${item.employeeId}` }],
    })) } };
  });
  const result = await createIncidentReport({ agent, config, model, domainName: 'payroll-services',
    invocation: { page: 'payrun', payrunId: 'PR-9', handoff } }, { loadContext, env: { EVIDENCE_CAPTURE_URL: captureUrl } });
  assert.deepEqual(request, { domain: 'payroll-services', payrunId: 'PR-9', items: [
    { id: 'EV-1', employeeId: 'E2', name: 'Twice' }, { id: 'EV-2', employeeId: 'E3', name: 'Leaver' },
  ] });
  assert.equal(result.incident.evidence[1].screenshots[0].dataUrl, 'data:image/jpeg;base64,E3');
  assert.equal(result.incident.screenshots.taken, 2);
  assert.match(result.incident.report, /## Screenshots[\s\S]*!\[EV-2 Pay row\]\(data:image\/jpeg;base64,E3\)/);
});

test('an unreachable capture service still produces the report and says why screenshots are missing', async () => {
  const result = await createIncidentReport({ agent, config, model, domainName: 'payroll-services',
    invocation: { page: 'payrun', payrunId: 'PR-9', handoff } }, { loadContext, env: { EVIDENCE_CAPTURE_URL: 'http://127.0.0.1:9' } });
  assert.equal(result.incident.screenshots.taken, 0);
  assert.match(result.incident.screenshots.error, /could not be reached/);
  assert.doesNotMatch(result.incident.report, /## Screenshots/);
  assert.equal(result.incident.evidence.length, 2);
});
