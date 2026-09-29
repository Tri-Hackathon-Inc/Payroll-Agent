import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { BASE } from './settings.mjs';
import { startMockServer } from '../mock/server.mjs';
import { prepare } from './prepare.mjs';
import { buildRuntime } from './build-runtime.mjs';

buildRuntime();
prepare();

const mock = process.env.GRAPHQL_MODE === 'mock' ? await startMockServer() : null;
const target = mock ? `http://127.0.0.1:${mock.address().port}` : process.env.API_PROXY_TARGET || 'http://127.0.0.1:4000';
const rewrite = Object.fromEntries([['graphql', '/'], ['webhook', '/webhook'], ['auth', '/auth'], ['agents', '/agents'], ['events/stream', '/events/stream']]
  .map(([part, dest]) => [`${BASE}${part}`, { target, secure: false, changeOrigin: true,
    pathRewrite: { [`^${BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${part}`]: dest } }]));
mkdirSync('.angular', { recursive: true });
const proxy = `.angular/proxy-${process.pid}.json`;
writeFileSync(proxy, JSON.stringify(rewrite));
const args = process.argv.slice(2).filter(arg => arg !== '--strictPort');
const defaults = [...(args.includes('--host') ? [] : ['--host', '0.0.0.0']), ...(args.includes('--port') ? [] : ['--port', '5173'])];
if (process.env.ALLOWED_HOSTS) defaults.push('--allowed-hosts', ...process.env.ALLOWED_HOSTS.split(',').map(host => host.trim()).filter(Boolean));
const child = spawn(process.execPath, ['node_modules/@angular/cli/bin/ng.js', 'serve', 'studio', ...defaults,
  '--serve-path', BASE, '--proxy-config', proxy, ...args], { stdio: 'inherit' });
function cleanup() { mock?.close(); rmSync(proxy, { force: true }); }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(signal); });
child.on('exit', code => { cleanup(); process.exitCode = code ?? 1; });
child.on('error', error => { console.error(error); cleanup(); process.exitCode = 1; });
