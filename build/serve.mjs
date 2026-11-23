// serve.mjs — a static server for the built site, as a host serves it: the app's pages at their
// clean addresses (app/js/pages.js), 404.html for whatever is not there, and each file with the
// date and tag the app's service worker checks its copy against (an unchanged file is answered 304).
// The tests' browser and `npm run preview` both get the site from here.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageFile } from '../app/js/pages.js';

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.md': 'text/markdown', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm',
  '.map': 'application/json', '.txt': 'text/plain',
};

const _stat = async (path) => { try { const s = await stat(path); return s.isFile() ? s : null; } catch { return null; } };

// A file's tag: a hash of what is in it, taken once for each version of the file (its size and date
// tell a new one). A file the same in two builds keeps its tag whatever its date, and a changed one
// gets a new tag even where its size and its date, to the second, are the same.
const _tags = new Map();
async function tagOf(path, file) {
  const known = _tags.get(path);
  if (known?.size === file.size && known.mtimeMs === file.mtimeMs) return known.tag;
  const tag = `"${createHash('sha1').update(await readFile(path)).digest('base64url')}"`;
  _tags.set(path, { size: file.size, mtimeMs: file.mtimeMs, tag });
  return tag;
}

// Serves the folder `root` on `port` (0: any free one) at each of `hosts`. Resolves
// { server, servers, origin, port }: `server` and `origin` are the first host's.
export async function startServer({ root, port = 0, hosts = ['127.0.0.1'] }) {
  root = resolve(root);
  const handler = async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      const path = decodeURIComponent(new URL(req.url, 'http://site').pathname);
      let full = normalize(join(root, pageFile(path.replace(/^\/+|\/+$/g, '')) ?? path.slice(1)));
      if (!full.startsWith(root + sep)) { res.writeHead(403).end(); return; }
      let file = await _stat(full);
      if (!file && !extname(full)) { full += '.html'; file = await _stat(full); }
      if (!file) {   // what a static host does: its 404 page, which finds the way to the app
        const page = await readFile(join(root, '404.html')).catch(() => null);
        res.writeHead(404, page ? { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' } : {}).end(page ?? undefined);
        return;
      }
      const modified = new Date(Math.floor(file.mtimeMs / 1000) * 1000);
      const etag = await tagOf(full, file);
      const headers = { 'Cache-Control': 'no-cache', 'Last-Modified': modified.toUTCString(), ETag: etag };
      // The tag decides where one is sent; the date only where none is.
      const tags = req.headers['if-none-match'];
      const since = Date.parse(req.headers['if-modified-since']);
      if (tags ? tags.split(',').some((t) => t.trim().replace(/^W\//, '') === etag) : modified.getTime() <= since) {
        res.writeHead(304, headers).end();
        return;
      }
      res.writeHead(200, { ...headers, 'Content-Type': TYPES[extname(full).toLowerCase()] || 'application/octet-stream', 'Content-Length': file.size });
      res.end(req.method === 'HEAD' ? undefined : await readFile(full));
    } catch { res.writeHead(500).end(); }
  };
  const servers = [];
  try {
    for (const host of hosts) {
      const server = createServer(handler);
      await new Promise((done, failed) => { server.once('error', failed); server.listen(port, host, done); });
      port = server.address().port;
      servers.push(server);
    }
  } catch (e) {
    for (const server of servers) server.close();
    throw e;
  }
  return { server: servers[0], servers, port, origin: `http://${hosts[0].includes(':') ? `[${hosts[0]}]` : hosts[0]}:${port}` };
}

// `node build/serve.mjs [--port N]`: the built site at localhost, on both of its addresses — bound
// to 127.0.0.1 alone, every connection to `localhost` stalls about two seconds on Windows, where
// the name is tried as ::1 first. (A computer without ::1 gets 127.0.0.1 alone.)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { builtSite } = await import('./built.mjs');
  const at = process.argv.indexOf('--port');
  const site = { root: builtSite(), port: at > 0 ? Number(process.argv[at + 1]) : 5500 };
  const { port } = await startServer({ ...site, hosts: ['127.0.0.1', '::1'] })
    .catch((e) => (['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(e.code) ? startServer(site) : Promise.reject(e)));
  console.log(`Shiori at http://localhost:${port}/`);
}
