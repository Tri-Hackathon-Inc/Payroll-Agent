// Severity policy for the automated findings, shared by the anomaly checks, the chat answers, and
// the Incident Report agent so they always agree:
//   critical - money would be paid wrongly or taxes under-withheld (duplicate payment, pay after
//              termination, no tax withholding), or more than CRITICAL_AMOUNT is at risk;
//   warning  - an unusual value to confirm (outliers, missing deductions);
//   info     - context only (new hire).
// An agent's capabilities.alerts decides what happens (see webhook.js): with alerts enabled,
// critical findings raise an incident automatically; other findings at or above alerts.severity
// are suggested for an incident.

const CRITICAL_KINDS = new Set(['duplicate payment', 'paid after termination', 'no tax withholding']);
const INFO_KINDS = new Set(['new hire']);
const CRITICAL_AMOUNT = 5000;
const RANK = { info: 0, warning: 1, critical: 2 };

const money = value => Math.round(value * 100) / 100;

// Dollars that would be paid wrongly if the run were approved as is, where it can be computed.
// lines: the employee's pay lines in this run; past: their lines in the history runs.
function amountAtRisk(kind, lines, past) {
  const line = lines[0];
  const highest = pick => Math.max(0, ...past.map(pick));
  switch (kind) {
    case 'duplicate payment': return money(line.gross * (lines.length - 1));
    case 'paid after termination': return money(line.gross);
    case 'bonus outlier': return money(line.earnings.bonus - highest(item => item.earnings.bonus));
    case 'reimbursement outlier': return money(line.earnings.reimbursement - highest(item => item.earnings.reimbursement));
    default: return null;
  }
}

function severityOf(kind, amount) {
  if (INFO_KINDS.has(kind)) return 'info';
  if (CRITICAL_KINDS.has(kind) || (amount != null && amount > CRITICAL_AMOUNT)) return 'critical';
  return 'warning';
}

const atLeast = (severity, threshold) => RANK[severity] >= (RANK[threshold] ?? RANK.warning);

module.exports = { amountAtRisk, severityOf, atLeast, CRITICAL_AMOUNT, RANK };
