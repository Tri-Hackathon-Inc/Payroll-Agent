const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { FEATURES, CUSTOMER_FEATURES, viewerFor, requireFeature, createAuthHandler, parseFeatures } = require('./access');
const { resolvers } = require('./aistudio');

const env = { STUDIO_ADMIN_KEY: 'correct horse battery staple' };

const servers = [];
after(() => servers.forEach(server => server.close()));
async function serve(handler) {
  const server = http.createServer((req, res) => handler(req, res, new URL(req.url, 'http://localhost').pathname));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
const signIn = (url, key) => fetch(`${url}/auth/admin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });

test('without an admin key the Studio is open; with one, only a signed-in admin gets admin features', () => {
  assert.deepEqual(viewerFor({}, {}), { role: 'admin', features: FEATURES, authMode: 'open', allowedModels: null, allowedTools: null });
  assert.deepEqual(viewerFor({}, env), { role: 'user', features: CUSTOMER_FEATURES, authMode: 'key', allowedModels: null, allowedTools: null });
  assert.equal(viewerFor({ cookie: 'studio_admin=123.forged' }, env).role, 'user', 'a forged cookie is ignored');
});

test('feature flags turn capabilities on and off per role', () => {
  assert.deepEqual(parseFeatures('metrics, models ,unknown', []), ['models', 'metrics']);
  assert.deepEqual(parseFeatures('all', []), FEATURES);
  assert.deepEqual(parseFeatures(undefined, ['tools']), ['tools']);
  assert.deepEqual(parseFeatures('', ['tools']), ['tools'], 'empty (as Compose passes it) keeps the defaults');
  assert.deepEqual(parseFeatures('none', ['tools']), []);
  assert.deepEqual(viewerFor({}, { ...env, USER_FEATURES: 'metrics' }).features, ['metrics'], 'users can be given a feature');
  assert.deepEqual(viewerFor({}, { ADMIN_FEATURES: 'manageAgents' }).features, ['manageAgents'], 'admins can lose one');
});

test('sign-in sets an HttpOnly admin cookie that grants admin features; wrong keys are limited', async () => {
  let clock = 1_000_000;
  const url = await serve(createAuthHandler({ env, now: () => clock }));
  const wrong = await signIn(url, 'guess');
  assert.equal(wrong.status, 401);
  const right = await signIn(url, env.STUDIO_ADMIN_KEY);
  assert.equal(right.status, 200);
  const cookie = right.headers.get('set-cookie');
  assert.match(cookie, /^studio_admin=\d+\.[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=28800$/);
  const header = cookie.split(';')[0];
  assert.equal(viewerFor({ cookie: header }, env, clock).role, 'admin');
  assert.equal(viewerFor({ cookie: header }, env, clock + 9 * 3600 * 1000).role, 'user', 'the session expires');
  assert.equal(viewerFor({ cookie: header }, { STUDIO_ADMIN_KEY: 'rotated key' }, clock).role, 'user', 'rotating the key signs everyone out');

  const out = await fetch(`${url}/auth/logout`, { method: 'POST' });
  assert.match(out.headers.get('set-cookie'), /^studio_admin=; .*Max-Age=0$/);
  for (let i = 0; i < 10; i += 1) await signIn(url, 'guess');
  assert.equal((await signIn(url, env.STUDIO_ADMIN_KEY)).status, 429, 'too many attempts');
  clock += 61_000;
  assert.equal((await signIn(url, env.STUDIO_ADMIN_KEY)).status, 200, 'the limit resets');
  assert.equal((await fetch(`${url}/auth/admin`)).status, 405);
  const open = await serve(createAuthHandler({ env: {} }));
  assert.equal((await signIn(open, 'x')).status, 400, 'no admin key configured');
});

test('the API enforces the role: customers build with allowed models and tools, admins see full metrics', async () => {
  const calls = [];
  const grpc = { call: async (...args) => { calls.push(args[3]); return args[3] === 'GetAgentMetrics'
    ? { metrics: { fields: {
      summary: { structValue: { fields: { questions: { numberValue: 5 }, p95LatencyMs: { numberValue: 900 } } } },
      business: { structValue: { fields: { amountAtRisk: { numberValue: 100 } } } },
      quality: { structValue: { fields: { flagged: { numberValue: 1 } } } } } } }
    : { id: 'agent-1' }; } };
  const as = viewer => ({ context: { viewer }, dataSources: { grpc } });
  const customer = as(viewerFor({}, { ...env, CUSTOMER_MODELS: 'groq-gpt-oss-120b', CUSTOMER_TOOLS: 'payrun,payrun-history' }));
  const save = (context, config) => resolvers.Mutation.createAgent(null, { input: { domainName: 'd', templateId: 't', name: 'n', config } }, context);

  assert.deepEqual(await save(customer, { model: 'groq-gpt-oss-120b', service: 'payrun', attached_services: ['payrun-history'] }), { id: 'agent-1' },
    'a customer may create an agent with allowed choices');
  assert.throws(() => save(customer, { model: 'llama-3-3-70b' }), error => error.extensions.code === 'FORBIDDEN' && /not available to customers/.test(error.message));
  assert.throws(() => save(customer, { attached_services: ['slack-webhook'] }), /Tool slack-webhook is not available/);
  const usage = await resolvers.Query.agentMetrics(null, { domainName: 'd' }, customer);
  assert.deepEqual(Object.keys(usage.summary).filter(key => usage.summary[key] !== undefined), ['questions'], 'customers get usage only');
  assert.equal(usage.quality, undefined);
  assert.equal(usage.business.amountAtRisk, undefined);

  const admin = as(viewerFor({}, {}));
  assert.ok(await save(admin, { model: 'llama-3-3-70b', attached_services: ['slack-webhook'] }), 'admins are not restricted');
  assert.equal((await resolvers.Query.agentMetrics(null, { domainName: 'd' }, admin)).quality.flagged, 1);

  const locked = as(viewerFor({}, { ...env, USER_FEATURES: 'none' }));
  for (const [kind, name] of [['Mutation', 'createAgent'], ['Mutation', 'updateAgent'], ['Mutation', 'chatAgent'], ['Query', 'agentMetrics']]) {
    assert.throws(() => resolvers[kind][name](null, { input: {}, domainName: 'd' }, locked), error => error.extensions.code === 'FORBIDDEN', name);
  }
  assert.equal(await resolvers.Mutation.rateAnswer(null, { input: { domainName: 'd', interactionId: 'a', rating: 'up' } }, locked), 'agent-1', 'anyone can rate an answer');
  assert.deepEqual(resolvers.Query.viewer(null, {}, customer).allowedModels, ['groq-gpt-oss-120b']);
  assert.ok(await requireFeature(['metrics', 'usage'], async () => 'ok')(null, {}, customer));
});
