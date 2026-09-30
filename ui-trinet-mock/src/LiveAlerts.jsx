import { useEffect, useRef, useState } from 'react'
import IncidentCard from './IncidentCard'

// Real-time anomaly detection on the payrun page: Agent Studio checks every saved change
// (backend/runtime/events.py) and pushes the result here over server-sent events.
const STREAM = `${import.meta.env.BASE_URL}agent-studio/events/stream`
const CHECK_TOAST_MS = 10000
const MAX_ALERTS = 4

export function useLiveAlerts(domainName, payrunId) {
  const [alerts, setAlerts] = useState([])
  const [connected, setConnected] = useState(false)
  const [snapshot, setSnapshot] = useState(null)
  useEffect(() => {
    if (!domainName || !payrunId || typeof EventSource === 'undefined') return undefined
    const source = new EventSource(`${STREAM}?${new URLSearchParams({ domain: domainName, payrunId })}`)
    source.onopen = () => setConnected(true)
    source.onerror = () => setConnected(false) // EventSource reconnects by itself.
    source.addEventListener('payroll', (message) => {
      try {
        const alert = { ...JSON.parse(message.data), key: `${Date.now()}-${Math.random()}` }
        if (alert.analysis) setSnapshot(current => !current || alert.version >= current.version ? alert : current)
        setAlerts((current) => [alert, ...current].slice(0, MAX_ALERTS))
      } catch { /* A malformed event is ignored. */ }
    })
    return () => { source.close(); setConnected(false); setAlerts([]); setSnapshot(null) }
  }, [domainName, payrunId])
  const dismiss = (key) => setAlerts((current) => current.filter((item) => item.key !== key))
  return { alerts, connected, dismiss, snapshot }
}

function findingSummary(alert) {
  const employee = alert.changedEmployee
  if (!employee) return 'The payrun was checked.'
  const who = `${employee.employeeId}${employee.name ? ` ${employee.name}` : ''}`
  if (!employee.findings.length) return `No issues found for ${who}.`
  return `${who}: ${employee.findings.map((finding) => `${finding.kind} (${finding.severity})`).join(', ')}.`
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

export default function LiveAlerts({ alerts, onDismiss }) {
  if (!alerts.length) return null
  return <div className="tn-live-alerts" aria-live="polite">
    {alerts.map((alert) => <Alert key={alert.key} alert={alert} onDismiss={() => onDismiss(alert.key)} />)}
  </div>
}
