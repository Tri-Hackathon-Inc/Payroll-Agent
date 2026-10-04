const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { encodeStruct, decodeStruct } = require('../graphql/client');
const { handleHttp, isHttpRequest } = require('../local_server/http-adapter');

test('generic anomaly events and tenant-scoped cases pass unchanged to Python', async t => {
  const calls = [];
  const context = { context: { headers: { 'x-payroll-events-token': 'producer-secret' } }, dataSources: { grpc: {
    call: async (...args) => {
      calls.push({ method: args[3], body: decodeStruct(args[4]), metadata: args[5] });
      return encodeStruct(args[3] === 'PublishPayrollEvent' ? { accepted: true, eventId: 'event-1' } : { items: [] });
    },
  } } };
  assert.equal(isHttpRequest('/events/anomaly'), true);
  const server = http.createServer((req, res) => handleHttp(req, res, new URL(req.url, 'http://localhost'), context));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = { type: 'anomaly.recorded', domainName: 'leaves', tenant: 'company-1', entityId: 'leave-1',
    entityType: 'leave-request', version: 1, occurredAt: '2026-09-30T00:00:00Z', finalized: false,
    measurements: [{ name: 'hours', value: 80, unit: 'hours', dimensions: { employeeId: 'E1' } }] };
  const response = await fetch(base + '/events/anomaly', { method: 'POST', body: JSON.stringify(body) });
  assert.equal(response.status, 202);
  assert.deepEqual(calls[0].body, body);
  assert.equal(calls[0].method, 'PublishPayrollEvent');
  assert.deepEqual(calls[0].metadata.get('x-payroll-events-token'), ['producer-secret']);
  const listed = await fetch(base + '/anomalies?domain=leaves&tenant=company-1&entityType=leave-request&entityId=leave-1');
  assert.equal(listed.status, 200);
  assert.deepEqual(calls[1].body, { domainName: 'leaves', tenant: 'company-1', entityId: 'leave-1', entityType: 'leave-request', payrunId: '' });
  assert.equal((await fetch(base + '/events/anomaly')).status, 405);
});
