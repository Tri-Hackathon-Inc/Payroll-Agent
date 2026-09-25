// crypto.randomUUID exists only on HTTPS and localhost; getRandomValues works on plain HTTP too
// (e.g. a cloud-dev hostname), and its hex output fits the backend's request ID format.
const newRequestId = () => globalThis.crypto?.randomUUID?.()
  ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')

// The two backends this mock TriNet UI talks to (both proxied by vite.config.js).
const BASE = import.meta.env.BASE_URL
const AGENT_STUDIO = `${BASE}agent-studio`

async function graphql(url, query, variables) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  const payload = await response.json().catch(() => ({}))
  if (payload.errors?.length) {
    const error = new Error(payload.errors[0].message)
    error.code = payload.errors[0].extensions?.code
    error.extensions = payload.errors[0].extensions || {}
    throw error
  }
  if (!response.ok) throw new Error(`Request failed (${response.status}).`)
  if (!payload.data) throw new Error('The server did not return GraphQL data.')
  return payload.data
}

// Mock TriNet payroll GraphQL API (backend/trinet_mock).
export const payrollRequest = (query, variables) => graphql(`${BASE}graphql`, query, variables)

// Agent Studio's GraphQL API: domains and their configured agents.
export const agentStudioRequest = (query, variables) => graphql(`${AGENT_STUDIO}/graphql`, query, variables)

export const conversationKey = ({ domain, agent, context }) => `payroll-chat:${JSON.stringify([domain.name, agent.id, context?.payrunId || '', context?.employeeId || ''])}`
export function resetAgentConversation(options) {
  try { sessionStorage.removeItem(conversationKey(options)) } catch { /* Browser storage may be disabled. */ }
}

// Agent Studio's chat webhook: POST /webhook/<domain>/<agentId> with the question and the
// page context the agent was invoked from.
export async function askAgent({ domain, agent, question, context }) {
  const key = conversationKey({ domain, agent, context })
  let sessionId
  try { sessionId = sessionStorage.getItem(key) || undefined } catch { /* Use a new server session. */ }
  const response = await fetch(`${AGENT_STUDIO}/webhook/${encodeURIComponent(domain.name)}/${encodeURIComponent(agent.id)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: 'trinet-payrun-mock',
      domain: { name: domain.name, label: domain.label },
      agent: { id: agent.id, name: agent.name },
      question,
      context,
      sessionId,
      requestId: newRequestId(),
    }),
  })
  const isJson = response.headers.get('content-type')?.includes('application/json')
  const body = isJson ? await response.json().catch(() => ({})) : await response.text()
  const message = typeof body === 'string' ? body : body.reply || body.message || body.answer
  if (!response.ok) throw new Error(message || `Agent request failed (${response.status}).`)
  if (body.session?.id) {
    try { sessionStorage.setItem(key, body.session.id) } catch { /* The answer remains available. */ }
  }
  const details = typeof body === 'object' ? body : {}
  return { id: `agent-${Date.now()}`, reply: message || 'Your request was sent to the agent.',
    analysis: details.analysis || null, session: body.session, retrieval: body.retrieval, incident: details.incident,
    source: answerSource(details), incidentAlert: details.incidentAlert || null }
}

// How an answer was produced, shown under the reply: computed exactly from the payroll data, from
// the calculated history comparisons (RAG or anomaly pipeline), or written by a model (with its
// latency, and whether it came from the cache).
function answerSource(details) {
  if (details.answeredBy === 'payroll-data') return { kind: 'data', label: 'Computed from payroll data' }
  const seconds = details.metrics?.latencyMs != null ? ` · ${(details.metrics.latencyMs / 1000).toFixed(1)} s` : ''
  if (details.answeredBy === 'rag' || details.answeredBy === 'anomaly-pipeline') {
    const basis = details.answeredBy === 'rag' ? 'Payroll history search' : 'Calculated history comparison'
    const explained = details.analysis?.modelStatus === 'completed' && details.model ? ` · explained by ${details.model.name}${seconds}` : ''
    return { kind: 'data', label: `${basis}${explained}` }
  }
  if (details.answeredBy !== 'model' || !details.model) return null
  return { kind: 'model', label: `Written by ${details.model.name}${details.cached ? ' · repeated answer' : seconds}`,
    checked: details.check?.checked ? details.check.ok : null }
}
