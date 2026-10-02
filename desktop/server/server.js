// server.js — the desktop app's local server: the app's own files for its windows, and the library
// over one WebSocket per window. It listens on 127.0.0.1 only. A library connection must carry the
// pairing token, come from an allowed origin (a browser always says which), and name this server
// as its host (so a page that rebinds its own domain to this address gets nowhere).
import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { wire, BackendError, UI_DIR } from './shared.js';

export const PROTOCOL = 1;

// The library operations a window may call: the ones the app's library interface (api.js) uses.
export const OPS = new Set([
  'galleriesPage', 'galleriesCount', 'galleryIdsSorted', 'getGallery', 'getGalleriesByIds', 'getStats', 'tagCounts',
  'metaGetAllMap', 'resolveGalleryId', 'galleryCreate', 'mutateGallery', 'rebuildGalleryEntry', 'deleteGallery',
  'metaGet', 'metaGetAll', 'metaPut',
  'seriesResolve', 'seriesChapters', 'seriesCommand', 'refreshSeriesAggregate',
  'pageList', 'pageHas', 'pageGet', 'getGalleryImageRecords', 'getPageBlob', 'pagePut', 'deleteStaleGalleryImages',
  'putTranslatedPage', 'putTranslatedImage', 'putPageStudy', 'setPagesOwn', 'clearGalleryTranslations',
  'listGalleryStudyRecords', 'putPageData',
  'coverGet', 'coverThumbnailGet', 'coverPreviewGet', 'coverThumbnailPut', 'coverPut',
  'sourceIconGet', 'sourceIconsAll', 'sourceIconPut',
  'transferIds', 'transferRead', 'transferWrite',
  'publishFeed', 'changeRevision', 'changesSince', 'integritySnapshot', 'clearAll',
]);
const MAX_ARGS = 8;
const MAX_FRAME = 1 << 30;

// The app's pages at their clean addresses (the app's service worker and dev server map them alike).
const PAGES = { '/': 'app/library.html', '/library': 'app/library.html', '/settings': 'app/settings.html',
  '/reader': 'app/reader.html', '/overview': 'app/overview.html' };
// What of the web root is served: the app and the assets its pages load, nothing else.
const PUBLIC = new Set(['app', 'icons', 'vendor', 'index.html', 'boot-root.js', 'CHANGELOG.md']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.wasm': 'application/wasm', '.mjs.map': 'application/json', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

// A failure as the window receives it: a BackendError's code, out of space as `quota`, anything
// else `aborted`.
function errorOf(e) {
  if (e instanceof BackendError) return { code: e.code, message: e.message };
  const text = String(e?.message || e);
  const quota = e?.code === 'ENOSPC' || /SQLITE_FULL|disk is full/i.test(text);
  return { code: quota ? 'quota' : 'aborted', message: text };
}

const sameToken = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Start serving. `ports` are tried in turn (the first free one is used; 0 picks any). `origins` are
// the web origins allowed besides this server's own.
export async function startServer({ library, token, ports = [0], webRoot = path.dirname(UI_DIR), origins = [], version = '' }) {
  const root = path.resolve(webRoot);
  let port = 0;
  const hosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowed = () => new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...origins]);

  async function serveFile(req, res, pathname) {
    const page = PAGES[pathname.replace(/\/+$/, '') || '/'];
    const rel = page || decodeURIComponent(pathname).replace(/^\/+/, '');
    const parts = rel.split('/');
    if (!PUBLIC.has(parts[0]) || parts.some(p => p === '..' || p === '') || (parts[0] === 'app' && parts[1] === 'tests')) {
      res.writeHead(404).end();
      return;
    }
    let file = path.resolve(root, ...parts);
    if (!file.startsWith(root + path.sep)) { res.writeHead(404).end(); return; }
    let stat = await fsp.stat(file).catch(() => null);
    if (!stat && !path.extname(file)) { file += '.html'; stat = await fsp.stat(file).catch(() => null); }
    if (!stat?.isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') { res.end(); return; }
    res.end(await fsp.readFile(file));
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!hosts().has(String(req.headers.host || ''))) { res.writeHead(421).end(); return; }
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const origin = req.headers.origin;
      if (url.pathname === '/api/ping') {
        // Lets a page find the desktop app; it says nothing about the library.
        const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
        if (origin && allowed().has(origin)) headers['Access-Control-Allow-Origin'] = origin;
        res.writeHead(200, headers).end(JSON.stringify({ app: 'shiori-desktop', protocol: PROTOCOL, version }));
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      await serveFile(req, res, url.pathname);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const origin = req.headers.origin;
    const ok = url.pathname === '/api/ws' && hosts().has(String(req.headers.host || ''))
      && (!origin || allowed().has(origin)) && sameToken(url.searchParams.get('k'), token);
    if (!ok) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const send = async (ws, message) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(await wire.encode(message));
  };
  wss.on('connection', (ws) => {
    ws.on('message', async (data, isBinary) => {
      if (!isBinary) { ws.close(1003, 'binary frames only'); return; }
      let msg;
      try { msg = wire.decode(data); } catch { ws.close(1007, 'unreadable frame'); return; }
      const { id, op, args } = msg || {};
      try {
        if (!OPS.has(op) || !Array.isArray(args) || args.length > MAX_ARGS) throw new BackendError('invalid', `no operation ${op}`);
        const result = await library[op](...args);
        await send(ws, { id, ok: true, result });
      } catch (e) {
        await send(ws, { id, ok: false, error: errorOf(e) }).catch(() => {});
      }
    });
  });
  const offPush = library.onPush((channel, msg) => {
    for (const ws of wss.clients) send(ws, { push: channel, msg }).catch(() => {});
  });

  for (const candidate of ports) {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(candidate, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
      port = server.address().port;
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE' || candidate === ports.at(-1)) throw e;
    }
  }

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    async close() {
      offPush();
      for (const ws of wss.clients) ws.terminate();
      await new Promise(resolve => wss.close(() => resolve()));
      await new Promise(resolve => server.close(() => resolve()));
    },
  };
}
