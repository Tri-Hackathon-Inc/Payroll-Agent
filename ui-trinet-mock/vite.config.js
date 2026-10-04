import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Temporary mock of the TriNet payroll UI, served separately from Agent Studio. It calls two
// backends, as the real TriNet UI would once the agent is embedded:
//   <BASE>graphql         -> mock TriNet payroll GraphQL API (backend/trinet_mock)
//   <BASE>agent-studio/*  -> Agent Studio's API and runtime Angular UI templates
const BASE = '/trinet/'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')
  const trinetTarget = env.TRINET_API_TARGET || 'http://127.0.0.1:4100'
  // Agent Studio's dev server proxies its API to Apollo (or serves its in-memory mock), so
  // pointing here works in both of Agent Studio's GraphQL modes.
  const agentStudio = new URL(env.AGENT_STUDIO_TARGET || 'http://127.0.0.1:5173/ai_studio/')
  const agentStudioPrefix = `${BASE}agent-studio`

  return {
    base: BASE,
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: 5174,
      allowedHosts: env.ALLOWED_HOSTS ? env.ALLOWED_HOSTS.split(',').map(host => host.trim()) : true,
      proxy: {
        [`${BASE}graphql`]: { target: trinetTarget, changeOrigin: true, rewrite: () => '/' },
        [agentStudioPrefix]: {
          target: agentStudio.origin,
          changeOrigin: true,
          rewrite: path => agentStudio.pathname.replace(/\/$/, '') + path.slice(agentStudioPrefix.length),
        },
      },
    },
  }
})
