import { spawnSync } from 'node:child_process';
import { BASE } from './settings.mjs';
import { prepare } from './prepare.mjs';
import { buildRuntime } from './build-runtime.mjs';
buildRuntime();
prepare();
const result = spawnSync(process.execPath, ['node_modules/@angular/cli/bin/ng.js', 'build', 'studio', '--base-href', BASE, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
