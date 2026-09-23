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
  }

  type Query {
    templates: [Template!]!
    template(id: ID!): Template!
    modelConfigs: [ModelConfig!]!
    services: [Service!]!
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

function grpcError(error) {
  return new GraphQLError(error.code === 5 ? error.details : 'Template catalog unavailable.', {
    extensions: { code: error.code === 5 ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR' },
  });
}

const resolvers = {
  JSON: new GraphQLScalarType({
    name: 'JSON',
    serialize: value => value,
    parseValue: value => value,
    parseLiteral: valueFromASTUntyped,
  }),
  Query: {
    templates: async (root, args, { dataSources, context }) => {
      try {
        const protoResponse = await dataSources.grpc.call(
          catalogRpc.protoPath,
          catalogRpc.packageName,
          catalogRpc.serviceName,
          'ListTemplates',
          {},
          getGrpcMetadata(context),
        );
        return protoResponse.templates || [];
      } catch (error) {
        throw grpcError(error);
      }
    },
    template: async (root, { id }, { dataSources, context }) => {
      try {
        const protoResponse = await dataSources.grpc.call(
          catalogRpc.protoPath,
          catalogRpc.packageName,
          catalogRpc.serviceName,
          'GetTemplate',
          { id },
          getGrpcMetadata(context),
        );
        return protoResponse;
      } catch (error) {
        throw grpcError(error);
      }
    },
    modelConfigs: async (root, args, { dataSources, context }) => {
      try {
        const protoResponse = await dataSources.grpc.call(
          catalogRpc.protoPath,
          catalogRpc.packageName,
          catalogRpc.serviceName,
          'ListModelConfigs',
          {},
          getGrpcMetadata(context),
        );
        return (protoResponse.items || []).map(decodeStruct);
      } catch (error) {
        throw grpcError(error);
      }
    },
    services: async (root, args, { dataSources, context }) => {
      try {
        const protoResponse = await dataSources.grpc.call(
          catalogRpc.protoPath,
          catalogRpc.packageName,
          catalogRpc.serviceName,
          'ListServices',
          {},
          getGrpcMetadata(context),
        );
        return (protoResponse.items || []).map(decodeStruct);
      } catch (error) {
        throw grpcError(error);
      }
    },
  },
  Template: {
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
