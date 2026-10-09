import { useEffect, useRef, useState } from 'react'

const STUDIO = `${import.meta.env.BASE_URL}agent-studio/`
const MANIFEST = `${STUDIO}ui-templates/manifest.json`
const STUDIO_URL = import.meta.env.VITE_AGENT_STUDIO_URL || 'http://localhost:5173/ai_studio/'
const PROTOCOL = 'agent-ui-v1'

// The host owns payroll selection and panel placement. Agent Studio owns and serves the
// Angular UI, its templates, agent discovery, conversations, and rendering at runtime.
export default function AgentUiTemplate({ domain, run, employeeId, onEmployeeChange, open, onClose }) {
  const frame = useRef(null)
  const [instance] = useState(() => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''))
  const [started, setStarted] = useState(false)
  const [entry, setEntry] = useState('')
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const latest = useRef(null)
  latest.current = { domain, run, employeeId, open, onEmployeeChange, onClose }

  function sendContext() {
    const state = latest.current
    frame.current?.contentWindow?.postMessage({ protocol: PROTOCOL, instance, type: 'context', context: {
      domain: state.domain,
      payrun: { id: state.run.id, employees: [...new Map(state.run.lines.map(line => [line.employeeId, { employeeId: line.employeeId, name: line.name }])).values()] },
      employeeId: state.employeeId || '', open: state.open, studioUrl: STUDIO_URL,
    } }, window.location.origin)
  }
  const send = useRef(sendContext)
  send.current = sendContext

  useEffect(() => { if (open) setStarted(true) }, [open])
  useEffect(() => {
    if (!started) return undefined
    const controller = new AbortController()
    let active = true
    const timeout = setTimeout(() => controller.abort(), 15000)
    setError(''); setReady(false); setEntry('')
    async function discover() {
      try {
        const response = await fetch(MANIFEST, { signal: controller.signal, cache: 'no-cache' })
        if (!response.ok) throw new Error(`Agent UI is unavailable (${response.status}).`)
        const manifest = await response.json()
        const template = manifest.templates?.find(item => item.page === 'payrun' && item.id === 'payrun-assistant')
        if (manifest.version !== 1 || template?.protocol !== PROTOCOL || template?.transport !== 'iframe' || typeof template.entry !== 'string') {
          throw new Error('Agent Studio did not publish a compatible payrun UI template.')
        }
        const manifestUrl = new URL(MANIFEST, location.origin)
        const url = new URL(template.entry, manifestUrl)
        if (url.origin !== location.origin || !url.pathname.startsWith(new URL('.', manifestUrl).pathname)) {
          throw new Error('The agent UI template must be served through the Agent Studio proxy.')
        }
        url.searchParams.set('instance', instance)
        if (active) setEntry(url.href)
      } catch (cause) {
        if (active) setError(cause.name === 'AbortError' ? 'Loading the agent UI timed out.' : cause.message)
      } finally { clearTimeout(timeout) }
    }
    discover()
    return () => { active = false; clearTimeout(timeout); controller.abort() }
  }, [started, retry, instance])

  useEffect(() => {
    if (!entry) return undefined
    const timeout = setTimeout(() => setError('The agent UI did not start. Retry loading it.'), 20000)
    function receive(event) {
      if (event.origin !== location.origin || event.source !== frame.current?.contentWindow
        || event.data?.protocol !== PROTOCOL || event.data.instance !== instance) return
      if (event.data.type === 'ready') { clearTimeout(timeout); setError(''); setReady(true); send.current() }
      if (event.data.type === 'close') latest.current.onClose()
      if (event.data.type === 'employee-change') {
        const id = event.data.employeeId
        if (id === '' || latest.current.run.lines.some(line => line.employeeId === id)) latest.current.onEmployeeChange(id)
      }
    }
    window.addEventListener('message', receive)
    return () => { clearTimeout(timeout); window.removeEventListener('message', receive) }
  }, [entry, instance])
  useEffect(() => { if (ready) send.current() }, [domain, run, employeeId, open, ready])

  return <aside id="tn-assistant" className="tn-agent-host" aria-label="Payroll assistant host" hidden={!open}>
    {(!ready || error) && <div className="tn-agent-host-status">
      <button type="button" className="tn-icon-btn float-end" onClick={onClose} aria-label="Close assistant"><i className="bi bi-x-lg" aria-hidden="true" /></button>
      {error ? <><p role="alert">{error}</p><button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => setRetry(value => value + 1)}>Retry agent UI</button></>
        : <p role="status">Loading Payroll Assistant…</p>}
    </div>}
    {entry && <iframe ref={frame} src={entry} title="Payroll Assistant" hidden={!ready || Boolean(error)} onLoad={() => send.current()} />}
  </aside>
}
