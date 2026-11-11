// migration-dry-run.mjs — what opening a desktop library with this build would change in it (plan
// D13), told without changing anything: the owner runs it on their own library, which no test or agent
// opens. It copies the library's index (library.db with its -wal and -shm) into a temporary folder,
// opens the copy read-only, reads — read-only too — the few files the index's rows name in the library
// folders, deletes the copy, and prints what the carry-over to format v2 (files.js _carryOver) and the
// first starts after it would do:
// - rows of the tables this build drops: `leftovers` and `retired` become files to retire (deleted by
//   name once their gallery publishes; a retired folder only while its description still names a
//   gallery: T03), `unplaced` pictures keep the name they were written under, their records pointed at
//   it (T06), or are reported when their file is gone;
// - galleries kept as folders, archives and linked overlays: each becomes format v2 at its next
//   publication; those with changes waiting are published soon after the first start;
// - galleries in the desktop's oldest format (shiori.json), converted at the next check (D18);
// - galleries' folders an earlier version made but never described (pictures only): how many get their
//   identity at the first start (files.js _bindUndescribed: holding no description and exactly the
//   pictures the index recorded) and how many stay conflicts, listed under Needs attention.
//
// Usage (the app closed or not — the index is copied, never opened in place):
//   node desktop/scripts/migration-dry-run.mjs "<data folder>" [--library "<first library folder>"]
// The data folder is the one holding library.db: %APPDATA%\Shiori\libraries\<the library's id> on
// Windows. The first library folder is found in the index (its `roots`); --library names it for an
// index from before folders had a lifecycle.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOTED = /^@([0-9a-f]{16})\/(.*)$/;

// The report for the library whose index is in `dataDir`: { tables, leftovers, retired, unplaced,
// galleries }. `libraryDir`: its first library folder, when the index doesn't say.
export async function dryRun(dataDir, { libraryDir = null } = {}) {
  const { content } = await import('../server/shared.js');
  const { recordedFiles } = await import('../server/files.js');
  const { undescribedAt } = await import('../server/folder-store.js');
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-dry-run-'));
  try {
    for (const name of ['library.db', 'library.db-wal', 'library.db-shm']) {
      if (fs.existsSync(path.join(dataDir, name))) fs.copyFileSync(path.join(dataDir, name), path.join(copy, name));
    }
    if (!fs.existsSync(path.join(copy, 'library.db'))) throw new Error(`no library.db in ${dataDir}`);
    const db = new DatabaseSync(path.join(copy, 'library.db'), { readOnly: true });
    try {
      const has = (table) => !!db.prepare(`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?`).get(table);
      const rows = (sql, ...args) => db.prepare(sql).all(...args);
      const roots = has('roots') ? rows('SELECT id, path, first FROM roots') : [];
      const first = roots.find(r => r.first)?.path ?? libraryDir;
      // Where a path of the index (`files.path`: relative to the first folder, or `@<id>/…`) is.
      const abs = (rel) => {
        const m = ROOTED.exec(String(rel));
        const root = m ? roots.find(r => r.id === m[1])?.path : first;
        return root ? path.join(root, ...(m ? m[2] : String(rel)).split('/')) : null;
      };
      const stat = (file) => { try { return file ? fs.statSync(file) : null; } catch { return null; } };
      const fileRow = (gid) => (has('files') ? db.prepare('SELECT * FROM files WHERE gid = ?').get(gid) : null);
      const out = { tables: {}, leftovers: [], retired: [], unplaced: [], galleries: {} };
      for (const table of ['leftovers', 'retired', 'unplaced']) if (has(table)) out.tables[table] = rows(`SELECT count(*) AS n FROM ${table}`)[0].n;
      if (has('leftovers')) {
        for (const { gid, entry } of rows('SELECT gid, entry FROM leftovers')) {
          const row = fileRow(gid);
          const there = row?.format === 'folder' && stat(path.join(abs(row.path) ?? '', ...entry.split('/')))?.isFile();
          out.leftovers.push({ gid, entry, becomes: there ? 'retires: deleted by name once its gallery publishes' : 'forgotten: the file is gone' });
        }
      }
      if (has('retired')) {
        for (const { path: rel } of rows('SELECT path FROM retired')) {
          const at = abs(rel), st = stat(at);
          let becomes = 'forgotten: nothing is there';
          if (st?.isFile()) becomes = 'retires: the archive, deleted while it is as it is now';
          else if (st?.isDirectory()) {
            const texts = {};
            for (const name of content.OWN_FILES) { try { texts[name] = fs.readFileSync(path.join(at, ...name.split('/')), 'utf8'); } catch {} }
            becomes = content.classifyFolder(texts).kind === 'gallery' ? 'retires: each of its files deleted by name, then the folder once empty'
              : 'forgotten, left as it is: its description names no gallery (T03)';
          }
          out.retired.push({ path: rel, becomes });
        }
      }
      if (has('unplaced')) {
        for (const { gid, rel, temp } of rows('SELECT gid, rel, temp FROM unplaced')) {
          const row = fileRow(gid);
          const dir = row?.format === 'folder' ? abs(row.path) : null;
          const there = dir && stat(path.join(dir, ...temp.split('/')))?.isFile();
          const hex = /\.([0-9a-f]{8,10})\.shiori-new$/.exec(temp)?.[1];
          out.unplaced.push({ gid, rel, temp, becomes: there
            ? `renamed to ${hex ? rel.replace(/(\.[^./]*)$/, `-${hex}$1`) : 'a name of its own'}, its records pointed at it; ${rel} retires`
            : `reported: its picture is gone, its records keep ${rel} as the folder has it` });
        }
      }
      if (has('files')) {
        const count = (where) => rows(`SELECT count(*) AS n FROM files WHERE ${where}`)[0].n;
        out.galleries = {
          folders: count(`format = 'folder' AND source IS NULL`),
          archives: count(`format != 'folder'`),
          linked: count('source IS NOT NULL'),
          pending: count('pending = 1'),
          oldestFormat: has('pages') ? rows(`SELECT count(DISTINCT p.gid) AS n FROM pages p JOIN files f ON f.gid = p.gid WHERE f.format = 'folder'
            AND json_extract(p.orig, '$.at') = 'p' AND instr(json_extract(p.orig, '$.entry'), '/') = 0`)[0].n : 0,
          undescribed: { bound: 0, conflicts: 0, unreachable: 0 },
        };
        // The folders never published (no stamp) that name no gallery, as the first start weighs them.
        const unstamped = has('stamps') ? `AND gid NOT IN (SELECT gid FROM stamps)` : '';
        for (const row of rows(`SELECT gid, path FROM files WHERE format = 'folder' AND source IS NULL ${unstamped}`)) {
          const at = abs(row.path);
          const pages = has('pages') ? rows('SELECT orig, record FROM pages WHERE gid = ?', row.gid) : [];
          const cover = has('covers') ? db.prepare('SELECT record FROM covers WHERE gid = ?').get(row.gid)?.record : null;
          const named = new Map([...recordedFiles(pages, cover ? JSON.parse(cover) : null)].map(([name, [size, mtime]]) => [name, { size, mtime }]));
          const found = at ? await undescribedAt(at, row.gid, named) : 'unreadable';
          const u = out.galleries.undescribed;
          if (found === 'match') u.bound++;
          else if (found === 'described' || found === 'mismatch' || found === 'conflict') u.conflicts++;
          else if (found === 'unreadable') u.unreachable++;
        }
      }
      // The favorite an earlier version kept in a gallery's metadata: the person's own mark from the first
      // start (plan D6), each such gallery's description published again without the field.
      if (has('meta')) {
        out.favorites = { marked: rows(`SELECT count(*) AS n FROM meta WHERE json_extract(record, '$.favorite') = 1`)[0].n,
          carried: rows(`SELECT count(*) AS n FROM meta WHERE json_type(record, '$.favorite') IS NOT NULL`)[0].n };
      }
      return out;
    } finally { db.close(); }
  } finally { fs.rmSync(copy, { recursive: true, force: true }); }
}

// The report in words.
function print(r) {
  const say = (s) => process.stdout.write(`${s}\n`);
  say('Tables this build drops (rows): ' + (Object.entries(r.tables).map(([t, n]) => `${t} ${n}`).join(', ') || 'none'));
  for (const [what, list] of [['leftovers', r.leftovers], ['retired', r.retired], ['unplaced', r.unplaced]]) {
    for (const item of list) say(`  ${what}: ${item.entry ?? item.rel ?? item.path}${item.gid ? ` (gallery ${item.gid})` : ''} — ${item.becomes}`);
  }
  const g = r.galleries;
  if (g.folders != null) {
    say(`Galleries: ${g.folders} kept as folders, ${g.archives} as archives, ${g.linked} linked — each becomes format v2 at its next publication.`);
    say(`  ${g.pending} with changes waiting: published soon after the first start.`);
    say(`  ${g.oldestFormat} in the oldest format (shiori.json): converted at the next check of their folder.`);
    const u = g.undescribed;
    say(`  Folders never described (pictures only): ${u.bound} get their identity at the first start, ${u.conflicts} stay conflicts (Needs attention)`
      + `${u.unreachable ? `, ${u.unreachable} couldn't be looked at (their folder out of reach)` : ''}.`);
  }
  if (r.favorites?.carried) {
    say(`Favorites in the galleries' metadata: ${r.favorites.marked} become this library's own marks at the first start; `
      + `${r.favorites.carried} galleries' descriptions are published again without the field.`);
  }
  say('Nothing was changed.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [dataDir, ...rest] = process.argv.slice(2);
  if (!dataDir) { process.stderr.write('usage: node desktop/scripts/migration-dry-run.mjs "<data folder>" [--library "<first library folder>"]\n'); process.exit(2); }
  const at = rest.indexOf('--library');
  dryRun(path.resolve(dataDir), { libraryDir: at >= 0 ? path.resolve(rest[at + 1]) : null }).then(print, (e) => { process.stderr.write(`${e.message}\n`); process.exit(1); });
}
