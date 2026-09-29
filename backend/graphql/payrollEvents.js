// Real-time anomaly detection: the payroll platform reports each saved change, and the domain's
// Anomaly Detection agent checks the payrun without anyone asking a question.
//
//   POST /events/payroll  { type: "payrun.changed", payrunId, version?, lineId?, employeeId? }
//        from the payroll platform (the TriNet mock's events.js); X-Payroll-Events-Token must
//        match PAYROLL_EVENTS_TOKEN when that is set. Replies 202 once the event is queued.
//   GET  /events/stream?domain=<name>&payrunId=<id>
//        server-sent events for open payrun pages: one "payroll" event per check.
//
// Events go through a Redis stream (consumer group, so an event received while the worker is
// busy or restarting is processed later) or, without REDIS_URL, an in-process queue. For each
// event, every domain with an Anomaly Detection agent that has alerts enabled runs the
// automated checks (code only, no model). New critical findings are claimed once
// (incidentTrigger.js) and handed to the domain's Incident Report agent, exactly as after a chat
// answer. Each check is pushed to open pages and recorded for Agent Metrics.
const { createHash, timingSafeEqual } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { brief } = require('./incidentTrigger');
const { loadPayrunContext } = require('./payrunContext');

const EVENTS_PATH = '/events/payroll';
const STREAM_PATH = '/events/stream';
const STREAM_KEY = 'payroll:events';
const GROUP = 'realtime-monitor';
const CONSUMER = 'monitor-1';
const MAX_BODY = 16 * 1024;
const ID = /^[A-Za-z0-9._-]{1,100}$/;
const KEEPALIVE_MS = 20000;
const MONITOR_TEMPLATE = 'anomaly-detection';

const alerts = new EventEmitter();
alerts.setMaxListeners(200);
let activeQueue = null;

const fail = (status, message) => Object.assign(new Error(message), { status });

function isEventsRequest(pathname) {
  return pathname === EVENTS_PATH || pathname === STREAM_PATH;
}

function validateEvent(body) {
  if (!body || typeof body !== 'object' || body.type !== 'payrun.changed') throw fail(400, 'type must be "payrun.changed".');
  if (typeof body.payrunId !== 'string' || !ID.test(body.payrunId)) throw fail(400, 'payrunId is required.');
  for (const key of ['lineId', 'employeeId']) {
    if (body[key] != null && (typeof body[key] !== 'string' || !ID.test(body[key]))) throw fail(400, `${key} is invalid.`);
  }
  if (body.version != null && !(Number.isInteger(body.version) && body.version > 0)) throw fail(400, 'version must be a positive integer.');
  return { type: body.type, payrunId: body.payrunId, version: body.version ?? null, lineId: body.lineId ?? null,
    employeeId: body.employeeId ?? null, changedAt: typeof body.changedAt === 'string' ? body.changedAt.slice(0, 40) : null };
}

// Constant-time comparison of the shared secret (hashed, so lengths always match).
function tokenAccepted(given, expected) {
  if (!expected) return true;
  const hash = value => createHash('sha256').update(String(value || '')).digest();
  return timingSafeEqual(hash(given), hash(expected));
}

function createMemoryQueue() {
  let handler = null;
  return {
    kind: 'memory',
    async publish(event) { setImmediate(() => handler?.(event).catch(error => console.warn(`Payroll event failed: ${error.message}`))); },
    start(process) { handler = process; },
    async stop() { handler = null; },
  };
}

// Redis stream with a consumer group. Pending messages (delivered but not acknowledged before a
// restart) are processed first, then new ones.
function createRedisQueue(url, { createClient = require('redis').createClient, retryMs = 5000 } = {}) {
  let running = false, reader = null, writer = null;
  const connect = async () => {
    const client = createClient({ url, socket: { connectTimeout: 3000, reconnectStrategy: false } });
    client.on('error', () => {}); // No connection strings in logs.
    await client.connect();
    return client;
  };
  async function loop(process) {
    while (running) {
      try {
        reader = await connect();
        try { await reader.xGroupCreate(STREAM_KEY, GROUP, '$', { MKSTREAM: true }); } catch (error) {
          if (!/BUSYGROUP/.test(error.message)) throw error;
        }
        let id = '0';
        while (running) {
          const reply = await reader.xReadGroup(GROUP, CONSUMER, { key: STREAM_KEY, id }, { COUNT: 10, BLOCK: 5000 });
          const messages = reply?.[0]?.messages || [];
          if (id === '0' && !messages.length) { id = '>'; continue; }
          for (const message of messages) {
            try { await process(JSON.parse(message.message.event)); } catch (error) { console.warn(`Payroll event failed: ${error.message}`); }
            await reader.xAck(STREAM_KEY, GROUP, message.id);
          }
        }
      } catch (error) {
        if (running) console.warn(`Payroll event queue unavailable, retrying: ${error.message}`);
        if (reader?.isOpen) reader.destroy();
        reader = null;
        if (running) await new Promise(resolve => setTimeout(resolve, retryMs));
      }
    }
  }
  return {
    kind: 'redis',
    async publish(event) {
      if (!writer?.isReady) writer = await connect();
      await writer.xAdd(STREAM_KEY, '*', { event: JSON.stringify(event) },
        { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: 1000 } });
    },
    start(process) { running = true; loop(process); },
    async stop() {
      running = false;
      for (const client of [reader, writer]) if (client?.isOpen) client.destroy();
    },
  };
}

// Checks the changed payrun in every domain that has a monitoring agent; returns what happened.
async function processPayrollEvent(event, deps = {}) {
  const webhook = require('./webhook');
  const { resolvers } = deps.resolvers ? deps : require('./aistudio');
  const { context } = deps;
  const outcomes = [];
  for (const domain of await resolvers.Query.listDomains(null, {}, context)) {
    const agents = await resolvers.Query.getServiceAgentRegistry(null, { domainName: domain.name }, context);
    const monitor = agents.find(agent => resolvers.Agent.templateId(agent) === MONITOR_TEMPLATE
      && resolvers.Agent.config(agent).capabilities?.alerts?.enabled);
    if (!monitor) continue;
    const started = performance.now();
    const config = resolvers.Agent.config(monitor);
    const invocation = { page: 'payrun', payrunId: event.payrunId };
    let loaded;
    const loadContext = deps.loadContext || ((request, options) => (loaded ||= loadPayrunContext(request, options)));
    const base = { domainName: domain.name, payrunId: event.payrunId, version: event.version, employeeId: event.employeeId,
      monitor: { id: monitor.id, name: monitor.name }, checkedAt: new Date().toISOString() };
    let payrunContext;
    try { payrunContext = await loadContext(invocation, {}); } catch (error) {
      const outcome = { ...base, type: 'error', message: 'The payrun could not be loaded for the automatic check.' };
      (deps.publish || publishAlert)(outcome);
      outcomes.push(outcome);
      continue;
    }
    const who = payrunContext?.payrun?.lines?.find(line => line.employeeId === event.employeeId);
    const reason = event.employeeId ? `${event.employeeId}${who ? ` ${who.name}` : ''} pay line changed` : 'payrun changed';
    const alert = await webhook.raiseIncidents({ agent: monitor, config, invocation, domainName: domain.name, question: '', reason, trigger: 'realtime' },
      { ...webhook.incidentHandoff({ agents, context, loadContext }), ...(deps.store && { store: deps.store }),
        ...(deps.createReport && { createReport: deps.createReport }), ...(deps.findIncidentAgent && { findIncidentAgent: deps.findIncidentAgent }) });
    const outcome = {
      ...base,
      type: alert?.raised ? 'incident' : 'checked',
      reason,
      changedEmployee: event.employeeId ? { employeeId: event.employeeId, name: who?.name || null,
        findings: (payrunContext?.signals || []).filter(signal => signal.employeeId === event.employeeId).map(brief) } : null,
      critical: (payrunContext?.signals || []).filter(signal => signal.severity === 'critical').length,
      raised: alert?.raised || null,
      alreadyRaised: alert?.alreadyRaised || 0,
      note: alert?.note || null,
    };
    (deps.publish || publishAlert)(outcome);
    await (deps.logInteraction || webhook.logInteraction)({ domainName: domain.name, agentId: monitor.id, context,
      question: `Automatic check: ${reason} (${event.payrunId}${event.version ? ` v${event.version}` : ''})`,
      invocation, source: 'realtime-monitor', config, payrunContext, incidentAlert: alert,
      answer: alert?.raised ? { answeredBy: 'incident-report', incident: alert.raised.incident } : { answeredBy: 'payroll-data', intent: 'realtime-check' },
      latencyMs: performance.now() - started });
    outcomes.push(outcome);
  }
  return outcomes;
}

function publishAlert(outcome) {
  alerts.emit('alert', outcome);
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw fail(413, 'Event is too large.');
  }
  try { return JSON.parse(body || '{}'); } catch { throw fail(400, 'Event must be JSON.'); }
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Server-sent events for one payrun page; alerts for other domains or payruns are not sent.
function openStream(req, res, url) {
  const domainName = url.searchParams.get('domain') || '';
  const payrunId = url.searchParams.get('payrunId') || '';
  if (!ID.test(domainName) || !ID.test(payrunId)) return send(res, 400, { message: 'domain and payrunId are required.' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive',
    'X-Accel-Buffering': 'no' });
  res.write('retry: 5000\n\n');
  const listener = outcome => {
    if (outcome.domainName === domainName && outcome.payrunId === payrunId) res.write(`event: payroll\ndata: ${JSON.stringify(outcome)}\n\n`);
  };
  alerts.on('alert', listener);
  const keepalive = setInterval(() => res.write(': keepalive\n\n'), KEEPALIVE_MS);
  req.on('close', () => { clearInterval(keepalive); alerts.off('alert', listener); });
}

async function handleEvents(req, res, url, context, deps = {}) {
  if (url.pathname === STREAM_PATH) {
    if (req.method !== 'GET') return send(res, 405, { message: 'Use GET.' });
    return openStream(req, res, url);
  }
  if (req.method !== 'POST') return send(res, 405, { message: 'Use POST.' });
  const env = deps.env || process.env;
  if (!tokenAccepted(req.headers['x-payroll-events-token'], env.PAYROLL_EVENTS_TOKEN)) return send(res, 401, { message: 'Invalid event token.' });
  try {
    const event = validateEvent(await readJson(req));
    const queue = deps.queue || activeQueue;
    if (!queue) return send(res, 503, { message: 'Real-time monitoring is not running.' });
    await queue.publish(event);
    return send(res, 202, { accepted: true, queue: queue.kind });
  } catch (error) {
    return send(res, error.status || 503, { message: error.status ? error.message : 'The event could not be queued.' });
  }
}

// Starts the worker (from local_server/apollo.js). context carries the gRPC data source.
function startPayrollMonitor({ context, env = process.env, queue } = {}) {
  activeQueue = queue || (env.REDIS_URL ? createRedisQueue(env.REDIS_URL) : createMemoryQueue());
  activeQueue.start(event => processPayrollEvent(event, { context }));
  return activeQueue;
}

module.exports = { isEventsRequest, handleEvents, startPayrollMonitor, processPayrollEvent, validateEvent, tokenAccepted,
  createMemoryQueue, createRedisQueue, publishAlert, alerts };
