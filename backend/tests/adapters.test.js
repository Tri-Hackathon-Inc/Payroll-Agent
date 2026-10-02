const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { resolvers } = require('../graphql/aistudio');
const { encodeStruct, decodeStruct, getGrpcMetadata } = require('../graphql/client');
const { handleHttp, isHttpRequest } = require('../local_server/http-adapter');

test('GraphQL executes in Python and preserves structured replies and session metadata', async () => {
  const input = { agentId: 'a', domainName: 'd', message: 'Why less?', context: { payrunId: 'p' }, confirmation: { mappingId: 'm', questionId: 'q' } };
  const result = { agent_id: 'a', model_id: 'm', output: 'Less overtime.', demo: false, analysis: { payComparison: { netChange: -283.78 } }, session: { id: 's' } };
  const context = { context: { sessionOwner: 'b'.repeat(64), headers: { cookie: 'studio_admin=signed', authorization: 'Bearer test' } }, dataSources: { grpc: { call: async (...args) => {
    assert.equal(args[3], 'ExecuteAgent');
    assert.deepEqual(decodeStruct(args[4]), { ...input, channel: 'studio' });
    assert.equal(args[5].get('x-session-owner')[0], 'b'.repeat(64));
    assert.equal(args[5].get('cookie')[0], 'studio_admin=signed');
    return encodeStruct(result);
  } } } };
  assert.deepEqual(await resolvers.Mutation.chatAgent(null, { input }, context), result);
});

test('GraphQL viewer and permissions are owned by gRPC', async () => {
  const context = { context: {}, dataSources: { grpc: { call: async (...args) => {
    if (args[3] === 'GetViewer') return encodeStruct({ role: 'user', features: ['usage'], authMode: 'key', allowedModels: null, allowedTools: null });
    throw { code: 7, details: 'Feature unavailable.' };
  } } } };
  assert.equal((await resolvers.Query.viewer(null, {}, context)).role, 'user');
  await assert.rejects(resolvers.Mutation.deleteAgent(null, { id: 'a', domainName: 'd' }, context), error => error.extensions.code === 'FORBIDDEN');
});

test('HTTP webhook and draft preview forward through gRPC; errors preserve status', async t => {
  const calls = [];
  const context = { context: {}, dataSources: { grpc: { call: async (...args) => {
    calls.push({ method: args[3], input: decodeStruct(args[4]) });
    if (args[3] === 'PreviewPayrollChange') throw { code: 10, details: 'Payroll changed. Reload it.' };
    return encodeStruct({ reply: 'Select a question.', status: 'confirmation_required' });
  } } } };
  const server = http.createServer((req, res) => handleHttp(req, res, new URL(req.url, 'http://localhost'), context));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const reply = await fetch(base+'/webhook/domain/agent', { method: 'POST', body: JSON.stringify({ question: 'Why less?' }) });
  assert.equal(reply.status, 200);
  assert.equal((await reply.json()).status, 'confirmation_required');
  assert.deepEqual(calls[0], { method: 'ExecuteAgent', input: { question: 'Why less?', domainName: 'domain', agentId: 'agent', channel: 'payroll' } });
  const preview = await fetch(base+'/events/preview', { method: 'POST', body: '{}' });
  assert.equal(preview.status, 409);
  assert.equal((await preview.json()).message, 'Payroll changed. Reload it.');
});

test('untrusted session-owner headers are not forwarded', () => {
  const metadata = getGrpcMetadata({ headers: { 'x-session-owner': 'forged', 'x-client-address': 'forged' }, sessionOwner: 'trusted', clientAddress: 'local' });
  assert.deepEqual(metadata.get('x-session-owner'), ['trusted']);
  assert.deepEqual(metadata.get('x-client-address'), ['local']);
});

test('POST /agents forwards creation to Python and returns the persisted agent', async t => {
  const calls = [];
  const context = { context: {}, dataSources: { grpc: { call: async (...args) => {
    calls.push(args);
    if (args[4].name === 'Denied') throw { code: 7, details: 'Administrator access required.' };
    return { id: 'saved-id', name: args[4].name, domain_name: 'payroll', template_id: 'general-query',
      template_version: 1, config: args[4].config, model_config: encodeStruct({ provider: 'demo' }), created_at: 'now', updated_at: 'now' };
  } } } };
  assert.equal(isHttpRequest('/agents'), true);
  assert.equal(isHttpRequest('/agents/'), true);
  const server = http.createServer((req, res) => handleHttp(req, res, new URL(req.url, 'http://localhost'), context));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/agents`;
  const body = { domainName: 'payroll', templateId: 'general-query', name: 'Query', config: { pipelines: { query: { candidateLimit: 2 } } } };
  const response = await fetch(url, { method: 'POST', body: JSON.stringify(body) });
  assert.equal(response.status, 201);
  assert.equal(calls[0][3], 'CreateAgent');
  assert.deepEqual(calls[0][4], { domain_name: 'payroll', template_id: 'general-query', name: 'Query', config: encodeStruct(body.config) });
  const agent = await response.json();
  assert.equal(agent.id, 'saved-id');
  assert.equal(agent.domainName, 'payroll');
  assert.deepEqual(agent.config, body.config);
  assert.deepEqual(agent.modelConfig, { provider: 'demo' });
  assert.equal((await fetch(url)).status, 405);
  const invalid = await fetch(url, { method: 'POST', body: JSON.stringify({ ...body, config: [] }) });
  assert.equal(invalid.status, 400);
  const denied = await fetch(url, { method: 'POST', body: JSON.stringify({ ...body, name: 'Denied' }) });
  assert.equal(denied.status, 403);
});

test('anomaly HTTP routes preserve scoped cases, review payload and caller metadata', async t => {
  const calls = [];
  const pending = { id: 'case-1', domainName: 'payroll-services', agentId: 'agent-1',
    agentName: 'Payroll anomalies', payrunId: 'payrun 1', version: 7, decision: 'REVIEW',
    reviewStatus: 'pending', summary: 'Bonus above history.', findings: [], investigation: null, createdAt: 'now' };
  const investigated = { ...pending, reviewStatus: 'completed', investigation: {
    summary: 'Review the bonus amount.', evidence: [], findings: [], modelStatus: 'completed',
  } };
  const context = { context: { headers: { cookie: 'studio_admin=signed', authorization: 'Bearer caller' },
    sessionOwner: 'trusted-browser' }, dataSources: { grpc: { call: async (...args) => {
    calls.push({ method: args[3], input: decodeStruct(args[4]), metadata: args[5] });
    return encodeStruct(args[3] === 'ListAnomalies' ? { items: [pending] } : investigated);
  } } } };
  assert.equal(isHttpRequest('/anomalies'), true);
  assert.equal(isHttpRequest('/anomalies/review'), true);
  const server = http.createServer((req, res) => handleHttp(req, res, new URL(req.url, 'http://localhost'), context));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const listed = await fetch(base+'/anomalies?domain=payroll-services&payrunId=payrun%201');
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), { items: [pending] });
  assert.equal(calls[0].method, 'ListAnomalies');
  assert.deepEqual(calls[0].input, { domainName: 'payroll-services', payrunId: 'payrun 1' });
  const body = { domainName: 'payroll-services', agentId: 'agent-1', anomalyId: 'case-1',
    action: 'REVIEW', expectedVersion: 7 };
  const reviewed = await fetch(base+'/anomalies/review', { method: 'POST', body: JSON.stringify(body) });
  assert.equal(reviewed.status, 200);
  assert.deepEqual(await reviewed.json(), investigated);
  assert.equal(calls[1].method, 'ReviewAnomaly');
  assert.deepEqual(calls[1].input, body);
  for (const call of calls) {
    assert.deepEqual(call.metadata.get('cookie'), ['studio_admin=signed']);
    assert.deepEqual(call.metadata.get('authorization'), ['Bearer caller']);
    assert.deepEqual(call.metadata.get('x-session-owner'), ['trusted-browser']);
  }
  for (const [path, method, allow] of [['/anomalies', 'POST', 'GET'], ['/anomalies/review', 'GET', 'POST']]) {
    const invalid = await fetch(base+path, { method });
    assert.equal(invalid.status, 405);
    assert.equal(invalid.headers.get('allow'), allow);
  }
  const malformed = await fetch(base+'/anomalies/review', { method: 'POST', body: '[]' });
  assert.equal(malformed.status, 400);
  assert.equal(calls.length, 2);
  const feedback = { ...body, action: 'CONFIRMED', requestId: 'review-feedback-id' };
  const saved = await fetch(base+'/anomalies/feedback', { method: 'POST', body: JSON.stringify(feedback) });
  assert.equal(saved.status, 200);
  assert.equal(calls[2].method, 'RecordAnomalyFeedback');
  assert.deepEqual(calls[2].input, feedback);
  const generic = await fetch(base+'/anomalies?domain=equipment&entityType=machine&entityId=pump-1');
  assert.equal(generic.status, 200);
  assert.deepEqual(calls[3].input, { domainName: 'equipment', payrunId: '', entityType: 'machine', entityId: 'pump-1' });
});

test('anomaly HTTP routes preserve Python permission and stale-version errors', async t => {
  const context = { context: {}, dataSources: { grpc: { call: async (...args) => {
    if (args[3] === 'ListAnomalies') throw { code: 7, details: 'Review access required.' };
    if (decodeStruct(args[4]).expectedVersion === 1) throw { code: 10, details: 'Payroll changed. Reload it.' };
    throw { code: 16, details: 'Sign in to review.' };
  } } } };
  const server = http.createServer((req, res) => handleHttp(req, res, new URL(req.url, 'http://localhost'), context));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const denied = await fetch(base+'/anomalies?domain=payroll-services&payrunId=p');
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { message: 'Review access required.' });
  const stale = await fetch(base+'/anomalies/review', { method: 'POST', body: JSON.stringify({ expectedVersion: 1 }) });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { message: 'Payroll changed. Reload it.' });
  const unauthenticated = await fetch(base+'/anomalies/review', { method: 'POST', body: '{}' });
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(await unauthenticated.json(), { message: 'Sign in to review.' });
});
