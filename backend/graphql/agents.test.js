const { test } = require('node:test');
const assert = require('node:assert/strict');
const { handleAgent, isAgentRequest } = require('./agents');
const { resolvers } = require('./aistudio');

function context(call, features = ['manageAgents']) {
  return { context: { viewer: { features } }, dataSources: { grpc: { call } } };
}
function response() {
  return { headers: {}, setHeader(key, value) { this.headers[key] = value; },
    writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
}

test('DELETE forwards the domain and agent to gRPC and returns an empty 204', async () => {
  const res = response();
  assert.equal(isAgentRequest('/agents/payroll-services/agent-1'), true);
  assert.equal(isAgentRequest('/agents/payroll-services'), false);
  await handleAgent({ method: 'DELETE' }, res, '/agents/payroll-services/agent-1', context(async (...args) => {
    assert.equal(args[3], 'DeleteAgent');
    assert.deepEqual(args[4], { id: 'agent-1', domain_name: 'payroll-services' });
    return {};
  }));
  assert.equal(res.status, 204);
  assert.equal(res.body, undefined);
});

test('HTTP and GraphQL deletion require manageAgents before calling storage', async () => {
  const denied = context(() => assert.fail('must not call storage'), ['createAgents']);
  assert.throws(() => resolvers.Mutation.deleteAgent(null, { id: 'a', domainName: 'd' }, denied),
    error => error.extensions.code === 'FORBIDDEN');
  const res = response();
  await handleAgent({ method: 'DELETE' }, res, '/agents/d/a', denied);
  assert.equal(res.status, 403);
});

test('deletion reports invalid, missing and unavailable agents, and rejects other methods', async () => {
  for (const [code, status] of [[3, 400], [5, 404], [14, 503]]) {
    const res = response();
    await handleAgent({ method: 'DELETE' }, res, '/agents/d/a', context(async () => {
      throw { code, details: 'Agent unavailable.' };
    }));
    assert.equal(res.status, status);
  }
  const res = response();
  await handleAgent({ method: 'POST' }, res, '/agents/d/a', context(() => assert.fail('must not delete')));
  assert.equal(res.status, 405);
  assert.equal(res.headers.Allow, 'DELETE');
  const malformed = response();
  await handleAgent({ method: 'DELETE' }, malformed, '/agents/d/%ZZ', context(() => assert.fail('must not delete')));
  assert.equal(malformed.status, 400);
});
