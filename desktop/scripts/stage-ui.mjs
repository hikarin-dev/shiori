// stage-ui.mjs — copies the app's own files (its pages, scripts, styles, fonts, icons and changelog;
// not its tests) into desktop/ui, which the installer carries as resources/ui. The desktop app
// serves its windows from there, and its library runs the app's shared modules from ui/app/js.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(desktop, '..');
const out = path.join(desktop, 'ui');

const COPY = ['app', 'icons', 'vendor', 'index.html', 'boot-root.js', 'CHANGELOG.md'];
const SKIP = new Set([path.join(repo, 'app', 'tests')]);

fs.rmSync(out, { recursive: true, force: true });
for (const name of COPY) {
  fs.cpSync(path.join(repo, name), path.join(out, name), { recursive: true, filter: (src) => !SKIP.has(src) });
}
fs.mkdirSync(path.join(desktop, 'build'), { recursive: true });
fs.copyFileSync(path.join(repo, 'icons', 'icon512.png'), path.join(desktop, 'build', 'icon.png'));
const count = fs.readdirSync(out, { recursive: true }).length;
console.log(`staged ${count} files into ${path.relative(repo, out)}`);
