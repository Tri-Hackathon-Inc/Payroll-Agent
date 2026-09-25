// Chat webhook: POST /webhook/<domainName>/<agentId> with { question, context? }.
// context describes where the host app invoked the agent, e.g. { page: 'payrun', payrunId }.
// Looks the agent up through the same gRPC resolvers as GraphQL. When the agent's model can be
// called (see modelRuntime), the question is answered with the payrun as context; otherwise the
// reply acknowledges the question with the agent's setup.
const { resolvers } = require('./aistudio');
const { buildMessages } = require('./agentPrompt');
const { callModel, unavailableReason, ModelUnavailable } = require('./modelRuntime');
const { loadPayrunContext } = require('./payrunContext');

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

// Answers with the model when it is connected; otherwise acknowledges. deps allows tests to
// replace the environment, fetch, and the payroll context loader.
async function answerQuestion({ agent, config, model, question, invocation }, deps = {}) {
  const acknowledgement = `${agent.name} received your question: "${question}". `
    + `It is configured with model ${config.model} and service ${config.service}. `
    + describeContext(invocation);
  const reason = model ? unavailableReason(model, deps.env) : `Model ${config.model} is not offered by this agent's template.`;
  if (reason) return { reply: `${acknowledgement}Agent execution is not active: ${reason}`, model: null, metrics: null, context: null };

  let payrunContext = null, contextError = null;
  try {
    payrunContext = await (deps.loadContext || loadPayrunContext)(invocation, deps);
  } catch (error) {
    contextError = error.message;
  }
  const messages = buildMessages({ agentName: agent.name, config, question, context: payrunContext });
  const { text, metrics } = await callModel(model, messages, deps);
  return {
    reply: text,
    model: { id: model.id, name: model.name, modelId: model.modelId },
    metrics,
    context: { payrunId: payrunContext?.payrunId || null, characters: payrunContext?.text.length || 0, error: contextError },
  };
}

function isWebhookRequest(pathname) {
  return WEBHOOK_PATH.test(pathname);
}

async function handleWebhook(req, res, pathname, context) {
  if (req.method !== 'POST') return send(res, 405, { message: 'Use POST.' });
  const [, domainName, agentId] = pathname.match(WEBHOOK_PATH).map(decodeURIComponent);
  try {
    const { question, context: invocation } = await readJson(req);
    if (typeof question !== 'string' || !question.trim()) return send(res, 400, { message: 'A question is required.' });

    const agents = await resolvers.Query.getServiceAgentRegistry(null, { domainName }, context);
    const agent = agents.find(item => item.id === agentId);
    if (!agent) return send(res, 404, { message: `Agent ${agentId} was not found for ${domainName}.` });

    const config = resolvers.Agent.config(agent);
    const model = await agentModel(agent, config, context);
    const answer = await answerQuestion({ agent, config, model, question: question.trim(), invocation });
    return send(res, 200, { agent: { id: agent.id, name: agent.name }, ...answer });
  } catch (error) {
    if (error instanceof ModelUnavailable) return send(res, 502, { message: error.message });
    const status = error.status || { NOT_FOUND: 404, BAD_USER_INPUT: 400 }[error.extensions?.code] || 502;
    return send(res, status, { message: error.message || 'The agent could not be reached.' });
  }
}

module.exports = { isWebhookRequest, handleWebhook, answerQuestion };
