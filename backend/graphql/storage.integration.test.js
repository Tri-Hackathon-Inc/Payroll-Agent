const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { ConversationStore, getRedis, closeRedis, digest } = require('./redisStore');
const { PayrollVectorStore, getVectorPool, closeVectorPool } = require('./rag/vectorStore');
const enabled = process.env.RUN_STORAGE_TESTS === '1';
const ids = [];
let testScope;
after(async () => {
  if (!enabled) return;
  const redis = await getRedis();
  for (const id of ids) await redis.del(`payroll:session:${id}`);
  if (testScope) await getVectorPool().query('DELETE FROM payroll_history_documents WHERE scope = $1', [testScope]);
  await closeRedis(); await closeVectorPool();
});

test('Redis resumes context, enforces browser/agent scope, caches retries, and expires sessions', { skip: !enabled }, async () => {
  const client = await getRedis(), store = new ConversationStore({ client, ttl: 60 });
  const scope = { domain: 'test', agent: randomUUID(), owner: randomUUID() }, context = { payrunId: 'p', employeeId: null };
  const first = await store.run({ scope, context, question: 'Luis overtime?', requestId: 'first' }, async () => ({
    answer: { reply: 'Overtime increased.' }, focus: { employeeIds: ['E1002'], topics: ['overtime'] } }));
  ids.push(first.session.id);
  let calls = 0;
  const options = { sessionId: first.session.id, scope, context, question: 'What about deductions?', requestId: 'second' };
  const second = await store.run(options, async state => {
    calls++;
    assert.equal(state.history.length, 2);
    assert.deepEqual(state.focus.employeeIds, ['E1002']);
    return { answer: { reply: 'Deductions are stable.' } };
  });
  const retried = await store.run(options, async () => { throw new Error('Must not run twice'); });
  assert.equal(retried.reply, second.reply);
  assert.equal(calls, 1);
  assert.ok(await client.ttl(`payroll:session:${first.session.id}`) > 0);
  for (const wrong of [{ ...scope, owner: 'other' }, { ...scope, agent: 'other' }]) {
    await assert.rejects(store.run({ ...options, scope: wrong }, async () => ({})), error => error.status === 409);
  }
  await assert.rejects(store.run({ ...options, context: { payrunId: 'another' } }, async () => ({})), error => error.status === 409);
  await client.pExpire(`payroll:session:${first.session.id}`, 1);
  await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(store.run(options, async () => ({})), error => error.status === 410);
});

test('Redis serializes simultaneous turns and never saves failed model turns', { skip: !enabled }, async () => {
  const client = await getRedis(), store = new ConversationStore({ client });
  const scope = { agent: randomUUID() };
  const first = await store.run({ scope, question: 'Hi' }, async () => ({ answer: { reply: 'Hello' } }));
  ids.push(first.session.id);
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const pending = store.run({ scope, sessionId: first.session.id, question: 'Wait' }, async () => {
    entered(); await new Promise(resolve => { release = resolve; }); return { answer: { reply: 'Done' } };
  });
  await ready;
  await assert.rejects(store.run({ scope, sessionId: first.session.id, question: 'Race' }, async () => ({})), error => error.status === 409);
  release(); await pending;
  const key = `payroll:session:${first.session.id}`, before = await client.get(key);
  await assert.rejects(store.run({ scope, sessionId: first.session.id, question: 'Failure' }, async () => { throw new Error('model failed'); }));
  assert.equal(await client.get(key), before);
});

test('Postgres persists semantic documents and exact KNN respects scope, employee, topic and source revisions', { skip: !enabled }, async () => {
  testScope = digest(randomUUID());
  let embedded = 0;
  const embedder = { dimensions: 384, version: 'integration-test-384', embed: async texts => texts.map(text => {
    embedded++;
    const vector = Array(384).fill(0); vector[text.includes('overtime') ? 0 : 1] = 1; return vector;
  }) };
  const pg = getVectorPool(), store = new PayrollVectorStore(pg, embedder);
  const make = (employeeId, topic, suffix = '') => ({ id: digest([testScope, employeeId, topic, suffix]), scope: testScope,
    employeeId, topic, revision: 'v1', text: topic, payrunId: 'old', payDate: '2026-09-01' });
  const docs = [make('E1001', 'overtime'), make('E1001', 'deductions'), make('E1002', 'overtime')];
  assert.deepEqual(await store.indexDocuments(docs), { documents: 3, inserted: 3, existing: 0 });
  assert.deepEqual(await store.indexDocuments([...docs, docs[0]]), { documents: 3, inserted: 0, existing: 3 });
  assert.equal(embedded, 3);
  const result = await new PayrollVectorStore(pg, embedder).search({ query: 'overtime', documents: docs, employeeIds: ['E1001'], topics: ['overtime'], k: 6 });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, docs[0].id);
  assert.ok(result[0].distance < .001);
  const absent = await store.search({ query: 'overtime', documents: [make('E1001', 'overtime', 'new revision')], employeeIds: [], topics: [], k: 6 });
  assert.equal(absent.length, 0);
  const foreign = await store.search({ query: 'overtime', documents: [{ ...docs[0], scope: digest('other') }], employeeIds: [], topics: [], k: 6 });
  assert.equal(foreign.length, 0);
});
