import { useEffect, useState } from 'react'
import './App.css'
import { graphqlRequest } from './graphql/client'
import { SERVICE_AGENT_REGISTRY_QUERY, DOMAIN_TEMPLATES_QUERY, STUDIO_QUERY } from './graphql/operations'
import AgentEditor from './AgentEditor'

const NAV_GROUPS = [
  {
    label: 'Build',
    items: [
      { key: 'templates', label: 'Templates', icon: 'bi-grid-1x2', path: '/ai-studio' },
      { key: 'my-agents', label: 'My Agents', icon: 'bi-robot', path: '/agents' },
      { key: 'tools', label: 'Tools & APIs', icon: 'bi-plug', soon: true },
      { key: 'models', label: 'Models', icon: 'bi-cpu', soon: true },
    ],
  },
  {
    label: 'Manage',
    items: [
      { key: 'registry', label: 'Agent Registry', icon: 'bi-collection', soon: true },
      { key: 'evaluation', label: 'Evaluation', icon: 'bi-graph-up', soon: true },
    ],
  },
]

function domainSlug(domain) {
  return domain.toLowerCase().replace(' ', '-')
}

function domainClass(domain) {
  return `domain-badge domain-${domainSlug(domain)}`
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
  const [templateResult, setTemplateResult] = useState(null)
  const [catalogError, setCatalogError] = useState('')
  const [reload, setReload] = useState(0)
  const [agentResult, setAgentResult] = useState(null)
  const [refreshAgents, setRefreshAgents] = useState(0)
  const [search, setSearch] = useState('')
  const [notice, setNotice] = useState('')
  const url = new URL(route, window.location.origin)
  const path = url.pathname
  const domainName = url.searchParams.get('domain') || catalog?.domains[0]?.name
  const domain = catalog?.domains.find(item => item.name === domainName)
  const domainHome = path === '/' || (path === '/ai-studio' && !url.searchParams.has('domain'))
  const templateMatch = path.match(/^\/ai-studio\/templates\/([^/]+)\/config$/)
  const agentMatch = path.match(/^\/agents\/([^/]+)$/)
  const editId = agentMatch && agentMatch[1] !== 'new' ? decodeURIComponent(agentMatch[1]) : null
  const listPage = path === '/agents'
  const agents = agentResult && agentResult.domainName === domainName ? agentResult.items : []
  const agentsLoading = domain && (agentResult?.domainName !== domainName || agentResult.loading)
  const agentsError = agentResult && agentResult.domainName === domainName ? agentResult.error : ''

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
      .then(data => { if (active) setCatalog({ domains: data.listDomains }) })
      .catch(error => { if (active) setCatalogError(error.message) })
    return () => { active = false }
  }, [reload])

  useEffect(() => {
    if (!domain) return
    let active = true
    setAgentResult({ domainName: domain.name, items: [], loading: true, error: '' })
    graphqlRequest(SERVICE_AGENT_REGISTRY_QUERY, { domainName: domain.name })
      .then(data => { if (active) setAgentResult({ domainName: domain.name, items: data.getServiceAgentRegistry, loading: false, error: '' }) })
      .catch(error => { if (active) setAgentResult({ domainName: domain.name, items: [], loading: false, error: error.message }) })
    return () => { active = false }
  }, [domain, refreshAgents])

  useEffect(() => {
    if (!domain) return
    let active = true
    setTemplateResult({ domainName: domain.name, loading: true, items: [] })
    graphqlRequest(DOMAIN_TEMPLATES_QUERY, { domainName: domain.name })
      .then(data => { if (active) setTemplateResult({ domainName: domain.name, items: data.getDomainAgentsTemplates }) })
      .catch(error => { if (active) setTemplateResult({ domainName: domain.name, items: [], error: error.message }) })
    return () => { active = false }
  }, [domain, reload])

  function navigate(next) {
    window.history.pushState({}, '', next)
    setRoute(next)
    setSearch('')
  }
  const scoped = (next, name = domainName) => `${next}?domain=${encodeURIComponent(name || '')}`
  const handleNav = item => item.soon ? setNotice(`${item.label} is coming soon.`) : navigate(scoped(item.path))
  const saved = agent => {
    setNotice(`${agent.name} saved for ${domain.label}.`)
    setRefreshAgents(value => value + 1)
    navigate(scoped('/agents'))
  }
  const query = search.trim().toLowerCase()
  const matches = (...values) => values.some(value => String(value || '').toLowerCase().includes(query))

  let content
  if (catalogError) {
    content = <div className="alert alert-danger" role="alert">Could not load Agent Studio: {catalogError}
      <button className="btn btn-outline-danger btn-sm ms-3" onClick={() => setReload(value => value + 1)}>Retry</button>
    </div>
  } else if (!catalog) {
    content = <Loading>Loading domains…</Loading>
  } else if (!catalog.domains.length) {
    content = <p>No domains are available yet. Ask your administrator to create one.</p>
  } else if (!domain) {
    content = <div className="alert alert-warning" role="alert">Domain not found.
      <button className="btn btn-link" onClick={() => navigate('/ai-studio')}>Choose a domain</button>
    </div>
  } else if (templateMatch || editId) {
    const agent = editId && agents.find(item => item.id === editId)
    if (editId && agentsLoading) content = <Loading>Loading agent…</Loading>
    else if (editId && agentsError) content = <div className="alert alert-danger" role="alert">{agentsError}<button className="btn btn-link" onClick={() => setRefreshAgents(value => value + 1)}>Retry</button></div>
    else if (editId && !agent) content = <p role="alert">This agent was not found in {domain.label}.</p>
    else content = <AgentEditor key={`${domain.name}:${editId || templateMatch[1]}`}
      domain={domain} agent={agent || null} templateId={agent?.templateId || decodeURIComponent(templateMatch[1])}
      onSaved={saved} onCancel={() => navigate(scoped(editId ? '/agents' : '/ai-studio'))} />
  } else if (domainHome) {
    content = <>
      <h1 className="h3 fw-bold">Choose a domain</h1>
      <p className="text-muted">Create and manage agents for a specific domain.</p>
      <input className="form-control mb-4" type="search" aria-label="Search domains" placeholder="Search domains…" value={search} onChange={event => setSearch(event.target.value)} />
      <div className="row row-cols-1 row-cols-md-3 g-3">
        {catalog.domains.filter(item => matches(item.label, item.domain)).map(item => <div className="col" key={item.name}>
          <button className="card border-0 shadow-sm template-card accent-neutral h-100 w-100 text-start" onClick={() => navigate(scoped('/ai-studio', item.name))}>
            <span className="card-body"><span className="template-icon mb-3"><i className="bi bi-building" /></span>
              <span className="h5 d-block">{item.label}</span><span className="text-muted d-block">{item.domain}</span>
              <span className="d-block mt-3 fw-semibold">Browse templates →</span>
            </span>
          </button>
        </div>)}
      </div>
      {!catalog.domains.some(item => matches(item.label, item.domain)) && <p>No domains match your search.</p>}
    </>
  } else if (listPage) {
    content = <>
      <div className="d-flex justify-content-between align-items-center mb-4 gap-3">
        <div><h1 className="h3 fw-bold">My agents</h1><p className="text-muted mb-0">{domain.label}</p></div>
        <button className="btn btn-dark" onClick={() => navigate(scoped('/ai-studio'))}>Create agent</button>
      </div>
      <input className="form-control mb-4" type="search" aria-label="Search agents" placeholder="Search agents…" value={search} onChange={event => setSearch(event.target.value)} />
      {agentsLoading ? <Loading>Loading agents…</Loading> : agentsError ? <div className="alert alert-danger" role="alert">{agentsError}<button className="btn btn-link" onClick={() => setRefreshAgents(value => value + 1)}>Retry</button></div> : <>
        <div className="row row-cols-1 row-cols-md-3 g-3">
          {agents.filter(item => matches(item.name, item.config.description)).map(agent => <div className="col" key={agent.id}>
            <div className="card h-100 border-0 shadow-sm"><div className="card-body d-flex flex-column">
              <h2 className="h5">{agent.name}</h2><span className={`badge align-self-start mb-3 ${domainClass(agent.config.domain)}`}>{agent.config.domain}</span>
              <p className="text-muted flex-grow-1">{agent.config.description}</p>
              <button className="btn btn-outline-secondary" onClick={() => navigate(scoped(`/agents/${encodeURIComponent(agent.id)}`))}>Edit agent</button>
            </div></div>
          </div>)}
        </div>
        {!agents.length && <p>No agents yet for {domain.label}. Choose a template to create your first agent.</p>}
        {!!agents.length && !agents.some(item => matches(item.name, item.config.description)) && <p>No agents match your search.</p>}
      </>}
    </>
  } else {
    const templates = (templateResult?.domainName === domainName ? templateResult.items : []).filter(item => item.config.domain === domain.domain && matches(item.name, item.description))
    content = <>
      <button className="btn btn-link ps-0 mb-3" onClick={() => navigate('/ai-studio')}>← All domains</button>
      <h1 className="h3 fw-bold">{domain.label} templates</h1>
      <p className="text-muted">Choose a template and customize its configuration for your domain.</p>
      <input className="form-control mb-4" type="search" aria-label="Search templates" placeholder="Search templates…" value={search} onChange={event => setSearch(event.target.value)} />
      <div className="row row-cols-1 row-cols-sm-2 row-cols-xl-4 g-3">
        {templates.map(template => <div className="col" key={template.id}>
          <div className="card h-100 border-0 shadow-sm template-card accent-neutral"><div className="card-body d-flex flex-column">
            <div className="template-icon mb-3"><i className="bi bi-stars" /></div>
            <h2 className="h6 fw-bold">{template.name}</h2><span className="small text-muted mb-2">Version {template.version}</span>
            <p className="text-muted flex-grow-1">{template.description}</p>
            <button className="btn btn-dark" onClick={() => navigate(scoped(`/ai-studio/templates/${encodeURIComponent(template.id)}/config`))}>Use Template</button>
          </div></div>
        </div>)}
      </div>
      {(!templateResult || templateResult.domainName !== domainName || templateResult.loading) ? <Loading>Loading templates...</Loading>
        : templateResult.error ? <div role="alert">{templateResult.error}<button onClick={() => setReload(value => value + 1)}>Retry</button></div>
        : !templates.length && <p>No templates match this domain and search.</p>}
    </>
  }

  return <AppShell activeKey={listPage || editId ? 'my-agents' : 'templates'} onNavigate={handleNav} notice={notice} onDismissNotice={() => setNotice('')}>
    {!!catalog?.domains.length && <div className="d-flex justify-content-end align-items-center gap-2 mb-4">
      <label htmlFor="domain" className="fw-semibold">Domain</label>
      <select id="domain" className="form-select w-auto" value={domain?.name || ''}
        onChange={event => navigate(scoped(listPage || editId ? '/agents' : '/ai-studio', event.target.value))}>
        {!domain && <option value="">Choose a domain</option>}
        {catalog.domains.map(item => <option key={item.name} value={item.name}>{item.label}</option>)}
      </select>
    </div>}
    {content}
  </AppShell>
}

export default App
