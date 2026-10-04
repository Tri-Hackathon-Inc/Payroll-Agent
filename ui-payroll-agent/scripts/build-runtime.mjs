import { spawnSync } from 'node:child_process';

export function buildRuntime() {
  const result = spawnSync(process.execPath, ['node_modules/@angular/cli/bin/ng.js', 'build', 'agent-runtime'], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Agent UI template build failed.');
}
