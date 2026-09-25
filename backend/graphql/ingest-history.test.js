const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PayrollHistoryIngestor, loadCompletedPayruns } = require('./rag/ingest-history');
const { historyDocuments } = require('./rag/documents');

const scope = { domainName: 'payroll-services', service: 'payrun' };
const old = { id: 'old', company: 'Example', currency: 'USD', frequency: 'semi-monthly', status: 'COMPLETED',
  periodStart: '2026-08-01', periodEnd: '2026-08-15', payDate: '2026-08-20',
  lines: ['E1001', 'E1002', 'E9000'].map(employeeId => ({ employeeId, lineId: employeeId, name: employeeId, payType: 'hourly',
    gross: 1000, net: 800, hours: { regular: 80, overtime: 4 }, earnings: { regular: 900, overtime: 100 },
    deductions: { health: 100 }, taxes: { federal: 100 } })) };
const current = { ...old, id: 'current', status: 'PENDING_APPROVAL', payDate: '2026-09-20',
  periodStart: '2026-09-01', periodEnd: '2026-09-15', lines: old.lines.slice(0, 2) };

function storage() {
  const rows = new Map();
  let calls = 0;
  return { rows, get calls() { return calls; }, async indexDocuments(docs) {
    calls++;
    let inserted = 0;
    for (const doc of docs) if (!rows.has(doc.id)) { rows.set(doc.id, doc); inserted++; }
    return { documents: docs.length, inserted, existing: docs.length - inserted };
  } };
}

test('preload includes every historical employee, excludes drafts, and shares IDs with chat retrieval', async () => {
  const vectorStore = storage();
  const ingestor = new PayrollHistoryIngestor({ loadRuns: async () => [current, old, old], vectorStore });
  const first = await ingestor.run(scope);
  assert.equal(first.payruns, 1);
  assert.equal(first.skippedPayruns, 2);
  assert.equal(first.employees, 3);
  assert.equal(first.inserted, 9);
  assert.ok([...vectorStore.rows.values()].some(doc => doc.employeeId === 'E9000'));
  const second = await ingestor.run(scope);
  assert.equal(second.inserted, 0);
  assert.equal(second.existing, 9);
  const queried = historyDocuments({ current, history: [old] }, { employees: current.lines }, scope);
  assert.equal(queried.length, 6);
  assert.ok(queried.every(doc => vectorStore.rows.has(doc.id)));
  assert.ok(queried.every(doc => doc.employeeId !== 'E9000'));
  const calls = vectorStore.calls;
  assert.equal((await ingestor.run({ ...scope, dryRun: true })).documents, 9);
  assert.equal(vectorStore.calls, calls);
});

test('changed historical values get new identities while unchanged documents remain reusable', async () => {
  const vectorStore = storage();
  const edited = structuredClone(old);
  const ingestor = new PayrollHistoryIngestor({ loadRuns: async () => [edited], vectorStore });
  await ingestor.run(scope);
  edited.lines[0].gross += 100;
  const result = await ingestor.run(scope);
  assert.equal(result.inserted, 1);
  assert.equal(result.existing, 8);
  assert.equal(vectorStore.rows.size, 10);
  const revised = historyDocuments({ current, history: [edited] }, { employees: current.lines }, scope);
  assert.ok(revised.find(doc => doc.employeeId === 'E1001' && doc.topic === 'earnings').text.includes('1100'));
});

test('ingestion validates scope and completed source records before performing writes', async () => {
  const vectorStore = storage();
  let loaded = false;
  const ingestor = new PayrollHistoryIngestor({ vectorStore, loadRuns: async () => {
    loaded = true; return [old, { ...old, id: 'bad', periodStart: '2026-02-30' }];
  } });
  await assert.rejects(ingestor.run({ ...scope, domainName: '' }), /domain/);
  assert.equal(loaded, false);
  await assert.rejects(ingestor.run(scope), /valid dates/);
  assert.equal(vectorStore.calls, 0);
});

test('source loader requests completed history and hides upstream error details', async () => {
  let request;
  const runs = await loadCompletedPayruns({ endpoint: 'http://payroll.example', fetchImpl: async (url, input) => {
    request = JSON.parse(input.body);
    return { ok: true, json: async () => ({ data: { payruns: [old] } }) };
  } });
  assert.match(request.query, /payruns\(status: COMPLETED\)/);
  assert.equal(runs[0].id, old.id);
  await assert.rejects(loadCompletedPayruns({ endpoint: 'http://payroll.example', fetchImpl: async () => {
    throw new Error('private-connection-details');
  } }), error => /could not be loaded/.test(error.message) && !error.message.includes('private'));
});
