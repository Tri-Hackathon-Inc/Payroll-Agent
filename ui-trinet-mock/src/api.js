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

// Agent Studio's GraphQL API: the host discovers its available domains.
export const agentStudioRequest = (query, variables) => graphql(`${AGENT_STUDIO}/graphql`, query, variables)
