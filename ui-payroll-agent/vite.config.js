import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { graphqlMock } from './mock/graphqlMock.js'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')
  const target = env.API_PROXY_TARGET || 'http://127.0.0.1:4000'
  const useBackend = env.GRAPHQL_MODE !== 'mock'

  return {
    plugins: [react(), ...(useBackend ? [] : [graphqlMock()])],
    server: {
      host: '0.0.0.0',
      port: 5173,
      proxy: useBackend ? {
        '/graphql': { target, changeOrigin: true, rewrite: () => '/' },
        '/webhook': { target, changeOrigin: true },
      } : {},
    },
  }
})
