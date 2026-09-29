// Anomaly detection -> incident creation by severity (findingPolicy). When an agent with
// capabilities.alerts enabled answers on a payrun, or the payrun changes (payrollEvents.js):
//   critical findings not reported before -> the domain's Incident Report agent raises an incident
//                                             automatically (evidence, screenshots, email);
//   warnings at or above alerts.severity   -> suggested for an incident (the user decides);
//   info                                   -> nothing.
// Each finding is raised once per domain, payrun, employee, and kind. The store claims findings
// atomically, so two workers (or a chat and a payrun change at once) never raise the same
// finding twice. Postgres keeps the claims across restarts; memory is for tests and runs
// without Postgres.
const { atLeast } = require('./findingPolicy');

// Store interface: raisedKeys(domain, payrunId) -> Set; claim(domain, payrunId, keys) -> the keys
// newly claimed; release(domain, payrunId, keys); attach(domain, payrunId, keys, incidentId).
function createIncidentStore() {
  const claims = new Map();
  const id = (domainName, payrunId, key) => `${domainName}\u0000${payrunId}\u0000${key}`;
  return {
    async raisedKeys(domainName, payrunId) {
      return new Set([...claims.keys()].filter(item => item.startsWith(`${domainName}\u0000${payrunId}\u0000`)).map(item => item.split('\u0000')[2]));
    },
    async claim(domainName, payrunId, keys) {
      return keys.filter(key => !claims.has(id(domainName, payrunId, key)) && claims.set(id(domainName, payrunId, key), null));
    },
    async release(domainName, payrunId, keys) { keys.forEach(key => claims.delete(id(domainName, payrunId, key))); },
    async attach(domainName, payrunId, keys, incidentId) { keys.forEach(key => claims.set(id(domainName, payrunId, key), incidentId)); },
  };
}

const TABLE = `CREATE TABLE IF NOT EXISTS payroll_incident_findings (
  domain_name text NOT NULL, payrun_id text NOT NULL, finding_key text NOT NULL, incident_id text,
  raised_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (domain_name, payrun_id, finding_key))`;

function createPostgresIncidentStore(pool) {
  let ready;
  const query = async (text, values) => {
    ready ||= pool.query(TABLE).catch(error => { ready = null; throw error; });
    await ready;
    return pool.query(text, values);
  };
  return {
    async raisedKeys(domainName, payrunId) {
      const { rows } = await query('SELECT finding_key FROM payroll_incident_findings WHERE domain_name = $1 AND payrun_id = $2', [domainName, payrunId]);
      return new Set(rows.map(row => row.finding_key));
    },
    async claim(domainName, payrunId, keys) {
      if (!keys.length) return [];
      const { rows } = await query(`INSERT INTO payroll_incident_findings (domain_name, payrun_id, finding_key)
        SELECT $1, $2, unnest($3::text[]) ON CONFLICT DO NOTHING RETURNING finding_key`, [domainName, payrunId, keys]);
      return rows.map(row => row.finding_key);
    },
    async release(domainName, payrunId, keys) {
      if (keys.length) await query('DELETE FROM payroll_incident_findings WHERE domain_name = $1 AND payrun_id = $2 AND finding_key = ANY($3::text[])', [domainName, payrunId, keys]);
    },
    async attach(domainName, payrunId, keys, incidentId) {
      if (keys.length) await query('UPDATE payroll_incident_findings SET incident_id = $4 WHERE domain_name = $1 AND payrun_id = $2 AND finding_key = ANY($3::text[])', [domainName, payrunId, keys, incidentId]);
    },
  };
}

// Postgres when the stack has it (VECTOR_DB_PASSWORD, as for the RAG store); if Postgres is
// unreachable, fall back to memory so alerts keep working (a restart may then repeat one).
function createDefaultIncidentStore(env = process.env) {
  const memory = createIncidentStore();
  if (!env.VECTOR_DB_PASSWORD) return memory;
  let postgres;
  const durable = () => (postgres ||= createPostgresIncidentStore(require('./rag/vectorStore').getVectorPool()));
  const withFallback = method => async (...args) => {
    try { return await durable()[method](...args); } catch (error) {
      console.warn(`Incident store unavailable, using memory: ${error.message}`);
      return memory[method](...args);
    }
  };
  return Object.fromEntries(['raisedKeys', 'claim', 'release', 'attach'].map(method => [method, withFallback(method)]));
}

const findingKey = signal => `${signal.employeeId}|${signal.kind}`;
const brief = signal => ({ employeeId: signal.employeeId, name: signal.name, kind: signal.kind, severity: signal.severity,
  amountAtRisk: signal.amountAtRisk ?? null });

// Which findings to raise now, which to suggest, and which were already raised (raised: Set of keys).
function planIncidents({ signals, alerts, raised = new Set() }) {
  if (!alerts?.enabled) return null;
  const critical = signals.filter(signal => signal.severity === 'critical');
  const toRaise = critical.filter(signal => !raised.has(findingKey(signal)));
  const suggested = signals.filter(signal => signal.severity === 'warning' && atLeast(signal.severity, alerts.severity));
  return { toRaise, alreadyRaised: critical.length - toRaise.length, suggested };
}

// The handed-over "conversation" for an automatic incident: the anomaly agent's findings.
function findingsMessage(agentName, signals, reason = '') {
  return { role: 'agent', agent: agentName, text: [`Automatic alert${reason ? ` (${reason})` : ''}: ${signals.length} critical finding${signals.length === 1 ? '' : 's'}.`,
    ...signals.map(signal => `- ${signal.employeeId} ${signal.name}: ${signal.kind}: ${signal.detail}.`)].join('\n') };
}

module.exports = { createIncidentStore, createPostgresIncidentStore, createDefaultIncidentStore, planIncidents, findingKey,
  findingsMessage, brief };
