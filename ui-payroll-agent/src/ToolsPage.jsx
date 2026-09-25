import { useMemo, useState } from 'react'

const METHOD_BADGE = { GET: 'text-bg-success', POST: 'text-bg-primary', PUT: 'text-bg-warning', DELETE: 'text-bg-danger' }

// Display style per tool id. The four notification/observability tools are demo placeholders
// with no live endpoint yet; anything not listed is shown as a payroll API.
const TOOL_STYLE = {
  'slack-webhook': { icon: 'bi-slack', kind: 'Webhook', demo: true },
  'email-notification': { icon: 'bi-envelope', kind: 'Notification', demo: true },
  'alert-manager': { icon: 'bi-bell', kind: 'Alerting', demo: true },
  'opensearch-sink': { icon: 'bi-search', kind: 'Observability', demo: true },
}
const toolStyle = id => TOOL_STYLE[id] || { icon: 'bi-plug', kind: 'Payroll API', demo: false }

const usesTool = (config, id) => config?.service === id || (config?.attached_services || []).includes(id)

// Collect each distinct service offered by any template, with the templates that attach it by default.
function collectTools(templates) {
  const tools = new Map()
  for (const template of templates) {
    for (const service of template.serviceOptions) {
      const tool = tools.get(service.id) || { ...service, templates: [] }
      if (usesTool(template.config, service.id)) tool.templates.push(template.name)
      tools.set(service.id, tool)
    }
  }
  return [...tools.values()]
}

// templates: the studio's loaded templates (with serviceOptions); tools are those of the domain's category.
export default function ToolsPage({ domain, templates, agents, agentsLoading }) {
  const tools = useMemo(() => collectTools(templates.filter((template) => template.config.domain === domain.domain)), [templates, domain])
  const [search, setSearch] = useState('')

  const query = search.trim().toLowerCase()
  const visible = (tools || []).filter((tool) => !query
    || [tool.name, tool.id, tool.path, tool.domain].some((value) => value.toLowerCase().includes(query)))

  return <>
    <div className="d-flex flex-wrap align-items-start justify-content-between gap-3 mb-4">
      <div>
        <h1 className="h4 fw-bold mb-1">Tools &amp; APIs</h1>
        <p className="text-muted mb-0">Approved payroll APIs plus notification and observability tools (webhooks, email, alerting, event sink). Agents can only call the tools attached in their configuration.</p>
      </div>
      {tools && <span className="badge rounded-pill text-bg-secondary">{tools.length} {tools.length === 1 ? 'tool' : 'tools'}</span>}
    </div>
    <input className="form-control mb-4" type="search" aria-label="Search tools" placeholder="Search tools…" value={search} onChange={(event) => setSearch(event.target.value)} />

    <>
        <div className="row row-cols-1 row-cols-lg-2 g-3 mb-4">
          {visible.map((tool) => {
            const style = toolStyle(tool.id)
            const agentsUsing = agents.filter((agent) => usesTool(agent.config, tool.id))
            return <div className="col" key={tool.id}>
              <div className="card h-100 border-0 shadow-sm tool-card">
                <div className="card-body p-4 d-flex flex-column">
                  <div className="d-flex align-items-start justify-content-between gap-2 mb-3">
                    <div className="d-flex align-items-center gap-3">
                      <span className="registry-icon flex-shrink-0"><i className={`bi ${style.icon}`} /></span>
                      <div>
                        <h2 className="h6 fw-bold mb-0">{tool.name}</h2>
                        <code className="small text-muted">{tool.id}</code>
                      </div>
                    </div>
                    <div className="d-flex gap-1 flex-wrap justify-content-end">
                      <span className="badge text-bg-light border">{style.kind}</span>
                      {style.demo && <span className="badge text-bg-warning">Demo only</span>}
                      <span className={`badge ${tool.enabled ? 'registry-status-active' : 'text-bg-secondary'}`}>{tool.enabled ? 'Enabled' : 'Disabled'}</span>
                    </div>
                  </div>
                  <div className="d-flex align-items-center gap-3 p-2 px-3 rounded registry-code-block mb-3">
                    <span className={`badge ${METHOD_BADGE[tool.method] || 'text-bg-secondary'}`} style={{ fontFamily: 'monospace', minWidth: 40 }}>{tool.method}</span>
                    <code className="small flex-grow-1 text-break">{'{'}{tool.baseUrlEnv}{'}'}{tool.path}</code>
                  </div>
                  <dl className="tool-meta mb-0">
                    <dt>Default in templates</dt>
                    <dd>{tool.templates.length ? tool.templates.join(', ') : <span className="text-muted">Optional only</span>}</dd>
                    <dt>Agents in {domain.label}</dt>
                    <dd>{agentsLoading ? <span className="text-muted">Loading…</span>
                      : agentsUsing.length ? <div className="d-flex flex-wrap gap-1">{agentsUsing.map((agent) => <span key={agent.id} className="badge model-strength-chip">{agent.name}</span>)}</div>
                      : <span className="text-muted">Not attached yet</span>}</dd>
                    {style.demo && <><dt>Status</dt>
                      <dd className="text-muted">Demo placeholder; set <code>{tool.baseUrlEnv}</code> once a real endpoint exists</dd></>}
                  </dl>
                </div>
              </div>
            </div>
          })}
        </div>
        {!visible.length && <p>No tools match your search.</p>}
        <div className="card border-0 shadow-sm">
          <div className="card-body d-flex align-items-start gap-3">
            <i className="bi bi-shield-check text-muted mt-1" style={{ fontSize: 18 }} />
            <div>
              <h2 className="h6 fw-bold mb-1">Connecting tools</h2>
              <p className="text-muted small mb-0">Each tool resolves its host from an environment variable at runtime, so the same agent works against any environment. Tools are scoped to their domain and invoked with role-authorized access; payroll services remain the source of truth.</p>
            </div>
          </div>
        </div>
      </>
  </>
}
