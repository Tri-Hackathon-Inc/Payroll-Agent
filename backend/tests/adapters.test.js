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
