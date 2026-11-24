// stand-in-translator.mjs — a translation server for browser tests, on a free port of its own (never
// the real one's): the status ping (/stats), what it can run (/capabilities, the fixture's, with its
// ETag), and the benchmark's endpoints, answering as the server's own tests describe (see
// app/tests/benchmark.test.mjs). It lets any page ask (CORS), keeps every request it was asked, and can
// be told to stop answering (`online`), to hold a benchmark job running until let go (`hold`), and to
// stop altogether (close()).
import http from 'node:http';
import { readFileSync } from 'node:fs';

export const CAPS = JSON.parse(readFileSync(new URL('../fixtures/capabilities.json', import.meta.url), 'utf8'));

const frame = (code, bytes) => {
  const out = new Uint8Array(5 + bytes.length); out[0] = code;
  new DataView(out.buffer).setUint32(1, bytes.length); out.set(bytes, 5); return out;
};
const jsonFrame = (code, value) => frame(code, new TextEncoder().encode(JSON.stringify(value)));
const pageFrame = (token, index) => {
  const t = new TextEncoder().encode(token), out = new Uint8Array(1 + t.length + 4 + 3);
  out[0] = t.length; out.set(t, 1); new DataView(out.buffer).setUint32(1 + t.length, index);
  return frame(5, out);
};

// `host`: the address it listens on (another loopback address stands for a server elsewhere);
// `state.delay`: how long the status ping waits before it answers.
export async function startTranslator({ online = true, caps = CAPS, host = '127.0.0.1' } = {}) {
  const state = { online, hold: false, delay: 0, requests: [], starts: [], cancels: [], token: null, count: 0, caps };
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Expose-Headers': '*', 'Cache-Control': 'no-store' };
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    state.requests.push({ method: req.method, path, token: req.headers['x-access-token'] || '', etag: req.headers['if-none-match'] || '' });
    const json = (value, status = 200) => { res.writeHead(status, { ...headers, 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (!state.online) { res.writeHead(503, headers); res.end('down'); return; }
    const form = () => new Request('http://x/', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body }).formData();
    if (path === '/stats') { if (state.delay) await new Promise((r) => setTimeout(r, state.delay)); return json({ ok: true }); }
    if (path === '/capabilities') {
      if (req.headers['if-none-match'] === `"${state.caps.etag}"`) { res.writeHead(304, headers); res.end(); return; }
      return json(state.caps);
    }
    if (path === '/benchmark/info') return json({ api_version: 1, limits: {}, queue: { live_jobs: 0, uploads_pending: 0 }, workers: { busy: 0 }, uptime_s: 1 });
    if (path === '/translate/gallery/resolve') { const f = await form(); return json({ config: JSON.parse(f.get('config')), signature: 'build', builds: {} }); }
    if (path === '/benchmark/gallery/start') {
      const f = await form();
      state.token = f.get('job_token'); state.count = f.getAll('image').length;
      state.starts.push({ token: state.token, images: state.count });
      return json({ token: state.token });
    }
    if (path === '/benchmark/gallery/cancel') { const f = await form(); state.cancels.push(f.get('job_token')); return json({ cancelling: true }); }
    if (path === '/benchmark/gallery/poll') {
      const chunks = state.hold ? [jsonFrame(7, { cursor: 0, status: 'running', queue: 0 })]
        : [jsonFrame(7, { cursor: state.count, status: 'done', queue: 0 }), ...Array.from({ length: state.count }, (_, i) => pageFrame(state.token, i)),
          jsonFrame(0, { count: state.count, failed: [], benchmark: { wall_s: 1.5, stages_s: { ocr: 0.5, detect: 0.25 }, model_loads: [], chunk_metrics: [{ model_loads: [] }] } })];
      res.writeHead(200, { ...headers, 'Content-Type': 'application/octet-stream' });
      res.end(Buffer.from(Uint8Array.from(chunks.flatMap((x) => [...x]))));
      return;
    }
    json({ error: 'not here' }, 404);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
  const origin = `http://${host}:${server.address().port}`;
  return { origin, state, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}
