import { useState } from 'react'
import { graphqlRequest } from './graphql/client'
import { UPDATE_AGENT_MUTATION } from './graphql/operations'

// Customer view of Tools & APIs: each agent in the service with the API it reads (its primary
// service) and the tools attached to it, and a way to attach another tool. Only tools the
// admin allows customers (viewer.allowedTools; null = all the template offers) can be attached;
// the API enforces the same list. The admin's tool catalog is ToolsPage.
export default function CustomerToolsPage({ domain, templates, agents, agentsLoading, viewer, onChanged }) {
  const [adding, setAdding] = useState({})
  const [saving, setSaving] = useState('')
  const [error, setError] = useState('')

  if (agentsLoading) return <p role="status" className="text-muted py-4"><span className="spinner-border spinner-border-sm me-2" />Loading your agents…</p>
  const toolsFor = agent => templates.find(template => template.id === agent.templateId)?.serviceOptions || []
  const allowed = tool => !viewer?.allowedTools || viewer.allowedTools.includes(tool.id)
  const nameOf = (agent, id) => toolsFor(agent).find(tool => tool.id === id)?.name || id

  async function attach(agent) {
    const toolId = adding[agent.id]
    if (!toolId) return
    setSaving(agent.id)
    setError('')
    try {
      await graphqlRequest(UPDATE_AGENT_MUTATION, { input: { id: agent.id, domainName: domain.name, name: agent.name,
        config: { attached_services: [...(agent.config.attached_services || []), toolId] } } })
      setAdding(current => ({ ...current, [agent.id]: '' }))
      onChanged()
    } catch (requestError) {
      setError(`${agent.name}: ${requestError.message}`)
    } finally {
      setSaving('')
    }
  }

  return <section aria-labelledby="customer-tools-heading">
    <h2 id="customer-tools-heading" className="h5 fw-bold mb-1">Tools &amp; APIs</h2>
    <p className="text-muted small mb-3">What each of your {domain.label} agents can read and do. Attach another tool to extend an agent.</p>
    {error && <div className="alert alert-danger py-2 small" role="alert">{error}</div>}
    {!agents.length && <p className="text-muted">No agents in {domain.label} yet. Create one under Services.</p>}
    <div className="row row-cols-1 row-cols-xl-2 g-3">
      {agents.map(agent => {
        const attached = agent.config?.attached_services || []
        const available = toolsFor(agent).filter(tool => allowed(tool) && tool.id !== agent.config?.service && !attached.includes(tool.id))
        return <div className="col" key={agent.id}><div className="card border-0 shadow-sm h-100"><div className="card-body">
          <div className="d-flex justify-content-between align-items-start gap-2 mb-2">
            <div><div className="fw-semibold">{agent.name}</div><div className="small text-muted">{agent.templateId}</div></div>
            <span className="badge rounded-pill text-bg-light">{agent.config?.page || 'no page'}</span>
          </div>
          <div className="small text-muted text-uppercase fw-semibold mt-3 mb-1">Reads</div>
          <div className="d-flex flex-wrap gap-2">
            <span className="tool-chip primary"><i className="bi bi-database me-1" aria-hidden="true" />{nameOf(agent, agent.config?.service)}</span>
          </div>
          <div className="small text-muted text-uppercase fw-semibold mt-3 mb-1">Attached tools</div>
          <div className="d-flex flex-wrap gap-2">
            {attached.length ? attached.map(id => <span key={id} className="tool-chip"><i className="bi bi-plug me-1" aria-hidden="true" />{nameOf(agent, id)}</span>)
              : <span className="small text-muted">None yet</span>}
          </div>
          <div className="d-flex gap-2 mt-3">
            <select className="form-select form-select-sm" aria-label={`Tool to attach to ${agent.name}`} value={adding[agent.id] || ''}
              disabled={!available.length || saving === agent.id} onChange={event => setAdding(current => ({ ...current, [agent.id]: event.target.value }))}>
              <option value="">{available.length ? 'Choose a tool to attach…' : 'No more tools available'}</option>
              {available.map(tool => <option key={tool.id} value={tool.id}>{tool.name}</option>)}
            </select>
            <button type="button" className="btn btn-dark btn-sm text-nowrap" disabled={!adding[agent.id] || saving === agent.id} onClick={() => attach(agent)}>
              {saving === agent.id ? 'Attaching…' : 'Attach tool'}
            </button>
          </div>
        </div></div></div>
      })}
    </div>
  </section>
}
