// stage-ui.mjs — builds the site (`npm run build` at the repository's root: dist/, the one page with its
// bundle, and the app's pages, scripts, styles, fonts, icons and changelog; not its tests) and copies it
// into desktop/ui, which the installer carries as resources/ui. The desktop app serves its windows from
// there, and its library runs the app's shared modules from ui/app/js. `pack`, `dist` and `dev-update`
// stage through here, so each builds the site once, first.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtSite } from '../../build/built.mjs';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(desktop, '..');
const out = path.join(desktop, 'ui');

// (npm is a script of the shell's on Windows: run through it.)
const build = spawnSync('npm run build', { cwd: repo, stdio: 'inherit', shell: true });
if (build.status !== 0) { console.error('stage-ui: the site did not build (`npm run build` at the repository\'s root)'); process.exit(build.status || 1); }
// The build just written, as everyone who takes the built site checks it.
let site;
try { site = builtSite(); } catch (e) { console.error(`stage-ui: ${e.message} (at the repository's root)`); process.exit(1); }

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(site, out, { recursive: true });
fs.mkdirSync(path.join(desktop, 'build'), { recursive: true });
fs.copyFileSync(path.join(repo, 'icons', 'icon512.png'), path.join(desktop, 'build', 'icon.png'));
const count = fs.readdirSync(out, { recursive: true }).length;
console.log(`staged ${count} files into ${path.relative(repo, out)}`);
