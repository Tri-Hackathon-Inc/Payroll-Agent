const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PayrollAnswerPostprocessor } = require('./rag/postprocessor');
const { AnomalyPreprocessor } = require('./anomalyPreprocessor');
const fixture = require('./fixtures/payrun-PR-2026-09-B.json');

const history = fixture.payrunHistory.map(run => ({
  ...fixture.payrun, ...run, status: 'COMPLETED', periodStart: '2026-08-01', periodEnd: '2026-08-15',
  lines: run.lines.map(line => ({ ...fixture.payrun.lines.find(current => current.employeeId === line.employeeId), ...line })),
}));
const evidence = new AnomalyPreprocessor().process(fixture.payrun, history, { employeeId: 'E1002' });
const sources = [
  { id: 'source-1', payrunId: 'PR-2026-08-B', employeeId: 'E1002', payDate: '2026-09-05', topic: 'overtime', text: 'Raw historical document' },
  { id: 'source-2', payrunId: 'PR-2026-08-A', employeeId: 'E1002', payDate: '2026-08-20', topic: 'earnings', text: 'Another raw document' },
];
function answer() {
  return { answer: '  Compare the current payment with the cited history.  ', sourceIds: ['source-1'],
    findings: evidence.findings.map(finding => ({ findingId: finding.id,
      explanation: '  The calculated evidence shows a change.  ', reviewAction: '  Review the approved payroll entries.  ' })) };
}
function processAnswer(value, history = sources, calculated = evidence) {
  return new PayrollAnswerPostprocessor().process(calculated, history, { modelStatus: 'completed', text: JSON.stringify(value) });
}
function assertEvidenceOnly(result, calculated = evidence) {
  assert.equal(result.analysis.modelStatus, 'invalid_response');
  assert.equal(result.analysis.modelAnswer, null);
  assert.deepEqual(result.citedSourceIds, []);
  assert.deepEqual(result.analysis.findings.map(({ modelComment, ...finding }) => finding), calculated.findings);
  assert.ok(result.analysis.findings.every(finding => finding.modelComment === null));
  assert.doesNotMatch(result.reply, /Compare the current payment|Historical sources:|Model explanation:|Suggested review:/);
}

test('formats accepted answers with deduplicated retrieved references and unchanged calculated findings', () => {
  assert.ok(evidence.findings.length, 'fixture must contain calculated findings');
  const before = structuredClone({ evidence, sources });
  const value = answer();
  value.sourceIds = ['source-2', 'source-1', 'source-2'];
  value.findings.reverse();
  const result = processAnswer(value);
  assert.equal(result.analysis.modelStatus, 'completed');
  assert.deepEqual(result.citedSourceIds, ['source-2', 'source-1']);
  assert.deepEqual(result.analysis.modelAnswer.sources, [sources[1], sources[0]].map(({ text, ...metadata }) => metadata));
  assert.deepEqual(result.analysis.modelAnswer.findings.map(item => item.findingId), evidence.findings.map(item => item.id));
  assert.ok(result.analysis.modelAnswer.findings.every(item => item.explanation === 'The calculated evidence shows a change.'));
  assert.ok(result.reply.startsWith('Compare the current payment with the cited history.\n\nHistorical sources:\n'));
  assert.match(result.reply, /1\. Payrun PR-2026-08-A \| Employee E1002 \| paid 2026-08-20 \| earnings/);
  assert.match(result.reply, /2\. Payrun PR-2026-08-B \| Employee E1002 \| paid 2026-09-05 \| overtime\n\nCalculated review:/);
  assert.doesNotMatch(result.reply, /source-1|Raw historical document|Another raw document/);
  assert.deepEqual(result.analysis.findings.map(({ modelComment, ...finding }) => finding), evidence.findings);
  assert.deepEqual({ evidence, sources }, before, 'postprocessing must not mutate evidence or retrieved documents');
});

test('formats only cited documents and permits current-pay answers when history is empty', () => {
  const result = processAnswer(answer());
  assert.deepEqual(result.analysis.modelAnswer.sourceIds, ['source-1']);
  assert.doesNotMatch(result.reply, /PR-2026-08-A/);
  const currentOnly = { ...evidence, findings: [] };
  const noHistory = processAnswer({ answer: 'Historical comparisons are unavailable.', sourceIds: [], findings: [] }, [], currentOnly);
  assert.equal(noHistory.analysis.modelStatus, 'completed');
  assert.deepEqual(noHistory.analysis.modelAnswer.sources, []);
  assert.ok(noHistory.reply.startsWith('Historical comparisons are unavailable.\n\nCalculated review:'));
  assert.doesNotMatch(noHistory.reply, /Historical sources:/);
});

test('rejects invalid citations, malformed answers and incomplete or altered findings as a whole', () => {
  const cases = [
    value => { value.sourceIds = ['invented-source']; },
    value => { value.sourceIds = []; },
    value => { value.sourceIds = [null]; },
    value => { value.sourceIds = [123]; },
    value => { value.sourceIds = ['']; },
    value => { value.answer = ' '; },
    value => { value.answer = 'x'.repeat(3001); },
    value => { value.answer = 'Hidden\u0000text'; },
    value => { value.sources = [{ id: 'source-1', payrunId: 'fabricated' }]; },
    value => { value.findings.pop(); },
    value => { value.findings.push(value.findings[0]); },
    value => { value.findings[0].findingId = 'invented-finding'; },
    value => { value.findings[0].current = 999999; },
    value => { value.findings[0].explanation = ' '; },
    value => { value.findings[0].reviewAction = 'x'.repeat(601); },
    value => { value.findings[0].explanation = 'Hidden\u0000text'; },
  ];
  for (const change of cases) {
    const value = answer();
    change(value);
    assertEvidenceOnly(processAnswer(value));
  }
  for (const text of ['not JSON', 'null', '[]', 'x'.repeat(50001)]) {
    assertEvidenceOnly(new PayrollAnswerPostprocessor().process(evidence, sources, { modelStatus: 'completed', text }));
  }
  const value = answer();
  assertEvidenceOnly(processAnswer(value, []));
});

test('unavailable model output cannot publish prose or attach citations', () => {
  for (const modelStatus of ['not_configured', 'not_needed', 'context_limit', 'unavailable']) {
    const result = new PayrollAnswerPostprocessor().process(evidence, sources, { modelStatus,
      reason: 'Calculated evidence remains available.', text: JSON.stringify(answer()) });
    assert.equal(result.analysis.modelStatus, modelStatus);
    assert.equal(result.analysis.modelAnswer, null);
    assert.deepEqual(result.citedSourceIds, []);
    assert.doesNotMatch(result.reply, /Compare the current payment|Historical sources:/);
    assert.deepEqual(result.analysis.findings.map(({ modelComment, ...finding }) => finding), evidence.findings);
  }
});
