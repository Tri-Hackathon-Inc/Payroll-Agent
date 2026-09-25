import { useEffect, useState } from 'react'
import { graphqlRequest } from './graphql/client'
import { SERVICE_AGENT_REGISTRY_QUERY } from './graphql/operations'
import { trinetUrl } from './links'

const PAGES = { payrun: 'Payrun page', employee: 'Employee page', dashboard: 'Dashboard' }

// Read-only view for normal users: which agents work in which service, where they appear, and
// which model they use. Creating, editing, testing, and metrics are admin features.
export default function UserAgentsPage({ domains }) {
  const [result, setResult] = useState(null)

  useEffect(() => {
    let active = true
    graphqlRequest(SERVICE_AGENT_REGISTRY_QUERY, {})
      .then(data => { if (active) setResult({ agents: data.getServiceAgentRegistry, error: '' }) })
      .catch(error => { if (active) setResult({ agents: [], error: error.message }) })
    return () => { active = false }
  }, [])

  if (!result) return <p role="status" className="text-muted py-4"><span className="spinner-border spinner-border-sm me-2" />Loading your agents…</p>
  if (result.error) return <div className="alert alert-danger" role="alert">Could not load agents: {result.error}</div>

  const groups = domains.map(domain => ({ domain, agents: result.agents.filter(agent => agent.domainName === domain.name) }))
    .filter(group => group.agents.length)
  return <section aria-labelledby="my-agents-heading">
    <h2 id="my-agents-heading" className="h5 fw-bold mb-1">My Agents</h2>
    <p className="text-muted small mb-3">The agents working in your services and where you can use them. Ask an admin to add or change an agent.</p>
    {!groups.length && <div className="card border-0 shadow-sm"><div className="card-body text-center py-5">
      <i className="bi bi-robot fs-2 text-muted" aria-hidden="true" />
      <p className="fw-semibold mt-2 mb-1">No agents yet</p>
      <p className="text-muted small mb-0">An admin has not set up agents for your services.</p>
    </div></div>}
    {groups.map(({ domain, agents }) => <div key={domain.name} className="mb-4">
      <h3 className="h6 fw-bold mb-2">{domain.label} <span className="text-muted fw-normal small">· {domain.domain}</span></h3>
      <div className="card border-0 shadow-sm"><div className="table-responsive">
        <table className="table table-sm align-middle mb-0 metrics-table">
          <thead><tr><th>Agent</th><th>Service</th><th>Available on</th><th>Model</th><th>Alerts</th><th /></tr></thead>
          <tbody>{agents.map(agent => {
            const alerts = agent.config?.capabilities?.alerts
            return <tr key={agent.id}>
              <td><div className="fw-semibold">{agent.name}</div><div className="small text-muted">{agent.config?.description}</div></td>
              <td className="small">{agent.config?.service || '—'}</td>
              <td className="small">{PAGES[agent.config?.page] || agent.config?.page || '—'}</td>
              <td className="small">{agent.modelConfig?.name || agent.config?.model || '—'}</td>
              <td className="small">{alerts?.enabled ? <span className="text-success"><i className="bi bi-bell me-1" aria-hidden="true" />On ({alerts.severity}+)</span> : <span className="text-muted">Off</span>}</td>
              <td className="text-end">{agent.config?.page === 'payrun' && <a className="btn btn-outline-secondary btn-sm" href={trinetUrl(domain.name)} target="_blank" rel="noreferrer">
                Open payruns <i className="bi bi-box-arrow-up-right ms-1" />
              </a>}</td>
            </tr>
          })}</tbody>
        </table>
      </div></div>
    </div>)}
  </section>
}
