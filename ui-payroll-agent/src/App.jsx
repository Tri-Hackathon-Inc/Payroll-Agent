import { useEffect, useState } from 'react'
import './App.css'
import { graphqlRequest } from './graphql/client'
import { BUSINESS_AGENTS_QUERY, STUDIO_QUERY } from './graphql/operations'
import AgentEditor from './AgentEditor'

const MODEL_OPTIONS = [
  {
    id: 'qwen-2.5-72b',
    label: 'Qwen 2.5 · 72B',
    provider: 'Alibaba Cloud',
    openSource: true,
    contextWindow: '128K tokens',
    accent: 'green',
    description: 'Highly capable open-source model with strong instruction following and multilingual support. Good balance of performance and speed for payroll Q&A.',
    strengths: ['Fast inference', 'Multilingual', 'Strong reasoning'],
    bestFor: ['General Query', 'Summarizer'],
  },
  {
    id: 'llama-3.1-70b',
    label: 'Llama 3.1 · 70B',
    provider: 'Meta',
    openSource: true,
    contextWindow: '128K tokens',
    accent: 'blue',
    description: "Meta's flagship open-source model. Excellent at reasoning and tool use, making it well-suited for agentic payroll workflows.",
    strengths: ['Tool calling', 'Reasoning', 'Code generation'],
    bestFor: ['Anomaly Detection', 'General Query'],
  },
  {
    id: 'mistral-large',
    label: 'Mistral Large',
    provider: 'Mistral AI',
    openSource: false,
    contextWindow: '32K tokens',
    accent: 'orange',
    description: 'Top-tier commercial model from Mistral. Excellent at structured output and function calling, ideal for incident generation and anomaly reporting.',
    strengths: ['Structured output', 'Function calling', 'Low latency'],
    bestFor: ['Incident Generator', 'Anomaly Detection'],
  },
  {
    id: 'bedrock-claude',
    label: 'AWS Bedrock · Claude',
    provider: 'Anthropic / AWS',
    openSource: false,
    contextWindow: '200K tokens',
    accent: 'purple',
    description: 'Claude via AWS Bedrock. Industry-leading at following complex instructions, analysis, and safe operation in production payroll environments.',
    strengths: ['Long context', 'Safety', 'Instruction following'],
    bestFor: ['All agent types'],
  },
]

const NAV_GROUPS = [
  {
    label: 'Build',
    items: [
      { key: 'templates', label: 'Templates', icon: 'bi-grid-1x2', path: '/ai-studio' },
      { key: 'my-agents', label: 'My Agents', icon: 'bi-robot', path: '/agents' },
      { key: 'tools', label: 'Tools & APIs', icon: 'bi-plug', soon: true },
      { key: 'models', label: 'Models', icon: 'bi-cpu', path: '/ai-studio/models' },
    ],
  },
  {
    label: 'Manage',
    items: [
      { key: 'registry', label: 'Agent Registry', icon: 'bi-collection', path: '/ai-studio/registry' },
      { key: 'evaluation', label: 'Evaluation', icon: 'bi-graph-up', soon: true },
    ],
  },
]

function domainSlug(domain = '') {
  return domain.toLowerCase().replace(/\s+/g, '-')
}

function domainClass(domain) {
  return `domain-badge domain-${domainSlug(domain)}`
}

const RUNTIME_BY_NAME = [
  { pattern: /anomaly/i, label: 'REAL-TIME', cls: 'runtime-real-time' },
  { pattern: /summar/i, label: 'OFFLINE', cls: 'runtime-offline' },
  { pattern: /query|general/i, label: 'INTERACTIVE', cls: 'runtime-interactive' },
  { pattern: /incident/i, label: 'EVENT-DRIVEN', cls: 'runtime-event-driven' },
]

function agentRuntime(agent) {
  const match = RUNTIME_BY_NAME.find(({ pattern }) => pattern.test(agent.name || ''))
  return match || { label: 'CONFIGURABLE', cls: 'runtime-offline' }
}

function Sidebar({ activeKey, onNavigate }) {
  return (
    <aside className="app-sidebar d-flex flex-column flex-shrink-0 p-3">
      <div className="d-flex align-items-center gap-2 px-1 mb-1">
        <span className="sidebar-mark"><i className="bi bi-stars" /></span>
        <div className="d-flex flex-column">
          <span className="text-white fw-bold text-uppercase sidebar-brand">Agent Studio</span>
          <span className="sidebar-subtitle">Payroll AI Platform</span>
        </div>
      </div>
      <hr className="sidebar-divider mt-3 mb-3" />
      {NAV_GROUPS.map((group) => (
        <div className="mb-3" key={group.label}>
          <div className="sidebar-group-label px-2 mb-2">{group.label}</div>
          <ul className="nav nav-pills flex-column gap-1">
            {group.items.map((item) => (
              <li className="nav-item" key={item.key}>
                <button
                  type="button"
                  className={`nav-link sidebar-link d-flex align-items-center gap-2 w-100 text-start${activeKey === item.key ? ' active' : ''}`}
                  onClick={() => onNavigate(item)}
                >
                  <span className="sidebar-icon"><i className={`bi ${item.icon}`} /></span>
                  <span className="flex-grow-1">{item.label}</span>
                  {item.soon && <span className="badge rounded-pill sidebar-soon">Soon</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </aside>
  )
}

function AppShell({ activeKey, onNavigate, notice, onDismissNotice, children }) {
  return (
    <div className="app-shell d-flex">
      <Sidebar activeKey={activeKey} onNavigate={onNavigate} />
      <div className="flex-grow-1 d-flex flex-column min-vw-0">
        <main className="flex-grow-1 p-4 p-xl-5">
          {notice && (
            <div className="alert alert-success d-flex align-items-center justify-content-between py-2 px-3 mb-4" role="alert">
              <span className="small">{notice}</span>
              <button type="button" className="btn-close" onClick={onDismissNotice} aria-label="Dismiss" />
            </div>
          )}
          {children}
        </main>
      </div>
    </div>
  )
}

function Loading({ children = 'Loading…' }) {
  return <p role="status" className="text-muted py-4"><span className="spinner-border spinner-border-sm me-2" />{children}</p>
}

function App() {
  const [route, setRoute] = useState(() => window.location.pathname + window.location.search)
  const [catalog, setCatalog] = useState(null)
  const [catalogError, setCatalogError] = useState('')
  const [reload, setReload] = useState(0)
  const [agentResult, setAgentResult] = useState(null)
  const [refreshAgents, setRefreshAgents] = useState(0)
  const [search, setSearch] = useState('')
  const [notice, setNotice] = useState('')

  const url = new URL(route, window.location.origin)
  const path = url.pathname
  const businessName = url.searchParams.get('business') || catalog?.businesses[0]?.name
  const business = catalog?.businesses.find((item) => item.name === businessName)
  const templateMatch = path.match(/^\/ai-studio\/templates\/([^/]+)\/config$/)
  const agentMatch = path.match(/^\/agents\/([^/]+)$/)
  const editId = agentMatch && agentMatch[1] !== 'new' ? decodeURIComponent(agentMatch[1]) : null
  const listPage = path === '/agents'
  const modelsPage = path === '/ai-studio/models'
  const registryPage = path === '/ai-studio/registry'
  const agents = agentResult && agentResult.businessName === businessName ? agentResult.items : []
  const agentsLoading = business && (agentResult?.businessName !== businessName || agentResult.loading)
  const agentsError = agentResult && agentResult.businessName === businessName ? agentResult.error : ''

  useEffect(() => {
    const onPopState = () => {
      setRoute(window.location.pathname + window.location.search)
      setSearch('')
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    let active = true
    setCatalogError('')
    graphqlRequest(STUDIO_QUERY)
      .then((data) => {
        if (active) setCatalog({ businesses: data.getBusinesses, templates: data.getTemplates })
      })
      .catch((error) => {
        if (active) setCatalogError(error.message)
      })
    return () => { active = false }
  }, [reload])

  useEffect(() => {
    if (!business) return undefined
    let active = true
    setAgentResult({ businessName: business.name, items: [], loading: true, error: '' })
    graphqlRequest(BUSINESS_AGENTS_QUERY, { businessName: business.name })
      .then((data) => {
        if (active) setAgentResult({ businessName: business.name, items: data.getBusinessAgents, loading: false, error: '' })
      })
      .catch((error) => {
        if (active) setAgentResult({ businessName: business.name, items: [], loading: false, error: error.message })
      })
    return () => { active = false }
  }, [business, refreshAgents])

  function navigate(next) {
    window.history.pushState({}, '', next)
    setRoute(next)
    setSearch('')
  }

  const scoped = (next, name = businessName) => `${next}?business=${encodeURIComponent(name || '')}`
  const handleNav = (item) => {
    if (item.soon) {
      setNotice(`${item.label} is coming soon.`)
      return
    }
    if (item.key === 'models') {
      navigate(item.path)
      return
    }
    navigate(scoped(item.path))
  }

  const saved = (agent) => {
    setNotice(`${agent.name} saved for ${business.label}.`)
    setRefreshAgents((value) => value + 1)
    navigate(scoped('/agents'))
  }

  const activeNavKey = modelsPage ? 'models'
    : registryPage ? 'registry'
    : listPage || editId ? 'my-agents'
    : 'templates'

  const query = search.trim().toLowerCase()
  const matches = (...values) => values.some((value) => String(value || '').toLowerCase().includes(query))

  // Models page — static, no business context needed
  if (modelsPage) {
    return (
      <AppShell activeKey={activeNavKey} onNavigate={handleNav} notice={notice} onDismissNotice={() => setNotice('')}>
        <div className="mb-4">
          <h1 className="h4 fw-bold mb-1">Model Library</h1>
          <p className="text-muted mb-0">Select a model when configuring an agent template. Each agent stores its own model preference — you can change it at any time.</p>
        </div>
        <div className="row row-cols-1 row-cols-md-2 g-3 mb-4">
          {MODEL_OPTIONS.map((model) => (
            <div className="col" key={model.id}>
              <div className={`card h-100 border-0 shadow-sm model-card accent-${model.accent}`}>
                <div className="card-body p-4">
                  <div className="d-flex align-items-start justify-content-between mb-3">
                    <div className={`template-icon accent-${model.accent}`}><i className="bi bi-cpu-fill" /></div>
                    {model.openSource
                      ? <span className="badge model-badge-oss">Open source</span>
                      : <span className="badge model-badge-commercial">Commercial</span>
                    }
                  </div>
                  <h3 className="h6 fw-bold mb-0">{model.label}</h3>
                  <div className="text-muted small mb-2">{model.provider}</div>
                  <p className="text-muted small mb-3" style={{ lineHeight: 1.6 }}>{model.description}</p>
                  <div className="d-flex flex-wrap gap-2 mb-3">
                    {model.strengths.map((s) => (
                      <span key={s} className="badge model-strength-chip">{s}</span>
                    ))}
                  </div>
                  <div className="d-flex align-items-center justify-content-between pt-2 border-top">
                    <div className="d-flex align-items-center gap-1 text-muted small">
                      <i className="bi bi-window me-1" />{model.contextWindow}
                    </div>
                    <div className="d-flex flex-wrap gap-1 justify-content-end">
                      {model.bestFor.map((type) => (
                        <span key={type} className="badge text-bg-light border model-bestfor-badge">{type}</span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="card border-0 shadow-sm">
          <div className="card-body d-flex align-items-start gap-3">
            <i className="bi bi-info-circle text-muted mt-1" style={{ fontSize: 18 }} />
            <div>
              <h2 className="h6 fw-bold mb-1">Choosing a model</h2>
              <p className="text-muted small mb-0">Real-time agents benefit from low-latency models. Offline summarizer tasks work well with high-context models. Interactive agents need strong instruction following and tool use.</p>
            </div>
          </div>
        </div>
      </AppShell>
    )
  }

  // Registry page — scoped to selected business
  if (registryPage) {
    const registryAgents = agentResult && agentResult.businessName === businessName ? agentResult.items : []
    const registryLoading = business && (agentResult?.businessName !== businessName || agentResult.loading)
    const registryError = agentResult && agentResult.businessName === businessName ? agentResult.error : ''

    return (
      <AppShell activeKey={activeNavKey} onNavigate={handleNav} notice={notice} onDismissNotice={() => setNotice('')}>
        <div className="d-flex flex-wrap align-items-start justify-content-between gap-3 mb-4">
          <div>
            <h1 className="h4 fw-bold mb-1">Agent Registry</h1>
            <p className="text-muted mb-0">All agents built and published in this studio, discoverable by payroll services via the discovery API.</p>
          </div>
          <div className="d-flex align-items-center gap-2">
            {registryAgents.length > 0 && (
              <span className="badge rounded-pill text-bg-secondary">{registryAgents.length} {registryAgents.length === 1 ? 'agent' : 'agents'}</span>
            )}
            <button className="btn btn-dark d-inline-flex align-items-center gap-2" type="button"
              onClick={() => navigate(businessName ? scoped('/ai-studio') : '/ai-studio')}>
              <i className="bi bi-plus-lg" /> New agent
            </button>
          </div>
        </div>

        {!catalog && !catalogError && <Loading>Loading…</Loading>}
        {catalogError && (
          <div className="alert alert-danger" role="alert">
            {catalogError}
            <button className="btn btn-link" onClick={() => setReload((v) => v + 1)}>Retry</button>
          </div>
        )}
        {catalog && !business && (
          <div className="alert alert-info" role="alert">
            Select a business to view its registered agents.
            <button className="btn btn-link" onClick={() => navigate('/ai-studio')}>Choose business</button>
          </div>
        )}

        {business && (
          <>
            <div className="card border-0 shadow-sm mb-3">
              <div className="card-body p-0">
                {registryError && <div className="alert alert-danger m-3 py-2 small" role="alert">{registryError}</div>}
                {registryLoading ? (
                  <div className="p-4"><Loading>Loading agents…</Loading></div>
                ) : registryAgents.length === 0 ? (
                  <div className="d-flex flex-column align-items-center justify-content-center py-5 text-center px-4">
                    <div className="registry-icon mb-3" style={{ width: 56, height: 56, fontSize: 24, borderRadius: 16 }}>
                      <i className="bi bi-collection" />
                    </div>
                    <h2 className="h6 fw-bold mb-1">Registry is empty</h2>
                    <p className="text-muted small mb-3">Create your first agent from a template to see it listed here.</p>
                    <button className="btn btn-dark btn-sm d-inline-flex align-items-center gap-2" type="button"
                      onClick={() => navigate(scoped('/ai-studio'))}>
                      Browse templates <i className="bi bi-arrow-right" />
                    </button>
                  </div>
                ) : (
                  <ul className="list-group list-group-flush rounded">
                    {registryAgents.map((agent) => {
                      const rt = agentRuntime(agent)
                      return (
                        <li className="list-group-item d-flex align-items-center gap-3 px-4 py-3" key={agent.id}>
                          <span className="registry-icon flex-shrink-0"><i className="bi bi-stars" /></span>
                          <div className="flex-grow-1" style={{ minWidth: 0 }}>
                            <div className="d-flex align-items-center gap-2 mb-1 flex-wrap">
                              <span className="fw-semibold">{agent.name}</span>
                              {agent.config?.domain && <span className={`badge ${domainClass(agent.config.domain)}`}>{agent.config.domain}</span>}
                              <span className={`runtime-badge ${rt.cls}`}>{rt.label}</span>
                            </div>
                            <div className="text-muted small text-truncate">{agent.config?.description}</div>
                          </div>
                          <div className="d-flex align-items-center gap-2 flex-shrink-0">
                            <button type="button" className="btn btn-outline-secondary btn-sm"
                              onClick={() => navigate(scoped(`/agents/${encodeURIComponent(agent.id)}`))}>
                              Open <i className="bi bi-arrow-right ms-1" />
                            </button>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            </div>

            {registryAgents.length > 0 && (
              <div className="card border-0 shadow-sm">
                <div className="card-body">
                  <h2 className="h6 fw-bold mb-1">Service discovery</h2>
                  <p className="text-muted small mb-3">Payroll services discover and invoke agents through the service-level API:</p>
                  <div className="d-flex flex-column gap-2">
                    <div className="d-flex align-items-center gap-3 p-3 rounded registry-code-block">
                      <span className="badge text-bg-success" style={{ fontFamily: 'monospace', minWidth: 40 }}>GET</span>
                      <code className="small flex-grow-1">/{'{service}'}/list-agents</code>
                      <span className="text-muted small">list agents available to a service</span>
                    </div>
                    <div className="d-flex align-items-center gap-3 p-3 rounded registry-code-block">
                      <span className="badge text-bg-success" style={{ fontFamily: 'monospace', minWidth: 40 }}>GET</span>
                      <code className="small flex-grow-1">/{'{service}'}/get-agent/{'{agent-id}'}</code>
                      <span className="text-muted small">get selected agent metadata</span>
                    </div>
                    <div className="d-flex align-items-center gap-3 p-3 rounded registry-code-block">
                      <span className="badge text-bg-primary" style={{ fontFamily: 'monospace', minWidth: 40 }}>POST</span>
                      <code className="small flex-grow-1">/{'{service}'}/{'{agent-id}'}/prompts</code>
                      <span className="text-muted small">invoke agent with a prompt</span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </AppShell>
    )
  }

  let content
  if (catalogError) {
    content = (
      <div className="alert alert-danger" role="alert">
        Could not load Agent Studio: {catalogError}
        <button className="btn btn-outline-danger btn-sm ms-3" onClick={() => setReload((value) => value + 1)}>Retry</button>
      </div>
    )
  } else if (!catalog) {
    content = <Loading>Loading businesses and templates…</Loading>
  } else if (!catalog.businesses.length) {
    content = <p>No businesses are available yet. Ask your administrator to create one.</p>
  } else if (!business) {
    content = (
      <>
        <h1 className="h3 fw-bold">Choose a business</h1>
        <p className="text-muted">Create and manage agents for a specific business.</p>
        <input className="form-control mb-4" type="search" aria-label="Search businesses" placeholder="Search businesses…" value={search} onChange={(event) => setSearch(event.target.value)} />
        <div className="row row-cols-1 row-cols-md-3 g-3">
          {catalog.businesses.filter((item) => matches(item.label, item.domain)).map((item) => (
            <div className="col" key={item.name}>
              <button className="card border-0 shadow-sm template-card accent-neutral h-100 w-100 text-start" onClick={() => navigate(scoped('/ai-studio', item.name))}>
                <span className="card-body">
                  <span className="template-icon mb-3"><i className="bi bi-building" /></span>
                  <span className="h5 d-block">{item.label}</span>
                  <span className="text-muted d-block">{item.domain}</span>
                  <span className="d-block mt-3 fw-semibold">Browse templates →</span>
                </span>
              </button>
            </div>
          ))}
        </div>
        {!catalog.businesses.some((item) => matches(item.label, item.domain)) && <p>No businesses match your search.</p>}
      </>
    )
  } else if (templateMatch || editId) {
    const agent = editId && agents.find((item) => item.id === editId)
    if (editId && agentsLoading) content = <Loading>Loading agent…</Loading>
    else if (editId && agentsError) content = <div className="alert alert-danger" role="alert">{agentsError}<button className="btn btn-link" onClick={() => setRefreshAgents((value) => value + 1)}>Retry</button></div>
    else if (editId && !agent) content = <p role="alert">This agent was not found in {business.label}.</p>
    else content = (
      <AgentEditor
        key={`${business.name}:${editId || templateMatch[1]}`}
        business={business}
        agent={agent || null}
        templateId={agent?.templateId || decodeURIComponent(templateMatch[1])}
        onSaved={saved}
        onCancel={() => navigate(scoped(editId ? '/agents' : '/ai-studio'))}
      />
    )
  } else if (listPage) {
    content = (
      <>
        <div className="d-flex justify-content-between align-items-center mb-4 gap-3">
          <div>
            <h1 className="h3 fw-bold">My agents</h1>
            <p className="text-muted mb-0">{business.label}</p>
          </div>
          <button className="btn btn-dark" onClick={() => navigate(scoped('/ai-studio'))}>Create agent</button>
        </div>
        <input className="form-control mb-4" type="search" aria-label="Search agents" placeholder="Search agents…" value={search} onChange={(event) => setSearch(event.target.value)} />
        {agentsLoading ? (
          <Loading>Loading agents…</Loading>
        ) : agentsError ? (
          <div className="alert alert-danger" role="alert">
            {agentsError}
            <button className="btn btn-link" onClick={() => setRefreshAgents((value) => value + 1)}>Retry</button>
          </div>
        ) : (
          <>
            <div className="row row-cols-1 row-cols-md-3 g-3">
              {agents.filter((item) => matches(item.name, item.config.description)).map((agent) => (
                <div className="col" key={agent.id}>
                  <div className="card h-100 border-0 shadow-sm">
                    <div className="card-body d-flex flex-column">
                      <h2 className="h5">{agent.name}</h2>
                      <span className={`badge align-self-start mb-3 ${domainClass(agent.config.domain)}`}>{agent.config.domain}</span>
                      <p className="text-muted flex-grow-1">{agent.config.description}</p>
                      <button className="btn btn-outline-secondary" onClick={() => navigate(scoped(`/agents/${encodeURIComponent(agent.id)}`))}>Edit agent</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {!agents.length && <p>No agents yet for {business.label}. Choose a template to create your first agent.</p>}
            {!!agents.length && !agents.some((item) => matches(item.name, item.config.description)) && <p>No agents match your search.</p>}
          </>
        )}
      </>
    )
  } else {
    const templates = catalog.templates.filter((item) => item.config.domain === business.domain && matches(item.name, item.description))
    content = (
      <>
        <button className="btn btn-link ps-0 mb-3" onClick={() => navigate('/ai-studio')}>← All businesses</button>
        <h1 className="h3 fw-bold">{business.label} templates</h1>
        <p className="text-muted">Choose a template and customize its configuration for your business.</p>
        <input className="form-control mb-4" type="search" aria-label="Search templates" placeholder="Search templates…" value={search} onChange={(event) => setSearch(event.target.value)} />
        <div className="row row-cols-1 row-cols-sm-2 row-cols-xl-4 g-3">
          {templates.map((template) => (
            <div className="col" key={template.id}>
              <div className="card h-100 border-0 shadow-sm template-card accent-neutral">
                <div className="card-body d-flex flex-column">
                  <div className="template-icon mb-3"><i className="bi bi-stars" /></div>
                  <h2 className="h6 fw-bold">{template.name}</h2>
                  <span className="small text-muted mb-2">Version {template.version}</span>
                  <p className="text-muted flex-grow-1">{template.description}</p>
                  <button className="btn btn-dark" onClick={() => navigate(scoped(`/ai-studio/templates/${encodeURIComponent(template.id)}/config`))}>Use Template</button>
                </div>
              </div>
            </div>
          ))}
        </div>
        {!templates.length && <p>No templates match this business and search.</p>}
      </>
    )
  }

  return (
    <AppShell activeKey={activeNavKey} onNavigate={handleNav} notice={notice} onDismissNotice={() => setNotice('')}>
      {!!catalog?.businesses.length && (
        <div className="d-flex justify-content-end align-items-center gap-2 mb-4">
          <label htmlFor="business" className="fw-semibold">Business</label>
          <select
            id="business"
            className="form-select w-auto"
            value={business?.name || ''}
            onChange={(event) => navigate(scoped(listPage || editId ? '/agents' : '/ai-studio', event.target.value))}
          >
            {!business && <option value="">Choose a business</option>}
            {catalog.businesses.map((item) => <option key={item.name} value={item.name}>{item.label}</option>)}
          </select>
        </div>
      )}
      {content}
    </AppShell>
  )
}

export default App
