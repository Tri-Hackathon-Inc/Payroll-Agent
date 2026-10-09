// Serve the built payroll UI for browser tests without platform-specific bundler dependencies.
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../ui-trinet-mock/dist/', import.meta.url))
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff' }
http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
    const target = path.resolve(root, pathname.replace(/^\/trinet\//, '') || 'index.html')
    if (!target.startsWith(path.resolve(root)+path.sep)) { response.writeHead(404); return response.end() }
    const content = await readFile(target)
    response.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream' })
    response.end(content)
  } catch { response.writeHead(404); response.end() }
}).listen(5181, '127.0.0.1')
