const grpc = require('@grpc/grpc-js');
const { valueFromASTUntyped } = require('graphql');

function getGrpcMetadata(context = {}) {
  const metadata = new grpc.Metadata();
  for (const name of ['authorization', 'x-request-id', 'cookie', 'x-payroll-events-token']) {
    const value = context.headers?.[name];
    if (typeof value === 'string') metadata.set(name, value);
  }
  if (context.sessionOwner) metadata.set('x-session-owner', context.sessionOwner);
  if (context.clientAddress) metadata.set('x-client-address', context.clientAddress);
  return metadata;
}

function apiError(message, code) {
  const error = new Error(message);
  error.extensions = { code };
  return error;
}

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
    throw apiError('config must be an object.', 'BAD_USER_INPUT');
  }
  return { fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeValue(item)])) };
}

function createRpcResolver(catalogRpc) {
  return (method, request, response = value => value) => {
    return async (root, args, { dataSources, context }) => {
      const input = request(args);
      try {
        return response(await dataSources.grpc.call(
          catalogRpc.protoPath, catalogRpc.packageName, catalogRpc.serviceName,
          method, input, getGrpcMetadata(context),
        ));
      } catch (error) {
        const code = { 3: 'BAD_USER_INPUT', 4: 'TIMEOUT', 5: 'NOT_FOUND', 7: 'FORBIDDEN', 8: 'RATE_LIMITED', 9: 'MODEL_NOT_CONFIGURED', 10: 'SESSION_CONFLICT', 11: 'SESSION_EXPIRED', 14: 'UNAVAILABLE', 16: 'UNAUTHENTICATED' }[error.code];
        throw apiError(code ? error.details : 'Backend service unavailable.', code || 'INTERNAL_SERVER_ERROR');
      }
    };
  };
}

const jsonResolver = {
  serialize: value => value,
  parseValue: value => value,
  parseLiteral: valueFromASTUntyped,
};

module.exports = { getGrpcMetadata, createRpcResolver, encodeStruct, decodeStruct, jsonResolver };
