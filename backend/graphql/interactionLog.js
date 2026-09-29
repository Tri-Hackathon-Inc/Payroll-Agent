// Builds the record of one answered question for the admin metrics (registry/metrics.py) from
// what the webhook already knows: how the answer was produced, latency, tokens, the reply check,
// the payrun's findings, and any incident. Measurements only; no model credentials, no payroll
// lines. The Redis session ID is stored hashed (it only groups questions into conversations).
const { createHash } = require('node:crypto');

const SEVERITIES = ['critical', 'warning', 'info'];
const ANSWER_TYPES = new Set(['payroll-data', 'model', 'rag', 'anomaly-pipeline', 'incident-report']);

const hashed = value => (value ? createHash('sha256').update(String(value)).digest('hex').slice(0, 32) : '');
// Reply fingerprint for the consistency metric (whitespace and case do not count as a difference).
const fingerprint = reply => (reply ? hashed(String(reply).toLowerCase().replace(/\s+/g, ' ').trim()) : '');
const count = value => (Number.isFinite(value) && value >= 0 ? Math.round(value) : null);

function findingsOf(payrunContext) {
  if (!payrunContext?.signals) return { findings: null, amountAtRisk: 0 };
  const findings = Object.fromEntries(SEVERITIES.map(severity => [severity, 0]));
  let amountAtRisk = 0;
  for (const signal of payrunContext.signals) {
    if (signal.severity in findings) findings[signal.severity] += 1;
    amountAtRisk += signal.amountAtRisk || 0;
  }
  return { findings, amountAtRisk: Math.round(amountAtRisk * 100) / 100 };
}

function buildInteraction({ question, invocation = {}, source, answer = null, error = null, config = {},
  payrunContext = null, incidentAlert = null, latencyMs }) {
  const check = answer?.check;
  const answeredBy = error ? 'error' : ANSWER_TYPES.has(answer?.answeredBy) ? answer.answeredBy
    : answer?.incident ? 'incident-report' : 'acknowledged';
  const modelTimed = ['model', 'rag', 'anomaly-pipeline', 'incident-report'].includes(answeredBy) && !answer?.cached;
  return {
    question: String(question || '').slice(0, 500),
    answeredBy,
    source: String(invocation?.source || source || '').slice(0, 60),
    sessionId: hashed(answer?.session?.id),
    payrunId: invocation?.payrunId || '',
    intent: answer?.intent || answer?.retrieval?.intent?.intent || '',
    modelId: answer?.model?.id || config.model || '',
    latencyMs: count(latencyMs) ?? 0,
    modelLatencyMs: modelTimed ? count(answer?.metrics?.latencyMs) : null,
    promptTokens: modelTimed ? count(answer?.metrics?.promptTokens) : null,
    completionTokens: modelTimed ? count(answer?.metrics?.completionTokens) : null,
    cached: Boolean(answer?.cached),
    checkStatus: check?.checked ? (check.ok ? 'passed' : 'flagged') : '',
    unverifiedCount: check?.checked ? (check.unverifiedAmounts?.length || 0) + (check.unknownEmployees?.length || 0) : 0,
    ...findingsOf(payrunContext),
    incidentId: incidentAlert?.raised?.incident?.id || answer?.incident?.id || '',
    suggestedCount: incidentAlert?.suggested?.length || 0,
    error: error ? String(error.message || error).slice(0, 300) : '',
    answerHash: error ? '' : fingerprint(answer?.reply),
  };
}

module.exports = { buildInteraction, findingsOf };
