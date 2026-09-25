const path = require('node:path');
const { createRpcResolver, encodeStruct, decodeStruct, jsonResolver } = require('./client');
const { withConversation, failure } = require('./redisStore');

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
    context: JSON
  }
  type ChatReply { agentId: ID!, modelId: String!, output: String!, demo: Boolean!, session: JSON, retrieval: JSON, analysis: JSON }
  type Mutation {
    chatAgent(input: ChatAgentInput!): ChatReply!
    createAgent(input: CreateAgentInput!): Agent!
    updateAgent(input: UpdateAgentInput!): Agent!
  }
  type Query {
    listTemplates(serviceName: String!): [Template!]!
    getTemplate(id: ID!): Template!
    listDomains: [Domain!]!
    getDomainAgentsTemplates(domainName: String!): [Template!]!
    getServiceAgentRegistry(serviceName: String, domainName: String): [Agent!]!
  }
`;

const rpcResolver = createRpcResolver(catalogRpc);

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
  },
  Mutation: {
    chatAgent: async (root, { input }, context) => withConversation({
      sessionId: input.sessionId, requestId: input.requestId, question: input.message, history: input.history || [],
      scope: { domainName: input.domainName, agentId: input.agentId, channel: 'studio', owner: context.context?.sessionOwner },
      context: input.context || {},
    }, async conversation => {
      if (conversation.context?.payrunId) {
        const agents = await resolvers.Query.getServiceAgentRegistry(null, { domainName: input.domainName }, context);
        const agent = agents.find(item => item.id === input.agentId);
        if (!agent) throw failure('Agent not found in this domain.', 400);
        const { answerQuestion, agentModel } = require('./webhook');
        const config = resolvers.Agent.config(agent), model = await agentModel(agent, config, context);
        const { focus, ...result } = await answerQuestion({ agent, config, model, question: input.message,
          invocation: { ...conversation.context, page: 'payrun' }, domainName: input.domainName, conversation });
        return { focus, answer: { agent_id: agent.id, model_id: model?.modelId || config.model,
          output: result.reply, demo: false, retrieval: result.retrieval, analysis: result.analysis } };
      }
      const invoke = rpcResolver('ChatAgent', () => ({ agent_id: input.agentId, domain_name: input.domainName,
        message: input.message, history: conversation.history }));
      return { answer: await invoke(root, {}, context) };
    }),
    createAgent: rpcResolver('CreateAgent', ({ input }) => ({
      domain_name: input.domainName, template_id: input.templateId,
      name: input.name, config: encodeStruct(input.config),
    })),
    updateAgent: rpcResolver('UpdateAgent', ({ input }) => ({
      id: input.id, domain_name: input.domainName,
      name: input.name, config: encodeStruct(input.config),
    })),
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

module.exports = { typeDefs, resolvers, catalogRpc };
