const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPseudonymizer, employeesIn } = require('./piiMask');
const { formatContext } = require('./payrunContext');

const fixture = require('./fixtures/payrun-PR-2026-09-B.json');
const context = { payrun: fixture.payrun, history: fixture.payrunHistory };

test('employee names are replaced with IDs before a model call and restored in the reply', () => {
  const pii = createPseudonymizer(employeesIn(context), {});
  const text = formatContext(fixture.payrun, fixture.payrunHistory);
  const masked = pii.mask(text);
  for (const line of fixture.payrun.lines) assert.ok(!masked.includes(line.name), `${line.name} is not sent`);
  assert.match(masked, /- E1004 \(Sales, salary/);
  assert.match(masked, /\$62,504\.00/, 'pay figures stay');
  assert.equal(pii.mask("Why are Daniel Brooks's taxes so high? And Brooks's bonus?"), "Why are E1004's taxes so high? And E1004's bonus?");
  assert.equal(pii.unmask('E1004 got a $25,000.00 bonus; E1004 Daniel Brooks is flagged.'),
    'E1004 Daniel Brooks got a $25,000.00 bonus; E1004 Daniel Brooks is flagged.');
  assert.ok(pii.masked > 10);
});

test('ambiguous last names are not guessed, and masking can be turned off', () => {
  const pii = createPseudonymizer([{ employeeId: 'E1', name: 'Ann Lee' }, { employeeId: 'E2', name: 'Bo Lee' }], {});
  assert.equal(pii.mask('Ann Lee and Lee'), 'E1 and Lee', 'a shared last name stays (only full names match)');
  const off = createPseudonymizer(employeesIn(context), { PII_MASKING: 'false' });
  assert.equal(off.mask('Daniel Brooks'), 'Daniel Brooks');
  assert.equal(off.enabled, false);
});

test('JSON replies get names back in prose fields while IDs used as keys stay exact', () => {
  const { unmaskJsonProse } = require('./piiMask');
  const pii = createPseudonymizer(employeesIn(context), {});
  const reply = JSON.stringify({ answer: 'E1004 got a large bonus.', sourceIds: ['E1004:2026-09'],
    findings: [{ findingId: 'E1004:bonus', explanation: 'E1004 bonus is 30x the median.', reviewAction: 'Confirm with E1004 manager.' }] });
  const restored = JSON.parse(unmaskJsonProse(reply, pii));
  assert.equal(restored.answer, 'E1004 Daniel Brooks got a large bonus.');
  assert.equal(restored.findings[0].explanation, 'E1004 Daniel Brooks bonus is 30x the median.');
  assert.equal(restored.findings[0].findingId, 'E1004:bonus');
  assert.deepEqual(restored.sourceIds, ['E1004:2026-09']);
  assert.equal(unmaskJsonProse('not json E1004', pii), 'not json E1004');
});
