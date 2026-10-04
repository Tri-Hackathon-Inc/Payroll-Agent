const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { createGrpcDataSource } = require('../local_server/grpc-client');
const { catalogRpc } = require('../graphql/aistudio');
const { encodeStruct } = require('../graphql/client');
const { handleHttp } = require('../local_server/http-adapter');

test('HTTP Review waits beyond five seconds while ordinary reads keep a short gRPC deadline', { timeout: 15000 }, async t => {
  const definition = protoLoader.loadSync(catalogRpc.protoPath, { keepCase: true, defaults: true, oneofs: true });
  const namespace = catalogRpc.packageName.split('.').reduce((value, part) => value[part], grpc.loadPackageDefinition(definition));
  const server = new grpc.Server();
  let reviewBudget, readBudget, timer, calls = 0;
  server.addService(namespace[catalogRpc.serviceName].service, {
    ReviewAnomaly(call, callback) {
      calls++;
      reviewBudget = new Date(call.getDeadline()).getTime() - Date.now();
      timer = setTimeout(() => callback(null, encodeStruct({ reviewStatus: 'completed' })), 5500);
    },
    ListAnomalies(call, callback) {
      readBudget = new Date(call.getDeadline()).getTime() - Date.now();
      callback(null, encodeStruct({ items: [] }));
    },
  });
  const port = await new Promise((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(),
    (error, port) => error ? reject(error) : resolve(port)));
  const source = createGrpcDataSource(`127.0.0.1:${port}`);
  const context = { context: {}, dataSources: { grpc: source } };
  const transport = http.createServer((req, res) => handleHttp(req, res, new URL(req.url, 'http://localhost'), context));
  t.after(() => { clearTimeout(timer); transport.closeAllConnections(); transport.close(); source.close(); server.forceShutdown(); });
  transport.listen(0, '127.0.0.1');
  await once(transport, 'listening');
  const base = `http://127.0.0.1:${transport.address().port}`;
  const response = await fetch(base + '/anomalies/review', { method: 'POST', body: JSON.stringify({ action: 'REVIEW' }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).reviewStatus, 'completed');
  assert.equal(calls, 1);
  assert.ok(reviewBudget > 170000 && reviewBudget <= 180000, `Review deadline: ${reviewBudget}`);
  const list = await fetch(base + '/anomalies?domain=payroll&payrunId=run');
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), { items: [] });
  assert.ok(readBudget > 0 && readBudget <= 5000, `Read deadline: ${readBudget}`);
});
