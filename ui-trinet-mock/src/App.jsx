import { useEffect, useRef, useState } from 'react'
import AgentUiTemplate from './AgentUiTemplate'
import AgentHealth from './AgentHealth'
import EmployeeDrawer from './EmployeeDrawer'
import LiveAlerts, { useLiveAlerts } from './LiveAlerts'
import PayrollDetail from './PayrollDetail'
import PayrollList from './PayrollList'
import { agentStudioRequest, payrollRequest } from './api'
import { money } from './format'
import { DOMAINS_QUERY, CHAT_AGENTS_QUERY, PAYRUNS_QUERY, PAYRUN_QUERY, PAYCHECK_QUERY } from './operations'

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
  const [adEmployee, setAdEmployee] = useState(null)
  const [employeeDirty, setEmployeeDirty] = useState(false)
  const refreshingVersion = useRef(0)
  useEffect(() => { setAdEmployee(null); setLineId(null); setEmployeeDirty(false); refreshingVersion.current = 0 }, [query.payrun, query.domain])
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [chatAttached, setChatAttached] = useState(false)
  const [assistantSelection, setAssistantSelection] = useState(null)
  const [notice, setNotice] = useState('')
  const [reloadDetail, setReloadDetail] = useState(0)
  const paycheckRequest = useRef(0)
  const payrunId = query.payrun || null
  useEffect(() => () => { paycheckRequest.current++ }, [payrunId, domain?.name])
  useEffect(() => {
    let active = true
    setChatAttached(false)
    if (!payrunId || !domain?.name) return undefined
    agentStudioRequest(CHAT_AGENTS_QUERY, { domainName: domain.name }).then(data => {
      if (!active) return
      const attached = (data.getServiceAgentRegistry || []).some(agent => agent.templateId === 'general-query'
        && agent.config?.page === 'payrun' && !agent.config?.anomaly)
      setChatAttached(attached)
      setAssistantOpen(attached)
    }).catch(() => { if (active) setChatAttached(false) })
    return () => { active = false }
  }, [payrunId, domain?.name])

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
    if (!payrunId || !domain?.name) return undefined
    let active = true
    payrollRequest(PAYRUN_QUERY, { id: payrunId, domainName: domain.name }).then((data) => {
      if (active) setDetail(current => current?.id === data.payrun.id && current.version > data.payrun.version ? current : data.payrun)
    })
      .catch((requestError) => { if (active) setError(requestError.message) })
    return () => { active = false }
  }, [payrunId, reloadDetail, domain?.name])

  async function openPaycheck(id) {
    if (!domain || !payrunId) return
    const request = ++paycheckRequest.current
    setAdEmployee(detail?.lines.find(line => line.lineId === id)?.employeeId || null)
    setLineId(null)
    setNotice('Loading latest paycheck…')
    try {
      const data = await payrollRequest(PAYCHECK_QUERY, { id: payrunId, domainName: domain.name, lineId: id })
      if (request !== paycheckRequest.current) return
      const line = data.payrun.lines.find(item => item.lineId === id)
      if (!line) throw new Error('The paycheck is no longer in this payrun.')
      setDetail(current => current?.id === data.payrun.id && current.version > data.payrun.version ? current : data.payrun)
      setAssistantSelection({ payrunId: data.payrun.id, employeeId: line.employeeId })
      setNotice('')
      setLineId(id)
      return true
    } catch (requestError) { if (request === paycheckRequest.current) { setNotice(requestError.message); setAdEmployee(null) } }
  }

  function go(nextPayrun) {
    setAdEmployee(null)
    paycheckRequest.current++
    const params = new URLSearchParams(window.location.search)
    if (nextPayrun) params.set('payrun', nextPayrun)
    else params.delete('payrun')
    window.history.pushState({}, '', `${window.location.pathname}?${params}`)
    setQuery(readQuery())
    setLineId(null)
    setAssistantOpen(false)
    setAssistantSelection(null)
    setError('')
    setNotice('')
  }

  // updatePayLine returns the whole recalculated payrun, so it replaces the page's data.
  function saved(updatedRun, savedLineId) {
    paycheckRequest.current++
    const line = updatedRun.lines.find((item) => item.lineId === savedLineId)
    setDetail(updatedRun)
    setAssistantSelection({ payrunId: updatedRun.id, employeeId: line.employeeId })
    setEmployeeDirty(false)
    // A monitored paycheck read reruns employee-scoped detection after save.
    void openPaycheck(savedLineId).then(refreshed => { if (refreshed) setNotice(`${line.name}'s pay was saved. Net pay is now ${money.format(line.net)}.`) })
  }

  function closePaycheck() {
    setAssistantSelection(null)
    paycheckRequest.current++
    setLineId(null)
    setAdEmployee(null)
    setEmployeeDirty(false)
    // Returning to the payrun asks the source API for a fresh whole-run check.
    setReloadDetail(value => value + 1)
  }

  function reload() {
    setAdEmployee(null)
    paycheckRequest.current++
    setLineId(null)
    setNotice('')
    setReloadDetail((value) => value + 1)
  }

  const run = detail && detail.id === payrunId ? detail : null
  const drawerLine = run?.lines.find((line) => line.lineId === lineId)
  const assistantEmployeeId = assistantSelection && assistantSelection.payrunId === run?.id ? assistantSelection.employeeId : ''
  const assistantEmployee = run?.lines.find((line) => line.employeeId === assistantEmployeeId)

  const assistantAvailable = Boolean(run && domain && chatAttached)
  // Agent Studio's real-time checks for this payrun (see LiveAlerts.jsx).
  const live = useLiveAlerts(run ? domain?.name : null, run?.id, run?.version)
  const scopedCases = live.cases.filter(item => (item.scope || null) === adEmployee && item.version === run?.version)
  const employeeChecked = live.checks.some(item => item.domainName === domain?.name && item.payrunId === run?.id && item.scope === adEmployee && item.version === run?.version)
  const adPanel = <LiveAlerts key={`${run?.id}:${adEmployee || 'payrun'}`} alerts={live.alerts.filter(item => item.type === 'error')} cases={scopedCases} onDismiss={live.dismiss} onReview={live.review} onFeedback={live.feedback} />
  // A change saved elsewhere (another reviewer, an integration) shows up here with its alert.
  const latestVersion = [...live.alerts, ...live.cases].reduce((highest, alert) => Math.max(highest, alert.version || 0), live.snapshot?.version || 0)
  useEffect(() => {
    if (!run || latestVersion <= run.version || refreshingVersion.current === latestVersion) return
    if (lineId && employeeDirty) return
    refreshingVersion.current = latestVersion
    if (lineId) void openPaycheck(lineId).finally(() => { refreshingVersion.current = 0 })
    else setReloadDetail((value) => value + 1)
  }, [latestVersion, run, lineId, employeeDirty])
  return <div className={`tn-app${assistantAvailable && assistantOpen ? ' tn-with-assistant' : ''}`}>
    <header className="tn-header">
      <span className="tn-logo">TriNet</span><span className="tn-mock-tag">Mock</span>
      {run && live.connected && <span className="tn-live-status" title="Agent Studio checks every saved change to this payroll">
        <span className="tn-live-dot" aria-hidden="true" />Live monitoring
      </span>}
      {assistantAvailable && <button type="button" className={`tn-assistant-toggle${assistantOpen ? ' active' : ''}`}
        aria-pressed={assistantOpen} aria-controls="tn-assistant" onClick={() => setAssistantOpen((value) => !value)}>
        <i className="bi bi-chat-dots" aria-hidden="true" /><span>{assistantOpen ? 'Minimize' : 'Open'} Payroll Assistant{assistantEmployee && ` · ${assistantEmployee.name}`}</span>
      </button>}
    </header>
    <main className="tn-main">
      {run && domain && <AgentHealth domainName={domain.name} />}
      {payrunId && !adEmployee && <div className={`tn-ad-scan ${live.scan}`} role="status">
        <span className="tn-ad-scan-icon" aria-hidden="true"><i className={`bi ${live.scan === 'checked' ? 'bi-check-circle' : live.scan === 'delayed' ? 'bi-clock' : 'bi-radar'}`} /></span>
        <div><strong>{live.scan === 'checked' ? 'Latest payroll checked' : live.scan === 'delayed' ? 'Waiting for results' : 'Checking your payroll'}</strong><span>
        {live.scan === 'scanning' ? 'Jev is actively scanning for payroll issues…' : live.scan === 'waiting' ? 'Preparing payroll scan…' : live.scan === 'delayed' ? 'Scan results are delayed. Check that an anomaly agent is enabled.' : 'Payroll scan complete.'}
        </span></div>
      </div>}
      {!adEmployee && adPanel}
      {error ? <div className="tn-page"><div className="alert alert-danger">{error}</div><button type="button" className="tn-link" onClick={() => go(null)}>Back to payrolls</button></div>
        : !payrunId ? (payruns ? <PayrollList payruns={payruns} onOpen={go} /> : <Loading>Loading payrolls…</Loading>)
        : !run ? <Loading>Loading payroll…</Loading>
        : <PayrollDetail run={run} notice={notice} onDismissNotice={() => setNotice('')} onBack={() => go(null)}
            analysis={!adEmployee && live.snapshot?.version === run.version ? live.snapshot.analysis : null}
          onSelectLine={openPaycheck} />}
    </main>
    {drawerLine && <EmployeeDrawer key={`${drawerLine.lineId}-${run.version}`} line={drawerLine} run={run}
      onClose={closePaycheck} onSaved={saved} onReload={reload} onDirtyChange={setEmployeeDirty}>
      {assistantAvailable && <button type="button" className="tn-link" onClick={() => setAssistantOpen(value => !value)}>{assistantOpen ? 'Minimize employee chat' : 'Open employee chat'}</button>}
      {latestVersion > run.version && employeeDirty && <p role="status">Payroll changed elsewhere. Reload the latest data before continuing; your unsaved edits are still shown.</p>}
      {adPanel}
      {!scopedCases.length && <p className="small text-muted" role="status">{employeeChecked ? 'No review findings for this employee.' : 'Checking this employee’s latest paycheck…'}</p>}
    </EmployeeDrawer>}
    {assistantAvailable && <AgentUiTemplate key={`${domain.name}:${run.id}`} domain={domain} run={run} open={assistantOpen}
      employeeId={assistantEmployeeId}
      onEmployeeChange={(employeeId) => setAssistantSelection({ payrunId: run.id, employeeId })}
      onClose={() => setAssistantOpen(false)} />}
  </div>
}
