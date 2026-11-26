// cn-tables.mjs — cn()'s merge tables (src/lib/cn-tables.ts), compiled from its config
// (src/lib/cn-config.ts) by the package's own compiler: every class group of the config, none left out
// for not being seen in the sources, and no stylesheet read (the config names the theme's tokens), so
// cn() merges exactly as one made from the config at run time does — without compiling the config in
// every page as it starts. The file is kept in the repository; a test holds it to what this writes.
//   node build/cn-tables.mjs          writes it
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'cn/build';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG = path.join(ROOT, 'src', 'lib', 'cn-config.ts');
export const TABLES = path.join(ROOT, 'src', 'lib', 'cn-tables.ts');

// The tables' source, as written to `out` (the file is written only when it changes).
export async function cnTables(out = TABLES) {
  const { source, warnings } = await build({ cwd: ROOT, full: true, config: CONFIG, css: false, out });
  if (warnings.length) throw new Error(`cn build: ${warnings.join('; ')}`);
  return source;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await cnTables();
  console.log(`written: ${path.relative(ROOT, TABLES)}`);
}
