// Post-processing check on a model's reply: every employee ID it names must exist in the payroll
// data, and every dollar amount must appear in the data the model was given (the payroll context
// text, which already holds the computed totals, facts, and findings). Anything else is reported
// so the reply can carry a note instead of an unchecked figure.

const AMOUNT = /\$\s?(\d[\d,]*(?:\.\d+)?)/g;
const NUMBER = /\d[\d,]*(?:\.\d+)?/g;
const EMPLOYEE_ID = /\bE\d{3,}\b/g;

const parse = text => Number(text.replace(/,/g, ''));

function checkReply(reply, context) {
  if (!context?.payrun) return { checked: false, ok: true, unknownEmployees: [], unverifiedAmounts: [] };
  const knownIds = new Set([context.payrun, ...(context.history || [])].flatMap(run => run.lines.map(line => line.employeeId)));
  const knownNumbers = new Set((context.text.match(NUMBER) || []).map(value => Math.round(parse(value) * 100)));
  const unknownEmployees = [...new Set(reply.match(EMPLOYEE_ID) || [])].filter(id => !knownIds.has(id));
  const unverifiedAmounts = [...new Set([...reply.matchAll(AMOUNT)].map(match => match[0].replace(/\s/g, '')))]
    .filter(amount => !knownNumbers.has(Math.round(parse(amount.slice(1)) * 100)));
  return { checked: true, ok: !unknownEmployees.length && !unverifiedAmounts.length, unknownEmployees, unverifiedAmounts };
}

// The note appended to a reply that did not pass the check.
function checkNote(result) {
  const parts = [];
  if (result.unverifiedAmounts.length) parts.push(`${result.unverifiedAmounts.join(', ')} ${result.unverifiedAmounts.length === 1 ? 'is' : 'are'} not in the payroll data (possibly calculated by the model)`);
  if (result.unknownEmployees.length) parts.push(`${result.unknownEmployees.join(', ')} ${result.unknownEmployees.length === 1 ? 'is not an employee' : 'are not employees'} in this payrun`);
  return `Check before acting: ${parts.join('; ')}.`;
}

module.exports = { checkReply, checkNote };
