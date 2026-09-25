// Chat webhook: POST /webhook/<domainName>/<agentId> with { question, context? }. With
// context.task "incident-report", the agent receives another agent's conversation instead
// (see incidentReport.js).
// context describes where the host app invoked the agent, e.g. { page: 'payrun', payrunId }.
// Looks the agent up through the same gRPC resolvers as GraphQL and answers (see answerQuestion).
const { resolvers, recordInteraction } = require('./aistudio');
const { buildInteraction } = require('./interactionLog');
const { buildMessages } = require('./agentPrompt');
const { callModel, unavailableReason, ModelUnavailable } = require('./modelRuntime');
const { loadPayrunContext } = require('./payrunContext');
const { AnomalyDetectionPipeline } = require('./anomalyPipeline');
const { withConversation } = require('./redisStore');
const { createIncidentReport } = require('./incidentReport');
const { answerFromData, normalize } = require('./factAnswers');
const { checkReply, checkNote } = require('./replyCheck');
const { createAnswerCache } = require('./answerCache');
const { scopeContext, isReviewQuestion } = require('./contextScope');
const { createDefaultIncidentStore, planIncidents, findingKey, findingsMessage, brief } = require('./incidentTrigger');

const answerCache = createAnswerCache();
const incidentStore = createDefaultIncidentStore();
const INCIDENT_TEMPLATE = 'incident-report';

const WEBHOOK_PATH = /^\/webhook\/([^/]+)\/([^/]+)\/?$/;
const MAX_BODY = 64 * 1024;

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
  }
  try { return body ? JSON.parse(body) : {}; } catch {
    throw Object.assign(new Error('Request body must be JSON.'), { status: 400 });
  }
}

function describeContext(context) {
  if (!context?.page) return '';
  return `Invoked from the ${context.page} page${context.payrunId ? ` for payrun ${context.payrunId}` : ''}. `;
}

// Model configuration of the agent's model, from its template's options (snake_case over gRPC).
async function agentModel(agent, config, context) {
  try {
    const template = await resolvers.Query.getTemplate(null, { id: resolvers.Agent.templateId(agent) }, context);
    const model = resolvers.Template.modelOptions(template).find(item => item.id === config.model);
    return model && { id: model.id, name: model.name, provider: model.provider, modelId: model.model_id,
      endpointEnv: model.endpoint_env, credentialEnv: model.credential_env, parameters: model.parameters };
  } catch {
    return null; // The source template was removed; fall back to the acknowledgement.
  }
}

// Answers a question, in order:
//   1. a fact in the payroll data is answered exactly in code (factAnswers), even when no model is
//      connected; follow-ups that depend on the conversation ("his", "her") go on to the next steps;
//   2. payrun questions go to the payroll RAG pipeline when Redis is configured, and Anomaly
//      Detection agents' review questions to the anomaly pipeline (calculated history comparisons);
//   3. otherwise the model answers: a question already answered for this payrun version returns
//      the same reply from the cache, only the pay lines the question needs are sent
//      (contextScope), and the reply is checked against the data (replyCheck).
// Without a connected model, step 3 acknowledges the question. context.answerMode "model" skips
// step 1 and the cache (used to benchmark models). deps allows tests to replace the environment,
// fetch, the payroll context loader, and the cache.
async function answerQuestion({ agent, config, model, question, invocation, domainName, conversation }, deps = {}) {
  const env = deps.env || process.env;
  const started = performance.now();
  const modelOnly = invocation?.answerMode === 'model';
  const templateId = agent.template_id || agent.templateId;
  let payrunContext = null, contextError = null;
  try {
    payrunContext = await (deps.loadContext || loadPayrunContext)(invocation, deps);
  } catch (error) {
    contextError = error.message;
  }
  const contextInfo = { payrunId: payrunContext?.payrunId || null, characters: payrunContext?.text?.length || 0, error: contextError };
  const anomalyReview = templateId === 'anomaly-detection' && isReviewQuestion(question);

  const computed = modelOnly || anomalyReview ? null : answerFromData(question, payrunContext);
  if (computed) {
    return { reply: computed.reply, answeredBy: 'payroll-data', intent: computed.intent, model: null,
      metrics: { latencyMs: Math.round(performance.now() - started) }, context: contextInfo };
  }
  if (invocation?.page === 'payrun' && env.RAG_ENABLED !== 'false' && (env.REDIS_URL || deps.vectorStore)) {
    const { PayrollRagPipeline } = require('./rag/pipeline');
    return { answeredBy: 'rag', ...await new PayrollRagPipeline(deps).run({ config, model, question, invocation, domainName, conversation }) };
  }
  if (templateId === 'anomaly-detection') {
    return { answeredBy: 'anomaly-pipeline', ...await new AnomalyDetectionPipeline(deps).run({ config, model, question, invocation }) };
  }

  const acknowledgement = `${agent.name} received your question: "${question}". `
    + `It is configured with model ${config.model} and service ${config.service}. `
    + describeContext(invocation);
  const reason = model ? unavailableReason(model, deps.env) : `Model ${config.model} is not offered by this agent's template.`;
  if (reason) return { reply: `${acknowledgement}Agent execution is not active: ${reason}`, model: null, metrics: null, context: null };

  // Conversation history changes the answer, so only first questions are cached.
  const history = conversation?.history || [];
  const cache = deps.cache || answerCache;
  const cacheKey = cache.key([agent.id || agent.name, model.id, model.modelId, config.description, config.instructions,
    payrunContext?.payrunId || null, payrunContext?.payrun?.version ?? null, normalize(question)]);
  const cacheable = !modelOnly && !history.length;
  const cached = cacheable ? cache.get(cacheKey) : null;
  if (cached) {
    const { sent, ...answer } = cached;
    return { ...answer, cached: true, context: { ...contextInfo, ...sent } };
  }

  // Only the pay lines this question needs go to the model (contextScope).
  const modelContext = scopeContext(payrunContext, question);
  const messages = buildMessages({ agentName: agent.name, config, question, context: modelContext, history });
  const { text, metrics } = await callModel(model, messages, deps);
  const check = checkReply(text, modelContext);
  const sent = { characters: modelContext?.text?.length || 0, scope: modelContext?.scope || null };
  const answer = {
    reply: check.ok ? text : `${text}\n\n${checkNote(check)}`,
    answeredBy: 'model',
    model: { id: model.id, name: model.name, modelId: model.modelId },
    metrics,
    check,
  };
  if (!modelOnly) cache.set(cacheKey, { ...answer, sent });
  return { ...answer, cached: false, context: { ...contextInfo, ...sent } };
}

// After an agent with alerts enabled answers on a payrun, raise new critical findings as an
// incident through the domain's Incident Report agent and list warnings to suggest (see
// incidentTrigger.js). reason says what triggered it (e.g. a payrun change); trigger is
// "automatic" (after an answer) or "realtime" (payrollEvents.js). deps: loadContext, store,
// findIncidentAgent, createReport.
async function raiseIncidents({ agent, config, invocation, domainName, question, reason = '', trigger = 'automatic' }, deps) {
  if (invocation?.page !== 'payrun' || !invocation.payrunId || invocation.answerMode === 'model') return null;
  let payrunContext;
  try { payrunContext = await deps.loadContext(invocation, deps); } catch { return null; }
  if (!payrunContext?.signals) return null;
  const store = deps.store || incidentStore;
  const payrunId = payrunContext.payrunId;
  const alerts = config.capabilities?.alerts;
  const plan = alerts?.enabled ? planIncidents({ signals: payrunContext.signals, alerts, raised: await store.raisedKeys(domainName, payrunId) }) : null;
  if (!plan) return null;
  // review: the question was about findings, so the UI shows suggestions and already-raised
  // incidents under it (not under every reply).
  const result = { suggested: plan.suggested.map(brief), alreadyRaised: plan.alreadyRaised, raised: null, note: null,
    review: isReviewQuestion(question) };
  if (!plan.toRaise.length) return result;
  const incidentAgent = await deps.findIncidentAgent();
  if (!incidentAgent) {
    return { ...result, note: `${plan.toRaise.length} critical finding${plan.toRaise.length === 1 ? '' : 's'} need an incident, but this domain has no Incident Report agent; create one in Agent Studio.` };
  }
  // Claim atomically: whoever claims a finding raises it; a concurrent claimant skips it.
  const claimed = new Set(await store.claim(domainName, payrunId, plan.toRaise.map(findingKey)));
  const toRaise = plan.toRaise.filter(signal => claimed.has(findingKey(signal)));
  if (!toRaise.length) return { ...result, alreadyRaised: plan.alreadyRaised + plan.toRaise.length };
  try {
    const report = await deps.createReport({ ...incidentAgent, domainName,
      invocation: { page: 'payrun', payrunId, task: 'incident-report',
        handoff: { fromAgent: agent.name, trigger, conversation: [findingsMessage(agent.name, toRaise, reason)] } } });
    await store.attach(domainName, payrunId, [...claimed], report.incident?.id || null);
    return { ...result, alreadyRaised: result.alreadyRaised + plan.toRaise.length - toRaise.length,
      raised: { agent: { id: incidentAgent.agent.id, name: incidentAgent.agent.name }, reply: report.reply, incident: report.incident,
        findings: toRaise.map(brief) } };
  } catch (error) {
    await store.release(domainName, payrunId, [...claimed]);
    return { ...result, note: `The automatic incident could not be created: ${error.message}` };
  }
}

// How raiseIncidents reaches the domain's Incident Report agent (shared by the chat webhook and
// the real-time monitor in payrollEvents.js).
function incidentHandoff({ agents, context, loadContext }) {
  return {
    loadContext,
    async findIncidentAgent() {
      const incidentAgent = agents.find(item => resolvers.Agent.templateId(item) === INCIDENT_TEMPLATE);
      if (!incidentAgent) return null;
      const incidentConfig = resolvers.Agent.config(incidentAgent);
      return { agent: incidentAgent, config: incidentConfig, model: await agentModel(incidentAgent, incidentConfig, context) };
    },
    createReport: ({ agent: incidentAgent, config: incidentConfig, model: incidentModel, domainName: domain, invocation: handoff }) =>
      createIncidentReport({ agent: incidentAgent, config: incidentConfig, model: incidentModel, invocation: handoff, domainName: domain }, { loadContext }),
  };
}

// Records the answer for the admin metrics and returns its ID (used for feedback). Metrics must
// never break a chat, so a failed write is logged and the answer is still returned.
async function logInteraction({ domainName, agentId, context, record = recordInteraction, ...details }) {
  try {
    return await record(null, { domainName, agentId, data: buildInteraction(details) }, context);
  } catch (error) {
    console.warn(`Interaction metrics not recorded: ${error.message}`);
    return null;
  }
}

function isWebhookRequest(pathname) {
  return WEBHOOK_PATH.test(pathname);
}

async function handleWebhook(req, res, pathname, context) {
  if (req.method !== 'POST') return send(res, 405, { message: 'Use POST.' });
  const [, domainName, agentId] = pathname.match(WEBHOOK_PATH).map(decodeURIComponent);
  const started = performance.now();
  const elapsed = () => performance.now() - started;
  let request = {}, found = null;
  try {
    const { question, context: invocation, sessionId, requestId, source } = request = await readJson(req);
    if (typeof question !== 'string' || !question.trim()) return send(res, 400, { message: 'A question is required.' });
    if (question.length > 10000) return send(res, 400, { message: 'Questions must be at most 10,000 characters.' });

    const agents = await resolvers.Query.getServiceAgentRegistry(null, { domainName }, context);
    const agent = agents.find(item => item.id === agentId);
    if (!agent) return send(res, 404, { message: `Agent ${agentId} was not found for ${domainName}.` });

    const config = resolvers.Agent.config(agent);
    found = { agent, config };
    const model = await agentModel(agent, config, context);
    // The payrun is loaded once per request (per history depth), shared by the answer and any
    // automatic incident.
    const loaded = new Map();
    const loadContext = (request, options = {}) => {
      const key = `${request?.payrunId}|${request?.employeeId || ''}|${options.historyLimit || ''}`;
      if (!loaded.has(key)) loaded.set(key, loadPayrunContext(request, options));
      return loaded.get(key);
    };
    // The explicit handoff carries a transcript and may deliver email. Keep it
    // outside ordinary chat session normalization and the payroll RAG path.
    if (invocation?.task === 'incident-report') {
      const report = await createIncidentReport({ agent, config, model, invocation, domainName }, { loadContext });
      const interactionId = await logInteraction({ domainName, agentId, context, question: question.trim(), invocation, source,
        config, answer: { ...report, answeredBy: 'incident-report' }, latencyMs: elapsed() });
      return send(res, 200, { agent: { id: agent.id, name: agent.name }, ...report, interactionId });
    }
    let effective = invocation || {};
    const answer = await withConversation({ sessionId, requestId, question: question.trim(),
      scope: { domainName, agentId, channel: 'payroll', owner: context.context?.sessionOwner },
      context: invocation || {} }, async conversation => {
      // The session keeps page, payrun, and employee; answerMode is per request.
      effective = { ...conversation.context, ...(invocation?.answerMode ? { answerMode: invocation.answerMode } : {}) };
      const { focus, ...result } = await answerQuestion({ agent, config, model, question: question.trim(),
        invocation: effective, domainName, conversation }, { loadContext });
      return { answer: result, focus };
    });
    const incidentAlert = await raiseIncidents({ agent, config, invocation: effective, domainName, question: question.trim() },
      incidentHandoff({ agents, context, loadContext }));
    const payrunContext = effective?.page === 'payrun' ? await loadContext(effective).catch(() => null) : null;
    const interactionId = await logInteraction({ domainName, agentId, context, question: question.trim(), invocation: effective,
      source, config, answer, payrunContext, incidentAlert, latencyMs: elapsed() });
    return send(res, 200, { agent: { id: agent.id, name: agent.name }, ...answer, incidentAlert, interactionId });
  } catch (error) {
    if (found && typeof request.question === 'string') {
      await logInteraction({ domainName, agentId, context, question: request.question.trim(), invocation: request.context,
        source: request.source, config: found.config, error, latencyMs: elapsed() });
    }
    if (error instanceof ModelUnavailable) return send(res, 502, { message: error.message });
    const status = error.status || { NOT_FOUND: 404, BAD_USER_INPUT: 400 }[error.extensions?.code] || 502;
    return send(res, status, { message: error.message || 'The agent could not be reached.' });
  }
}

module.exports = { isWebhookRequest, handleWebhook, answerQuestion, agentModel, raiseIncidents, logInteraction, incidentHandoff };
