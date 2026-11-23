// stage-ui.mjs — copies the built site (dist/ at the repository's root: the one page with its bundle,
// and the app's pages, scripts, styles, fonts, icons and changelog as they are; not its tests) into
// desktop/ui, which the installer carries as resources/ui. The desktop app serves its windows from
// there, and its library runs the app's shared modules from ui/app/js.
// The site is built first, at the root: `npm run build`. This refuses a build that is missing or
// older than its sources.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtSite } from '../../build/built.mjs';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(desktop, '..');
const out = path.join(desktop, 'ui');

let site;
try { site = builtSite(); } catch (e) { console.error(`stage-ui: ${e.message} (at the repository's root)`); process.exit(1); }

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(site, out, { recursive: true });
fs.mkdirSync(path.join(desktop, 'build'), { recursive: true });
fs.copyFileSync(path.join(repo, 'icons', 'icon512.png'), path.join(desktop, 'build', 'icon.png'));
const count = fs.readdirSync(out, { recursive: true }).length;
console.log(`staged ${count} files into ${path.relative(repo, out)}`);
