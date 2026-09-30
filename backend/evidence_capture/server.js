// Evidence capture: a headless browser that opens the payroll UI the way a user would and takes
// read-only screenshots of each problem employee's pay row and their "Edit employee pay" drawer.
// It never saves or edits anything. Used by the Incident Report agent (registry/runtime/incidents.py).
//
//   POST /capture { domain, payrunId, items: [{ id, employeeId, name }] }
//     -> { capturedAt, captures: [{ id, screenshots: [{ label, dataUrl }], error? }] }
//   GET /health -> { ok: true }
const http = require('node:http');
const { chromium } = require('playwright');

const PORT = Number(process.env.PORT || 4300);
const TRINET_UI_URL = process.env.TRINET_UI_URL || 'http://127.0.0.1:5174/trinet/';
const TIMEOUT_MS = Number(process.env.CAPTURE_TIMEOUT_MS || 15000);
const MAX_ITEMS = 20;
const JPEG = { type: 'jpeg', quality: 60 };

let browserPromise;
const browser = () => (browserPromise ||= chromium.launch());

const dataUrl = buffer => `data:image/jpeg;base64,${buffer.toString('base64')}`;

async function captureItem(page, item) {
  const screenshots = [];
  // Pay rows are matched by the employee ID shown under the name ("ID: E1001").
  const rows = page.locator('tbody tr').filter({ hasText: `ID: ${item.employeeId}` });
  const count = await rows.count();
  if (!count) return { id: item.id, screenshots, error: `No pay row found for ${item.employeeId}.` };
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    await row.scrollIntoViewIfNeeded();
    screenshots.push({ label: count > 1 ? `Pay row ${index + 1} of ${count}` : 'Pay row', dataUrl: dataUrl(await row.screenshot(JPEG)) });
  }
  await rows.first().getByRole('button', { name: item.name, exact: true }).click();
  const drawer = page.getByRole('complementary', { name: 'Edit employee pay' });
  await drawer.waitFor({ timeout: TIMEOUT_MS });
  screenshots.push({ label: 'Edit employee pay (read-only view)', dataUrl: dataUrl(await drawer.screenshot(JPEG)) });
  await drawer.getByRole('button', { name: 'Close' }).click();
  await drawer.waitFor({ state: 'hidden', timeout: TIMEOUT_MS });
  return { id: item.id, screenshots };
}

async function capture({ domain, payrunId, items }) {
  const context = await (await browser()).newContext({ viewport: { width: 1440, height: 900 } });
  context.setDefaultTimeout(TIMEOUT_MS);
  try {
    const page = await context.newPage();
    const url = new URL(TRINET_UI_URL);
    if (domain) url.searchParams.set('domain', domain);
    url.searchParams.set('payrun', payrunId);
    await page.goto(url.href);
    await page.locator('tbody tr').first().waitFor();
    const captures = [];
    for (const item of items.slice(0, MAX_ITEMS)) {
      try {
        captures.push(await captureItem(page, item));
      } catch (error) {
        captures.push({ id: item.id, screenshots: [], error: `Capture failed: ${error.message.split('\n')[0]}` });
      }
    }
    return { capturedAt: new Date().toISOString(), source: url.href, captures };
  } finally {
    await context.close();
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64 * 1024) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
  }
  try { return JSON.parse(body || '{}'); } catch { throw Object.assign(new Error('Request body must be JSON.'), { status: 400 }); }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
    if (req.method !== 'POST' || req.url !== '/capture') return send(res, 404, { message: 'Use POST /capture.' });
    const request = await readJson(req);
    if (typeof request.payrunId !== 'string' || !Array.isArray(request.items)) {
      return send(res, 400, { message: 'payrunId and items are required.' });
    }
    return send(res, 200, await capture(request));
  } catch (error) {
    return send(res, error.status || 502, { message: error.message || 'Capture failed.' });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`Evidence capture on :${PORT}, payroll UI ${TRINET_UI_URL}`));
const shutdown = async () => { server.close(); if (browserPromise) await (await browserPromise).close(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { capture };
