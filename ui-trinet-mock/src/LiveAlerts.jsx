import { useEffect, useRef, useState } from 'react'
import IncidentCard from './IncidentCard'

// Detection results arrive over SSE; only the Review button requests investigation.
const API = `${import.meta.env.BASE_URL}agent-studio`
const CHECK_TOAST_MS = 10000
const MAX_ALERTS = 4
const statusOrder = { pending: 0, investigating: 1, failed: 2, completed: 3 }

function mergeCases(current, incoming, force = false) {
  const records = new Map(current.map(item => [item.id, item]))
  for (const item of incoming) {
    const previous = records.get(item.id)
    if (!previous || item.version > previous.version || (item.version === previous.version &&
      (force || statusOrder[item.reviewStatus] >= statusOrder[previous.reviewStatus]))) {
      records.set(item.id, { ...previous, ...item })
    }
  }
  // Payroll versions cover the whole run. Any newer saved check supersedes older
  // cases, including when the new result is NORMAL. Same-version checks coexist.
  const latestVersion = Math.max(0, ...[...records.values()].map(item => item.version))
  return [...records.values()].filter(item => item.version === latestVersion)
}

export function useLiveAlerts(domainName, payrunId) {
  const [alerts, setAlerts] = useState([])
  const [cases, setCases] = useState([])
  const [connected, setConnected] = useState(false)
  const [snapshot, setSnapshot] = useState(null)
  const scope = `${domainName}:${payrunId}`
  const activeScope = useRef(scope)
  activeScope.current = scope
  const requests = useRef(new Set())
  const reloadCases = useRef(null)
  useEffect(() => {
    setAlerts([])
    setCases([])
    setSnapshot(null)
    setConnected(false)
    if (!domainName || !payrunId) return undefined
    let active = true
    let poll
    let loading = false
    const controller = new AbortController()
    const belongsHere = item => item.domainName === domainName && item.payrunId === payrunId
    async function loadCases() {
      if (loading || !active) return
      loading = true
      try {
        const response = await fetch(`${API}/anomalies?${new URLSearchParams({ domain: domainName, payrunId })}`, { signal: controller.signal })
        if (!response.ok) throw new Error('Review list is unavailable.')
        const body = await response.json()
        if (!active) return
        const items = (body.items || []).filter(belongsHere)
        setCases(current => mergeCases(current, items))
        setAlerts(current => current.filter(item => item.key !== 'review-list-error'))
        clearTimeout(poll)
        if (items.some(item => item.reviewStatus === 'investigating')) poll = setTimeout(loadCases, 3000)
      } catch (error) {
        if (!active || error.name === 'AbortError') return
        setAlerts(current => [{ key: 'review-list-error', scope, type: 'error', monitor: { name: 'Anomaly review' },
          message: 'Could not load saved reviews. Reconnecting will retry.' }, ...current.filter(item => item.key !== 'review-list-error')].slice(0, MAX_ALERTS))
      } finally { loading = false }
    }
    reloadCases.current = loadCases
    // Load even when SSE is unavailable. Reconnects also recover missed saved cases.
    loadCases()
    const source = typeof EventSource === 'undefined' ? null : new EventSource(`${API}/events/stream?${new URLSearchParams({ domain: domainName, payrunId })}`)
    if (source) {
      source.onopen = () => { if (active) { setConnected(true); loadCases() } }
      source.onerror = () => { if (active) setConnected(false) }
      source.addEventListener('payroll', (message) => {
        try {
          if (!active) return
          const event = JSON.parse(message.data)
          if ((event.domainName && event.domainName !== domainName) || (event.payrunId && event.payrunId !== payrunId)) return
          const alert = { ...event, scope, key: `${Date.now()}-${Math.random()}` }
          if (alert.analysis) setSnapshot(current => !current || alert.version >= current.version ? alert : current)
          if (alert.anomaly && belongsHere(alert.anomaly)) setCases(current => mergeCases(current, [alert.anomaly]))
          if (!alert.anomaly || alert.anomaly.decision === 'NORMAL') setAlerts(current => [alert, ...current].slice(0, MAX_ALERTS))
        } catch { /* A malformed event is ignored. */ }
      })
    }
    return () => {
      active = false
      controller.abort()
      clearTimeout(poll)
      source?.close()
      reloadCases.current = null
    }
  }, [domainName, payrunId, scope])

  async function review(item) {
    if (requests.current.has(item.id) || item.reviewStatus === 'investigating' || item.reviewStatus === 'completed') return
    requests.current.add(item.id)
    const requestScope = scope
    setCases(current => current.map(value => value.id === item.id ? { ...value, reviewing: true, reviewError: '' } : value))
    try {
      const response = await fetch(`${API}/anomalies/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domainName, agentId: item.agentId, anomalyId: item.id, action: 'REVIEW', expectedVersion: item.version }) })
      const result = await response.json()
      if (!response.ok) {
        if (response.status === 409 && activeScope.current === requestScope) reloadCases.current?.()
        throw new Error(response.status === 409 ? 'This review changed. The latest saved reviews have been refreshed.' : result.error || result.message || 'Investigation could not complete. Try Review again.')
      }
      if (activeScope.current !== requestScope) return
      if (result.domainName !== domainName || result.payrunId !== payrunId || result.id !== item.id) throw new Error('The investigation returned a different review.')
      setCases(current => mergeCases(current, [{ ...result, reviewing: false, reviewError: '' }], true))
      if (result.reviewStatus === 'investigating') reloadCases.current?.()
    } catch (error) {
      if (activeScope.current === requestScope) setCases(current => current.map(value => value.id === item.id ? { ...value, reviewing: false, reviewError: error.message } : value))
    } finally { requests.current.delete(item.id) }
  }

  const dismiss = key => setAlerts(current => current.filter(item => item.key !== key))
  return { alerts: alerts.filter(item => item.scope === scope), cases: cases.filter(item => item.domainName === domainName && item.payrunId === payrunId && item.decision !== 'NORMAL'),
    connected, dismiss, review, snapshot: snapshot?.scope === scope ? snapshot : null }
}

function findingSummary(alert) {
  const employee = alert.changedEmployee
  if (!employee) return 'The payrun was checked.'
  const who = `${employee.employeeId}${employee.name ? ` ${employee.name}` : ''}`
  if (!employee.findings.length) return `No issues found for ${who}.`
  return `${who}: ${employee.findings.map((finding) => `${finding.kind} (${finding.severity})`).join(', ')}.`
}

function ReviewCase({ item, onReview }) {
  const investigating = item.reviewing || item.reviewStatus === 'investigating'
  const investigation = item.investigation
  return <article className={`tn-live-alert ${item.decision === 'CRITICAL' ? 'critical' : 'warning'}`} aria-label={`${item.agentName}: ${item.decision === 'CRITICAL' ? 'Critical' : 'Needs review'}`}>
    <div className="fw-semibold">{item.decision === 'CRITICAL' ? 'Critical - Needs review' : 'Needs review'}</div>
    <div className="tn-meta">{item.agentName} - Payroll version {item.version}</div>
    <p className="mb-1">{item.summary}</p>
    {investigation ? <div className="tn-review-investigation">
      <div className="fw-semibold">{investigation.modelStatus === 'completed' ? 'Investigation' : 'Calculated review'}</div>
      <p className="mb-1">{investigation.summary}</p>
      {investigation.reason && <p className="small text-muted mb-1">{investigation.reason}</p>}
    </div> : <div className="small text-muted">Select Review to ask this agent to investigate.</div>}
    {(item.findings?.length > 0 || investigation?.evidence?.length > 0) && <details className="tn-review-evidence">
      <summary>Findings and evidence</summary>
      <ul>{(investigation?.findings?.length ? investigation.findings : item.findings || []).map((finding, index) => <li key={finding.id || index}>
        {[finding.employeeId, finding.label || finding.kind, finding.explanation].filter(Boolean).join(': ')}
      </li>)}</ul>
      {investigation?.evidence?.length > 0 && <ul>{investigation.evidence.map((source, index) => <li key={source.id || index}>
        <span className="fw-semibold">{source.id}</span>{source.payrunId && ` - ${source.payrunId}`}{source.employeeId && ` - ${source.employeeId}`}
      </li>)}</ul>}
    </details>}
    {item.reviewStatus !== 'completed' && <button type="button" className="btn btn-sm btn-primary mt-2" onClick={() => onReview(item)} disabled={investigating}>
      {investigating ? 'Investigating...' : 'Review'}
    </button>}
    {item.reviewStatus === 'completed' && <div className="small text-muted mt-1">Investigation complete</div>}
    {item.reviewError && <div className="small text-danger mt-1" role="alert">{item.reviewError}</div>}
    {item.reviewStatus === 'failed' && !item.reviewError && <div className="small text-danger mt-1" role="alert">Investigation could not complete. Select Review to retry.</div>}
  </article>
}

function Alert({ alert, onDismiss }) {
  const [open, setOpen] = useState(false)
  // Confirmations clear themselves; incidents and errors stay until dismissed. The ref keeps the
  // timer from restarting when newer alerts re-render the list.
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss
  useEffect(() => {
    if (alert.type !== 'checked') return undefined
    const timer = setTimeout(() => dismiss.current(), CHECK_TOAST_MS)
    return () => clearTimeout(timer)
  }, [alert.type, alert.key])

  if (alert.type === 'incident') {
    const incident = alert.raised.incident
    return <div className="tn-live-alert critical" role="alert">
      <div className="d-flex align-items-start gap-2">
        <i className="bi bi-exclamation-octagon-fill" aria-hidden="true" />
        <div className="flex-grow-1">
          <div className="fw-semibold">{alert.monitor.name} raised {incident?.id || 'an incident'} automatically</div>
          <div className="small">{alert.raised.findings.length} new critical finding{alert.raised.findings.length === 1 ? '' : 's'} after: {alert.reason}. {findingSummary(alert)}</div>
          <button type="button" className="tn-live-link" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
            {open ? 'Hide incident' : 'View incident'}
          </button>
        </div>
        <button type="button" className="tn-live-close" aria-label="Dismiss alert" onClick={onDismiss}><i className="bi bi-x-lg" /></button>
      </div>
      {open && incident && <div className="mt-2"><IncidentCard agentName={alert.raised.agent.name} incident={incident} /></div>}
    </div>
  }
  if (alert.type === 'error') {
    return <div className="tn-live-alert warning" role="alert">
      <div className="d-flex align-items-start gap-2">
        <i className="bi bi-exclamation-triangle" aria-hidden="true" />
        <div className="flex-grow-1 small">{alert.monitor.name}: {alert.message}</div>
        <button type="button" className="tn-live-close" aria-label="Dismiss alert" onClick={onDismiss}><i className="bi bi-x-lg" /></button>
      </div>
    </div>
  }
  return <div className="tn-live-alert checked" role="status">
    <div className="d-flex align-items-start gap-2">
      <i className="bi bi-shield-check" aria-hidden="true" />
      <div className="flex-grow-1 small">
        <span className="fw-semibold">{alert.monitor.name} checked your change.</span> {findingSummary(alert)}
        {alert.alreadyRaised > 0 && ` ${alert.alreadyRaised} critical finding${alert.alreadyRaised === 1 ? ' was' : 's were'} already raised as an incident.`}
        {alert.note && ` ${alert.note}`}
      </div>
      <button type="button" className="tn-live-close" aria-label="Dismiss" onClick={onDismiss}><i className="bi bi-x-lg" /></button>
    </div>
  </div>
}

export default function LiveAlerts({ alerts, cases, onDismiss, onReview }) {
  if (!alerts.length && !cases.length) return null
  return <div className="tn-live-alerts" aria-live="polite">
    {cases.map(item => <ReviewCase key={item.id} item={item} onReview={onReview} />)}
    {alerts.map((alert) => <Alert key={alert.key} alert={alert} onDismiss={() => onDismiss(alert.key)} />)}
  </div>
}
