// Golden test cases for the Evaluation page, keyed by template id. Every case runs
// against the sample payrun PR-2026-09-B; keep the checks in sync with its planted
// anomalies (listed in backend/trinet_mock/README.md). A check passes when the reply
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
    }],
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
    }],
  },
  'general-query': {
    name: 'Payrun Q&A',
    description: 'Factual questions a payroll admin would ask about the pending payrun.',
    cases: [
      { id: 'overtime', prompt: "Why is Luis Ortega's pay higher this run?", checks: [{ label: 'Attributes it to overtime', anyOf: ['overtime', '46'] }] },
      { id: 'new-hire', prompt: 'Who is being paid for the first time in this payrun?', checks: [{ label: 'Names Jordan Reyes', anyOf: ['Jordan Reyes', 'E1009'] }] },
      { id: 'net-total', prompt: 'What is the total net pay for this payrun?', checks: [{ label: 'Answers $44,610.40', anyOf: ['44,610', '44610'] }] },
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
