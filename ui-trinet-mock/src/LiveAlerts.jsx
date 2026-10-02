import { useEffect, useRef, useState } from 'react'
import AgentHandoff from './AgentHandoff'
import IncidentCard from './IncidentCard'

// Jev flags findings; only the user's Review action authorizes investigation.
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
  const latest = [...records.values()].filter(item => item.version === latestVersion)
  // Rechecks can create a new case ID. Keep only the newest check per agent and
  // employee scope so detection and Review do not appear as duplicate cards.
  return latest.filter(item => !latest.some(other => other.id !== item.id && other.agentId === item.agentId &&
    (other.scope || null) === (item.scope || null) && Date.parse(other.createdAt) > Date.parse(item.createdAt)))
}

export function useLiveAlerts(domainName, payrunId, version) {
  const [scan, setScan] = useState('waiting')
  const currentVersion = useRef(version)
  currentVersion.current = version
  useEffect(() => {
    setScan('waiting')
    const timer = setTimeout(() => setScan(current => ['waiting', 'scanning'].includes(current) ? 'delayed' : current), 30000)
    return () => clearTimeout(timer)
  }, [domainName, payrunId, version])
  const [alerts, setAlerts] = useState([])
  const [cases, setCases] = useState([])
  const [connected, setConnected] = useState(false)
  const [snapshot, setSnapshot] = useState(null)
  const scope = `${domainName}:${payrunId}`
  const activeScope = useRef(scope)
  activeScope.current = scope
  const requests = useRef(new Set())
  const feedbackRequests = useRef(new Map())
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
        if (items.some(item => item.version === currentVersion.current)) setScan('checked')
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
          if (event.type === 'scanning') { setScan('scanning'); return }
          if (event.type === 'checked') setScan('checked')
          const alert = { ...event, scope, key: `${Date.now()}-${Math.random()}` }
          if (alert.analysis && !event.scope && !alert.analysis.employeeId) setSnapshot(current => !current || alert.version >= current.version ? alert : current)
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

  async function feedback(item, action, note = '') {
    if (requests.current.has(item.id) || item.reviewStatus === 'investigating' || (action === 'CONFIRMED' && item.reviewStatus !== 'completed')) return
    requests.current.add(item.id)
    const requestScope = scope
    const key = JSON.stringify([item.id, action, note])
    if (!feedbackRequests.current.has(key)) feedbackRequests.current.set(key, crypto.randomUUID())
    setCases(current => current.map(value => value.id === item.id ? { ...value, savingFeedback: true, reviewError: '' } : value))
    try {
      const response = await fetch(`${API}/anomalies/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domainName, agentId: item.agentId, anomalyId: item.id, expectedVersion: item.version,
          action, note, requestId: feedbackRequests.current.get(key) }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.message || 'Feedback could not be saved. Try again.')
      if (activeScope.current !== requestScope) return
      if (result.domainName !== domainName || result.payrunId !== payrunId || result.id !== item.id) throw new Error('Feedback returned a different review.')
      setCases(current => mergeCases(current, [{ ...result, savingFeedback: false, reviewError: '' }], true))
    } catch (error) {
      if (activeScope.current === requestScope) setCases(current => current.map(value => value.id === item.id ? { ...value, savingFeedback: false, reviewError: error.message } : value))
    } finally { requests.current.delete(item.id) }
  }

  const dismiss = key => setAlerts(current => current.filter(item => item.key !== key))
  return { alerts: alerts.filter(item => item.scope === scope), cases: cases.filter(item => item.domainName === domainName && item.payrunId === payrunId && item.decision !== 'NORMAL'),
    checks: cases, connected, scan, dismiss, review, feedback, snapshot: snapshot?.scope === scope ? snapshot : null }
}

function affectedEmployees(item) {
  const groups = new Map()
  for (const finding of item.findings || []) {
    if (!finding.employeeId || !['warning', 'critical'].includes(finding.severity)) continue
    const group = groups.get(finding.employeeId) || { id: finding.employeeId, name: finding.employeeName || finding.name || finding.employeeId, specific: new Set(), other: new Set() }
    const code = (finding.code || finding.kind || '').toLowerCase()
    const issue = /duplicate|multiple_lines/.test(code) ? 'Possible duplicate payment'
      : /termination|terminated/.test(code) ? 'Payment after termination'
      : /withholding/.test(code) ? 'No tax withholding'
      : /bonus/.test(code) ? 'Unusual bonus'
      : /overtime/.test(code) ? 'Unusual overtime'
      : /reimbursement/.test(code) ? 'Unusual reimbursement'
      : /health.*missing/.test(code) ? 'Missing health deduction' : null
    if (issue) group.specific.add(issue)
    else group.other.add(finding.label || finding.kind || 'Pay changed')
    groups.set(finding.employeeId, group)
  }
  return [...groups.values()].map(group => ({ ...group, issues: [...(group.specific.size ? group.specific : group.other)].slice(0, 2).join('; ') }))
}

function findingSummary(alert) {
  const employee = alert.changedEmployee
  if (!employee) return 'The payrun was checked.'
  const who = `${employee.employeeId}${employee.name ? ` ${employee.name}` : ''}`
  if (!employee.findings.length) return `No issues found for ${who}.`
  return `${who}: ${employee.findings.map((finding) => `${finding.kind} (${finding.severity})`).join(', ')}.`
}

function ReviewCase({ item, onReview, onFeedback }) {
  const [dismissNote, setDismissNote] = useState('')
  const [dismissing, setDismissing] = useState(false)
  const dismissed = item.feedback?.action === 'DISMISSED'
  const investigating = item.reviewing || item.reviewStatus === 'investigating'
  const investigation = item.investigation
  const partial = investigation?.modelStatus === 'partial_response'
  const employees = affectedEmployees(item)
  const legacyBackupBilling = investigation?.modelRoute?.provider === 'openrouter'
    && investigation?.modelRoute?.fallback && investigation?.reason?.startsWith('The model account has no inference credits.')
  const failureReason = legacyBackupBilling
    ? `${investigation.modelRoute.reason === 'invalid_response' ? 'The primary model answered, but its response failed validation. ' : ''}The OpenRouter backup reported payment required. Check OpenRouter API billing before retrying Review. This error does not describe your Hugging Face balance.`
    : investigation?.reason === 'The model could not complete the investigation. Showing calculated evidence only.'
    ? 'The investigation failed, but this saved attempt did not record the provider cause. Select Review to retry. Calculated findings remain available; no AI explanation was produced.'
    : investigation?.reason
  const critical = item.decision === 'CRITICAL' || item.severity === 'critical'
  return <article className={`tn-live-alert ${dismissed ? 'checked' : critical ? 'critical' : 'warning'}`} aria-label={`${item.agentName}: ${dismissed ? 'Dismissed' : critical ? 'Critical' : 'Needs review'}`}>
    <div className="fw-semibold">{dismissed ? 'Dismissed by reviewer' : item.scope ? 'Employee review' : 'Payrun review'}</div>
    <div className="tn-meta">{item.agentName} · Version {item.version}</div>
    {investigating && <div role="status"><span className="spinner-border spinner-border-sm me-2" />Investigating flagged findings…</div>}
    {investigation ? <div className="tn-review-investigation">
      <div className="fw-semibold">{partial ? 'Partial conclusion — more review needed' : investigation.modelStatus === 'completed' ? 'Investigation conclusion' : 'No investigation conclusion yet'}</div>
      <p className="mb-1">{investigation.modelStatus === 'completed' || partial ? (investigation.summary.length > 320 ? investigation.summary.slice(0, 317) + '…' : investigation.summary) : 'Investigation incomplete. Download the report for supporting data.'}</p>
      {investigation.reason && item.reviewStatus !== 'failed' && <p className="small text-muted mb-1">{investigation.reason}</p>}
    </div> : !dismissed && !investigating && <p className="mb-1">{employees.length ? `${employees.length} employee${employees.length === 1 ? '' : 's'} flagged. Select Review to investigate.` : 'Payroll checks need review.'}</p>}
    {!dismissed && employees.length > 0 && <ul className="small my-2" aria-label="Employees needing review">{employees.map(employee => <li key={employee.id}><strong>{employee.name}</strong>: {employee.issues}</li>)}</ul>}
    {partial && <p className="small mb-1">Some findings still need manual review. See the report for coverage.</p>}
    <button type="button" className="btn btn-sm btn-outline-secondary mt-2 me-2" onClick={() => downloadInvestigation(item)}>Download Report</button>
    {item.reviewStatus === 'completed' && !dismissed && <AgentHandoff item={item} />}
    {item.reviewStatus !== 'completed' && !dismissed && <button type="button" className="btn btn-sm btn-primary mt-2" onClick={() => onReview(item)} disabled={investigating}>
      {investigating ? 'Investigating...' : 'Review'}
    </button>}
    {item.reviewStatus !== 'completed' && !item.feedback && <button type="button" className="btn btn-sm btn-outline-secondary mt-2 ms-2" disabled={investigating || item.savingFeedback} onClick={() => setDismissing(!dismissing)}>Dismiss as expected</button>}
    {dismissing && !item.feedback && <div className="mt-2">
      <label className="small">Why are these payments expected?
        <textarea className="form-control" value={dismissNote} maxLength={2000} onChange={event => setDismissNote(event.target.value)} />
      </label>
      <div className="small">This dismisses this version's review flags and records your reason. Payroll data is unchanged.</div>
      <button type="button" className="btn btn-sm btn-secondary" disabled={!dismissNote.trim() || item.savingFeedback} onClick={() => onFeedback(item, 'DISMISSED', dismissNote.trim())}>Confirm dismissal</button>
    </div>}
    {item.reviewStatus === 'completed' && !item.feedback && <div className="d-flex gap-2 mt-2">
      <button type="button" className="btn btn-sm btn-outline-primary" disabled={item.savingFeedback} onClick={() => onFeedback(item, 'CONFIRMED')}>Confirm finding</button>
      <button type="button" className="btn btn-sm btn-outline-secondary" disabled={item.savingFeedback} onClick={() => onFeedback(item, 'DISMISSED')}>Dismiss finding</button>
    </div>}
    {item.feedback && <div className="small mt-1">Feedback saved: {item.feedback.action === 'CONFIRMED' ? 'finding confirmed' : 'finding dismissed'}</div>}
    {item.feedback?.note && <div className="small">Reason: {item.feedback.note}</div>}
    {item.reviewError && <div className="small text-danger mt-1" role="alert">{item.reviewError}</div>}
    {item.reviewStatus === 'failed' && !item.reviewError && <div className="small text-danger mt-1" role="alert">{failureReason || 'Investigation could not complete. Select Review to retry.'}</div>}
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

function downloadInvestigation(item) {
  const investigation = item.investigation
  const explanations = new Map((investigation?.findings || []).map(finding => [finding.findingId || finding.id, finding]))
  const label = key => key.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ')
  function dataLines(value, prefix = '') {
    if (value === null || value === undefined) return [prefix + ': Not available']
    if (typeof value !== 'object') return [prefix + ': ' + String(value)]
    return Object.entries(value).flatMap(([key, child]) => dataLines(child, prefix ? `${prefix} / ${label(key)}` : label(key)))
  }
  const lines = ['PAYROLL INVESTIGATION REPORT', '', `Agent: ${item.agentName}`, `Payroll: ${item.payrunId}`, `Data version: ${item.version}`,
    `Scope: ${item.scope ? 'Employee ' + item.scope : 'Whole payrun'}`, '', 'CONCLUSION',
    investigation?.modelStatus === 'completed' ? 'Investigation complete.' : 'Investigation incomplete. Some findings still need review.',
    ['completed', 'partial_response'].includes(investigation?.modelStatus) ? investigation.summary : 'No validated AI conclusion is available. Use the calculated findings below.',
    investigation?.reason || '', '', 'WHAT WAS FLAGGED', item.adminSummary?.summary || item.summary,
    'Flags indicate possible issues. They do not establish an error or an unauthorized payment.', '', 'DATA, EXPLANATIONS AND NEXT STEPS']
  for (const [index, finding] of (item.findings || []).entries()) {
    const explanation = explanations.get(finding.id)
    lines.push('', `${index + 1}. ${finding.label || finding.kind}`, `Employee: ${finding.employeeName || finding.name || finding.employeeId || 'Payrun-level check'}`,
      'Data checked:', ...dataLines(finding.evidence || {}, '  Evidence'),
      `Agent explanation: ${explanation?.explanation || 'The model did not explain this finding. Manual review is needed.'}`,
      `Recommended next step: ${explanation?.reviewAction || 'Compare this finding with approved payroll records.'}`)
  }
  lines.push('', 'SOURCE RECORDS', 'These are the records supplied to the investigation. Citations support the overall answer; they are not individual finding-to-source links.')
  for (const source of investigation?.evidence || []) lines.push(`- Payroll ${source.payrunId || 'not recorded'}; pay date ${source.payDate || 'not recorded'}; ${source.employeeId ? 'employee ' + source.employeeId : 'payrun scope'}; ${source.cited ? 'cited by the model' : 'supplied as evidence'}. Reference: ${source.id}`)
  lines.push('', 'LIMITATIONS', ...(item.adminSummary?.limitations || ['No additional coverage information recorded.']), '', 'REVIEWER DECISION',
    item.feedback ? `${item.feedback.action === 'DISMISSED' ? 'Dismissed as expected' : 'Finding confirmed'}: ${item.feedback.note || 'No note supplied.'}` : 'No reviewer decision recorded.',
    '', 'This report does not change payroll or approve payments.')
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url; link.download = `payroll-investigation-${item.version}-${item.id.slice(0, 12)}.txt`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function LiveAlerts({ alerts, cases, onDismiss, onReview, onFeedback }) {
  const [minimized, setMinimized] = useState(false)
  if (!alerts.length && !cases.length) return null
  return <div className="tn-live-alerts" style={{ position: 'static', width: 'auto', maxHeight: 'none', margin: '16px 24px' }} aria-live="polite">
    <div className="d-flex justify-content-between align-items-center"><strong>AD agent {minimized && `· ${cases.length} review case(s)`}</strong>
      <button type="button" className="btn btn-sm btn-outline-secondary" aria-expanded={!minimized} onClick={() => setMinimized(value => !value)}>{minimized ? 'Expand AD agent' : 'Minimize AD agent'}</button>
    </div>
    <div hidden={minimized}>
    {cases.map(item => <ReviewCase key={item.id} item={item} onReview={onReview} onFeedback={onFeedback} />)}
    {alerts.map((alert) => <Alert key={alert.key} alert={alert} onDismiss={() => onDismiss(alert.key)} />)}
    </div>
  </div>
}
