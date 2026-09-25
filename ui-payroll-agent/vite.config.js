import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { graphqlMock } from './mock/graphqlMock.js'

// Agent Studio is one page mounted under STUDIO_BASE_PATH (default /ai_studio/). Every URL the
// app, proxies and mocks use derives from it, so plugging the UI into another host only needs
// this setting, e.g. STUDIO_BASE_PATH=/paycalendar/ai_studio/.
export const basePath = value => {
  const trimmed = String(value ?? '').trim().replace(/^\/+|\/+$/g, '')
  return trimmed ? `/${trimmed}/` : '/'
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')
  const BASE = basePath(env.STUDIO_BASE_PATH || '/ai_studio/')
  const target = env.API_PROXY_TARGET || 'http://127.0.0.1:4000'
  const useBackend = env.GRAPHQL_MODE !== 'mock'

  return {
    base: BASE,
    plugins: [react(), ...(useBackend ? [] : [graphqlMock(`${BASE}graphql`, `${BASE}webhook`)])],
    server: {
      host: '0.0.0.0',
      port: 5173,
      // Served behind nginx on the cloud-dev domain, so accept any Host header unless
      // ALLOWED_HOSTS (comma-separated) narrows it.
      allowedHosts: env.ALLOWED_HOSTS ? env.ALLOWED_HOSTS.split(',').map(host => host.trim()) : true,
      proxy: useBackend ? {
        [`${BASE}graphql`]: { target, changeOrigin: true, rewrite: () => '/' },
        [`${BASE}webhook`]: { target, changeOrigin: true, rewrite: path => path.slice(BASE.length - 1) },
        // Admin sign-in and sign-out (sets the HttpOnly admin cookie).
        [`${BASE}auth`]: { target, changeOrigin: true, rewrite: path => path.slice(BASE.length - 1) },
        // Live payroll alerts (server-sent events); the event intake is backend-internal.
        [`${BASE}events/stream`]: { target, changeOrigin: true, rewrite: path => path.slice(BASE.length - 1) },
      } : {},
    },
  }
})
