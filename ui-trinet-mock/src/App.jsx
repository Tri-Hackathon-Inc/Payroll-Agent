import { useEffect, useState } from 'react'
import AssistantPanel from './AssistantPanel'
import EmployeeDrawer from './EmployeeDrawer'
import PayrollDetail from './PayrollDetail'
import PayrollList from './PayrollList'
import { agentStudioRequest, payrollRequest } from './api'
import { money } from './format'
import { DOMAINS_QUERY, PAYRUNS_QUERY, PAYRUN_QUERY } from './operations'

// Temporary mock of the TriNet payroll screens (rfcs/payroll-ui-reference), standing in for the
// real TriNet UI until the agent is embedded there. URL: /trinet/?domain=<name>[&payrun=<id>].
const readQuery = () => {
  const query = Object.fromEntries(new URLSearchParams(window.location.search))
  return { ...query, domain: query.domain || query.business } // ?business= is the older name
}

function Loading({ children }) {
  return <div className="tn-page text-muted"><span className="spinner-border spinner-border-sm me-2" />{children}</div>
}

export default function App() {
  const [query, setQuery] = useState(readQuery)
  const [domain, setDomain] = useState(null)
  const [payruns, setPayruns] = useState(null)
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState('')
  const [lineId, setLineId] = useState(null)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [reloadDetail, setReloadDetail] = useState(0)
  const payrunId = query.payrun || null

  // The docked assistant closes from its header button, its close button, or Esc.
  useEffect(() => {
    if (!assistantOpen) return undefined
    const onKeyDown = (event) => { if (event.key === 'Escape') setAssistantOpen(false) }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [assistantOpen])

  useEffect(() => {
    const onPopState = () => setQuery(readQuery())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  // The domain decides which Agent Studio agents the Payroll Assistant offers.
  useEffect(() => {
    let active = true
    agentStudioRequest(DOMAINS_QUERY).then((data) => {
      if (active) setDomain(data.listDomains.find((item) => item.name === query.domain) || data.listDomains[0] || null)
    }).catch(() => { if (active) setDomain(query.domain ? { name: query.domain, label: query.domain } : null) })
    return () => { active = false }
  }, [query.domain])

  // Refetched whenever the list is shown, so its totals reflect saved edits.
  useEffect(() => {
    if (payrunId) return undefined
    let active = true
    payrollRequest(PAYRUNS_QUERY).then((data) => { if (active) setPayruns(data.payruns) })
      .catch((requestError) => { if (active) setError(requestError.message) })
    return () => { active = false }
  }, [payrunId])

  useEffect(() => {
    if (!payrunId) return undefined
    let active = true
    payrollRequest(PAYRUN_QUERY, { id: payrunId }).then((data) => { if (active) setDetail(data.payrun) })
      .catch((requestError) => { if (active) setError(requestError.message) })
    return () => { active = false }
  }, [payrunId, reloadDetail])

  function go(nextPayrun) {
    const params = new URLSearchParams(window.location.search)
    if (nextPayrun) params.set('payrun', nextPayrun)
    else params.delete('payrun')
    window.history.pushState({}, '', `${window.location.pathname}?${params}`)
    setQuery(readQuery())
    setLineId(null)
    setAssistantOpen(false)
    setError('')
    setNotice('')
  }

  // updatePayLine returns the whole recalculated payrun, so it replaces the page's data.
  function saved(updatedRun, savedLineId) {
    const line = updatedRun.lines.find((item) => item.lineId === savedLineId)
    setDetail(updatedRun)
    setLineId(null)
    setNotice(`${line.name}'s pay was saved. Net pay is now ${money.format(line.net)}.`)
  }

  function reload() {
    setLineId(null)
    setNotice('')
    setReloadDetail((value) => value + 1)
  }

  const run = detail && detail.id === payrunId ? detail : null
  const drawerLine = run?.lines.find((line) => line.lineId === lineId)

  const assistantAvailable = Boolean(run && domain)
  return <div className={`tn-app${assistantAvailable && assistantOpen ? ' tn-with-assistant' : ''}`}>
    <header className="tn-header">
      <span className="tn-logo">TriNet</span><span className="tn-mock-tag">Mock</span>
      {assistantAvailable && <button type="button" className={`tn-assistant-toggle${assistantOpen ? ' active' : ''}`}
        aria-pressed={assistantOpen} aria-controls="tn-assistant" onClick={() => { setLineId(null); setAssistantOpen((value) => !value) }}>
        <i className="bi bi-stars" aria-hidden="true" /><span>Payroll Assistant</span>
      </button>}
    </header>
    <main className="tn-main">
      {error ? <div className="tn-page"><div className="alert alert-danger">{error}</div><button type="button" className="tn-link" onClick={() => go(null)}>Back to payrolls</button></div>
        : !payrunId ? (payruns ? <PayrollList payruns={payruns} onOpen={go} /> : <Loading>Loading payrolls…</Loading>)
        : !run ? <Loading>Loading payroll…</Loading>
        : <PayrollDetail run={run} notice={notice} onDismissNotice={() => setNotice('')} onBack={() => go(null)}
          onSelectLine={(id) => { setAssistantOpen(false); setNotice(''); setLineId(id) }} />}
    </main>
    {drawerLine && <EmployeeDrawer key={`${drawerLine.lineId}-${run.version}`} line={drawerLine} run={run}
      onClose={() => setLineId(null)} onSaved={saved} onReload={reload} />}
    {assistantAvailable && <AssistantPanel key={run.id} domain={domain} run={run} open={assistantOpen} onClose={() => setAssistantOpen(false)} />}
  </div>
}
