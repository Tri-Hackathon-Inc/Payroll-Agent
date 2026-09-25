const { parseArgs } = require('node:util');
const { PAYRUN_FIELDS } = require('../payrunContext');
const { completedPayrunDocuments } = require('./documents');
const { LocalEmbeddings } = require('./embeddings');
const { PayrollVectorStore, getVectorPool, closeVectorPool } = require('./vectorStore');

async function loadCompletedPayruns({ endpoint = process.env.TRINET_API_URL, fetchImpl = fetch } = {}) {
  if (!endpoint) throw new Error('TRINET_API_URL is required to load historical payments.');
  try {
    const response = await fetchImpl(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `query IngestCompletedPayruns { payruns(status: COMPLETED) { ${PAYRUN_FIELDS} } }` }),
      signal: AbortSignal.timeout(30000), redirect: 'error' });
    const body = await response.json();
    if (!response.ok || body.errors?.length || !Array.isArray(body.data?.payruns)) throw new Error('Invalid payroll response.');
    return body.data.payruns;
  } catch { throw new Error('Completed payroll history could not be loaded from the payroll API.'); }
}

class PayrollHistoryIngestor {
  constructor(dependencies = {}) { this.dependencies = dependencies; }

  async run({ domainName, service, dryRun = false }) {
    if (![domainName, service].every(value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,254}$/.test(value))) {
      throw new Error('Provide valid --domain and --service identifiers for the agent scope.');
    }
    const deps = this.dependencies;
    const runs = await (deps.loadRuns || loadCompletedPayruns)(deps);
    if (!Array.isArray(runs)) throw new Error('The payroll API must return a list of completed runs.');
    const seen = new Set();
    const completed = runs.filter(run => {
      if (run?.status !== 'COMPLETED' || seen.has(run.id)) return false;
      seen.add(run.id); return true;
    });
    // Validate the entire source before writes; future/current-run eligibility remains a query-time filter.
    const batches = completed.map(run => completedPayrunDocuments(run, { domainName, service }));
    const employees = new Set(batches.flat().map(doc => JSON.stringify([doc.scope, doc.employeeId])));
    const summary = { domainName, service, payruns: completed.length, skippedPayruns: runs.length - completed.length,
      employees: employees.size, documents: batches.reduce((total, docs) => total + docs.length, 0),
      inserted: 0, existing: 0, dryRun, embeddingModel: (deps.embeddings || new LocalEmbeddings()).version };
    if (dryRun || !batches.length) return summary;
    const store = deps.vectorStore || new PayrollVectorStore(getVectorPool(), deps.embeddings || new LocalEmbeddings());
    for (const docs of batches) {
      try {
        const result = await store.indexDocuments(docs);
        summary.inserted += result.inserted; summary.existing += result.existing;
      } catch { throw new Error('History indexing failed. Check PostgreSQL and the embedding model cache; rerunning safely resumes completed inserts.'); }
    }
    return summary;
  }
}

async function main() {
  const { values } = parseArgs({ options: { domain: { type: 'string' }, service: { type: 'string' },
    'dry-run': { type: 'boolean', default: false } }, strict: true });
  try {
    const summary = await new PayrollHistoryIngestor().run({ domainName: values.domain, service: values.service, dryRun: values['dry-run'] });
    console.log(JSON.stringify(summary));
  } finally { await closeVectorPool(); }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { PayrollHistoryIngestor, loadCompletedPayruns };
