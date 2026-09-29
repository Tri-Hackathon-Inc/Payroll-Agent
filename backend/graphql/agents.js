// HTTP adapter for the same domain-scoped, permission-checked deletion used by GraphQL.
const { resolvers } = require('./aistudio');

const AGENT_PATH = /^\/agents\/([^/]+)\/([^/]+)\/?$/;
const isAgentRequest = pathname => AGENT_PATH.test(pathname);

async function handleAgent(req, res, pathname, context) {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method !== 'DELETE') {
    res.setHeader('Allow', 'DELETE');
    return send(405, { message: 'Use DELETE.' });
  }
  try {
    const [, domainName, id] = pathname.match(AGENT_PATH).map(decodeURIComponent);
    await resolvers.Mutation.deleteAgent(null, { id, domainName }, context);
    res.writeHead(204);
    res.end();
  } catch (error) {
    const status = error instanceof URIError ? 400
      : { FORBIDDEN: 403, NOT_FOUND: 404, BAD_USER_INPUT: 400, UNAVAILABLE: 503 }[error.extensions?.code] || 502;
    return send(status, { message: error instanceof URIError ? 'Invalid agent URL.' : error.message });
  }
}

module.exports = { isAgentRequest, handleAgent };
