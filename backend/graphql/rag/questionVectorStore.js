const { vectorLiteral } = require('./vectorStore');

// Question embeddings are a separate collection from paycheck evidence. Only question
// IDs supplied by the current agent catalogue can be returned from its scoped index.
class QuestionVectorStore {
  constructor(client, embeddings) { this.client = client; this.embeddings = embeddings; }

  async indexQuestions(questions) {
    const dimensions = this.embeddings.dimensions;
    if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 4096) throw new Error('Invalid embedding dimensions.');
    await this.client.query('CREATE EXTENSION IF NOT EXISTS vector');
    await this.client.query(`CREATE TABLE IF NOT EXISTS payroll_question_embeddings (
      id TEXT NOT NULL, embedding_model TEXT NOT NULL, scope TEXT NOT NULL,
      question JSONB NOT NULL, embedding vector(${dimensions}) NOT NULL,
      indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (id, embedding_model))`);
    await this.client.query('CREATE INDEX IF NOT EXISTS payroll_question_scope ON payroll_question_embeddings (scope)');
    const existing = await this.client.query('SELECT id FROM payroll_question_embeddings WHERE id = ANY($1::text[]) AND embedding_model = $2',
      [questions.map(item => item.id), this.embeddings.version]);
    const known = new Set(existing.rows.map(row => row.id));
    const missing = questions.filter(item => !known.has(item.id));
    const vectors = await this.embeddings.embed(missing.map(item => item.text));
    if (vectors.length !== missing.length) throw new Error('Embedding count mismatch.');
    for (let i = 0; i < missing.length; i++) {
      const item = missing[i];
      await this.client.query(`INSERT INTO payroll_question_embeddings (id, embedding_model, scope, question, embedding)
        VALUES ($1, $2, $3, $4::jsonb, $5::vector) ON CONFLICT (id, embedding_model) DO NOTHING`,
      [item.id, this.embeddings.version, item.scope, JSON.stringify(item), vectorLiteral(vectors[i], dimensions)]);
    }
  }

  async search({ questions, query, k = 3 }) {
    if (!questions.length) return [];
    const [vector] = await this.embeddings.embed([query]);
    const result = await this.client.query(`SELECT id, embedding <=> $4::vector AS distance
      FROM payroll_question_embeddings WHERE scope = $1 AND id = ANY($2::text[]) AND embedding_model = $3
      ORDER BY embedding <=> $4::vector, id LIMIT $5`,
    [questions[0].scope, questions.map(item => item.id), this.embeddings.version,
      vectorLiteral(vector, this.embeddings.dimensions), Math.max(1, Math.min(Number(k) || 3, 5))]);
    const allowed = new Map(questions.map(item => [item.id, item]));
    return result.rows.flatMap(row => {
      const item = allowed.get(row.id), distance = Number(row.distance);
      return item && Number.isFinite(distance) ? [{ ...item, distance }] : [];
    });
  }
}

module.exports = { QuestionVectorStore };
