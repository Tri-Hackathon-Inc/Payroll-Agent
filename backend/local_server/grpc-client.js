const path = require('node:path');
const { createRequire } = require('node:module');
const graphqlRequire = createRequire(path.join(__dirname, '../graphql/package.json'));
const grpc = graphqlRequire('@grpc/grpc-js');
const protoLoader = graphqlRequire('@grpc/proto-loader');

function createGrpcDataSource(address = '127.0.0.1:50051') {
  const clients = new Map();
  const getClient = (protoPath, packageName, serviceName) => {
    const key = JSON.stringify([protoPath, packageName, serviceName]);
    if (!clients.has(key)) {
      const definition = protoLoader.loadSync(protoPath, { keepCase: true, defaults: true, oneofs: true });
      const namespace = packageName.split('.').reduce((value, part) => value?.[part], grpc.loadPackageDefinition(definition));
      if (typeof namespace?.[serviceName] !== 'function') {
        throw new Error(`gRPC service ${packageName}.${serviceName} is not declared in ${protoPath}`);
      }
      clients.set(key, new namespace[serviceName](address, grpc.credentials.createInsecure()));
    }
    return clients.get(key);
  };
  return {
    call(protoPath, packageName, serviceName, method, request, metadata) {
      return new Promise((resolve, reject) => {
        getClient(protoPath, packageName, serviceName)[method](request, metadata,
          { deadline: new Date(Date.now() + 5000) },
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
module.exports = { createGrpcDataSource };
