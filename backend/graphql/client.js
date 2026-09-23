const path = require('node:path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

function createGrpcDataSource(address = 'localhost:50051', {
  credentials = grpc.credentials.createInsecure(), timeoutMs = 5000,
} = {}) {
  const clients = new Map();

  function getClient(protoPath, packageName, serviceName) {
    const resolvedPath = path.resolve(protoPath);
    const key = JSON.stringify([resolvedPath, packageName, serviceName]);
    if (!clients.has(key)) {
      const definition = protoLoader.loadSync(resolvedPath, {
        keepCase: true, defaults: true, oneofs: true,
      });
      const proto = grpc.loadPackageDefinition(definition);
      const namespace = packageName.split('.').reduce((value, part) => value[part], proto);
      clients.set(key, new namespace[serviceName](address, credentials));
    }
    return clients.get(key);
  }

  return {
    call(protoPath, packageName, serviceName, method, request, metadata) {
      return new Promise((resolve, reject) => {
        const client = getClient(protoPath, packageName, serviceName);
        client[method](request, metadata, { deadline: new Date(Date.now() + timeoutMs) },
          (error, response) => error ? reject(error) : resolve(response));
      });
    },
    waitForReady(protoPath, packageName, serviceName) {
      return new Promise((resolve, reject) => {
        getClient(protoPath, packageName, serviceName).waitForReady(Date.now() + 30000,
          error => error ? reject(error) : resolve());
      });
    },
    close() {
      for (const client of clients.values()) client.close();
      clients.clear();
    },
  };
}

function getGrpcMetadata(context = {}) {
  const metadata = new grpc.Metadata();
  for (const name of ['authorization', 'x-request-id']) {
    const value = context.headers?.[name];
    if (typeof value === 'string') metadata.set(name, value);
  }
  return metadata;
}

module.exports = { createGrpcDataSource, getGrpcMetadata };
