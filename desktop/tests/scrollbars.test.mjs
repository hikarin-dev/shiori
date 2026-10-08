import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const electron = fileURLToPath(new URL('../node_modules/electron/dist/electron.exe', import.meta.url));
test('Electron shares Chromium native defaults and can enable and disable the custom scrollbar', {
  skip: process.platform !== 'win32' || !existsSync(electron), timeout: 30000,
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'shiori-scrollbar-test-'));
  const resultPath = join(temp, 'result.json');
  const server = createServer(async (req, res) => {
    if (req.url === '/fixture') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><link rel="icon" href="data:,"><link rel="stylesheet" href="/base.css">
        <style>body{min-height:4000px}#panel{width:200px;height:200px;overflow:auto}</style>
        <body><div id="panel"><div style="height:2000px"></div></div>
        <script type="module" src="/scrollbar.js"></script>`);
    } else if (req.url === '/base.css' || req.url === '/scrollbar.js') {
      const file = req.url === '/base.css' ? '../../app/base.css' : '../../app/js/scrollbar.js';
      res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript');
      res.end(await readFile(new URL(file, import.meta.url)));
    } else if (req.url.startsWith('/vendor/overlayscrollbars/')) {
      const file = req.url.endsWith('.css') ? 'overlayscrollbars.min.css' : 'overlayscrollbars.mjs';
      res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'text/javascript');
      res.end(await readFile(new URL(`../../vendor/overlayscrollbars/${file}`, import.meta.url)));
    } else res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, SHIORI_SCROLLBAR_TEST_PROFILE: join(temp, 'profile'),
    SHIORI_SCROLLBAR_TEST_RESULT: resultPath, SHIORI_SCROLLBAR_TEST_URL: `http://127.0.0.1:${server.address().port}/fixture` };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [fileURLToPath(new URL('./fixtures/scrollbars.cjs', import.meta.url))], { env, windowsHide: true, stdio: 'ignore' });
  try {
    const deadline = Date.now() + 20000;
    while (!existsSync(resultPath) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(existsSync(resultPath), 'the test window must write its result');
    const result = JSON.parse(await readFile(resultPath, 'utf8'));
    assert.equal(result.error, undefined);
    assert.equal(result.available, true);
    assert.deepEqual(result.native, { pageGutter: 15, panelGutter: 10, overlays: 0, gutter: 'auto' });
    assert.equal(result.custom.pageGutter, 0);
    assert.equal(result.custom.panelGutter, 0);
    assert.ok(result.custom.overlays >= 2);
    assert.deepEqual(result.restored, result.native);
    const physicalRail = result.native.pageGutter * result.zooms[0].dpr;
    assert.equal(result.zooms[0].paintedRail, Math.round(physicalRail));
    for (const zoom of result.zooms) {
      assert.equal(zoom.customWidth, 'auto', `${zoom.factor}x zoom must use browser geometry`);
      assert.ok(zoom.reserved >= zoom.occupied, `${zoom.factor}x zoom must reserve the native scrollbar space`);
      assert.equal(zoom.paintedRail, result.zooms[0].paintedRail,
        `${zoom.factor}x zoom must paint the same track width: ${JSON.stringify(result.zooms)}`);
    }
  } finally {
    child.kill(); server.close();
    const temporaryPath = relative(tmpdir(), temp);
    assert.ok(temporaryPath && !temporaryPath.startsWith('..') && !isAbsolute(temporaryPath));
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
