const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { handleEvents, processPayrollEvent, validateEvent, tokenAccepted, createMemoryQueue, publishAlert } = require('./payrollEvents');
const { createIncidentStore } = require('./incidentTrigger');
const { detectSignals, formatContext } = require('./payrunContext');

const fixture = require('./fixtures/payrun-PR-2026-09-B.json');
const context = { payrunId: 'PR-2026-09-B', payrun: fixture.payrun, history: fixture.payrunHistory,
  signals: detectSignals(fixture.payrun, fixture.payrunHistory), text: formatContext(fixture.payrun, fixture.payrunHistory) };
const event = { type: 'payrun.changed', payrunId: 'PR-2026-09-B', version: 2, lineId: 'PR-2026-09-B-L07', employeeId: 'E1006' };

// A stand-in for the Agent Studio registry: one domain with a monitor and an Incident Report agent.
const agent = (id, name, templateId, alerts) => ({ id, name, template_id: templateId, config: { capabilities: { alerts } } });
const registry = (agents) => ({
  Query: {
    listDomains: async () => [{ name: 'payroll-services' }, { name: 'hr' }],
    getServiceAgentRegistry: async (_, { domainName }) => (domainName === 'payroll-services' ? agents : []),
  },
  Agent: { templateId: item => item.template_id, config: item => item.config },
});

test('events are validated and the shared token is checked in constant time', () => {
  assert.equal(validateEvent(event).employeeId, 'E1006');
  for (const bad of [{}, { ...event, type: 'other' }, { ...event, payrunId: 'x y' }, { ...event, version: 0 }, { ...event, employeeId: '<script>' }]) {
    assert.throws(() => validateEvent(bad), /required|type|invalid|version/);
  }
  assert.equal(tokenAccepted(undefined, ''), true, 'no token configured');
  assert.equal(tokenAccepted('secret', 'secret'), true);
  assert.equal(tokenAccepted('guess', 'secret'), false);
});

test('a payrun change is checked by the monitor, raises new critical findings once, and is pushed and recorded', async () => {
  const published = [], logged = [], reports = [];
  const deps = {
    resolvers: registry([agent('m1', 'Payroll monitor', 'anomaly-detection', { enabled: true, severity: 'warning' }),
      agent('q1', 'Query bot', 'general-query', { enabled: true })]),
    loadContext: async () => context,
    store: createIncidentStore(),
    findIncidentAgent: async () => ({ agent: { id: 'inc', name: 'Incident bot' }, config: {}, model: null }),
    createReport: async request => { reports.push(request); return { reply: 'ok', incident: { id: 'INC-RT-1', severity: 'critical' } }; },
    publish: outcome => published.push(outcome),
    logInteraction: async record => { logged.push(record); return 'answer-1'; },
  };
  const [first] = await processPayrollEvent(event, deps);
  assert.equal(first.type, 'incident');
  assert.equal(first.monitor.name, 'Payroll monitor');
  assert.equal(first.reason, 'E1006 Tom Becker pay line changed');
  assert.deepEqual(first.changedEmployee.findings.map(item => item.kind), ['paid after termination']);
  assert.equal(first.raised.incident.id, 'INC-RT-1');
  assert.equal(reports[0].invocation.handoff.trigger, 'realtime');
  assert.match(reports[0].invocation.handoff.conversation[0].text, /Automatic alert \(E1006 Tom Becker pay line changed\): 4 critical findings/);
  assert.equal(logged[0].source, 'realtime-monitor');
  assert.equal(logged[0].answer.answeredBy, 'incident-report');

  const [second] = await processPayrollEvent({ ...event, version: 3 }, deps);
  assert.equal(second.type, 'checked', 'the same findings are not raised again');
  assert.equal(second.alreadyRaised, 4);
  assert.equal(reports.length, 1);
  assert.equal(published.length, 2);
});

test('domains without a monitoring agent are skipped, and a payroll outage is reported, not thrown', async () => {
  const quiet = await processPayrollEvent(event, { resolvers: registry([agent('m1', 'Off', 'anomaly-detection', { enabled: false })]) });
  assert.deepEqual(quiet, []);
  const published = [];
  const [failed] = await processPayrollEvent(event, {
    resolvers: registry([agent('m1', 'Monitor', 'anomaly-detection', { enabled: true })]),
    loadContext: async () => { throw new Error('payroll API down'); }, publish: outcome => published.push(outcome),
  });
  assert.equal(failed.type, 'error');
  assert.equal(published[0].type, 'error');
});

// HTTP: intake (token, validation, queueing) and the per-payrun live stream.
const servers = [];
after(() => servers.forEach(server => server.close()));
async function serve(deps) {
  const server = http.createServer((req, res) => handleEvents(req, res, new URL(req.url, 'http://localhost'), {}, deps));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

test('the intake queues valid events and rejects bad tokens and bad events', async () => {
  const queued = [];
  const queue = { kind: 'test', publish: async item => queued.push(item) };
  const url = await serve({ queue, env: { PAYROLL_EVENTS_TOKEN: 'secret' } });
  const post = (body, token) => fetch(`${url}/events/payroll`, { method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Payroll-Events-Token': token } : {}) } });
  assert.equal((await post(event, 'wrong')).status, 401);
  assert.equal((await post({ type: 'nope' }, 'secret')).status, 400);
  const accepted = await post(event, 'secret');
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { accepted: true, queue: 'test' });
  assert.equal(queued[0].payrunId, 'PR-2026-09-B');
  assert.equal((await fetch(`${url}/events/payroll`)).status, 405);
});

test('the live stream sends only alerts for the page’s domain and payrun', async () => {
  const url = await serve({});
  const controller = new AbortController();
  const response = await fetch(`${url}/events/stream?domain=payroll-services&payrunId=PR-2026-09-B`, { signal: controller.signal });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = response.body.getReader();
  await reader.read(); // retry hint
  publishAlert({ domainName: 'payroll-services', payrunId: 'PR-OTHER', type: 'checked' });
  publishAlert({ domainName: 'payroll-services', payrunId: 'PR-2026-09-B', type: 'incident', raised: { incident: { id: 'INC-9' } } });
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  assert.match(text, /^event: payroll\ndata: /);
  assert.match(text, /"INC-9"/);
  assert.doesNotMatch(text, /PR-OTHER/);
  controller.abort();
  assert.equal((await fetch(`${url}/events/stream?domain=bad name`)).status, 400);
});

test('the in-process queue hands events to the worker', async () => {
  const queue = createMemoryQueue();
  const seen = [];
  queue.start(async item => { seen.push(item); });
  await queue.publish(event);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen, [event]);
});
