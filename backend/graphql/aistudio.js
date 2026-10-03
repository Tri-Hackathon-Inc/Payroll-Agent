const path = require('node:path');
const { createRpcResolver, encodeStruct, decodeStruct, jsonResolver } = require('./client');
const catalogRpc = {
  protoPath: path.join(__dirname, '../api/proto/templates.proto'),
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
    agentPipeline(domainName: String!, agentId: ID!, anomalyId: ID): JSON!
    agentHealth(domainName: String!, agentId: ID): JSON!
    viewer: Viewer!
  }

`;

const rpcResolver = createRpcResolver(catalogRpc);
const recordInteraction = rpcResolver('RecordInteraction', ({ domainName, agentId, data }) => ({ domain_name: domainName, agent_id: agentId, data: encodeStruct(data) }), value => value.id);
const resolvers = {
  JSON: jsonResolver,
  Query: {
    listTemplates: rpcResolver('ListTemplates', ({ serviceName }) => ({ service_name: serviceName }), value => value.templates || []),
    getTemplate: rpcResolver('GetTemplate', ({ id }) => ({ id })),
    listDomains: rpcResolver('ListDomains', () => ({}), value => value.domains || []),
    getDomainAgentsTemplates: rpcResolver('GetDomainAgentsTemplates', ({ domainName }) => ({ domain_name: domainName }), value => value.templates || []),
    getServiceAgentRegistry: rpcResolver('GetServiceAgentRegistry', ({ serviceName, domainName }) => ({ service_name: serviceName || '', domain_name: domainName || '' }), value => value.agents || []),
    agentPipeline: rpcResolver('GetAgentPipeline', args => encodeStruct(args), decodeStruct),
    agentHealth: rpcResolver('GetAgentHealth', args => encodeStruct(args), decodeStruct),
    viewer: rpcResolver('GetViewer', () => ({}), decodeStruct),
    agentMetrics: rpcResolver('GetAgentMetrics', ({ domainName, agentId, sinceHours }) => ({
      domain_name: domainName, agent_id: agentId || '', since_hours: Math.max(0, sinceHours || 0),
    }), value => decodeStruct(value.metrics || { fields: {} })),
  },
  Mutation: {
    chatAgent: rpcResolver('ExecuteAgent', ({ input }) => encodeStruct({ ...input, channel: 'studio' }), decodeStruct),
    createAgent: rpcResolver('CreateAgent', ({ input }) => ({
      domain_name: input.domainName, template_id: input.templateId, name: input.name, config: encodeStruct(input.config),
    })),
    rateAnswer: rpcResolver('RateInteraction', ({ input }) => ({
      domain_name: input.domainName, interaction_id: input.interactionId, rating: input.rating,
    }), value => value.id),
    updateAgent: rpcResolver('UpdateAgent', ({ input }) => ({
      id: input.id, domain_name: input.domainName,
      name: input.name, config: encodeStruct(input.config),
    })),
    deleteAgent: rpcResolver('DeleteAgent', ({ id, domainName }) => ({
      id, domain_name: domainName,
    }), () => true),
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
