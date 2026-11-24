// harness.browser.mjs — what the harness promises every other browser test: nothing a page opens
// leaves the test server unless the test let its address through. A request is refused by the
// interception; a socket goes past that, so the page's WebSocket is stood in for (harness.mjs openPage).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { startServer, chromePath, launch, openPage } from './harness.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

const skip = (t) => { if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return true; } return false; };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// What stands for an app running on this machine: it counts who connects, and hangs up.
async function listening(t) {
  const state = { connections: 0 };
  const listener = createServer((socket) => { state.connections++; socket.destroy(); });
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  return { state, origin: `http://127.0.0.1:${listener.address().port}` };
}
// A socket opened by the page: how it ended.
const socket = (page, url) => page.evaluate((url) => new Promise((resolve) => {
  const ws = new WebSocket(url);
  ws.onopen = () => resolve('open');
  ws.onclose = () => resolve('closed');
}), url);

test('a socket to another address never reaches it: it fails as one nothing answers, and is kept in page.refused', async (t) => {
  if (skip(t)) return;
  const other = await listening(t);
  const page = await openPage(browser, origin);
  t.after(() => page.close().catch(() => {}));
  await page.goto(`${origin}/CHANGELOG.md`, { waitUntil: 'load' });
  page.problems.length = 0;   // (the file has no icon of its own)
  const url = `${other.origin.replace(/^http/, 'ws')}/api/ws?k=t`;
  assert.equal(await socket(page, url), 'closed');
  assert.equal(other.state.connections, 0);
  assert.deepEqual(page.refused.filter((u) => u.startsWith('ws')), [url]);
  assert.deepEqual(page.problems, [], 'the refusal is the harness\'s own doing, not a problem of the page');
});

test('a socket to an address the test let through is opened there', async (t) => {
  if (skip(t)) return;
  const other = await listening(t);
  const page = await openPage(browser, origin, { allow: [other.origin] });
  t.after(() => page.close().catch(() => {}));
  await page.goto(`${origin}/CHANGELOG.md`, { waitUntil: 'load' });
  await socket(page, `${other.origin.replace(/^http/, 'ws')}/api/ws?k=t`);
  assert.equal(other.state.connections, 1);
  assert.deepEqual(page.refused.filter((u) => u.startsWith('ws')), []);
});

test('a page of the app whose library is kept by an app at another address never reaches that address', async (t) => {
  if (skip(t)) return;
  const other = await listening(t);
  const context = await browser.createBrowserContext();
  t.after(() => context.close().catch(() => {}));
  const page = await openPage(context, origin);
  await page.goto(`${origin}/CHANGELOG.md`, { waitUntil: 'load' });
  await page.evaluate((url) => localStorage.setItem('shiori:libraryLocation', JSON.stringify({ kind: 'desktop', url, token: 't' })), other.origin);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  const end = Date.now() + 15000;
  while (!page.refused.some((u) => u.startsWith(other.origin.replace(/^http/, 'ws'))) && Date.now() < end) await pause(100);
  await pause(500);
  assert.ok(page.refused.some((u) => u.startsWith(other.origin.replace(/^http/, 'ws'))), 'the app asked for its library\'s socket');
  assert.equal(other.state.connections, 0);
});
