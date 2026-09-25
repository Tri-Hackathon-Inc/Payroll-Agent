function readWebhookReply(body) {
  if (typeof body === 'string') return body
  return body.reply || body.message || body.answer || 'Your request was sent to the agent webhook.'
}

// POST <BASE>webhook/<domain>/<agentId>. `context` tells the agent where it was invoked
// from in the host app, e.g. { page: 'payrun', payrunId, dataUrl }.
const sessionKey = ({ domain, agent, context }) => `studio-webhook:${JSON.stringify([domain.name, agent.id, context?.page, context?.payrunId, context?.employeeId])}`

export function resetWebhookConversation(options) {
  try { sessionStorage.removeItem(sessionKey(options)) } catch { /* Storage may be disabled. */ }
}

export async function callWebhook({ domain, agent, question, source = 'agent-studio-chat', context, conversation = false }) {
  const key = sessionKey({ domain, agent, context })
  let sessionId
  if (conversation) {
    try { sessionId = sessionStorage.getItem(key) || undefined } catch { /* Start a new session. */ }
  }
  const webhookUrl = `${import.meta.env.BASE_URL}webhook/${domain.name}/${agent.id}`
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source,
      domain: domain && { name: domain.name, label: domain.label },
      agent: { id: agent.id, name: agent.name },
      question,
      ...(conversation ? { sessionId, requestId: crypto.randomUUID() } : {}),
      ...(context ? { context } : {}),
    }),
  })
  const isJson = response.headers.get('content-type')?.includes('application/json')
  const body = isJson ? await response.json().catch(() => ({})) : await response.text()

  if (!response.ok) throw new Error(typeof body === 'object' ? body.message || `Webhook request failed (${response.status}).` : body || `Webhook request failed (${response.status}).`)
  if (conversation && body.session?.id) {
    try { sessionStorage.setItem(key, body.session.id) } catch { /* The answer remains available. */ }
  }
  return { id: `webhook-${Date.now()}`, reply: readWebhookReply(body), session: body.session, retrieval: body.retrieval }
}
