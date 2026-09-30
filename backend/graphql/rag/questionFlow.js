const { randomUUID } = require('node:crypto');
const { digest, failure } = require('../redisStore');
const { LocalEmbeddings } = require('./embeddings');
const { getVectorPool } = require('./vectorStore');
const { QuestionVectorStore } = require('./questionVectorStore');
const library = require('./payrollQuestions.json');

function questionCatalogue({ agent, config, domainName }) {
  const scope = digest(['questions-v1', domainName, agent.id, config.service]);
  const texts = [...(config.questions || []), ...library.flatMap(group => group.questions)];
  const unique = new Map();
  for (const text of texts) {
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) continue;
    const normalized = text.trim().replace(/\s+/g, ' ');
    const key = normalized.toLowerCase();
    if (!unique.has(key)) unique.set(key, { id: digest([scope, key]), scope, text: normalized });
  }
  return [...unique.values()];
}

// Called inside the conversation lock by both public adapters. The pending match is
// server-owned, expiring, and scoped by Redis to this browser/domain/agent/payrun/employee.
async function runQuestionFlow(args, conversation, dependencies = {}) {
  const { question, confirmation } = args;
  if (!conversation.scopeHash) throw failure('Question confirmation requires conversation storage. Configure Redis and retry.');
  const questions = questionCatalogue(args);
  const revision = digest([questions, args.config]);
  const now = dependencies.now?.() ?? Date.now();
  if (confirmation !== undefined && confirmation !== null) {
    if (!confirmation || typeof confirmation !== 'object' || Array.isArray(confirmation)
      || typeof confirmation.mappingId !== 'string' || typeof confirmation.questionId !== 'string') {
      throw failure('Confirm a proposed question using its mappingId and questionId.', 400);
    }
    const pending = conversation.pendingQuestion;
    if (!pending || confirmation.mappingId !== pending.id || pending.expiresAt <= now
      || pending.originalQuery !== question.trim() || pending.revision !== revision) {
      throw failure('This question match has expired or changed. Submit the query again to review a new match.', 409);
    }
    const match = pending.candidates.find(item => item.id === confirmation.questionId);
    const current = questions.find(item => item.id === confirmation.questionId);
    if (!match || !current || current.text !== match.text) throw failure('Choose one of the questions proposed for this query.', 400);
    const mappedQuestion = { id: match.id, text: match.text, originalQuery: pending.originalQuery, distance: match.distance };
    const answerQuestion = dependencies.answerQuestion || require('../webhook').answerQuestion;
    const { focus, ...answer } = await answerQuestion({ ...args, conversation, mappedQuestion }, dependencies);
    return { answer: { ...answer, status: 'answered', mappedQuestion }, focus, pendingQuestion: null };
  }

  if (!questions.length) throw failure('No predefined questions are available for this agent. Configure its question list first.');
  const embeddings = dependencies.embeddings || new LocalEmbeddings();
  const store = dependencies.questionStore || new QuestionVectorStore(getVectorPool(), embeddings);
  let matches;
  try {
    await store.indexQuestions(questions);
    // Short follow-ups retain prior employee/topic context for question matching only.
    // The second retrieval still validates employee scope against the current payrun.
    const previous = conversation.focus;
    const followUp = /^(and\b|what about\b|how about\b|why\b|explain\b)/i.test(question.trim()) && previous;
    const query = followUp ? `${question.trim()}\nPrior question: ${previous.question || ''}. Topics: ${(previous.topics || []).join(', ')}.` : question.trim();
    matches = await store.search({ questions, query, k: 3 });
  } catch { throw failure('Predefined-question search is unavailable. Please retry; no payroll retrieval or model call has run.'); }
  const allowed = new Map(questions.map(item => [item.id, item]));
  const candidates = matches.filter(item => allowed.has(item.id) && Number.isFinite(item.distance))
    .map(item => ({ id: item.id, text: allowed.get(item.id).text, distance: item.distance }));
  if (!candidates.length) throw failure('No predefined question could be matched. Rephrase the query or update the agent questions.');
  const pendingQuestion = { id: randomUUID(), originalQuery: question.trim(), candidates, revision, expiresAt: now + 10 * 60 * 1000 };
  const { revision: unused, ...mapping } = pendingQuestion;
  return { recordTurn: false, pendingQuestion, answer: { status: 'confirmation_required',
    answeredBy: 'question-mapping', reply: 'Confirm the predefined question you want this agent to answer.',
    questionMapping: { ...mapping, embeddingModel: embeddings.version }, model: null, metrics: null } };
}

module.exports = { questionCatalogue, runQuestionFlow };
