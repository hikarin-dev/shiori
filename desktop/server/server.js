// server.js — the desktop app's local server: the app's own files for its windows, and the library
// over one WebSocket per window or tab. It listens on 127.0.0.1 only, and every request must name
// this server as its host (so a page that rebinds its own domain to this address gets nowhere).
// A library connection carries a token: the desktop app's own (for its windows) or the one a site
// was given when the person allowed it (/api/pair), which opens connections from that site only —
// and from the pages this server serves, which a helper of that site embeds handing them its token
// (a site's page can't always reach this server, a page served here always can). The library's
// windows can reach each other through it ('relay'), whatever their origin.
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
// What a window may hand the library's other windows: control signals and job status.
const RELAY_CHANNELS = new Set(['control', 'jobs']);
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

// What a site's page needs to read an answer (its own origin, never a wildcard with credentials).
const cors = (origin) => (origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {});

const sameToken = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Start serving. `ports` are tried in turn (the first free one is used; 0 picks any). `origins` are
// the web origins allowed besides this server's own. `clients`, when given, lets sites ask to use
// the library: { tokenFor(origin) → its token or null, siteOf(token) → the site it was given to or
// null, approve(origin) → a new token once the person allows it, or null }.
export async function startServer({ library, token, ports = [0], webRoot = path.dirname(UI_DIR), origins = [], version = '', clients = null }) {
  const root = path.resolve(webRoot);
  let port = 0;
  const hosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const served = () => new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const allowed = () => new Set([...served(), ...origins]);

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
      // A site's page may ask first (CORS, and its browser's check before it reaches a local app).
      if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
        res.writeHead(204, { ...cors(origin), 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'content-type',
          'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Max-Age': '600' }).end();
        return;
      }
      if (url.pathname === '/api/ping') {
        // Lets any page find the desktop app; it says nothing about the library.
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(origin) })
          .end(JSON.stringify({ app: 'shiori-desktop', protocol: PROTOCOL, version }));
        return;
      }
      if (url.pathname === '/api/pair') {
        // A site asks to use the library: the person decides, in the desktop app.
        if (req.method !== 'POST' || !origin || !clients || allowed().has(origin)) { res.writeHead(403, cors(origin)).end(); return; }
        const given = clients.tokenFor(origin) || await clients.approve(origin);
        if (!given) { res.writeHead(403, cors(origin)).end(); return; }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(origin) }).end(JSON.stringify({ token: given }));
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
    const key = url.searchParams.get('k');
    // The app's own windows (and a client with no page, as tests are) present the app's token; a
    // site presents the one it was given, from that site or from a page served here.
    const own = !!token && (!origin || allowed().has(origin)) && sameToken(key, token);
    const siteToken = origin && clients ? clients.tokenFor(origin) : null;
    let site = siteToken && sameToken(key, siteToken) ? origin : null;
    if (!site && !own && clients && served().has(origin)) site = clients.siteOf(key);
    const ok = url.pathname === '/api/ws' && hosts().has(String(req.headers.host || '')) && (own || !!site);
    if (!ok) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.site = site;
      ws.origin = origin || null;
      wss.emit('connection', ws, req);
    });
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
        if (op === 'relay') {
          // To the library's windows on other origins: those on the sender's own get it from the sender.
          const [channel, payload] = Array.isArray(args) ? args : [];
          if (!RELAY_CHANNELS.has(channel) || !payload || typeof payload !== 'object') throw new BackendError('invalid', 'nothing to relay');
          for (const other of wss.clients) if (other !== ws && other.origin !== ws.origin) send(other, { push: channel, msg: payload }).catch(() => {});
          await send(ws, { id, ok: true, result: true });
          return;
        }
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
    // Close the library connections a site has open (it was disconnected).
    dropSite(origin) { for (const ws of wss.clients) if (ws.site === origin) ws.terminate(); },
    async close() {
      offPush();
      for (const ws of wss.clients) ws.terminate();
      await new Promise(resolve => wss.close(() => resolve()));
      await new Promise(resolve => server.close(() => resolve()));
    },
  };
}
