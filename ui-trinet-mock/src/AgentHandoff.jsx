import { useEffect, useState } from 'react'

const API = `${import.meta.env.BASE_URL}agent-studio`

export default function AgentHandoff({ item }) {
  const [agents, setAgents] = useState([])
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [discovered, setDiscovered] = useState(false)
  const { id, agentId, domainName, version } = item
  async function request(action, targetAgentId, signal) {
    const response = await fetch(`${API}/agent-messages`, { method: 'POST', signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, domainName, agentId, targetAgentId,
        capability: 'incident-report', responseType: 'anomaly-investigation', responseId: id, expectedVersion: version }) })
    if (!response.headers.get('content-type')?.includes('application/json')) {
      throw new Error('Incident agent endpoint is unavailable. Check the Agent Studio proxy connection.')
    }
    const value = await response.json()
    if (!response.ok) throw new Error(value.message || 'Agent handoff unavailable.')
    return value
  }
  useEffect(() => {
    const controller = new AbortController()
    request('DISCOVER', undefined, controller.signal).then(value => {
      setAgents(value.agents)
      setTarget(value.agents[0]?.id || '')
      setDiscovered(true)
    }).catch(error => { if (error.name !== 'AbortError') setError(error.message || 'Incident agent discovery is unavailable. Reload to retry.') })
    return () => controller.abort()
  }, [id, agentId, domainName, version])
  async function send() {
    setBusy(true)
    setError('')
    try {
      const value = await request('SEND', target)
      setResult(value)
      if (value.status === 'failed') setError(value.result?.message || 'Report creation failed.')
    } catch (error) { setError(error.message) }
    finally { setBusy(false) }
  }
  function download() {
    const report = result.result.incident
    const url = URL.createObjectURL(new Blob([report.report], { type: 'text/markdown;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `${report.id}.md`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <div className="tn-ad-handoff">
    {agents.length > 1 && !result && <label className="small">Incident Report agent
      <select className="form-select form-select-sm" value={target} onChange={event => setTarget(event.target.value)} disabled={busy}>
        {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
      </select>
    </label>}
    {discovered && !result && <button className="btn btn-sm btn-outline-primary" disabled={busy || !target} onClick={send}>
      <i className="bi bi-file-earmark-plus me-2" aria-hidden="true" />
      {busy ? 'Recreating incident and capturing snapshots…' : 'Report to Incident Agent'}
    </button>}
    {discovered && agents.length === 0 && <p className="small text-muted">Attach an Incident Report agent to this service in My Agents to enable reporting.</p>}
    {result?.status === 'completed' && <div role="status">Incident report created.
      <button className="btn btn-sm btn-link" onClick={download}>Download incident report</button>
      {result.result.artifacts && <div className="small text-muted">Saved {result.result.artifacts.snapshotCount} snapshots with the report in <code>.local-data/{result.result.artifacts.folder}</code>.</div>}
      {result.result.incident?.screenshots?.error && <p className="small text-warning">{result.result.incident.screenshots.error} The available evidence and report were saved.</p>}
    </div>}
    {result?.status === 'processing' && <p role="status" className="small">Report creation is already in progress. Reload and select Report to Incident Agent to retrieve it.</p>}
    {error && <p role="alert" className="small text-danger">{error}</p>}
  </div>
}
