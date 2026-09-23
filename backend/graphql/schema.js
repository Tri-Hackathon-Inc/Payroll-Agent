const { GraphQLScalarType, GraphQLError, valueFromASTUntyped } = require('graphql');
const path = require('node:path');
const { getGrpcMetadata } = require('./client');

const catalogRpc = {
  protoPath: path.join(__dirname, '../registry/proto/templates.proto'),
  packageName: 'payroll.templates.v1',
  serviceName: 'TemplateCatalog',
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

  type Business { name: String!, label: String!, domain: String! }
  type Agent {
    id: ID!
    name: String!
    businessName: String!
    templateId: String!
    templateVersion: Int!
    config: JSON!
    createdAt: String!
    updatedAt: String!
  }
  input CreateAgentInput {
    businessName: String!
    templateId: String!
    name: String!
    config: JSON!
  }
  input UpdateAgentInput {
    id: ID!
    businessName: String!
    name: String!
    config: JSON!
  }
  type Mutation {
    createAgent(input: CreateAgentInput!): Agent!
    updateAgent(input: UpdateAgentInput!): Agent!
  }
  type Query {
    getTemplates: [Template!]!
    getTemplate(id: ID!): Template!
    getBusinesses: [Business!]!
    getBusinessAgents(businessName: String!): [Agent!]!
  }
`;

// proto-loader preserves Struct/Value messages; unwrap them into JSON values.
function decodeValue(value) {
  if ('nullValue' in value) return null;
  if ('numberValue' in value) return value.numberValue;
  if ('stringValue' in value) return value.stringValue;
  if ('boolValue' in value) return value.boolValue;
  if ('structValue' in value) return decodeStruct(value.structValue);
  if ('listValue' in value) return (value.listValue.values || []).map(decodeValue);
  throw new Error('Invalid protobuf Value');
}

function decodeStruct(struct) {
  return Object.fromEntries(Object.entries(struct.fields || {}).map(
    ([key, value]) => [key, decodeValue(value)],
  ));
}

function encodeValue(value) {
  if (value === null) return { nullValue: 0 };
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number' && Number.isFinite(value)) return { numberValue: value };
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) return { listValue: { values: value.map(encodeValue) } };
  return { structValue: encodeStruct(value) };
}

function encodeStruct(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GraphQLError('config must be a JSON object.', { extensions: { code: 'BAD_USER_INPUT' } });
  }
  return { fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeValue(item)])) };
}

function grpcError(error) {
  const code = { 3: 'BAD_USER_INPUT', 5: 'NOT_FOUND' }[error.code];
  return new GraphQLError(code ? error.details : 'Backend service unavailable.', {
    extensions: { code: code || 'INTERNAL_SERVER_ERROR' },
  });
}

function rpcResolver(method, request, response = value => value) {
  return async (root, args, { dataSources, context }) => {
    const input = request(args);
    try {
      return response(await dataSources.grpc.call(
        catalogRpc.protoPath, catalogRpc.packageName, catalogRpc.serviceName,
        method, input, getGrpcMetadata(context),
      ));
    } catch (error) { throw grpcError(error); }
  };
}

const resolvers = {
  JSON: new GraphQLScalarType({
    name: 'JSON',
    serialize: value => value,
    parseValue: value => value,
    parseLiteral: valueFromASTUntyped,
  }),
  Query: {
    getTemplates: rpcResolver('ListTemplates', () => ({}), value => value.templates || []),
    getTemplate: rpcResolver('GetTemplate', ({ id }) => ({ id })),
    getBusinesses: rpcResolver('ListBusinesses', () => ({}), value => value.businesses || []),
    getBusinessAgents: rpcResolver('GetBusinessAgents', ({ businessName }) => ({ business_name: businessName }),
      value => value.agents || []),
  },
  Mutation: {
    createAgent: rpcResolver('CreateAgent', ({ input }) => ({
      business_name: input.businessName, template_id: input.templateId,
      name: input.name, config: encodeStruct(input.config),
    })),
    updateAgent: rpcResolver('UpdateAgent', ({ input }) => ({
      id: input.id, business_name: input.businessName,
      name: input.name, config: encodeStruct(input.config),
    })),
  },
  Agent: {
    businessName: agent => agent.business_name,
    templateId: agent => agent.template_id,
    templateVersion: agent => agent.template_version,
    config: agent => decodeStruct(agent.config),
    createdAt: agent => agent.created_at,
    updatedAt: agent => agent.updated_at,
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
