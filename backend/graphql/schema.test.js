const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { buildSchema, graphql } = require('graphql');
const { typeDefs, resolvers } = require('./schema');
const { createGrpcDataSource } = require('./client');

// Exercise the production GraphQL resolvers against a real gRPC service and a
// migrated temporary database. No Apollo HTTP listener is needed for this test.
test('GraphQL to gRPC business and agent workflow', { timeout: 30000 }, async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'payroll-agent-test-'));
  const backend = path.resolve(__dirname, '..');
  const python = process.env.PYTHON || path.resolve(backend, '../.venv/bin/python');
  const child = spawn(python, ['-u', '-c', `
import os
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'local_server.studio.settings')
import django
django.setup()
from django.core.management import call_command
call_command('migrate', verbosity=0)
call_command('sync_templates', verbosity=0)
from registry.models import Business
Business.objects.create(name='other-payroll', label='Other Payroll', domain='Payroll')
from concurrent.futures import ThreadPoolExecutor
import grpc
from registry.servicers import TemplateCatalogServicer
from registry.proto.templates_pb2_grpc import add_TemplateCatalogServicer_to_server
server = grpc.server(ThreadPoolExecutor(max_workers=4))
add_TemplateCatalogServicer_to_server(TemplateCatalogServicer(), server)
port = server.add_insecure_port('127.0.0.1:0')
server.start()
print('READY:' + str(port), flush=True)
server.wait_for_termination()
`], { cwd: backend, env: { ...process.env, DATABASE_PATH: path.join(directory, 'test.sqlite3') } });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  t.after(async () => {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await closed;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`gRPC server exited (${code}): ${stderr}`)));
    lines.on('line', line => { if (line.startsWith('READY:')) resolve(Number(line.slice(6))); });
  });
  const grpc = createGrpcDataSource(`127.0.0.1:${port}`);
  t.after(() => grpc.close());
  const schema = buildSchema(typeDefs);
  for (const [typeName, fields] of Object.entries(resolvers)) {
    const type = schema.getType(typeName);
    if (typeName === 'JSON') {
      for (const key of ['serialize', 'parseValue', 'parseLiteral']) type[key] = fields[key];
    } else {
      for (const [name, resolve] of Object.entries(fields)) type.getFields()[name].resolve = resolve;
    }
  }
  const execute = (source, variableValues) => graphql({ schema, source, variableValues,
    contextValue: { dataSources: { grpc }, context: {} } });

  assert.deepEqual(Object.keys(schema.getQueryType().getFields()).sort(),
    ['businessAgents', 'businesses', 'template', 'templates']);
  assert.deepEqual(Object.keys(schema.getMutationType().getFields()).sort(), ['createAgent', 'updateAgent']);

  const catalog = await execute(`{ businesses { name label domain }
    templates { id config }
    template(id: "anomaly-detection") {
      config modelConfig { id modelId } service { id baseUrlEnv }
      modelOptions { id enabled } serviceOptions { id domain }
    }
  }`);
  assert.equal(catalog.errors, undefined);
  assert.equal(catalog.data.templates.length, 4);
  assert.ok(catalog.data.businesses.some(item => item.name === 'payroll-services'));
  assert.ok(catalog.data.template.modelOptions.length);
  assert.ok(catalog.data.template.serviceOptions.length);

  const create = `mutation Create($input: CreateAgentInput!) {
    createAgent(input: $input) { id name businessName templateId templateVersion config createdAt }
  }`;
  const input = { businessName: 'payroll-services', templateId: 'anomaly-detection',
    name: 'Payroll review', config: { instructions: 'Check large payments',
      questions: ['Which payments changed?'],
      capabilities: { webhooks: { enabled: true, url: 'https://example.com/payroll' } } } };
  const created = await execute(create, { input });
  assert.equal(created.errors, undefined);
  const agent = created.data.createAgent;
  assert.equal(agent.config.instructions, input.config.instructions);
  assert.equal(agent.config.capabilities.webhooks.enabled, true);
  assert.equal(agent.config.capabilities.alerts.enabled, true);
  assert.equal(agent.businessName, 'payroll-services');

  const updated = await execute(`mutation Update($input: UpdateAgentInput!) {
    updateAgent(input: $input) { id name config createdAt }
  }`, { input: { id: agent.id, businessName: 'payroll-services', name: 'Updated review',
    config: { questions: [], capabilities: { alerts: { enabled: false } } } } });
  assert.equal(updated.errors, undefined);
  assert.equal(updated.data.updateAgent.id, agent.id);
  assert.equal(updated.data.updateAgent.createdAt, agent.createdAt);
  assert.equal(updated.data.updateAgent.config.instructions, input.config.instructions);
  assert.equal(updated.data.updateAgent.config.capabilities.alerts.enabled, false);
  assert.deepEqual(updated.data.updateAgent.config.questions, []);

  const listed = await execute(`{
    businessAgents(businessName: "payroll-services") { id name config }
    other: businessAgents(businessName: "other-payroll") { id }
  }`);
  assert.equal(listed.errors, undefined);
  assert.equal(listed.data.businessAgents[0].name, 'Updated review');
  assert.deepEqual(listed.data.other, []);

  for (const config of [[], { model: 'missing' }, { capabilities: { webhooks: { url: 'http://example.com' } } }]) {
    const invalid = await execute(create, { input: { ...input, config } });
    assert.equal(invalid.errors[0].extensions.code, 'BAD_USER_INPUT');
  }
  const missing = await execute('{ businessAgents(businessName: "missing") { id } }');
  assert.equal(missing.errors[0].extensions.code, 'NOT_FOUND');
  const missingTemplate = await execute('{ template(id: "missing") { id } }');
  assert.equal(missingTemplate.errors[0].extensions.code, 'NOT_FOUND');
  const wrongBusiness = await execute(`mutation Update($input: UpdateAgentInput!) {
    updateAgent(input: $input) { id }
  }`, { input: { id: agent.id, businessName: 'other-payroll', name: 'Wrong', config: {} } });
  assert.equal(wrongBusiness.errors[0].extensions.code, 'NOT_FOUND');
});
