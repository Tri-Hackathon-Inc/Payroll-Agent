import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

const SEVERITY_CLASS = { critical: 'critical', warning: 'warning', info: 'info' }
const dollars = (value) => `$${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// Result of an agent-to-agent handoff: the incident the Incident Report agent created.
export default function IncidentCard({ agentName, incident }) {
  const [showReport, setShowReport] = useState(false)
  const [viewing, setViewing] = useState(null)
  const shots = incident.screenshots || {}

  // The full-size screenshot viewer closes on Esc (a click outside the image closes it too).
  useEffect(() => {
    if (!viewing) return undefined
    const onKeyDown = (event) => { if (event.key === 'Escape') { event.stopPropagation(); setViewing(null) } }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [viewing])
  const email = incident.email || {}

  function download() {
    const url = URL.createObjectURL(new Blob([incident.report], { type: 'text/markdown' }))
    const link = Object.assign(document.createElement('a'), { href: url, download: `${incident.id}.md` })
    link.click()
    URL.revokeObjectURL(url)
  }

  return <div className="tn-incident" aria-label={`Incident ${incident.id}`}>
    <div className="tn-incident-head">
      <span className={`tn-incident-severity ${SEVERITY_CLASS[incident.severity] || 'info'}`}>{incident.severity}</span>
      <span className="tn-incident-id">{incident.id}</span>
    </div>
    <div className="tn-incident-title">{incident.title}</div>
    <div className="tn-incident-meta">
      {agentName} · {dollars(incident.totalAtRisk)} at risk · written by {incident.writtenBy === 'evidence' ? 'evidence only' : incident.writtenBy}
    </div>
    <ul className="tn-incident-evidence">
      {incident.evidence.map((item) => <li key={item.id}>
        <span className="tn-incident-ev">{item.id}</span>
        <span className="flex-grow-1">
          <strong>{item.name}</strong> · {item.finding}{item.amountAtRisk != null && <> · {dollars(item.amountAtRisk)}</>}
          {item.screenshots?.length > 0 && <span className="tn-incident-shots">
            {item.screenshots.map((shot) => <button type="button" key={shot.label} onClick={() => setViewing({ ...shot, title: `${item.id} ${item.name}` })}
              title={shot.label} aria-label={`View screenshot: ${item.id} ${item.name}, ${shot.label}`}>
              <img src={shot.dataUrl} alt="" />
            </button>)}
          </span>}
        </span>
      </li>)}
    </ul>
    <div className="tn-incident-note">
      <i className="bi bi-camera me-1" aria-hidden="true" />
      {shots.taken ? `${shots.taken} screenshot${shots.taken === 1 ? '' : 's'} captured by the headless browser (read-only)` : `No screenshots: ${shots.error || 'none captured.'}`}
    </div>
    <div className={`tn-incident-email ${email.status === 'sent' ? 'sent' : 'not-sent'}`}>
      <i className={`bi ${email.status === 'sent' ? 'bi-envelope-check' : 'bi-envelope-exclamation'}`} aria-hidden="true" />
      {email.status === 'sent' ? `Emailed to ${email.to}` : `Email not sent (${email.to}): ${email.reason}`}
    </div>
    {incident.modelError && <div className="tn-incident-note">Model unavailable, report built from evidence: {incident.modelError}</div>}
    <div className="tn-incident-buttons">
      <button type="button" onClick={() => setShowReport((value) => !value)} aria-expanded={showReport}>
        <i className="bi bi-file-text" aria-hidden="true" />{showReport ? 'Hide report' : 'View report'}
      </button>
      <button type="button" onClick={download}><i className="bi bi-download" aria-hidden="true" />Download report</button>
    </div>
    {showReport && <pre className="tn-incident-report">{incident.report.replace(/\(data:image\/[^)]+\)/g, '(screenshot)')}</pre>}
    {/* Rendered at the document root so it overlays the page header, not just the panel. */}
    {viewing && createPortal(<div className="tn-shot-viewer" role="dialog" aria-label={`Screenshot: ${viewing.title}`} onMouseDown={() => setViewing(null)}>
      <figure onMouseDown={(event) => event.stopPropagation()}>
        <img src={viewing.dataUrl} alt={`${viewing.title}: ${viewing.label}`} />
        <figcaption>{viewing.title} · {viewing.label}</figcaption>
      </figure>
    </div>, document.body)}
  </div>
}
