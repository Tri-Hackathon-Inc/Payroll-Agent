// Resolve conversational references before choosing a factual or model answer.
// Previous replies identify the subject only; amounts always come from fresh payroll data.
const { mentioned, normalize } = require('./factAnswers');

const METRICS = [
  ['overtime hours', 'overtime', /\bovertime\b.*\bhours\b|\bhours\b.*\bovertime\b/],
  ['overtime pay', 'overtime', /\bovertime\b/],
  ['regular hours', 'overtime', /\bregular hours\b/],
  ['net pay', 'earnings', /\bnet\b|\btake[ -]home\b/],
  ['gross pay', 'earnings', /\bgross\b/],
  ['bonus', 'earnings', /\bbonus\w*\b/],
  ['reimbursement', 'earnings', /\breimburse\w*\b/],
  ['salary', 'earnings', /\bsalary\b|\brate\b/],
  ['health deduction', 'deductions', /\bhealth\b/],
  ['401k deduction', 'deductions', /\b401k\b|\bretirement\b/],
  ['garnishment', 'deductions', /\bgarnish\w*\b/],
  ['tax withholding', 'deductions', /\btax\w*\b|\bwithh\w*\b/],
  ['deductions', 'deductions', /\bdeductions?\b/],
];
const ALL = /\b(all employees|all payments|everyone|everybody|entire payrun|whole payrun|all staff)\b/;
const PERSON = /\b(he|she|his|her|him|this employee|that employee|same employee|same person)\b/;
const PEOPLE = /\b(they|their|them|those employees|these employees)\b/;
const REFERENCE = /\b(it|that|those|these|same)\b/;
const CONTINUATION = /^(and\b|what about\b|how about\b|why\b|explain\b|compare (it|that|them|this)\b)/;
const HISTORY = /\b(history|historical|previous|prior|earlier|last (run|payrun|payment|period)|past (payments|runs)|trend\w*|compar\w*)\b/;

function vocabulary(question) {
  const q = normalize(question);
  const found = METRICS.filter(([, , pattern]) => pattern.test(q));
  const metrics = found.map(([metric]) => metric).filter(metric => metric !== 'overtime pay' || !found.some(([name]) => name === 'overtime hours'));
  return { metrics, topics: [...new Set(found.map(([, topic]) => topic))] };
}

function employeeList(employees = []) {
  return [...new Map(employees.map(employee => [employee.employeeId,
    { employeeId: employee.employeeId, name: employee.name || employee.employeeId }])).values()];
}

function previousContext(history, employees) {
  const lastUser = [...history].reverse().find(turn => turn.role === 'user');
  const lastAnswer = [...history].reverse().find(turn => turn.role === 'assistant');
  const question = lastUser?.content || '';
  const named = mentioned(normalize(question), employees);
  const referenced = mentioned(normalize(lastAnswer?.content || ''), employees);
  return { employeeIds: (named.length ? named : referenced).map(employee => employee.employeeId),
    ...vocabulary(question), question: question.slice(0, 1000), period: HISTORY.test(normalize(question)) ? 'history' : 'current' };
}

function resolveQuestionContext({ question, employees = [], selectedEmployee, previousFocus, history = [] }) {
  employees = employeeList(employees);
  const allowed = new Set(employees.map(employee => employee.employeeId));
  const previous = previousFocus || previousContext(history, employees);
  let q = normalize(question);
  const named = mentioned(q, employees).map(employee => employee.employeeId);
  const hasPast = history.length > 0 || Boolean(previousFocus);
  const answeringClarification = previous.pendingQuestion && named.length === 1
    && q.split(' ').length <= 5 && !vocabulary(question).metrics.length;
  const original = answeringClarification ? previous.pendingQuestion : question;
  q = normalize(original);
  const requested = vocabulary(original);
  const all = ALL.test(q);
  const followUp = !all && (answeringClarification || PERSON.test(q) || PEOPLE.test(q) || REFERENCE.test(q)
    || CONTINUATION.test(q) || (hasPast && requested.metrics.length && q.split(' ').length <= 4)
    || (hasPast && /^(in |for |the )?(previous|prior|last|earlier)\b/.test(q)));
  const inheritedIds = (previous.employeeIds || []).filter(id => allowed.has(id));
  const employeeIds = selectedEmployee ? [selectedEmployee] : named.length ? named : followUp ? inheritedIds : [];
  const inheritedMetrics = (previous.metrics || vocabulary(previous.question || '').metrics)
    .filter(metric => METRICS.some(([name]) => name === metric));
  const metrics = requested.metrics.length ? requested.metrics : followUp ? inheritedMetrics : [];
  const topics = requested.topics.length ? requested.topics : followUp ? (previous.topics || []).filter(topic => ['earnings', 'overtime', 'deductions'].includes(topic)) : [];
  const explicitCurrent = /\b(this|current) (run|payrun|payment|period)\b/.test(q);
  const period = HISTORY.test(q) ? 'history' : explicitCurrent ? 'current' : followUp && previous.period === 'history' ? 'history' : 'current';
  let clarification = null;
  if (!selectedEmployee && !named.length && ((PERSON.test(q) && employeeIds.length !== 1) || (PEOPLE.test(q) && !employeeIds.length))) {
    clarification = 'Which employee do you mean? Select one or include their name or employee ID.';
  } else if (!hasPast && !selectedEmployee && !named.length && /^(why|why is that|explain that|what about that)$/.test(q)) {
    clarification = 'Which payment or change would you like me to explain?';
  }
  if (selectedEmployee && named.some(id => id !== selectedEmployee)) {
    clarification = 'That question names a different employee. Change the employee selection or ask about the selected employee.';
  }
  const unknown = (question.match(/\bE\d{4,}\b/gi) || []).some(id => !employees.some(employee => employee.employeeId.toLowerCase() === id.toLowerCase()));
  if (unknown) clarification = 'That employee is not in this payrun. Choose an employee from the current payrun.';
  const focus = { employeeIds, topics, metrics, period, question: original.slice(0, 1000) };
  if (clarification) return { question: original, followUp: Boolean(followUp), clarification,
    focus: { ...previous, pendingQuestion: original.slice(0, 1000) } };
  const subject = employeeIds.map(id => employees.find(employee => employee.employeeId === id))
    .filter(Boolean).map(employee => `${employee.employeeId} ${employee.name}`).join(', ');
  const details = [subject, metrics.join(', '), period === 'history' ? 'historical payments' : ''].filter(Boolean);
  const resolved = (followUp || selectedEmployee) && details.length ? `${original}\nFollow-up context: ${details.join('; ')}.` : original;
  return { question: resolved, followUp: Boolean(followUp), clarification: null, focus };
}

function focusFromAnswer(resolution, reply, employees) {
  if (resolution.clarification) return resolution.focus;
  const referenced = mentioned(normalize(reply || ''), employeeList(employees)).map(employee => employee.employeeId);
  return { ...resolution.focus, employeeIds: resolution.focus.employeeIds.length ? resolution.focus.employeeIds : referenced };
}

module.exports = { resolveQuestionContext, focusFromAnswer, vocabulary, HISTORY };
