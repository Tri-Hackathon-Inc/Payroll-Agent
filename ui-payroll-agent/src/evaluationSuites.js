// Golden test cases for the Evaluation page and scripts/benchmark-models.mjs, keyed by template
// id; each template's starting questions have a case here. Every case runs
// against the sample payrun PR-2026-09-B; keep the checks in sync with its planted
// anomalies (seeded in backend/trinet_mock/seed/payruns.json). A check passes when the reply
// contains any `anyOf` term, or none of the `noneOf` terms (case-insensitive).
export const EVALUATION_PAYRUN = 'PR-2026-09-B'

export const EVALUATION_SUITES = {
  'anomaly-detection': {
    name: 'Planted payrun anomalies',
    description: 'Recall of the seven anomalies seeded into the pending payrun, plus one normal employee that must not be flagged.',
    cases: [{
      id: 'review-all',
      prompt: 'Which payments need review?',
      checks: [
        { label: 'Overtime spike: Luis Ortega (46 OT hours)', anyOf: ['E1002', 'Ortega'] },
        { label: 'Bonus outlier: Daniel Brooks ($25,000)', anyOf: ['E1004', 'Brooks'] },
        { label: 'Duplicate payment: Aisha Karim', anyOf: ['E1005', 'Karim'] },
        { label: 'Paid after termination: Tom Becker', anyOf: ['E1006', 'Becker'] },
        { label: 'Health deduction missing: Grace Liu', anyOf: ['E1007', 'Grace Liu'] },
        { label: 'Unusual reimbursement: Sam Patel ($1,850)', anyOf: ['E1008', 'Patel'] },
        { label: 'No tax withholding: Jordan Reyes (new hire)', anyOf: ['E1009', 'Reyes'] },
        { label: 'Does not flag Maya Chen (normal pay)', noneOf: ['E1001', 'Maya Chen'] },
      ],
    },
    { id: 'duplicates', prompt: 'Is anyone paid twice in this payrun?', checks: [
      { label: 'Names Aisha Karim', anyOf: ['E1005', 'Karim'] },
      { label: 'Does not name Maya Chen', noneOf: ['E1001', 'Maya Chen'] },
    ] },
    { id: 'termination', prompt: 'Is anyone paid after their termination date?', checks: [
      { label: 'Names Tom Becker', anyOf: ['E1006', 'Becker'] },
      { label: 'Gives the termination date (2026-09-12)', anyOf: ['2026-09-12', 'September 12', 'Sep 12', '09-12'] },
    ] },
    { id: 'missing-withholding', prompt: 'Are any taxes or deductions missing?', checks: [
      { label: 'Health deduction missing: Grace Liu', anyOf: ['E1007', 'Grace Liu'] },
      { label: 'No tax withholding: Jordan Reyes', anyOf: ['E1009', 'Reyes'] },
    ] },
    { id: 'biggest-change', prompt: 'Whose pay changed the most since the last payrun?', checks: [
      { label: 'Names Daniel Brooks', anyOf: ['E1004', 'Brooks'] },
      { label: 'Gives the change (+$24,380)', anyOf: ['24,380', '24380'] },
    ] }],
  },
  summarizer: {
    name: 'Payrun summary coverage',
    description: 'The summary must report totals and the notable workforce changes in the pending payrun.',
    cases: [{
      id: 'summary',
      prompt: 'Summarize this payrun.',
      checks: [
        { label: 'Reports gross pay ($62,504.00)', anyOf: ['62,504', '62504'] },
        { label: 'Reports net pay ($44,610.40)', anyOf: ['44,610', '44610'] },
        { label: 'Mentions the new hire (Jordan Reyes)', anyOf: ['Jordan Reyes', 'new hire'] },
        { label: 'Mentions the termination (Tom Becker)', anyOf: ['Tom Becker', 'terminat'] },
        { label: 'Compares against the prior run', anyOf: ['prior', 'previous', 'last run'] },
      ],
    },
    { id: 'changes', prompt: 'What changed since the last payrun?', checks: [
      { label: 'Reports the gross change (+$34,558 / $27,946 before)', anyOf: ['34,558', '34558', '27,946', '27946'] },
      { label: 'Mentions the bonus (Daniel Brooks)', anyOf: ['Brooks', 'bonus'] },
      { label: 'Mentions the new hire (Jordan Reyes)', anyOf: ['Jordan Reyes', 'new hire'] },
    ] },
    { id: 'pre-approval', prompt: 'What should I check before approving this payrun?', checks: [
      { label: 'Duplicate payment: Aisha Karim', anyOf: ['E1005', 'Karim'] },
      { label: 'Paid after termination: Tom Becker', anyOf: ['E1006', 'Becker'] },
      { label: 'Bonus outlier: Daniel Brooks', anyOf: ['E1004', 'Brooks'] },
    ] }],
  },
  'general-query': {
    name: 'Payrun Q&A',
    description: 'Factual questions a payroll admin would ask about the pending payrun.',
    cases: [
      { id: 'overtime', prompt: "Why is Luis Ortega's pay higher this run?", checks: [{ label: 'Attributes it to overtime', anyOf: ['overtime', '46'] }] },
      { id: 'new-hire', prompt: 'Who is being paid for the first time in this payrun?', checks: [{ label: 'Names Jordan Reyes', anyOf: ['Jordan Reyes', 'E1009'] }] },
      { id: 'net-total', prompt: 'What is the total net pay for this payrun?', checks: [{ label: 'Answers $44,610.40', anyOf: ['44,610', '44610'] }] },
      { id: 'compare-previous', prompt: 'How does this payrun compare to the previous one?', checks: [
        { label: 'Gives both gross figures ($62,504 vs $27,946)', anyOf: ['27,946', '27946'] },
        { label: 'Mentions the net pay change', anyOf: ['44,610', '44610', '25,982', '25982'] },
      ] },
      { id: 'top-department', prompt: 'Which department has the highest payroll cost?', checks: [
        { label: 'Answers Sales ($28,500)', anyOf: ['Sales'] },
      ] },
      { id: 'overtime-who', prompt: 'Who worked overtime this payrun?', checks: [
        { label: 'Names Luis Ortega (46h)', anyOf: ['Ortega'] },
        { label: 'Names Aisha Karim', anyOf: ['Karim'] },
        { label: 'Names Sam Patel', anyOf: ['Patel'] },
        { label: 'Does not name Maya Chen', noneOf: ['Maya Chen'] },
      ] },
    ],
  },
}

export function gradeReply(reply, checks) {
  const text = reply.toLowerCase()
  const has = (term) => text.includes(term.toLowerCase())
  return checks.map((check) => ({
    ...check,
    passed: check.anyOf ? check.anyOf.some(has) : !check.noneOf.some(has),
  }))
}
