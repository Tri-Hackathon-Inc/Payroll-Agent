const { digest } = require('../redisStore');
let pool;

function getVectorPool() {
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({ host: process.env.VECTOR_DB_HOST || 'vector-db', port: Number(process.env.VECTOR_DB_PORT) || 5432,
      database: process.env.VECTOR_DB_NAME || 'payroll_vectors', user: process.env.VECTOR_DB_USER || 'payroll_vector',
      password: process.env.VECTOR_DB_PASSWORD, max: 4, connectionTimeoutMillis: 3000, idleTimeoutMillis: 10000 });
    pool.on('error', () => {});
  }
  return pool;
}

async function closeVectorPool() { if (pool) { const active = pool; pool = null; await active.end(); } }

function vectorLiteral(vector, dimensions) {
  if (!Array.isArray(vector) || vector.length !== dimensions || !vector.every(Number.isFinite)) throw new Error('Invalid embedding dimensions.');
  return `[${vector.join(',')}]`;
}

class PayrollVectorStore {
  constructor(client, embeddings) { this.client = client; this.embeddings = embeddings; }

  async ensureIndex() {
    const dimensions = this.embeddings.dimensions;
    if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 4096) throw new Error('Invalid embedding dimensions.');
    await this.client.query('CREATE EXTENSION IF NOT EXISTS vector');
    await this.client.query(`CREATE TABLE IF NOT EXISTS payroll_history_documents (
      id TEXT NOT NULL, embedding_model TEXT NOT NULL, scope TEXT NOT NULL,
      employee_hash TEXT NOT NULL, topic TEXT NOT NULL, document JSONB NOT NULL,
      embedding vector(${dimensions}) NOT NULL, indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (id, embedding_model))`);
    await this.client.query('CREATE INDEX IF NOT EXISTS payroll_history_scope ON payroll_history_documents (scope, employee_hash, topic)');
  }

  async indexDocuments(documents) {
    await this.ensureIndex();
    documents = [...new Map(documents.map(doc => [doc.id, doc])).values()];
    const existing = await this.client.query('SELECT id FROM payroll_history_documents WHERE id = ANY($1::text[]) AND embedding_model = $2',
      [documents.map(doc => doc.id), this.embeddings.version]);
    const known = new Set(existing.rows.map(row => row.id));
    const missing = documents.filter(doc => !known.has(doc.id));
    const vectors = await this.embeddings.embed(missing.map(doc => doc.text));
    if (vectors.length !== missing.length) throw new Error('Embedding count mismatch.');
    let inserted = 0;
    for (let i = 0; i < missing.length; i++) {
      const doc = missing[i];
      const result = await this.client.query(`INSERT INTO payroll_history_documents
        (id, embedding_model, scope, employee_hash, topic, document, embedding)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::vector) ON CONFLICT (id, embedding_model) DO NOTHING`,
      [doc.id, this.embeddings.version, doc.scope, digest(doc.employeeId), doc.topic, JSON.stringify(doc), vectorLiteral(vectors[i], this.embeddings.dimensions)]);
      inserted += result.rowCount;
    }
    return { documents: documents.length, inserted, existing: documents.length - inserted };
  }

  async search({ query, documents, employeeIds, topics, k = 6 }) {
    if (!documents.length) return [];
    if (topics.some(topic => !['earnings', 'overtime', 'deductions'].includes(topic))) throw new Error('Invalid retrieval topic.');
    const [vector] = await this.embeddings.embed([query]);
    // Exact KNN within the trusted source snapshot; filters are SQL parameters, never model-authored SQL.
    const result = await this.client.query(`SELECT id, embedding <=> $5::vector AS distance
      FROM payroll_history_documents
      WHERE scope = $1 AND id = ANY($2::text[]) AND embedding_model = $7
        AND (cardinality($3::text[]) = 0 OR employee_hash = ANY($3::text[]))
        AND (cardinality($4::text[]) = 0 OR topic = ANY($4::text[]))
      ORDER BY embedding <=> $5::vector, id LIMIT $6`,
    [documents[0].scope, documents.map(doc => doc.id), employeeIds.map(digest), topics,
      vectorLiteral(vector, this.embeddings.dimensions), Math.max(1, Math.min(k, 20)), this.embeddings.version]);
    const allowed = new Map(documents.map(doc => [doc.id, doc]));
    return result.rows.flatMap(row => {
      const doc = allowed.get(row.id), distance = Number(row.distance);
      return doc && Number.isFinite(distance) && (!employeeIds.length || employeeIds.includes(doc.employeeId))
        && (!topics.length || topics.includes(doc.topic)) ? [{ ...doc, distance }] : [];
    });
  }
}

module.exports = { PayrollVectorStore, vectorLiteral, getVectorPool, closeVectorPool };
