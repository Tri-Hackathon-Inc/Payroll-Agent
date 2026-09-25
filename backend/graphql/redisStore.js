const { createHash, randomBytes, randomUUID } = require('node:crypto');

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure = (message, status = 503) => Object.assign(new Error(message), { status,
  extensions: { code: status === 400 ? 'BAD_USER_INPUT' : status === 409 ? 'SESSION_CONFLICT' : status === 410 ? 'SESSION_EXPIRED' : 'UNAVAILABLE' } });
let connection;
async function getRedis() {
  if (!process.env.REDIS_URL) throw failure('Conversation storage is not configured.');
  if (!connection) {
    const { createClient } = require('redis');
    const client = createClient({ url: process.env.REDIS_URL, disableOfflineQueue: true,
      socket: { connectTimeout: 3000, reconnectStrategy: false } });
    client.on('error', () => {}); // No raw connection strings or credentials in logs.
    connection = client.connect().then(() => client).catch(() => { connection = null; throw failure('Conversation storage is unavailable. Try again.'); });
  }
  const client = await connection;
  if (!client.isReady) { connection = null; throw failure('Conversation storage is unavailable. Try again.'); }
  return client;
}

async function closeRedis() {
  const pending = connection;
  connection = null;
  if (pending) { const client = await pending.catch(() => null); if (client?.isOpen) client.destroy(); }
}

const RELEASE = 'if redis.call("GET",KEYS[1]) == ARGV[1] then return redis.call("DEL",KEYS[1]) else return 0 end';
const SAVE = 'if redis.call("GET",KEYS[1]) ~= ARGV[1] then return 0 end redis.call("SET",KEYS[2],ARGV[2],"EX",ARGV[3]) return 1';

class ConversationStore {
  constructor({ client, ttl = Number(process.env.CHAT_SESSION_TTL_SECONDS) || 1800 } = {}) {
    this.client = client;
    this.ttl = Math.max(60, Math.min(ttl, 86400));
  }

  async run({ sessionId, requestId, scope, context = {}, question, history = [] }, execute) {
    if (typeof question !== 'string' || !question.trim() || question.length > 10000) throw failure('A question of at most 10,000 characters is required.', 400);
    if (sessionId && !/^[a-f0-9]{64}$/.test(sessionId)) throw failure('Invalid conversation session.', 400);
    if (requestId && (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(requestId))) throw failure('Invalid request ID.', 400);
    if (!Array.isArray(history) || history.length > 40 || history.length % 2 || history.some((turn, index) =>
      !turn || turn.role !== (index % 2 ? 'assistant' : 'user') || typeof turn.content !== 'string'
      || !turn.content.trim() || turn.content.length > 10000) || JSON.stringify(history).length > 100000) {
      throw failure('Conversation history must contain at most 20 complete user and assistant turns.', 400);
    }
    const id = sessionId || randomBytes(32).toString('hex');
    const key = `payroll:session:${id}`, lock = `${key}:lock`, token = randomUUID();
    const client = this.client || await getRedis();
    const scopeHash = digest(scope), requestHash = digest({ question, context });
    try {
      if (!await client.set(lock, token, { NX: true, PX: 300000 })) throw failure('A response is already being prepared in this conversation. Retry shortly.', 409);
      try {
        const stored = await client.get(key);
        if (sessionId && !stored) throw failure('This conversation has expired. Start a new chat.', 410);
        const state = stored ? JSON.parse(stored) : { scopeHash, context, history: history.slice(-40), focus: null };
        if (state.scopeHash !== scopeHash) throw failure('This conversation belongs to a different agent or browser. Start a new chat.', 409);
        if (stored && Object.entries(context).some(([name, value]) => JSON.stringify(state.context[name]) !== JSON.stringify(value))) {
          throw failure('The payrun or employee selection changed. Start a new chat for this selection.', 409);
        }
        if (requestId && state.lastRequest?.id === requestId) {
          if (state.lastRequest.hash !== requestHash) throw failure('A request ID cannot be reused for a different question.', 409);
          await client.expire(key, this.ttl);
          return { ...state.lastRequest.answer, session: { id, status: 'active', expiresInSeconds: this.ttl } };
        }
        const { answer, focus = state.focus } = await execute(state);
        const content = answer.reply ?? answer.output;
        if (typeof content !== 'string') throw failure('The model did not return a conversation response.');
        const turns = [...state.history, { role: 'user', content: question.trim() }, { role: 'assistant', content }].slice(-40);
        while (turns.length > 2 && JSON.stringify(turns).length > 60000) turns.splice(0, 2);
        const updated = { ...state, history: turns, focus, updatedAt: new Date().toISOString(),
          lastRequest: { id: requestId || null, hash: requestHash, answer } };
        const saved = await client.eval(SAVE, { keys: [lock, key], arguments: [token, JSON.stringify(updated), String(this.ttl)] });
        if (!saved) throw failure('The conversation took too long to save. Retry your question.', 409);
        return { ...answer, session: { id, status: 'active', expiresInSeconds: this.ttl } };
      } finally { await client.eval(RELEASE, { keys: [lock], arguments: [token] }).catch(() => {}); }
    } catch (error) {
      if (error.status || error.extensions) throw error;
      throw failure('Conversation storage is unavailable. Try again.');
    }
  }
}

async function withConversation(options, execute, dependencies = {}) {
  const context = options.context;
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw failure('Conversation context must be an object.', 400);
  for (const key of ['page', 'payrunId', 'employeeId']) {
    if (context[key] !== undefined && context[key] !== null && (typeof context[key] !== 'string' || !context[key].trim() || context[key].length > 255)) {
      throw failure(`Invalid ${key} in conversation context.`, 400);
    }
  }
  options = { ...options, context: Object.fromEntries(['page', 'payrunId', 'employeeId'].filter(key => context[key] !== undefined).map(key => [key, context[key]])) };
  if (!dependencies.store && !process.env.REDIS_URL) {
    if (options.sessionId) throw failure('Conversation storage is unavailable.');
    const { answer } = await execute({ history: options.history || [], context: options.context || {}, focus: null });
    return { ...answer, session: { id: null, status: 'disabled', expiresInSeconds: 0 } };
  }
  return (dependencies.store || new ConversationStore()).run(options, execute);
}

module.exports = { ConversationStore, withConversation, getRedis, closeRedis, digest, failure };
