// Pre-processing: chooses which pay lines a model question needs, so the prompt stays small (free
// tiers limit tokens per minute) and the approach scales to large payruns. Plain rules, no model:
//   a concept question (definitions, general guidance) -> header and totals only
//   a question naming employees                        -> those employees' lines
//   a question about findings, review, or anomalies    -> the flagged employees' lines
//   anything else                                      -> every line while the run is small
//                                                         (SMALL_RUN_LINES), else flagged ones
// Otherwise the totals, computed facts, and findings always cover the whole run.
const { formatContext, MAX_CONTEXT_CHARS } = require('./payrunContext');
const { normalize, mentioned, employeesOf } = require('./factAnswers');

const SMALL_RUN_LINES = 25;
const CONCEPT = /\b(mean|means|meaning|difference between|usually|typically|in general|definition|define)\b|^what (is|are) (fica|flsa|futa|suta|a w-?[24]|w-?[24]s?)\b/;
const REVIEW = /\b(review|unusual|wrong|odd|suspicious|anomal\w*|flag\w*|issues?|problems?|risk\w*|incident|missing|duplicat\w*|twice|terminat\w*|outliers?|check)\b/;

function selectEmployees(question, context) {
  const q = normalize(question);
  const run = context.payrun;
  const flagged = [...new Set(context.signals.filter(signal => signal.kind !== 'new hire').map(signal => signal.employeeId))];
  if (CONCEPT.test(q)) return { kind: 'concept', employeeIds: [] };
  const named = mentioned(q, employeesOf(run)).map(employee => employee.employeeId);
  if (named.length) return { kind: 'named employees', employeeIds: named };
  if (REVIEW.test(q)) return { kind: 'flagged employees', employeeIds: flagged };
  if (run.lines.length <= SMALL_RUN_LINES) return { kind: 'whole run', employeeIds: null };
  return { kind: 'flagged employees', employeeIds: flagged };
}

// The payroll context narrowed to the question, with a summary of what was sent.
function scopeContext(context, question) {
  if (!context?.payrun) return context;
  const selection = selectEmployees(question, context);
  let text = formatContext(context.payrun, context.history || [], { employeeIds: selection.employeeIds });
  // A concept question needs only the payrun header and totals (lines 1-2) to stay on this run.
  if (selection.kind === 'concept') text = text.split('\n').slice(0, 2).join('\n');
  if (text.length > MAX_CONTEXT_CHARS) text = `${text.slice(0, MAX_CONTEXT_CHARS)}\n[context truncated]`;
  const linesSent = selection.employeeIds
    ? context.payrun.lines.filter(line => selection.employeeIds.includes(line.employeeId)).length : context.payrun.lines.length;
  return { ...context, text, scope: { kind: selection.kind, linesSent, linesTotal: context.payrun.lines.length } };
}

// Whether a question is about findings or review (the UI shows incident suggestions only then).
const isReviewQuestion = question => REVIEW.test(normalize(question || ''));

module.exports = { scopeContext, selectEmployees, isReviewQuestion, SMALL_RUN_LINES };
