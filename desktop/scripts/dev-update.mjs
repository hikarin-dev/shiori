// dev-update.mjs — a build of Shiori Desktop from this checkout, for installed copies in developer
// mode (Settings → System) to update to. It is numbered as the next patch version with a
// "-dev.<time>" suffix (newer than the release it follows and than any earlier build, older than the
// next release), built into dist-dev/, and served at http://127.0.0.1:47199/ — where developer mode
// looks — until stopped. Run it again after changing code: the new build is served in its place.
//
//   npm run dev-update               build, then serve (or let the one already serving pick it up)
//   npm run dev-update -- --serve    serve the last build only
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(desktop, 'dist-dev');
const PORT = 47199;

const serving = () => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port: PORT, path: '/latest.yml', timeout: 1000 }, (res) => { res.resume(); resolve(true); });
  req.on('error', () => resolve(false));
  req.on('timeout', () => { req.destroy(); resolve(false); });
});

function build() {
  const { version } = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
  const [major, minor, patch] = version.split(/[.-]/).map(Number);
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);   // yyyymmddhhmmss, no leading zero
  const devVersion = `${major}.${minor}.${patch + 1}-dev.${stamp}`;
  console.log(`Building Shiori ${devVersion}…`);
  fs.rmSync(out, { recursive: true, force: true });   // one build at a time: each installer is ~110 MB
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const run = (args) => {
    const r = spawnSync(process.execPath, args, { cwd: desktop, env, stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status || 1);
  };
  run([path.join(desktop, 'scripts', 'stage-ui.mjs')]);
  run([path.join(desktop, 'node_modules', 'electron-builder', 'cli.js'), '--win', '--publish', 'never',
    `--config.directories.output=${out}`, `--config.extraMetadata.version=${devVersion}`,
    '--config.detectUpdateChannel=false']);   // latest.yml, which developer mode reads, even for a -dev version
  console.log(`Built ${devVersion} in ${path.relative(desktop, out)}.`);
}

const TYPES = { '.yml': 'text/yaml', '.exe': 'application/octet-stream', '.blockmap': 'application/octet-stream' };
function serve() {
  http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1));
    const file = path.join(out, name);
    if (!name || name.includes('/') || name.includes('\\') || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
    const size = fs.statSync(file).size;
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    if (range) {   // the updater asks for parts of the installer it doesn't have yet
      const start = Number(range[1]), end = range[2] ? Number(range[2]) : size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    }
    console.log(`${new Date().toLocaleTimeString()}  ${req.method} ${name}${range ? ` (${range[0]})` : ''}`);
  }).listen(PORT, '127.0.0.1', () => console.log(`Serving ${path.relative(desktop, out)} at http://127.0.0.1:${PORT}/ — Ctrl+C to stop.`));
}

const already = await serving();
if (!process.argv.includes('--serve')) build();
if (already) console.log(`Already served at http://127.0.0.1:${PORT}/: installed copies in developer mode find this build there.`);
else serve();
