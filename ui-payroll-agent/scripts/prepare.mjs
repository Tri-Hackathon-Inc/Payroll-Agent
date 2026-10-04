import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { BASE } from './settings.mjs';

export function prepare() {
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const trinet = process.env.TRINET_MOCK_URL || process.env.VITE_TRINET_MOCK_URL || 'http://localhost:5174/trinet/';
  const html = readFileSync('src/index.html', 'utf8').replace('<base href="/ai_studio/">',
    `<base href="${escape(BASE)}"><meta name="trinet-url" content="${escape(trinet)}">`);
  mkdirSync('.angular', { recursive: true });
  writeFileSync('.angular/index.html', html);
}
