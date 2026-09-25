// Who may use which Agent Studio capability: an admin role, a customer ("user") role, and
// feature flags.
//
// Role: an admin signs in with STUDIO_ADMIN_KEY (POST /auth/admin), which sets an HttpOnly cookie
// holding an HMAC of the key; everyone else is a customer. Without STUDIO_ADMIN_KEY the Studio
// runs open (everyone is admin), as before, for local development.
// Feature flags: ADMIN_FEATURES and USER_FEATURES (comma-separated, or "all") turn capabilities
// on or off per role.
//   Customers (default): createAgents (from templates), testAgents (My Agents playground),
//     agentTools (their agents' tools, attach a tool), usage (questions asked, most asked).
//   Admins (default all): also manageAgents, tools (tool catalog), models, evaluation, metrics
//     (business and technical).
// CUSTOMER_MODELS and CUSTOMER_TOOLS (comma-separated IDs; empty = every enabled one) limit the
// models and tools customers may give an agent. The GraphQL resolvers enforce all of this, so
// hiding a menu item is not the only protection. The payrun page's chat webhook is not affected.
const { createHmac, timingSafeEqual } = require('node:crypto');

const CUSTOMER_FEATURES = ['createAgents', 'testAgents', 'agentTools', 'usage'];
const FEATURES = [...CUSTOMER_FEATURES, 'manageAgents', 'tools', 'models', 'evaluation', 'metrics'];
const COOKIE = 'studio_admin';
const SESSION_SECONDS = 8 * 60 * 60;
const ATTEMPTS = 10;
const WINDOW_MS = 60 * 1000;

// "all", "none", or a comma-separated list; unset or empty keeps the role's defaults.
function parseFeatures(value, fallback) {
  if (value === undefined || value === null || !String(value).trim()) return fallback;
  const list = String(value).split(',').map(item => item.trim()).filter(Boolean);
  if (list.includes('none')) return [];
  if (list.includes('all')) return [...FEATURES];
  return FEATURES.filter(feature => list.includes(feature));
}

const sign = (key, issuedAt) => createHmac('sha256', key).update(`studio-admin:${issuedAt}`).digest('hex');
const same = (a, b) => {
  const left = Buffer.from(String(a)), right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
};

function readCookie(header, name) {
  return String(header || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}

const idList = value => (value ? String(value).split(',').map(item => item.trim()).filter(Boolean) : null);

// The viewer for one request: { role, features, authMode, allowedModels, allowedTools }; the
// allow-lists are null when unrestricted (admins always).
function viewerFor(headers = {}, env = process.env, now = Date.now()) {
  const key = env.STUDIO_ADMIN_KEY;
  const admin = { role: 'admin', features: parseFeatures(env.ADMIN_FEATURES, [...FEATURES]), allowedModels: null, allowedTools: null };
  if (!key) return { ...admin, authMode: 'open' };
  const [issuedAt, signature] = readCookie(headers.cookie, COOKIE).split('.');
  const fresh = Number(issuedAt) > 0 && now - Number(issuedAt) < SESSION_SECONDS * 1000;
  if (fresh && same(signature || '', sign(key, issuedAt))) return { ...admin, authMode: 'key' };
  return { role: 'user', features: parseFeatures(env.USER_FEATURES, [...CUSTOMER_FEATURES]), authMode: 'key',
    allowedModels: idList(env.CUSTOMER_MODELS), allowedTools: idList(env.CUSTOMER_TOOLS) };
}

function forbidden(feature) {
  return Object.assign(new Error(`This needs the admin "${feature}" feature. Sign in as an admin.`), { extensions: { code: 'FORBIDDEN' } });
}

const viewerOf = context => context?.context?.viewer || viewerFor(context?.context?.headers);

// Wraps a resolver so it runs only when the request's viewer has one of the features.
function requireFeature(features, resolver) {
  const needed = [].concat(features);
  return (root, args, context, info) => {
    if (!needed.some(feature => viewerOf(context).features.includes(feature))) throw forbidden(needed.join('" or "'));
    return resolver(root, args, context, info);
  };
}

// A customer may only give an agent the models and tools the admin allowed.
function checkCustomerChoices(viewer, config = {}) {
  if (viewer.features.includes('manageAgents')) return;
  const reject = message => { throw Object.assign(new Error(message), { extensions: { code: 'FORBIDDEN' } }); };
  if (config.model && viewer.allowedModels && !viewer.allowedModels.includes(config.model)) {
    reject(`Model ${config.model} is not available to customers. Ask an admin.`);
  }
  const tools = [config.service, ...(config.attached_services || [])].filter(Boolean);
  const blocked = viewer.allowedTools ? tools.filter(tool => !viewer.allowedTools.includes(tool)) : [];
  if (blocked.length) reject(`Tool ${blocked.join(', ')} is not available to customers. Ask an admin.`);
}

// POST /auth/admin { key } signs in; POST /auth/logout signs out. Attempts are limited per client.
function createAuthHandler({ env = process.env, now = () => Date.now() } = {}) {
  const attempts = new Map();
  const send = (res, status, body, cookie) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...(cookie ? { 'Set-Cookie': cookie } : {}) });
    res.end(JSON.stringify(body));
  };
  const cookie = (value, maxAge) => `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
  return async function handleAuth(req, res, pathname) {
    if (req.method !== 'POST') return send(res, 405, { message: 'Use POST.' });
    if (pathname === '/auth/logout') return send(res, 200, { role: 'user' }, cookie('', 0));
    if (!env.STUDIO_ADMIN_KEY) return send(res, 400, { message: 'Admin sign-in is off: STUDIO_ADMIN_KEY is not set.' });
    const client = req.socket?.remoteAddress || 'unknown';
    const recent = (attempts.get(client) || []).filter(time => now() - time < WINDOW_MS);
    if (recent.length >= ATTEMPTS) return send(res, 429, { message: 'Too many attempts. Try again in a minute.' });
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 1024) return send(res, 413, { message: 'Request too large.' }); }
    let key = '';
    try { key = String(JSON.parse(body || '{}').key || ''); } catch { return send(res, 400, { message: 'Body must be JSON.' }); }
    if (!same(createHmac('sha256', 'k').update(key).digest('hex'), createHmac('sha256', 'k').update(env.STUDIO_ADMIN_KEY).digest('hex'))) {
      attempts.set(client, [...recent, now()]);
      return send(res, 401, { message: 'Incorrect admin key.' });
    }
    attempts.delete(client);
    const issuedAt = now();
    return send(res, 200, { role: 'admin' }, cookie(`${issuedAt}.${sign(env.STUDIO_ADMIN_KEY, issuedAt)}`, SESSION_SECONDS));
  };
}

const isAuthRequest = pathname => pathname === '/auth/admin' || pathname === '/auth/logout';

module.exports = { FEATURES, CUSTOMER_FEATURES, viewerFor, viewerOf, requireFeature, checkCustomerChoices, createAuthHandler,
  isAuthRequest, parseFeatures, COOKIE };
