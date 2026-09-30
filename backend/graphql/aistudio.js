const path = require('node:path');
const { createRpcResolver, encodeStruct, decodeStruct, jsonResolver } = require('./client');
const { withConversation, failure } = require('./redisStore');
const { requireFeature, viewerFor, viewerOf, checkCustomerChoices } = require('./access');

// Customers see their usage (questions asked, most asked, helpful rate), not the admin's
// business and technical metrics.
function usageOnly(metrics) {
  const { summary = {}, business = {}, recent = [], window } = metrics;
  return { window, summary: { questions: summary.questions, conversations: summary.conversations, activeAgents: summary.activeAgents,
    up: summary.up, down: summary.down, helpfulRate: summary.helpfulRate },
  business: { topQuestions: business.topQuestions || [] },
  recent: recent.map(({ id, createdAt, agentName, question, feedback }) => ({ id, createdAt, agentName, question, feedback })) };
}

// Admins or customers may save agents; customers only with the models and tools they are allowed.
const savingAgent = resolver => requireFeature(['manageAgents', 'createAgents'], (root, args, context, info) => {
  checkCustomerChoices(viewerOf(context), args.input?.config);
  return resolver(root, args, context, info);
});

const catalogRpc = {
  protoPath: path.join(__dirname, '../registry/proto/templates.proto'),
  packageName: 'ai_studio_agents',
  serviceName: 'ai_studio'
};

const typeDefs = `
  scalar JSON

  type ModelConfig {
    id: ID!
    name: String!
    provider: String!
    modelId: String!
    enabled: Boolean!
    endpointEnv: String!
    credentialEnv: String!
    parameters: JSON!
    details: JSON!
  }

  type Service {
    id: ID!
    name: String!
    domain: String!
    enabled: Boolean!
    baseUrlEnv: String!
    method: String!
    path: String!
  }

  type Template {
    id: ID!
    name: String!
    description: String!
    version: Int!
    config: JSON!
    modelConfig: ModelConfig!
    service: Service!
    attachedServices: [Service!]!
    modelOptions: [ModelConfig!]!
    serviceOptions: [Service!]!
  }

  type Domain { name: String!, label: String!, domain: String! }
  type Agent {
    id: ID!
    name: String!
    domainName: String!
    templateId: String!
    templateVersion: Int!
    config: JSON!
    createdAt: String!
    updatedAt: String!
    modelConfig: JSON!
  }
  input CreateAgentInput {
    domainName: String!
    templateId: String!
    name: String!
    config: JSON!
  }
  input UpdateAgentInput {
    id: ID!
    domainName: String!
    name: String!
    config: JSON!
  }
  input ChatMessageInput { role: String!, content: String! }
  input ChatAgentInput {
    agentId: ID!
    domainName: String!
    message: String!
    history: [ChatMessageInput!]
    sessionId: String
    requestId: String
    confirmation: JSON
    context: JSON
  }
  type ChatReply { agentId: ID!, modelId: String!, output: String!, demo: Boolean!, session: JSON, retrieval: JSON, analysis: JSON, status: String, questionMapping: JSON, mappedQuestion: JSON }
  type Viewer {
    role: String!
    features: [String!]!
    authMode: String!
    allowedModels: [String!]
    allowedTools: [String!]
  }
  input RateAnswerInput {
    domainName: String!
    interactionId: ID!
    rating: String!
  }
  type Mutation {
    chatAgent(input: ChatAgentInput!): ChatReply!
    rateAnswer(input: RateAnswerInput!): ID!
    createAgent(input: CreateAgentInput!): Agent!
    updateAgent(input: UpdateAgentInput!): Agent!
    deleteAgent(id: ID!, domainName: String!): Boolean!
  }
  type Query {
    listTemplates(serviceName: String!): [Template!]!
    getTemplate(id: ID!): Template!
    listDomains: [Domain!]!
    getDomainAgentsTemplates(domainName: String!): [Template!]!
    getServiceAgentRegistry(serviceName: String, domainName: String): [Agent!]!
    agentMetrics(domainName: String!, agentId: ID, sinceHours: Int): JSON!
    viewer: Viewer!
  }
`;

const rpcResolver = createRpcResolver(catalogRpc);

// Records one answered question for the admin metrics (called by the webhook, not exposed in
// GraphQL): recordInteraction(null, { domainName, agentId, data }, context) resolves to its ID.
const recordInteraction = rpcResolver('RecordInteraction', ({ domainName, agentId, data }) => ({
  domain_name: domainName, agent_id: agentId, data: encodeStruct(data),
}), value => value.id);

const resolvers = {
  JSON: jsonResolver,
  Query: {
    listTemplates: rpcResolver('ListTemplates', ({ serviceName }) => ({ service_name: serviceName }), value => value.templates || []),
    getTemplate: rpcResolver('GetTemplate', ({ id }) => ({ id })),
    listDomains: rpcResolver('ListDomains', () => ({}), value => value.domains || []),
    getDomainAgentsTemplates: rpcResolver('GetDomainAgentsTemplates', ({ domainName }) => ({ domain_name: domainName }),
      value => value.templates || []),
    getServiceAgentRegistry: rpcResolver('GetServiceAgentRegistry', ({ serviceName, domainName }) => ({ service_name: serviceName || '', domain_name: domainName || '' }),
      value => value.agents || []),
    viewer: (root, args, { context }) => context?.viewer || viewerFor(context?.headers),
    agentMetrics: requireFeature(['metrics', 'usage'], async (root, args, context, info) => {
      const metrics = await rpcResolver('GetAgentMetrics', ({ domainName, agentId, sinceHours }) => ({
        domain_name: domainName, agent_id: agentId || '', since_hours: Math.max(0, sinceHours || 0),
      }), value => decodeStruct(value.metrics || { fields: {} }))(root, args, context, info);
      return viewerOf(context).features.includes('metrics') ? metrics : usageOnly(metrics);
    }),
  },
  Mutation: {
    chatAgent: requireFeature('testAgents', async (root, { input }, context) => withConversation({
      sessionId: input.sessionId, requestId: input.requestId, confirmation: input.confirmation, question: input.message, history: input.history || [],
      scope: { domainName: input.domainName, agentId: input.agentId, channel: 'studio', owner: context.context?.sessionOwner },
      context: input.context || {},
    }, async conversation => {
      if (conversation.context?.payrunId) {
        const agents = await resolvers.Query.getServiceAgentRegistry(null, { domainName: input.domainName }, context);
        const agent = agents.find(item => item.id === input.agentId);
        if (!agent) throw failure('Agent not found in this domain.', 400);
        const { agentModel } = require('./webhook');
        const { runQuestionFlow } = require('./rag/questionFlow');
        const config = resolvers.Agent.config(agent), model = await agentModel(agent, config, context);
        const result = await runQuestionFlow({ agent, config, model, question: input.message, confirmation: input.confirmation,
          invocation: { ...conversation.context, page: 'payrun' }, domainName: input.domainName }, conversation);
        const answer = result.answer;
        return { ...result, answer: { agent_id: agent.id, model_id: model?.modelId || config.model,
          output: answer.reply, demo: false, retrieval: answer.retrieval, analysis: answer.analysis,
          status: answer.status, questionMapping: answer.questionMapping, mappedQuestion: answer.mappedQuestion } };
      }
      const invoke = rpcResolver('ChatAgent', () => ({ agent_id: input.agentId, domain_name: input.domainName,
        message: input.message, history: conversation.history }));
      return { answer: await invoke(root, {}, context) };
    })),
    createAgent: savingAgent(rpcResolver('CreateAgent', ({ input }) => ({
      domain_name: input.domainName, template_id: input.templateId,
      name: input.name, config: encodeStruct(input.config),
    }))),
    rateAnswer: rpcResolver('RateInteraction', ({ input }) => ({
      domain_name: input.domainName, interaction_id: input.interactionId, rating: input.rating,
    }), value => value.id),
    updateAgent: savingAgent(rpcResolver('UpdateAgent', ({ input }) => ({
      id: input.id, domain_name: input.domainName,
      name: input.name, config: encodeStruct(input.config),
    }))),
    deleteAgent: requireFeature('manageAgents', rpcResolver('DeleteAgent', ({ id, domainName }) => ({
      id, domain_name: domainName,
    }), () => true)),
  },
  Agent: {
    domainName: agent => agent.domain_name,
    templateId: agent => agent.template_id,
    templateVersion: agent => agent.template_version,
    config: agent => decodeStruct(agent.config),
    createdAt: agent => agent.created_at,
    updatedAt: agent => agent.updated_at,
    modelConfig: agent => decodeStruct(agent.model_config || { fields: {} }),
  },
  ChatReply: {
    agentId: reply => reply.agent_id,
    modelId: reply => reply.model_id,
  },
  Template: {
    modelOptions: template => (template.model_options || []).map(decodeStruct),
    serviceOptions: template => (template.service_options || []).map(decodeStruct),
    config: template => decodeStruct(template.config),
    modelConfig: template => decodeStruct(template.model_config),
    service: template => decodeStruct(template.service),
    attachedServices: template => (template.attached_services || []).map(decodeStruct),
  },
  ModelConfig: {
    modelId: model => model.model_id,
    endpointEnv: model => model.endpoint_env,
    credentialEnv: model => model.credential_env,
  },
  Service: { baseUrlEnv: service => service.base_url_env },
};

module.exports = { typeDefs, resolvers, catalogRpc, recordInteraction };
