const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startStandaloneServer } = require('@apollo/server/standalone');
const { DatabaseSync } = require('node:sqlite');
const { createApolloServer } = require('./server');
const { openDatabase } = require('./db');
const { recalculateLine, recalculateTotals } = require('./payroll');

const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed', 'payruns.json'), 'utf8'));

const LINE = 'lineId name payType hours { regular overtime } earnings { bonus overtime } gross taxes { federal } net';
const UPDATE = `mutation ($input: UpdatePayLineInput!) {
  updatePayLine(input: $input) { id version totals { gross net } lines { ${LINE} } }
}`;

function setup(databasePath) {
  const server = createApolloServer();
  const store = openDatabase(databasePath);
  const run = async (query, variables) => {
    const { body } = await server.executeOperation({ query, variables }, { contextValue: { store } });
    return JSON.parse(JSON.stringify(body.singleResult)); // plain objects for deepEqual
  };
  return { run, store };
}

test('recalculation reproduces every seeded line and total', () => {
  for (const payrun of seed.payruns) {
    for (const line of payrun.lines) {
      const employee = seed.employees.find(item => item.employeeId === line.employeeId);
      assert.deepEqual(recalculateLine(line, employee), line, line.lineId);
    }
    assert.deepEqual(recalculateTotals(payrun), payrun.totals, payrun.id);
  }
});

// Nullable columns come back as null; the seed simply omits those keys.
const withoutNulls = value => JSON.parse(JSON.stringify(value, (key, item) => (item === null ? undefined : item)));

test('the database round-trips the seed exactly', () => {
  const store = openDatabase();
  for (const run of seed.payruns) {
    const { lines, ...summary } = run;
    assert.deepEqual(withoutNulls(store.getPayrun(run.id)), summary, run.id);
    assert.deepEqual(withoutNulls(store.getLines(run.id)), lines, `${run.id} lines`);
  }
  for (const employee of seed.employees) assert.deepEqual(store.getEmployee(employee.employeeId), employee);
});

test('saveLine refuses a stale version inside its transaction', () => {
  const store = openDatabase();
  const [line] = store.getLines('PR-2026-09-B');
  const totals = store.getPayrun('PR-2026-09-B').totals;
  assert.equal(store.saveLine({ payrunId: 'PR-2026-09-B', expectedVersion: 1, line, totals }), true);
  assert.equal(store.saveLine({ payrunId: 'PR-2026-09-B', expectedVersion: 1, line, totals }), false);
  assert.equal(store.getPayrun('PR-2026-09-B').version, 2);
});

test('payrun queries', async () => {
  const { run } = setup();
  const list = await run('{ payruns { id status } pending: payruns(status: PENDING_APPROVAL) { id } }');
  assert.equal(list.errors, undefined);
  assert.deepEqual(list.data.payruns[0], { id: 'PR-2026-09-B', status: 'PENDING_APPROVAL' });
  assert.deepEqual(list.data.pending, [{ id: 'PR-2026-09-B' }]);
  const history = await run('{ payrunHistory(limit: 2) { id } older: payrunHistory(before: "PR-2026-09-A") { id } }');
  assert.deepEqual(history.data.payrunHistory.map(item => item.id), ['PR-2026-09-A', 'PR-2026-08-B']);
  assert.deepEqual(history.data.older.map(item => item.id), ['PR-2026-08-B', 'PR-2026-08-A']);
  const employee = await run('{ employeePayHistory(employeeId: "E1005") { employee { name } lines { payrunId line { lineId } } } }');
  assert.equal(employee.data.employeePayHistory.lines.length, 5);
  const missing = await run('{ payrun(id: "nope") { id } }');
  assert.equal(missing.errors[0].extensions.code, 'NOT_FOUND');
});

test('UI reads emit scoped events with the current version; internal reads remain silent', async () => {
  const server = createApolloServer();
  const store = openDatabase();
  const sent = [];
  const run = async (query, variables) => (await server.executeOperation({ query, variables },
    { contextValue: { store, events: { notify: event => sent.push(event) } } })).body.singleResult;
  await run('{ payrun(id: "PR-2026-09-B") { id } payrunHistory { id } }');
  assert.equal(sent.length, 0);
  const query = `query($line: ID) { payrun(id: "PR-2026-09-B", monitor: true, domainName: "payroll-services", checkLineId: $line) { version } }`;
  assert.equal((await run(query)).errors, undefined);
  assert.equal(sent[0].type, 'payrun.loaded');
  assert.equal(sent[0].domainName, 'payroll-services');
  assert.equal(sent[0].version, 1);
  await run(UPDATE, { input: { payrunId: 'PR-2026-09-B', lineId: 'PR-2026-09-B-L07', earnings: { bonus: 100 } } });
  await run(query, { line: 'PR-2026-09-B-L07' });
  assert.deepEqual([sent[2].type, sent[2].version, sent[2].employeeId], ['paycheck.opened', 2, 'E1006']);
  assert.ok((await run(query, { line: 'PR-2026-09-A-L07' })).errors);
  assert.ok((await run('{ payrun(id: "PR-2026-09-B", monitor: true) { id } }')).errors);
  assert.equal(sent.length, 3, 'invalid requests never trigger checks');
  store.close();
  await server.stop();
});

test('updatePayLine recalculates pay, totals, and version', async () => {
  const { run } = setup();
  const edited = await run(UPDATE, { input: { payrunId: 'PR-2026-09-B', lineId: 'PR-2026-09-B-L02', expectedVersion: 1, hours: { overtime: 4 } } });
  assert.equal(edited.errors, undefined);
  const payrun = edited.data.updatePayLine;
  assert.equal(payrun.version, 2);
  assert.equal(payrun.lines[1].earnings.overtime, 192);
  assert.equal(payrun.lines[1].gross, 2752);
  assert.equal(payrun.totals.gross, 62504 - 4768 + 2752);

  const stale = await run(UPDATE, { input: { payrunId: 'PR-2026-09-B', lineId: 'PR-2026-09-B-L02', expectedVersion: 1, hours: { overtime: 2 } } });
  assert.equal(stale.errors[0].extensions.code, 'CONFLICT');
  assert.equal(stale.errors[0].extensions.currentVersion, 2);

  // Jordan Reyes has no withholding set up; editing pay must not add taxes.
  const hire = await run(UPDATE, { input: { payrunId: 'PR-2026-09-B', lineId: 'PR-2026-09-B-L10', earnings: { bonus: 500 } } });
  const jordan = hire.data.updatePayLine.lines[9];
  assert.equal(jordan.taxes.federal, 0);
  assert.equal(jordan.gross, 4750);
});

test('invalid edits and completed runs are rejected', async () => {
  const { run } = setup();
  const edit = input => run(UPDATE, { input: { payrunId: 'PR-2026-09-B', lineId: 'PR-2026-09-B-L01', ...input } });
  const code = async result => (await result).errors?.[0].extensions.code;
  assert.equal(await code(edit({ hours: { overtime: 5 } })), 'BAD_USER_INPUT');
  assert.equal(await code(edit({ earnings: { bonus: -1 } })), 'BAD_USER_INPUT');
  assert.equal(await code(edit({ paymentMethod: 'Cash' })), 'BAD_USER_INPUT');
  assert.equal(await code(edit({ taxes: { federal: 0 } })), 'BAD_USER_INPUT');
  assert.equal(await code(run(UPDATE, { input: { payrunId: 'PR-2026-09-A', lineId: 'PR-2026-09-A-L01', earnings: { bonus: 1 } } })), 'CONFLICT');
  assert.equal(await code(run(UPDATE, { input: { payrunId: 'PR-2026-09-B', lineId: 'nope' } })), 'NOT_FOUND');
});

test('edits persist in the database file and reset restores the seed', async t => {
  const databasePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trinet-mock-')), 'trinet_mock.sqlite3');
  t.after(() => fs.rmSync(path.dirname(databasePath), { recursive: true, force: true }));
  const first = setup(databasePath);
  await first.run(UPDATE, { input: { payrunId: 'PR-2026-09-B', lineId: 'PR-2026-09-B-L04', earnings: { bonus: 2500 } } });
  first.store.close();

  const tables = new DatabaseSync(databasePath).prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  assert.deepEqual(tables.map(row => row.name), ['employees', 'pay_lines', 'payruns']);

  const second = setup(databasePath);
  const bonus = async () => (await second.run('{ payrun(id: "PR-2026-09-B") { version lines { earnings { bonus } } } }')).data.payrun;
  assert.equal((await bonus()).lines[3].earnings.bonus, 2500);
  assert.equal((await bonus()).version, 2);
  assert.deepEqual((await second.run('mutation { resetPayrollData }')).data, { resetPayrollData: true });
  assert.equal((await bonus()).lines[3].earnings.bonus, 25000);
  assert.equal((await bonus()).version, 1);
});

test('serves GraphQL over HTTP', async t => {
  const server = createApolloServer();
  const store = openDatabase();
  const { url } = await startStandaloneServer(server, { listen: { port: 0, host: '127.0.0.1' }, context: async () => ({ store }) });
  t.after(() => server.stop());
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '{ payruns { id } }' }) });
  assert.equal((await response.json()).data.payruns.length, 4);
});

test('a saved pay line sends a payrun.changed event, and delivery failures never block the save', async () => {
  const { createEventNotifier } = require('./events');
  const sent = [];
  const events = createEventNotifier({ url: 'http://agent-studio/events/payroll', token: 'shared-secret',
    fetchImpl: async (url, request) => { sent.push({ url, request }); return { ok: true }; } });
  const server = createApolloServer();
  const store = openDatabase();
  const run = async (query, variables, contextValue) => JSON.parse(JSON.stringify(
    (await server.executeOperation({ query, variables }, { contextValue })).body.singleResult));
  const edited = await run(UPDATE, { input: { payrunId: 'PR-2026-09-B', lineId: 'PR-2026-09-B-L07', earnings: { bonus: 100 } } }, { store, events });
  assert.equal(edited.errors, undefined);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].request.headers['X-Payroll-Events-Token'], 'shared-secret');
  const event = JSON.parse(sent[0].request.body);
  assert.deepEqual([event.type, event.payrunId, event.version, event.lineId, event.employeeId],
    ['payrun.changed', 'PR-2026-09-B', 2, 'PR-2026-09-B-L07', 'E1006']);

  const warn = console.warn;
  console.warn = () => {};
  try {
    const down = createEventNotifier({ url: 'http://agent-studio/events/payroll', fetchImpl: async () => { throw new Error('refused'); } });
    const saved = await run(UPDATE, { input: { payrunId: 'PR-2026-09-B', lineId: 'PR-2026-09-B-L07', earnings: { bonus: 200 } } }, { store, events: down });
    assert.equal(saved.errors, undefined, 'the save succeeds when the receiver is down');
    assert.equal(await down.notify({}), false);
  } finally {
    console.warn = warn;
  }
  assert.equal(await createEventNotifier({ url: '' }).notify({}), false, 'no URL, no event');
})
