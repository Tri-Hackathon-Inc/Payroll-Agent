import { useEffect, useState } from 'react'
import { graphqlRequest } from './graphql/client'
import { SERVICE_AGENT_REGISTRY_QUERY } from './graphql/operations'
import { trinetUrl } from './links'

// My Agents is the admin view: every agent, grouped by the service (domain) and domain it
// belongs to. Agents are not opened here; the service uses them, e.g. the TriNet payrun page.

const RUNTIME_BY_NAME = [
  { pattern: /anomaly/i, label: 'REAL-TIME', cls: 'runtime-real-time' },
  { pattern: /summar/i, label: 'OFFLINE', cls: 'runtime-offline' },
  { pattern: /query|general/i, label: 'INTERACTIVE', cls: 'runtime-interactive' },
  { pattern: /incident/i, label: 'EVENT-DRIVEN', cls: 'runtime-event-driven' },
]

// The source template decides the runtime; the name is only a fallback for unknown templates.
function agentRuntime(agent) {
  const match = RUNTIME_BY_NAME.find(({ pattern }) => pattern.test(agent.templateId || ''))
    || RUNTIME_BY_NAME.find(({ pattern }) => pattern.test(agent.name || ''))
  return match || { label: 'CONFIGURABLE', cls: 'runtime-offline' }
}

const domainClass = (domain = '') => `domain-badge domain-${domain.toLowerCase().replace(/\s+/g, '-')}`

const DISCOVERY_ENDPOINTS = [
  { method: 'GET', badge: 'text-bg-success', path: '/{service}/list-agents', description: 'list agents available to a service' },
  { method: 'GET', badge: 'text-bg-success', path: '/{service}/get-agent/{agent-id}', description: 'get selected agent metadata' },
  { method: 'POST', badge: 'text-bg-primary', path: '/{service}/{agent-id}/prompts', description: 'invoke agent with a prompt' },
]

function Loading({ children }) {
  return <p role="status" className="text-muted py-4 px-4 mb-0"><span className="spinner-border spinner-border-sm me-2" />{children}</p>
}

function AgentRow({ agent, domain }) {
  const runtime = agentRuntime(agent)
  return <li className="list-group-item d-flex align-items-center gap-3 px-4 py-3 my-agent-row">
    <span className="registry-icon flex-shrink-0"><i className="bi bi-stars" /></span>
    <div className="flex-grow-1" style={{ minWidth: 0 }}>
      <div className="d-flex align-items-center gap-2 mb-1 flex-wrap">
        <span className="fw-semibold">{agent.name}</span>
        <span className={`runtime-badge ${runtime.cls}`}>{runtime.label}</span>
        <span className="small text-muted">{agent.templateId}</span>
      </div>
      <div className="text-muted small text-truncate">{agent.config?.description}</div>
    </div>
    {agent.config?.page === 'payrun' && <a className="btn btn-outline-secondary btn-sm flex-shrink-0" href={trinetUrl(domain.name)} target="_blank" rel="noreferrer">
      Open in payrun <i className="bi bi-box-arrow-up-right ms-1" />
    </a>}
  </li>
}

export default function MyAgentsPage({ domains, onCreate }) {
  const [result, setResult] = useState(null)
  const [reload, setReload] = useState(0)
  const [search, setSearch] = useState('')

  useEffect(() => {
    let active = true
    setResult(null)
    // One registry call for every agent, grouped here by the domain it belongs to.
    graphqlRequest(SERVICE_AGENT_REGISTRY_QUERY, {})
      .then(data => domains.map(domain => ({ domain, agents: data.getServiceAgentRegistry.filter(agent => agent.domainName === domain.name) })))
      .then(groups => { if (active) setResult({ groups, error: '' }) })
      .catch(error => { if (active) setResult({ groups: [], error: error.message }) })
    return () => { active = false }
  }, [domains, reload])

  const query = search.trim().toLowerCase()
  const matches = agent => !query || [agent.name, agent.templateId, agent.config?.description]
    .some(value => String(value || '').toLowerCase().includes(query))
  const groups = (result?.groups || []).map(group => ({ ...group, agents: group.agents.filter(matches) }))
  const categories = [...new Set(groups.map(group => group.domain.domain))]
  const total = (result?.groups || []).reduce((sum, group) => sum + group.agents.length, 0)

  return <>
    <div className="d-flex flex-wrap align-items-start justify-content-between gap-3 mb-3">
      <div>
        <h2 className="h4 fw-bold mb-1">My Agents</h2>
        <p className="text-muted mb-0">Agents available to each service, discoverable by services through the discovery API.</p>
      </div>
      <div className="d-flex align-items-center gap-2">
        {total > 0 && <span className="badge rounded-pill text-bg-secondary">{total} {total === 1 ? 'agent' : 'agents'}</span>}
        <button className="btn btn-dark d-inline-flex align-items-center gap-2" type="button" onClick={onCreate}>
          <i className="bi bi-plus-lg" /> New agent
        </button>
      </div>
    </div>
    <input className="form-control mb-4" type="search" aria-label="Search agents" placeholder="Search agents…" value={search} onChange={event => setSearch(event.target.value)} />

    {!result ? <div className="card border-0 shadow-sm mb-3"><Loading>Loading agents…</Loading></div>
      : result.error ? <div className="alert alert-danger" role="alert">{result.error}<button className="btn btn-link" onClick={() => setReload(value => value + 1)}>Retry</button></div>
      : total === 0 ? <div className="card border-0 shadow-sm mb-3"><div className="d-flex flex-column align-items-center py-5 text-center px-4">
        <div className="registry-icon mb-3" style={{ width: 56, height: 56, fontSize: 24, borderRadius: 16 }}><i className="bi bi-collection" /></div>
        <h3 className="h6 fw-bold mb-1">No agents yet</h3>
        <p className="text-muted small mb-3">Create your first agent from a template to see it listed here.</p>
        <button className="btn btn-dark btn-sm" type="button" onClick={onCreate}>Browse services <i className="bi bi-arrow-right" /></button>
      </div></div>
      : categories.map(category => <section key={category} className="mb-4" aria-label={`${category} agents`}>
        <h3 className="h6 fw-bold text-uppercase text-muted small mb-2"><span className={`badge me-2 ${domainClass(category)}`}>{category}</span>service</h3>
        {groups.filter(group => group.domain.domain === category).map(({ domain, agents }) => <div className="card border-0 shadow-sm mb-3" key={domain.name}>
          <div className="card-header bg-white d-flex justify-content-between align-items-center py-2 px-4">
            <span className="fw-semibold">{domain.label}</span>
            <span className="small text-muted">{agents.length} {agents.length === 1 ? 'agent' : 'agents'}</span>
          </div>
          {agents.length ? <ul className="list-group list-group-flush rounded-bottom">
            {agents.map(agent => <AgentRow key={agent.id} agent={agent} domain={domain} />)}
          </ul> : <p className="text-muted small px-4 py-3 mb-0">{query ? 'No agents match your search.' : 'No agents yet.'}</p>}
        </div>)}
      </section>)}

    <div className="card border-0 shadow-sm">
      <div className="card-body">
        <h3 className="h6 fw-bold mb-1">Service discovery</h3>
        <p className="text-muted small mb-3">Services discover and invoke agents through the service-level API:</p>
        <div className="d-flex flex-column gap-2">
          {DISCOVERY_ENDPOINTS.map(endpoint => <div key={endpoint.path} className="d-flex align-items-center gap-3 p-3 rounded registry-code-block">
            <span className={`badge ${endpoint.badge}`} style={{ fontFamily: 'monospace', minWidth: 40 }}>{endpoint.method}</span>
            <code className="small flex-grow-1">{endpoint.path}</code>
            <span className="text-muted small">{endpoint.description}</span>
          </div>)}
        </div>
      </div>
    </div>
  </>
}
