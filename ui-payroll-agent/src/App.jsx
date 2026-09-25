import { useEffect, useRef, useState } from 'react'
import './App.css'
import { graphqlRequest } from './graphql/client'
import { DOMAIN_TEMPLATES_QUERY, SERVICE_AGENT_REGISTRY_QUERY, STUDIO_QUERY, VIEWER_QUERY } from './graphql/operations'
import AgentEditor from './AgentEditor'
import ChatWindow from './ChatWindow'
import ToolsPage from './ToolsPage'
import EvaluationPage from './EvaluationPage'
import MetricsPage from './MetricsPage'
import UserAgentsPage from './UserAgentsPage'
import CustomerToolsPage from './CustomerToolsPage'
import MyAgentsPage from './MyAgentsPage'
import ModelsPage from './ModelsPage'
import { trinetUrl } from './links'

// Services (domain categories) shown on the landing page. Display chrome only: a service
// becomes available once the backend has a domain and templates in that category, and any
// other backend category is listed too.
const SERVICES = [
  { category: 'Payroll', icon: 'bi-cash-coin', description: 'Payrun anomalies, summaries, and payroll questions.' },
  { category: 'Benefits', icon: 'bi-heart-pulse', description: 'Stock matching, HSA, and other benefits questions.' },
  { category: 'Insurance', icon: 'bi-shield-check', description: 'Coverage, claims, and policy questions.' },
  { category: 'HR', icon: 'bi-people', description: 'Policies, onboarding, and general people questions.' },
  { category: 'Time off', icon: 'bi-calendar-week', description: 'PTO balances, requests, and time-off policy.' },
]

// Agent Studio is a single page at BASE_URL: the left panel switches views in place and
// the URL never changes. What the panel offers depends on the viewer's role and feature flags
// (backend/graphql/access.js); the API enforces the same rules.
//   Admin: Services, Tools & APIs (tool catalog), Models, My Agents, Evaluation, Agent Metrics.
//   Customer: Services (allowed models and tools), Tools & APIs (their agents' tools), My Agents
//   (playground), Usage.
const USER_VIEW = { key: 'mine', label: 'My Agents', icon: 'bi-robot' }

function navFor(viewer) {
  if (!viewer) return []
  const has = feature => viewer.features.includes(feature)
  const admin = has('manageAgents')
  const build = [
    (admin || has('createAgents')) && { key: 'studio', label: 'Services', icon: 'bi-grid-1x2' },
    has('tools') ? { key: 'tools', label: 'Tools & APIs', icon: 'bi-plug' }
      : has('agentTools') && { key: 'agent-tools', label: 'Tools & APIs', icon: 'bi-plug' },
    has('models') && { key: 'models', label: 'Models', icon: 'bi-cpu' },
  ].filter(Boolean)
  const manage = [
    (admin || has('testAgents')) && { key: 'agents', label: 'My Agents', icon: 'bi-robot' },
    has('evaluation') && { key: 'evaluation', label: 'Evaluation', icon: 'bi-graph-up' },
    has('metrics') ? { key: 'metrics', label: 'Agent Metrics', icon: 'bi-speedometer2' }
      : has('usage') && { key: 'usage', label: 'Usage', icon: 'bi-bar-chart' },
  ].filter(Boolean)
  const groups = [{ label: 'Build', items: build }, { label: 'Manage', items: manage }].filter(group => group.items.length)
  // With no features at all, a read-only list of the agents in the viewer's services.
  return groups.length ? groups : [{ label: 'Your service', items: [USER_VIEW] }]
}

function AccessBox({ viewer, onSignIn, onSignOut }) {
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  if (!viewer) return null
  if (viewer.authMode === 'open') {
    return <div className="sidebar-access small" title="Set STUDIO_ADMIN_KEY on the server to require admin sign-in.">
      <i className="bi bi-unlock me-1" aria-hidden="true" />Open access · everyone is admin
    </div>
  }
  const submit = async event => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try { await onSignIn(key); setKey(''); setOpen(false) } catch (signInError) { setError(signInError.message) } finally { setBusy(false) }
  }
  return <div className="sidebar-access small">
    <div className="d-flex align-items-center justify-content-between gap-2">
      <span><i className={`bi ${viewer.role === 'admin' ? 'bi-shield-lock' : 'bi-person'} me-1`} aria-hidden="true" />{viewer.role === 'admin' ? 'Admin' : 'User'}</span>
      {viewer.role === 'admin'
        ? <button type="button" className="btn btn-link btn-sm p-0 sidebar-access-link" onClick={onSignOut}>Sign out</button>
        : <button type="button" className="btn btn-link btn-sm p-0 sidebar-access-link" aria-expanded={open} onClick={() => setOpen(value => !value)}>Admin sign in</button>}
    </div>
    {open && viewer.role !== 'admin' && <form className="mt-2" onSubmit={submit}>
      <label htmlFor="admin-key" className="visually-hidden">Admin key</label>
      <input id="admin-key" type="password" className="form-control form-control-sm" placeholder="Admin key" autoComplete="current-password"
        value={key} onChange={event => setKey(event.target.value)} required autoFocus />
      {error && <div className="text-warning mt-1" role="alert">{error}</div>}
      <button type="submit" className="btn btn-light btn-sm w-100 mt-2" disabled={busy || !key}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form>}
  </div>
}

function Sidebar({ activeKey, onNavigate, domainName, viewer, onSignIn, onSignOut }) {
  return (
    <aside className="app-sidebar studio-sticky d-flex flex-column flex-shrink-0 p-3">
      <div className="d-flex align-items-center gap-2 px-1 mb-1">
        <span className="sidebar-mark"><i className="bi bi-stars" /></span>
        <div className="d-flex flex-column">
          <span className="text-white fw-bold text-uppercase sidebar-brand">Agent Studio</span>
          <span className="sidebar-subtitle">Payroll AI Platform</span>
        </div>
      </div>
      <hr className="sidebar-divider mt-3 mb-3" />
      <nav aria-label="Agent Studio">
        {navFor(viewer).map((group) => (
          <div className="mb-3" key={group.label}>
            <div className="sidebar-group-label px-2 mb-2">{group.label}</div>
            <ul className="nav nav-pills flex-column gap-1">
              {group.items.map((item) => (
                <li className="nav-item" key={item.key}>
                  <button
                    type="button"
                    aria-current={activeKey === item.key ? 'true' : undefined}
                    className={`nav-link sidebar-link d-flex align-items-center gap-2 w-100 text-start${activeKey === item.key ? ' active' : ''}`}
                    onClick={() => onNavigate(item.key)}
                  >
                    <span className="sidebar-icon"><i className={`bi ${item.icon}`} /></span>
                    <span className="flex-grow-1">{item.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className="mt-auto">
        <hr className="sidebar-divider mt-0 mb-3" />
        <AccessBox viewer={viewer} onSignIn={onSignIn} onSignOut={onSignOut} />
        <a className="nav-link sidebar-link d-flex align-items-center gap-2 w-100" href={trinetUrl(domainName)} target="_blank" rel="noreferrer">
          <span className="sidebar-icon"><i className="bi bi-cash-stack" /></span>
          <span className="flex-grow-1">TriNet Payruns</span>
          <i className="bi bi-box-arrow-up-right small" aria-label="Opens in a new tab" />
        </a>
      </div>
    </aside>
  )
}

function Loading({ children = 'Loading…' }) {
  return <p role="status" className="text-muted py-4"><span className="spinner-border spinner-border-sm me-2" />{children}</p>
}

// ?view=chat&domain=X opens the standalone chat window instead of the studio.
const standaloneView = () => {
  const params = new URLSearchParams(window.location.search)
  return params.get('view') === 'chat' ? { view: 'chat', domain: params.get('domain') || params.get('business') || '' } : null
}

function App() {
  const [standalone] = useState(standaloneView)
  const [view, setView] = useState('studio')
  const [catalog, setCatalog] = useState(null)
  const [catalogError, setCatalogError] = useState('')
  const [reload, setReload] = useState(0)
  const [service, setService] = useState(null)
  const [domainName, setDomainName] = useState('')
  const [editing, setEditing] = useState(null)
  const [notice, setNotice] = useState('')
  const [agentResult, setAgentResult] = useState(null)
  const [viewer, setViewer] = useState(null)
  const [agentReload, setAgentReload] = useState(0)
  const [viewerReload, setViewerReload] = useState(0)
  const editorRef = useRef(null)
  // In the studio the domain list is limited to the chosen service; other views use all domains.
  const domains = (view === 'studio' ? catalog?.domains.filter(item => item.domain === service) : catalog?.domains) || []
  const domain = domains.find(item => item.name === domainName) || domains[0]
  const needsAgents = ['tools', 'evaluation', 'agent-tools', 'metrics', 'usage'].includes(view)
  const agents = agentResult && agentResult.domainName === domain?.name ? agentResult.items : []
  const agentsLoading = domain && (agentResult?.domainName !== domain.name || agentResult.loading)

  useEffect(() => {
    if (standalone) return undefined
    let active = true
    setCatalogError('')
    // Domains, then each domain's templates (one list, deduplicated by template id).
    graphqlRequest(STUDIO_QUERY)
      .then(async ({ listDomains: domainList }) => {
        const results = await Promise.all(domainList.map(item => graphqlRequest(DOMAIN_TEMPLATES_QUERY, { domainName: item.name })))
        const templates = [...new Map(results.flatMap(result => result.getDomainAgentsTemplates).map(item => [item.id, item])).values()]
        if (active) setCatalog({ domains: domainList, templates })
      })
      .catch(error => { if (active) setCatalogError(error.message) })
    return () => { active = false }
  }, [reload, standalone])

  useEffect(() => {
    if (standalone || !needsAgents || !domain) return undefined
    let active = true
    setAgentResult({ domainName: domain.name, items: [], loading: true, error: '' })
    graphqlRequest(SERVICE_AGENT_REGISTRY_QUERY, { domainName: domain.name })
      .then(data => { if (active) setAgentResult({ domainName: domain.name, items: data.getServiceAgentRegistry, loading: false, error: '' }) })
      .catch(error => { if (active) setAgentResult({ domainName: domain.name, items: [], loading: false, error: error.message }) })
    return () => { active = false }
  }, [domain, needsAgents, standalone, agentReload])

  useEffect(() => {
    if (editing) editorRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }, [editing])

  // Clicking anywhere outside the configuration and summary cards closes them.
  // Template cards are excluded so Use Template switches templates instead.
  useEffect(() => {
    if (!editing) return undefined
    const closeOnOutsideClick = event => {
      const onScrollbar = event.clientX >= document.documentElement.clientWidth
      const inside = event.target.closest?.('.template-card, .alert, [role="status"]')
        || [...(editorRef.current?.querySelectorAll('.card') || [])].some(card => card.contains(event.target))
      if (onScrollbar || inside) return
      setEditing(null)
    }
    document.addEventListener('mousedown', closeOnOutsideClick)
    return () => document.removeEventListener('mousedown', closeOnOutsideClick)
  }, [editing])

  // Role and feature flags decide which views are shown (the API enforces them as well).
  useEffect(() => {
    if (standalone) return undefined
    let active = true
    graphqlRequest(VIEWER_QUERY)
      .then(data => { if (active) setViewer(data.viewer) })
      .catch(() => { if (active) setViewer({ role: 'user', features: [], authMode: 'key' }) })
    return () => { active = false }
  }, [standalone, viewerReload])
  const allowedViews = navFor(viewer).flatMap(group => group.items.map(item => item.key))
  const allowedKey = allowedViews.join(',')
  // After sign-in or sign-out, leave a view the viewer can no longer open.
  useEffect(() => {
    const allowed = allowedKey.split(',')
    if (viewer && !allowed.includes(view)) setView(allowed[0] || USER_VIEW.key)
  }, [viewer, view, allowedKey])

  async function access(path, body) {
    const response = await fetch(`${import.meta.env.BASE_URL}auth/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.message || `Sign-in failed (${response.status}).`)
    setViewerReload(value => value + 1)
  }

  if (standalone?.view === 'chat') {
    return <main className="chat-app-shell">
      <ChatWindow domainName={standalone.domain || null} />
    </main>
  }

  const showView = next => {
    setView(next)
    setEditing(null)
    setNotice('')
    window.scrollTo?.({ top: 0, behavior: 'smooth' })
  }
  const openService = category => {
    setService(category)
    setDomainName('')
    showView('studio')
  }
  const chooseDomain = name => {
    setDomainName(name)
    setEditing(null)
    setNotice('')
  }
  const saved = agent => {
    setNotice(`${agent.name} created for ${domain.label}. It is now available to the ${domain.domain} service.`)
    setEditing(null)
    window.scrollTo?.({ top: 0, behavior: 'smooth' })
  }

  let content
  if (!viewer) {
    content = <Loading>Checking access…</Loading>
  } else if (!allowedViews.includes(view)) {
    content = <Loading />
  } else if (view === USER_VIEW.key) {
    content = catalog ? <UserAgentsPage domains={catalog.domains} /> : <Loading>Loading your agents…</Loading>
  } else if (view === 'models') {
    content = <ModelsPage templates={catalog?.templates} />
  } else if (catalogError) {
    content = <div className="alert alert-danger" role="alert">Could not load Agent Studio: {catalogError}
      <button className="btn btn-outline-danger btn-sm ms-3" onClick={() => setReload(value => value + 1)}>Retry</button>
    </div>
  } else if (!catalog) {
    content = <Loading>Loading domains and templates…</Loading>
  } else if (view !== 'studio' && !domain) {
    content = <p>No domains are available yet. Ask your administrator to create one.</p>
  } else if (view === 'tools') {
    content = <ToolsPage domain={domain} templates={catalog.templates} agents={agents} agentsLoading={agentsLoading} />
  } else if (view === 'evaluation') {
    content = <EvaluationPage key={domain.name} domain={domain} agents={agents} agentsLoading={agentsLoading}
      onBrowseTemplates={() => openService(domain.domain)} />
  } else if (view === 'metrics' || view === 'usage') {
    content = <MetricsPage key={domain.name} domain={domain} agents={agents} agentsLoading={agentsLoading} />
  } else if (view === 'agent-tools') {
    content = <CustomerToolsPage key={domain.name} domain={domain} templates={catalog.templates} agents={agents}
      agentsLoading={agentsLoading} viewer={viewer} onChanged={() => setAgentReload(value => value + 1)} />
  } else if (view === 'agents') {
    content = <MyAgentsPage domains={catalog.domains} onCreate={() => openService(null)} canChat={viewer.features.includes('testAgents')} />
  } else if (!service || !domain) {
    const categories = [...SERVICES.map(item => item.category),
      ...new Set(catalog.domains.map(item => item.domain).filter(category => !SERVICES.some(item => item.category === category)))]
    content = <section aria-labelledby="services-heading">
      <h2 id="services-heading" className="h5 fw-bold">Choose a service</h2>
      <p className="text-muted">Pick the service your agent will work in.</p>
      <div className="row row-cols-1 row-cols-sm-2 row-cols-xl-3 g-3">
        {categories.map(category => {
          const info = SERVICES.find(item => item.category === category) || { icon: 'bi-grid', description: `${category} agents.` }
          const templateCount = catalog.templates.filter(item => item.config.domain === category).length
          const available = templateCount > 0 && catalog.domains.some(item => item.domain === category)
          return <div className="col" key={category}>
            <button type="button" disabled={!available} onClick={() => openService(category)}
              className="card border-0 shadow-sm template-card service-card accent-neutral h-100 w-100 text-start">
              <span className="card-body d-flex flex-column w-100">
                <span className="d-flex justify-content-between align-items-start mb-3">
                  <span className="template-icon"><i className={`bi ${info.icon}`} /></span>
                  {!available && <span className="badge rounded-pill text-bg-light">Coming soon</span>}
                </span>
                <span className="h6 fw-bold d-block">{category}</span>
                <span className="text-muted d-block flex-grow-1">{info.description}</span>
                <span className="small fw-semibold mt-3 d-block">{available ? `${templateCount} template${templateCount === 1 ? '' : 's'} →` : 'No templates yet'}</span>
              </span>
            </button>
          </div>
        })}
      </div>
    </section>
  } else {
    const templates = catalog.templates.filter(item => item.config.domain === domain.domain)
    content = <section id="templates" className="studio-section" aria-labelledby="templates-heading">
      <button type="button" className="btn btn-link ps-0 mb-2" onClick={() => openService(null)}>← All services</button>
      <h2 id="templates-heading" className="h5 fw-bold">{service} templates</h2>
      <p className="text-muted">Pick a {domain.domain} template, configure it below, and submit to create the agent.</p>
      <div className="row row-cols-1 row-cols-sm-2 row-cols-xl-4 g-3">
        {templates.map(template => {
          const selected = editing?.templateId === template.id
          return <div className="col" key={template.id}>
            <div className={`card h-100 border-0 shadow-sm template-card accent-neutral${selected ? ' border border-2 border-dark' : ''}`}><div className="card-body d-flex flex-column">
              <div className="template-icon mb-3"><i className="bi bi-stars" /></div>
              <h3 className="h6 fw-bold">{template.name}</h3><span className="small text-muted mb-2">Version {template.version}</span>
              <p className="text-muted flex-grow-1">{template.description}</p>
              <button className="btn btn-dark" aria-pressed={selected} onClick={() => { setNotice(''); setEditing({ templateId: template.id }) }}>Use Template</button>
            </div></div>
          </div>
        })}
      </div>
      {!templates.length && <p>No templates are available for this domain.</p>}
      {editing && <div id="configure" ref={editorRef} className="mt-4 studio-section" aria-label="Configure agent">
        <AgentEditor key={`${domain.name}:${editing.templateId}`} viewer={viewer}
          domain={domain} agent={null} templateId={editing.templateId}
          onSaved={saved} onCancel={() => setEditing(null)} />
      </div>}
    </section>
  }

  const showDomain = !['models', 'agents', USER_VIEW.key].includes(view) && viewer && domain && (view !== 'studio' || service)
  const isAdmin = viewer?.role === 'admin'
  return <div className="app-shell d-flex">
    <Sidebar activeKey={view} onNavigate={key => key === 'studio' ? openService(null) : showView(key)} domainName={domain?.name}
      viewer={viewer} onSignIn={key => access('admin', { key })} onSignOut={() => access('logout')} />
    <main className="studio-page flex-grow-1 min-vw-0 p-4 p-xl-5">
      <header className="d-flex flex-wrap justify-content-between align-items-center gap-3 mb-4">
        <div><h1 className="h3 fw-bold mb-0">Agent Studio</h1><p className="text-muted mb-0">{viewer && !isAdmin ? 'Build and try AI agents for your services.' : 'Create an AI agent for a service and domain.'}</p></div>
        {showDomain && <div className="d-flex align-items-center gap-2">
          <label htmlFor="domain" className="fw-semibold">Domain</label>
          <select id="domain" className="form-select w-auto" value={domain.name} onChange={event => chooseDomain(event.target.value)}>
            {domains.map(item => <option key={item.name} value={item.name}>{item.label}</option>)}
          </select>
        </div>}
      </header>
      {notice && <div className="alert alert-success d-flex align-items-center justify-content-between py-2 px-3 mb-4" role="status">
        <span className="small">{notice}</span>
        <button type="button" className="btn-close" onClick={() => setNotice('')} aria-label="Dismiss" />
      </div>}
      {content}
    </main>
  </div>
}

export default App
