// Anomaly detection -> incident creation by severity (findingPolicy). When an agent with
// capabilities.alerts enabled answers on a payrun:
//   critical findings not reported before -> the domain's Incident Report agent raises an incident
//                                             automatically (evidence, screenshots, email);
//   warnings at or above alerts.severity   -> suggested for an incident (the user decides);
//   info                                   -> nothing.
// Each finding is raised once per domain, payrun, employee, and kind. The store is in memory for
// now (lost on restart); the shared Postgres store can replace it with the same has/add interface.
const { atLeast } = require('./findingPolicy');

function createIncidentStore() {
  const keys = new Set();
  return { has: key => keys.has(key), add: key => keys.add(key) };
}

const findingKey = (domainName, payrunId, signal) => [domainName, payrunId, signal.employeeId, signal.kind].join('|');
const brief = signal => ({ employeeId: signal.employeeId, name: signal.name, kind: signal.kind, severity: signal.severity,
  amountAtRisk: signal.amountAtRisk ?? null });

// Which findings to raise now, which to suggest, and which were already raised.
function planIncidents({ signals, alerts, domainName, payrunId, store }) {
  if (!alerts?.enabled) return null;
  const critical = signals.filter(signal => signal.severity === 'critical');
  const toRaise = critical.filter(signal => !store.has(findingKey(domainName, payrunId, signal)));
  const suggested = signals.filter(signal => signal.severity === 'warning' && atLeast(signal.severity, alerts.severity));
  return { toRaise, alreadyRaised: critical.length - toRaise.length, suggested };
}

// The handed-over "conversation" for an automatic incident: the anomaly agent's findings.
function findingsMessage(agentName, signals) {
  return { role: 'agent', agent: agentName, text: [`Automatic alert: ${signals.length} critical finding${signals.length === 1 ? '' : 's'}.`,
    ...signals.map(signal => `- ${signal.employeeId} ${signal.name}: ${signal.kind}: ${signal.detail}.`)].join('\n') };
}

module.exports = { createIncidentStore, planIncidents, findingKey, findingsMessage, brief };
