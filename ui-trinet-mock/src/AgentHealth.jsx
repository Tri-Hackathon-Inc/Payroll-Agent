import { useEffect, useState } from 'react'

export default function AgentHealth({ domainName }) {
  const [health, setHealth] = useState({ items: [], checking: true })
  useEffect(() => {
    let active = true, timer
    const controller = new AbortController()
    setHealth({ items: [], checking: true })
    async function check() {
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}agent-studio/graphql`, {
          method: 'POST', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]), headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'query AgentHealth($domainName: String!) { agentHealth(domainName: $domainName) }', variables: { domainName } }),
        })
        const body = await response.json()
        if (!response.ok || body.errors || !Array.isArray(body.data?.agentHealth?.items)) throw new Error('Health check unavailable')
        if (active) setHealth({ items: body.data.agentHealth.items, scope: body.data.agentHealth.scope })
      } catch {
        if (active) setHealth(previous => ({ ...previous, checking: false, error: true, items: previous.items.map(item => ({ ...item, status: 'not_connected', reason: 'Health check unavailable. Retrying automatically.' })) }))
      } finally { if (active) timer = setTimeout(check, 30000) }
    }
    if (domainName) void check()
    return () => { active = false; clearTimeout(timer); controller.abort() }
  }, [domainName])
  if (!health.checking && !health.error && !health.items.length) return null
  return <div className="tn-agent-health" aria-label="Agent connections" role="status">
    {health.checking && <span>Checking agent connections…</span>}
    {health.error && !health.items.length && <span className="offline"><i className="bi bi-circle-fill" aria-hidden="true" />Agents: Not connected</span>}
    {health.items.map(item => <span key={item.agentId} className={item.status === 'live' ? 'live' : 'offline'} title={`${item.reason} Checked ${new Date(item.checkedAt).toLocaleTimeString()}. ${health.scope || ''}`}>
      <i className="bi bi-circle-fill" aria-hidden="true" />{item.agentName}: {item.status === 'live' ? 'Live' : 'Not connected'}
    </span>)}
  </div>
}
