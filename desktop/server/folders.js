// folders.js — the folders a desktop library (library.js) is kept in, like a game launcher's library
// folders: the first one (libraryDir, which names the library: its index here is found by that
// folder's id) and any added, each known by its own id (its .shiori/library.json). Each is a row of
// `roots` with one lifecycle state (folder-lifecycle.js):
//   'shown'     its galleries are in the library, and the library writes to it;
//   'hidden'    listed, its galleries out of the library until it is shown again; nothing is written
//               to it meanwhile — what waits for it is written once it is shown;
//   'removing'  leaving the library: off the list and its galleries out of it at once, its removal
//               writing back what only the library has of them (that write-back alone writes there),
//               then forgetting the folder and them (their files stay).
// Every gallery with a stat record has a place (`places`: the folder it is kept in), written by the
// transaction that makes it (library.js _placesIn) and changed only by a move. Whether a gallery is in
// the library is derived from its place's state (the `unmounted` view), never kept apart. A record
// with metadata only belongs to no folder: it takes the default's place once it becomes a gallery.
// New galleries go to the default folder; a gallery stays in its folder until moved (files.js moveTo).
// A folder can't be added inside another one (or holding one): the same galleries would be found twice.
//
// One app writes to a folder at a time: the one holding its claim (folder-owner.js, .shiori/owner.json).
// This library claims the folders it adds, and those no app holds as it reads them; one another app
// holds — or whose claim can't be read, or isn't one — is read but never written to until it is taken
// back by hand (folderClaim): what changes for it meanwhile waits in the library's own staging, its
// descriptions pending. Every change to a folder's files goes through one gate (`writable`): the folder
// can be reached, this library holds its claim, and its state allows it.
// Work on a folder — its check, its removal — runs through its queue, one job at a time (jobPlan), as a
// task the windows' tasks pages list.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { owner as claims, lifecycle, linked as linkedSource, BackendError } from './shared.js';
import { libraryId, replaceFile } from './files.js';
import { scanLibrary } from './scan.js';
import { fingerprintNow } from './linked.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS roots (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('shown', 'hidden', 'removing')),
  first INTEGER NOT NULL DEFAULT 0,
  added_at REAL NOT NULL,
  epoch INTEGER,
  removal TEXT
);
CREATE TABLE IF NOT EXISTS places (gid TEXT PRIMARY KEY, root TEXT NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS places_root ON places (root);
`;
// `roots`: `first` for the library's own folder; `epoch` the claim's counter this library last held it
// at (folder-owner.js: to tell, once it is added back, whether another app had it meanwhile);
// `removal` while it is being removed: { moveTo, discard, before } — where its galleries go first, whether
// the person chose to lose what can't be written there, and the state it goes back to should the
// removal be kept. The galleries out of the library: those placed in a folder that isn't shown (one no
// longer known among them).
const UNMOUNTED = `CREATE VIEW IF NOT EXISTS unmounted AS
  SELECT gid, root FROM places WHERE root NOT IN (SELECT id FROM roots WHERE state = 'shown')`;
const CLAIM_TTL = 5000;   // how long a folder's claim, as read, is taken as it is

// A moment for the windows' requests: long work on a folder waits for it every so often.
const breathe = () => new Promise((resolve) => setImmediate(resolve));
const parse = (s) => (s == null ? null : JSON.parse(s));
const refusal = (code, reason, message) => Object.assign(new BackendError(code, message), { reason });
const isDir = (dir) => { try { return fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true; } catch { return false; } };
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const within = (a, b) => { const rel = path.relative(b, a); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

export class Folders {
  constructor(library) {
    this.library = library;
    this._probes = new Map();    // id → { read, access, at }: its claim as last read (for CLAIM_TTL)
    this._jobs = new Map();      // id → the job in its queue: { kind, stop, cancel, phase, run }
    this._removed = new Map();   // id → its removed.json's last write (noteRemoved: one at a time)
    this._rescanning = null;     // the check of every folder under way: { stop }
    this._dormant = false;       // whether galleries an earlier version set aside are still kept (`dormant`)
  }
  get primaryId() { return this.library.primaryId; }

  // ── Opening ──
  // The tables, what earlier versions kept elsewhere taken over (P10), and every folder's claim read
  // (one no app holds becomes this library's).
  async open() {
    const lib = this.library;
    lib._db.exec(SCHEMA);
    lib._tx(() => this._migrateIn());
    lib._db.exec(UNMOUNTED);
    lib._stmts.clear();
    await lib.asFolderWork(() => this._restoreSetAside());
    for (const id of this.ids()) this.probe(id);
  }
  // Removals the app was closed in the middle of go on.
  resume() {
    for (const r of this._rows()) if (r.state === 'removing') this._remove(r.id).catch(() => {});
  }

  // The folders and places earlier versions kept, inside one transaction: the folders listed in the
  // index's settings (kv `roots`, `hiddenRoots`, `claimEpochs`) as rows — one an earlier version was
  // removing as `removing` again, and one it removed but kept its galleries' records of (`dormant`)
  // likewise, so its removal writes back what only the library has before forgetting it (kept, it
  // comes back hidden, out of the way); every gallery's place from where its files are, else from the
  // folder noted for it (`homes`) or that hid it (`unmounted`), else the first folder (where an index
  // from before folders kept everything). Records with metadata only had places too: no longer.
  _migrateIn() {
    const lib = this.library;
    const run = (sql, ...args) => lib._db.prepare(sql).run(...args);
    const all = (sql, ...args) => lib._db.prepare(sql).all(...args);
    const table = (name) => !!lib._db.prepare(`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?`).get(name);
    const now = Date.now();
    run(`INSERT INTO roots (id, path, state, first, added_at) VALUES (?, ?, 'shown', 1, ?)
      ON CONFLICT(id) DO UPDATE SET path = excluded.path, first = 1`, this.primaryId, lib.libraryDir, now);
    const listed = lib._kvGet('roots');
    const hidden = new Set((lib._kvGet('hiddenRoots') || []).map(h => h?.id));
    const epochs = lib._kvGet('claimEpochs') || {};
    const epochOf = (id) => (Number.isSafeInteger(epochs[id]) ? epochs[id] : null);
    for (const [i, r] of (Array.isArray(listed) ? listed : []).entries()) {
      if (typeof r?.id !== 'string' || r.id === this.primaryId || typeof r.path !== 'string') continue;
      const was = hidden.has(r.id) ? 'hidden' : 'shown';
      const removal = r.dormant ? { moveTo: null, discard: false, before: 'hidden' }
        : r.removing ? { moveTo: r.moveTo || null, discard: !!r.discard, before: was } : null;
      run(`INSERT OR IGNORE INTO roots (id, path, state, first, added_at, epoch, removal) VALUES (?, ?, ?, 0, ?, ?, ?)`,
        r.id, path.resolve(r.path), removal ? 'removing' : was, now + i, epochOf(r.id), removal && JSON.stringify(removal));
    }
    if (hidden.has(this.primaryId)) run(`UPDATE roots SET state = 'hidden' WHERE id = ? AND state = 'shown'`, this.primaryId);
    if (epochOf(this.primaryId) != null) run('UPDATE roots SET epoch = ? WHERE id = ? AND epoch IS NULL', epochOf(this.primaryId), this.primaryId);
    run(`DELETE FROM kv WHERE key IN ('roots', 'hiddenRoots', 'claimEpochs')`);
    const noted = new Map();
    for (const name of ['homes', 'unmounted']) {
      if (!table(name)) continue;
      for (const r of all(`SELECT gid, root FROM ${name}`)) if (!noted.has(r.gid) && this.has(r.root)) noted.set(r.gid, r.root);
    }
    const files = lib.files;
    for (const { gid } of all('SELECT gid FROM stats WHERE gid NOT IN (SELECT gid FROM places)')) {
      const row = files._row(gid);
      run('INSERT INTO places (gid, root) VALUES (?, ?)', gid, row ? files._split(row.path).root : noted.get(gid) ?? this.primaryId);
    }
    for (const name of ['homes', 'unmounted']) if (table(name)) run(`DROP TABLE ${name}`);
    this._dormant = table('dormant');
  }

  // Galleries an earlier version set aside (`dormant`: a hidden or removed folder's galleries' records
  // moved out of the library) brought back where they were — out of the library still while their
  // folder is hidden or being removed. Not one the library has meanwhile (or whose pages' keys another
  // gallery holds now), nor one whose folder or archive is no longer there; a folder out of reach keeps
  // its galleries set aside until a start that finds it (A05, A07).
  async _restoreSetAside() {
    if (!this._dormant) return;
    const lib = this.library;
    for (const { root } of lib._db.prepare('SELECT DISTINCT root FROM dormant').all()) {
      if (this.has(root) && isDir(this.dir(root))) await this._restoreFrom(root);
    }
    if (lib._db.prepare('SELECT 1 FROM dormant LIMIT 1').get()) return;
    lib._db.exec('DROP TABLE dormant');
    lib._stmts.clear();
    this._dormant = false;
  }
  async _restoreFrom(root) {
    const lib = this.library;
    const back = [];
    let n = 0;
    for (const { gid, bundle } of lib._db.prepare('SELECT gid, bundle FROM dormant WHERE root = ?').all(root)) {
      if (++n % 20 === 0) await breathe();
      try {
        const b = parse(bundle);
        const there = !b.files || fs.existsSync(lib.files._abs(b.files.path));
        const taken = lib._s('SELECT 1 FROM stats WHERE gid = ?').get(gid) || lib._s('SELECT 1 FROM meta WHERE gid = ?').get(gid)
          || (b.pages || []).some(p => lib._pageRowByKey(p.key));
        lib._tx(() => {
          lib._s('DELETE FROM dormant WHERE gid = ?').run(gid);
          if (!there || taken) return;
          if (b.meta) lib._metaPutRaw(parse(b.meta));
          lib._statPut(parse(b.stat));
          for (const p of b.pages || []) lib._pagePutRow({ gid, n: p.n, key: p.key, w: p.w, h: p.h, orig: parse(p.orig), record: parse(p.record) });
          if (b.cover) lib._coverPut(b.cover);
          const f = b.files;
          if (f) {
            lib._s(`INSERT OR REPLACE INTO files (gid, path, format, state, packed_at, pending, unpack, used_at, tail, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(gid, f.path, f.format, f.state, f.packed_at ?? null, f.pending ?? 0, f.unpack ?? 0, f.used_at ?? null, f.tail ?? null, f.source ?? null);
          } else lib._s('INSERT OR REPLACE INTO places (gid, root) VALUES (?, ?)').run(gid, this.has(b.home) ? b.home : root);   // kept nowhere yet: still that folder's
          lib._logIn(gid);
          back.push(gid);
        });
      } catch (e) { console.warn(`[shiori] gallery ${gid} couldn't come back:`, String(e?.message || e)); }
    }
    lib._tidyLinks(back);
    for (const gid of back) lib.publishFeed(gid);
  }

  // ── The folders ──
  _row(id) { return this.library._s('SELECT * FROM roots WHERE id = ?').get(String(id)); }
  _rows() { return this.library._s('SELECT * FROM roots ORDER BY first DESC, added_at, id').all(); }
  // The folders' ids and paths, the first one first, then as they were added.
  ids() { return this._rows().map(r => r.id); }
  paths() { return this._rows().map(r => r.path); }
  has(id) { return id != null && !!this._row(id); }
  state(id) { return this._row(id)?.state ?? null; }
  dir(id) {
    const row = this._row(id);
    if (!row) throw new BackendError('not-found', `no library folder ${id}`);
    return row.path;
  }
  // The galleries placed in folder `id`.
  galleriesIn(id) { return this.library._s('SELECT gid FROM places WHERE root = ?').all(String(id)).map(r => r.gid); }
  // Where new galleries go: the folder chosen (kv defaultRoot; none: the first one) while it is shown,
  // else the first one shown.
  defaultRoot() {
    const id = this.library._kvGet('defaultRoot') ?? this.primaryId;
    if (this.state(id) === 'shown') return id;
    return this._rows().find(r => r.state === 'shown')?.id ?? this.primaryId;
  }
  // The folders shown that this library may write to: what a check of every folder looks into.
  activeRoots() { return this._rows().filter(r => r.state === 'shown' && this.writable(r.id)).map(r => r.id); }
  // Folder `id` as folder-lifecycle.js weighs it: { id, state, isDefault, owned, reachable }.
  _facts(id) {
    const { reachable, access } = this.probe(id);
    return { id, state: this.state(id), isDefault: this.defaultRoot() === id, owned: access === 'mine', reachable };
  }

  // ── Which app keeps a folder (folder-owner.js) ──
  // The desktop app is known by the computer and the person using it — not by its index, so an index
  // made again (its data folder lost, the app installed again) still holds the folders it held.
  _me() {
    return this._instance ??= crypto.createHash('sha256').update(`shiori-desktop\0${os.hostname()}\0${os.userInfo().username}`).digest('hex').slice(0, 16);
  }
  _label() { return { app: 'desktop', host: os.hostname() }; }
  _claimFile(dir) { return path.join(dir, ...claims.OWNER_FILE.split('/')); }
  // What folder `dir`'s claim file says (folder-owner.js readClaim); one that can't be read is damaged.
  _readClaim(dir) {
    let text;
    try { text = fs.readFileSync(this._claimFile(dir), 'utf8'); } catch (e) { text = e?.code === 'ENOENT' ? null : e; }
    return claims.readClaim(text);
  }
  // A claim written whole — beside the file, then renamed over it — in a folder that is there: never one
  // made again where a folder was (a drive away, a folder moved or deleted).
  _writeClaim(dir, claim) {
    if (!isDir(dir)) throw refusal('unavailable', 'unavailable', `${dir} can't be reached`);
    const file = this._claimFile(dir);
    const temp = `${file}.${crypto.randomBytes(4).toString('hex')}.shiori-tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      fs.writeFileSync(temp, claims.claimText(claim));
      fs.renameSync(temp, file);
    } catch (e) {
      fs.rmSync(temp, { force: true });
      throw e;
    }
  }
  _setEpoch(id, epoch) { this.library._s('UPDATE roots SET epoch = ? WHERE id = ?').run(epoch, id); }
  _ownerOf(read) { return read?.state === 'claim' ? { ...(read.by || {}), active: !!read.owner, at: read.at } : null; }

  // Whether folder `id` can be reached now (looked at every time: a drive goes at any moment) and, when
  // it can, which app keeps it: `access` (folder-owner.js — 'mine', 'taken' or 'unknown') and the claim
  // as read (`read`), read again at most every few seconds. One no app holds (or this library let go
  // itself, untouched since) is claimed now — written, then read back; one that can't be is not this
  // library's.
  probe(id, { fresh = false } = {}) {
    const row = this._row(id);
    if (!row || !isDir(row.path)) return { reachable: false, access: null, read: null };
    let hit = this._probes.get(row.id);
    if (fresh || !hit || Date.now() - hit.at >= CLAIM_TTL) {
      hit = { ...this._access(row), at: Date.now() };
      this._probes.set(row.id, hit);
    }
    return { reachable: true, access: hit.access, read: hit.read };
  }
  _access(row) {
    const me = this._me();
    const read = this._readClaim(row.path);
    const access = claims.access(read, me, row.epoch);
    if (access !== 'free') return { read, access };
    const { claim } = claims.nextClaim(read, me, this._label(), { held: row.epoch });
    try { this._writeClaim(row.path, claim); } catch {}
    const back = this._readClaim(row.path);
    const now = claims.access(back, me, claim.epoch);
    if (now !== 'mine') return { read: back, access: now === 'free' ? 'unknown' : now };
    this._setEpoch(row.id, claim.epoch);
    return { read: back, access: 'mine' };
  }
  // Folder `dir` claimed by this library (nextClaim): written, then read back. Another app's claim, or
  // one that can't be checked, is refused — reason 'claimed', `owner` who — unless `force` (the person
  // chose to take it over). Returns the claim.
  _claimFor(dir, { force = false, held = null } = {}) {
    const me = this._me();
    const claimed = (read) => Object.assign(refusal('invalid', 'claimed', `${dir} is in use by another app`), { owner: this._ownerOf(read) });
    const got = claims.nextClaim(this._readClaim(dir), me, this._label(), { held, force });
    if (got.refused) throw claimed(got.refused);
    if (got.changed) this._writeClaim(dir, got.claim);
    const back = this._readClaim(dir);
    if (claims.access(back, me, got.claim.epoch) !== 'mine') throw claimed(back);
    return got.claim;
  }

  // ── The gate ──
  // Whether folder `id`'s files may be changed now (folder-lifecycle.js writeAllowed): it can be
  // reached, this library holds its claim, and its state allows it — 'shown', or 'removing' for `work`
  // 'removal' (its removal's own write-back). In front of every change to a folder's files.
  writable(id, work = null) {
    const state = this.state(id);
    if (!state) return false;
    const { reachable, access } = this.probe(id);
    return lifecycle.writeAllowed({ state, owned: access === 'mine', reachable, work });
  }
  // The same, refused as the windows are told (_refusal).
  assertWritable(id, work = null) { if (!this.writable(id, work)) throw this._refusal(id); }
  // Folder `id` can take galleries moved there (shown, held, reachable), or the reason it can't.
  assertMoveTo(id) { if (!lifecycle.canMoveTo(this._facts(id))) throw this._refusal(id); }
  // Why folder `id` can't be written to: not-found (not one of the library's), 'hidden' (hidden, or
  // being removed), 'unavailable' (out of reach) or 'taken' (another app keeps it, or its claim can't be
  // checked).
  _refusal(id) {
    const state = this.state(id);
    if (!state) return new BackendError('not-found', `no library folder ${id}`);
    if (state !== 'shown') return refusal('invalid', 'hidden', `library folder ${id} is hidden or being removed`);
    return this.probe(id).reachable ? refusal('unavailable', 'taken', `library folder ${id} is in use by another app`)
      : refusal('unavailable', 'unavailable', `library folder ${id} can't be reached`);
  }

  // ── What the windows do with folders (Settings → Storage) ──
  // The library's folders, the first one first, those being removed left out: [{ id, kind, name, path,
  // isDefault, access, galleries, size, removable, hidden?, owner? }] — `access` 'granted', 'taken'
  // (another app keeps it: `owner` who, null when its claim can't be read) or 'unavailable' (out of
  // reach). A hidden one counts the galleries it holds, out of the library meanwhile.
  async list() {
    const lib = this.library;
    const tally = new Map(lib._s('SELECT p.root, count(*) AS n, total(s.size) AS size FROM places p JOIN stats s ON s.gid = p.gid GROUP BY p.root')
      .all().map(r => [r.root, { galleries: Number(r.n), size: Number(r.size) }]));
    const defaultId = this.defaultRoot();
    return this._rows().filter(r => r.state !== 'removing').map((r) => {
      const { reachable, access, read } = this.probe(r.id, { fresh: true });
      const taken = reachable && access !== 'mine';
      return { id: r.id, kind: 'folder', name: path.basename(r.path) || r.path, path: r.path, isDefault: r.id === defaultId,
        access: !reachable ? 'unavailable' : taken ? 'taken' : 'granted', removable: !r.first,
        ...(tally.get(r.id) || { galleries: 0, size: 0 }), ...(r.state === 'hidden' ? { hidden: true } : {}),
        ...(taken ? { owner: this._ownerOf(read) } : {}) };
    });
  }

  // Folder `dir` (a full path) becomes one of the library's, claimed by it. Its galleries are found by
  // checking it (scan, a task the caller starts next). A hidden one is shown; one being removed is added
  // back (_addBack). Resolves { id, restored } — for one already among them, its id and `existed`. One
  // another app holds is refused (reason 'claimed', `owner` who) unless `force`: this library takes it
  // over.
  async add(dir, { force = false } = {}) {
    const lib = this.library;
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new BackendError('invalid', 'a library folder is a full path');
    const abs = path.resolve(dir);
    if (!(await fsp.stat(abs).then(st => st.isDirectory(), () => false))) throw new BackendError('invalid', `${abs} is not a folder`);
    const known = this._rows().find(r => samePath(r.path, abs));
    if (known?.state === 'hidden') return this.show(known.id);
    if (known?.state === 'shown') return { id: known.id, restored: 0, existed: true };
    if (known) return this._addBack(known, { force });
    for (const root of [...this.paths(), lib.dataDir]) {
      if (within(abs, root) || within(root, abs)) throw refusal('invalid', 'nested', `${abs} is inside a library folder, or holds one`);
    }
    const id = libraryId(abs);
    if (this.has(id)) throw refusal('invalid', 'copy', `${abs} is a copy of one of the library's folders`);
    const claim = this._claimFor(abs, { force });
    lib._s(`INSERT INTO roots (id, path, state, first, added_at, epoch) VALUES (?, ?, 'shown', 0, ?, ?)`).run(id, abs, Date.now(), claim.epoch);
    this._probes.delete(id);
    try { lib._hide(path.join(abs, '.shiori')); } catch {}
    lib._push('control', { type: 'FOLDERS_CHANGED' });
    return { id, restored: 0 };
  }

  // Folder `row`, being removed, added back (P7). Its claim is read first: another app's, or one that
  // can't be checked, is refused unless forced (R21). Unchanged since this library held it, and before
  // the removal's last step, the removal ends and its galleries are back as they were. Otherwise the
  // removal ends first, and the folder is added as any other: checked from scratch (or, the removal
  // kept, as it is now).
  async _addBack(row, { force }) {
    const me = this._me();
    const read = this._readClaim(row.path);
    if (['taken', 'unknown'].includes(claims.access(read, me, row.epoch)) && !force) {
      throw Object.assign(refusal('invalid', 'claimed', `${row.path} is in use by another app`), { owner: this._ownerOf(read) });
    }
    const job = this._jobs.get(row.id);
    if (claims.unchangedSince(read, me, row.epoch) && job?.phase !== 'forget') {
      if (job) {
        job.cancel = job.stop = true;
        await job.run.catch(() => {});
      }
      this._setState(row.id, 'shown');
      this._probes.delete(row.id);
      this.library.files.resume();
      return { id: row.id, restored: this.galleriesIn(row.id).length };
    }
    await this._remove(row.id).catch(() => {});
    return this.add(row.path, { force });
  }

  // Folder `id` (not the first one) leaves the library — at once: it is no longer listed, new galleries
  // no longer go to it, and its galleries leave the library (its state 'removing'). What it still owes
  // the folder is its removal (_removal), a task carried on at the app's next start should it be cut
  // short; then the library forgets the folder and its galleries (their files stay). `moveTo`: a folder
  // its galleries are moved to first. A folder that can't be written to now (out of reach, or another
  // app's) while galleries of it have what only this library has is refused (reason 'unsaved',
  // `galleries` how many) — unless `discard`: that is lost. Asked again while it is being removed, the
  // removal goes on (started again if it was stopped). Resolves { id, galleries }: how many leave.
  async remove(id, { moveTo = null, discard = false } = {}) {
    const lib = this.library;
    const row = this._row(id);
    if (!row) throw new BackendError('not-found', `no library folder ${id}`);
    if (row.first) throw new BackendError('invalid', 'the first library folder stays');
    if (row.state !== 'removing') {
      if (moveTo != null) {
        if (moveTo === id) throw new BackendError('invalid', 'not a place to move to');
        this.dir(moveTo);
        this.assertMoveTo(moveTo);
      }
      // The default leaves with it: the first folder that can be the default is, from now on.
      let next = null;
      if (this.defaultRoot() === id) {
        next = lifecycle.nextDefault(this.ids().map(r => this._facts(r)), id);
        if (!next) throw refusal('invalid', 'default', 'no other folder is shown to keep new galleries in');
      }
      const { reachable, access } = this.probe(id);
      if (!discard && !(reachable && access === 'mine')) {
        const n = this._unsavedIn(id).length + this._dormantIn(id);
        if (n) throw Object.assign(refusal('invalid', 'unsaved', `${n} galleries have changes not saved to library folder ${id}`), { galleries: n });
      }
      if (next) lib._kvSet('defaultRoot', next === this.primaryId ? null : next);
      this._setState(id, 'removing', { moveTo, discard: !!discard, before: row.state });
    }
    this._remove(id).catch(() => {});
    return { id, galleries: this.galleriesIn(id).length };
  }

  // Folder `id` hidden (not the default one) — at once: it stays listed, and its galleries leave the
  // library until it is shown again. A check of it under way stops. Resolves { id, galleries }: how
  // many left.
  async hide(id) {
    const row = this._row(id);
    if (!row || row.state === 'removing') throw new BackendError('not-found', `no library folder ${id}`);
    if (row.state === 'hidden') return { id, galleries: 0 };
    if (!lifecycle.canHide({ state: row.state, isDefault: this.defaultRoot() === id })) throw refusal('invalid', 'default', 'the default folder stays shown');
    const job = this._jobs.get(id);
    if (job?.kind === 'scan') job.stop = true;
    this._setState(id, 'hidden');
    return { id, galleries: this.galleriesIn(id).length };
  }

  // Hidden folder `id` shown again: its galleries are back in the library at once, and what waited for
  // the folder is written there. Resolves { id, restored }.
  async show(id) {
    const row = this._row(id);
    if (!row) throw new BackendError('not-found', `no library folder ${id}`);
    if (!lifecycle.canShow(row)) return { id, restored: 0 };
    this._setState(id, 'shown');
    this.library.files.resume();
    return { id, restored: this.galleriesIn(id).length };
  }

  // Where new galleries go: a folder shown, held and reachable (else refused, as _refusal says).
  async setDefault(id) {
    this.dir(id);
    if (!lifecycle.canSetDefault(this._facts(id))) throw this._refusal(id);
    this.library._kvSet('defaultRoot', id === this.primaryId ? null : id);
    this.library._push('control', { type: 'FOLDERS_CHANGED' });
  }

  // Folder `id`, taken over by another app (or its claim unreadable), held by this library again — from
  // a click, the person told what that risks: what waited for it meanwhile is settled into it.
  async claim(id) {
    const row = this._row(id);
    if (!row) throw new BackendError('not-found', `no library folder ${id}`);
    const claim = this._claimFor(row.path, { force: true, held: row.epoch });
    this._setEpoch(id, claim.epoch);
    this._probes.delete(id);
    this.library._push('control', { type: 'FOLDERS_CHANGED' });
    const files = this.library.files;
    files.resume();
    for (const gid of this.galleriesIn(id)) files.settle(gid).catch(() => {});
    return 'granted';
  }

  // A folder's state changed — `removal` with it while it is being removed — in a transaction that
  // leaves a trace in the change log, so a window catching up reads everything again (A26).
  _setState(id, state, removal = null) {
    const lib = this.library;
    lib._tx(() => {
      lib._s('UPDATE roots SET state = ?, removal = ? WHERE id = ?').run(state, removal && JSON.stringify(removal), id);
      lib._logIn('*');
    });
    lib._push('control', { type: 'FOLDERS_CHANGED' });
    lib._feedMuchLater();
  }

  // ── Work on a folder: its queue ──
  // Job `kind` ('scan' or 'removal') on folder `id`, through its queue (folder-lifecycle.js jobPlan):
  // started when nothing runs there; joined when the same work runs; a removal asked for during a check
  // stops the check, then runs; a check asked for during a removal is refused. `start(job)` runs it, as
  // folder work (library.js asFolderWork) — `job.stop` asks it to stop where it is.
  _queue(id, kind, start) {
    const running = this._jobs.get(id);
    const plan = lifecycle.jobPlan(running?.kind ?? null, kind);
    if (plan === 'join') return running.run;
    if (plan === 'refuse') throw refusal('invalid', 'removing', `library folder ${id} is being removed`);
    const job = { kind, stop: false, cancel: false, phase: null, run: null };
    const before = plan === 'after' ? (running.stop = true, running.run.catch(() => {})) : null;
    job.run = (async () => {
      await before;
      return this.library.asFolderWork(() => start(job));
    })().finally(() => { if (this._jobs.get(id) === job) this._jobs.delete(id); });
    this._jobs.set(id, job);
    return job.run;
  }
  // The job running on folder `id`, as a promise (null when none runs).
  job(id) { return this._jobs.get(String(id))?.run ?? null; }

  // `work(progress)` on folder `id` as a job the windows' tasks pages list — kind 'folder', id
  // `folder-<id>`, the folder's name its title, its texts' keys as folder-scan.js gives them, run in the
  // app itself — heard as it starts, every few seconds while it runs (so a window can tell one that
  // ended unheard), as it goes and as it ends. `progress(done, total, found, step)`: `step` the label
  // of the step under way, when the work goes in steps (each counted on its own). `work` resolves
  // { found, updated?, problems?, left?, stopped, result? } — `problems`, how many things it couldn't
  // read or join; `left`, galleries a move couldn't take — and the job's last message carries each of
  // them that isn't 0. This resolves `result` (what a check found), else that.
  async _announce(id, { labelKey, doneKey, foundKey }, work) {
    const dir = this._row(id)?.path || '';
    const title = path.basename(dir) || dir || id;
    let last = { done: 0, total: 0, found: 0 }, shown = 0;
    const say = (status, extra = {}) => this.library._push('jobs', { gid: `folder-${id}`, kind: 'folder', status, title, labelKey,
      labelArgs: { name: title }, doneKey, ...(foundKey != null ? { foundKey } : {}), ...last, ...extra,
      runner: { kind: 'desktop-background' }, at: Date.now() });
    const beat = setInterval(() => say('progress'), 5000);
    beat.unref?.();
    say('started');
    try {
      const out = await work((done, total, found, step) => {
        const next = step && step !== last.labelKey;
        last = { done, total, found, ...(step ? { labelKey: step } : {}) };
        if (!next && Date.now() - shown < 300 && done < total) return;
        shown = Date.now();
        say('progress');
      });
      last.found = out.found;
      if (out.updated) last.updated = out.updated;
      if (out.problems) last.problems = out.problems;
      if (out.left) last.left = out.left;
      say(out.stopped ? 'cancelled' : 'done');
      return out.result ?? out;
    } catch (e) {
      say('error', { error: String(e?.message || e), ...(e?.errorKey ? { errorKey: e.errorKey } : {}), ...(e?.unsaved ? { unsaved: e.unsaved } : {}) });
      throw e;
    } finally { clearInterval(beat); }
  }

  // Galleries put in folder `id` outside the app join the library (scan.js), as a task in its queue.
  // A hidden folder, or one another app keeps, isn't checked; one being removed isn't the library's any
  // more. Resolves what scan.js found.
  async scan(id) {
    const row = this._row(id);
    if (!row || row.state === 'removing') throw new BackendError('not-found', `no library folder ${id}`);
    if (row.state === 'hidden') throw refusal('invalid', 'hidden', `library folder ${id} is hidden`);
    const { reachable, access } = this.probe(id);
    if (reachable && access !== 'mine') throw this._refusal(id);
    return this._queue(id, 'scan', (job) => this._announce(id, { labelKey: 'lf.task_checking', doneKey: 'lf.task_done' }, async (progress) => {
      const found = await this.library._bulkRun(() => scanLibrary(this.library, { roots: [id], stopped: () => job.stop, onProgress: progress }));
      return { found: found.added.length, updated: found.updated.length, problems: found.problems.length, stopped: found.stopped, result: found };
    }));
  }

  // Every folder shown that this library may write to checked, each through its own queue, one after
  // another (a check of one already under way is joined). Resolves what they found, together.
  async rescan() {
    const all = { moved: [], missing: [], found: [], added: [], updated: [], removed: 0, problems: [], stopped: false };
    const run = this._rescanning = { stop: false };
    try {
      for (const id of this.activeRoots()) {
        if (run.stop) { all.stopped = true; break; }
        const found = await this.scan(id).catch(() => null);   // hidden or being removed meanwhile: left out
        if (!found) continue;
        for (const k of ['moved', 'missing', 'found', 'added', 'updated', 'problems']) all[k].push(...found[k]);
        all.removed += found.removed;
        all.stopped ||= found.stopped;
      }
    } finally { if (this._rescanning === run) this._rescanning = null; }
    // One a folder's check found gone that a later one found moved there by hand isn't missing.
    all.missing = all.missing.filter(gid => !all.moved.includes(gid));
    return all;
  }

  // The work on folder `id` stopped where it is (a removal goes on at the app's next start); 'all': the
  // check of every folder.
  stop(id) {
    if (id === 'all') {
      if (this._rescanning) this._rescanning.stop = true;
      for (const job of this._jobs.values()) if (job.kind === 'scan') job.stop = true;
      return;
    }
    const job = this._jobs.get(String(id));
    if (job) job.stop = true;
  }

  // ── Removal ──
  // Folder `id`'s removal (P7), through its queue: joined while it runs, else (re)started.
  _remove(id) {
    return this._queue(id, 'removal', (job) => {
      const { moveTo } = parse(this._row(id)?.removal) || {};
      const keys = moveTo ? { labelKey: 'lf.task_moving', doneKey: 'lf.task_moved', foundKey: '' }
        : { labelKey: 'lf.task_removing', doneKey: 'lf.task_removed', foundKey: '' };
      return this._announce(id, keys, (progress) => this.library._bulkRun(() => this._removal(id, job, progress)));
    });
  }

  // What folder `id`, being removed, still owes it, then the folder forgotten:
  // 1. its galleries moved to the folder chosen, when one was — each on its own, and each either moved
  //    or left with the folder (it can't be: reported as `left`);
  // 2. every gallery placed in it, while the folder can be written to, written back there — what waits
  //    settled in, a folder of its own for one with none, every description that differs — and counted
  //    saved only when that succeeded; while it can't be written to, a gallery counts as saved only
  //    when nothing waits for it (its folder has everything);
  // 3. how it ends (folder-lifecycle.js removalOutcome): with something not saved — unless the person
  //    chose to lose it — the removal is kept, the folder back as it was before (lf.task_kept);
  // 4. its claim let go (one out of reach keeps it: the next app to add it asks first), and the folder
  //    forgotten with its galleries' records (their files stay).
  // It ends at a stop (going on at the app's next start), and when the folder is added back (`cancel`):
  // before step 4 (`phase` 'forget'), which an adding back waits for.
  async _removal(id, job, progress) {
    const lib = this.library, files = lib.files;
    const row = this._row(id);
    if (row?.state !== 'removing') return { found: 0, stopped: true };
    const { moveTo = null, discard = false, before = 'shown' } = parse(row.removal) || {};
    let moved = 0, left = 0;
    const stopped = () => ({ found: moved, left, stopped: true });
    if (moveTo && this.has(moveTo)) {
      const gids = this.galleriesIn(id);
      for (const [i, gid] of gids.entries()) {
        if (job.stop) return stopped();
        try {
          if (await files.moveTo(gid, moveTo, { work: 'removal' })) { moved++; lib.publishFeed(gid); } else left++;
        } catch { left++; }
        progress(i + 1, gids.length, moved, 'lf.task_moving');
        if (i % 20 === 19) await breathe();
      }
    }
    const required = this.galleriesIn(id);
    // Galleries an earlier version set aside here wait for the folder to be reached again (A07).
    if (!discard && this._dormantIn(id)) return stopped();
    const saved = new Set();
    if (this.writable(id, 'removal')) {
      // Their folders first (a series' description names its members' folders), then each written —
      // and one not written (the folder out of reach for a moment) tried once more.
      for (const gid of required) if (!files._row(gid)) { try { files._claim(gid, lib._metaGet(gid), 'removal'); } catch {} }
      for (const [i, gid] of required.entries()) {
        if (job.stop) return stopped();
        if (await this._writeBack(gid)) saved.add(gid);
        progress(i + 1, required.length, saved.size, 'lf.task_removing');
        if (i % 20 === 19) await breathe();
      }
      for (const gid of required) if (!saved.has(gid) && !discard && !job.stop && await this._writeBack(gid)) saved.add(gid);
    } else for (const gid of required) if (this._nothingWaits(gid)) saved.add(gid);
    if (job.stop) return stopped();
    const { forget, unsaved } = lifecycle.removalOutcome({ required, saved, discard });
    if (!forget) {
      this._setState(id, before);
      files.resume();
      throw Object.assign(new BackendError('unavailable', `what library folder ${id} is owed couldn't be written there: it stays`),
        { errorKey: 'lf.task_kept', unsaved: unsaved.length });
    }
    job.phase = 'forget';
    this._release(id);
    await this._forget(id);
    return { found: moveTo ? moved : required.length, left, stopped: false };
  }

  // Gallery `gid` written back to its folder, which is being removed: what waits settled in, then its
  // descriptions (those that differ, and its series') written. Resolves whether the folder now has
  // everything the library has of it.
  async _writeBack(gid) {
    const files = this.library.files;
    if (!files._row(gid)) return false;
    try {
      await files.place(gid, { work: 'removal' });
      const { ok } = await files.describe(gid, { all: true, work: 'removal' });
      return ok && this._nothingWaits(gid);
    } catch { return false; }
  }
  // Whether gallery `gid` has nothing only the library has: a folder of its own, its descriptions
  // written, nothing staged for it, nothing to take out of its archive.
  _nothingWaits(gid) {
    const files = this.library.files;
    const row = files._row(gid);
    return !!row && !row.pending && !row.unpack && !files._staged(gid).length && !files._stagedOwn(gid).length;
  }
  // The galleries of folder `id` with something only this library has (forgetting the folder would lose
  // it) — a record with no folder of its own among them (a series' record, a chapter not downloaded:
  // described only here).
  _unsavedIn(id) { return this.galleriesIn(id).filter(gid => !this._nothingWaits(gid)); }
  // How many galleries an earlier version set aside in folder `id` are still kept, waiting for it.
  _dormantIn(id) { return this._dormant ? Number(this.library._s('SELECT count(*) AS n FROM dormant WHERE root = ?').get(id).n) : 0; }
  // Inside the transaction clearing the library (library.js clearAll): those set-aside galleries too.
  clearIn() { if (this._dormant) this.library._s('DELETE FROM dormant').run(); }

  // Folder `id` let go: its claim released, when this library holds it. One out of reach can't be: its
  // claim stays (decision 9), and the next app to add it asks first.
  _release(id) {
    const dir = this.dir(id);
    if (!isDir(dir)) return;
    const next = claims.releasedClaim(this._readClaim(dir), this._me());
    if (next) try { this._writeClaim(dir, next); } catch {}
    this._probes.delete(id);
  }

  // Folder `id` forgotten: every record of its galleries gone (their files stay — the folder has what
  // the library had of them), and the folder with them: added again, it is checked as one never seen.
  async _forget(id) {
    const lib = this.library;
    const gids = this.galleriesIn(id);
    for (let at = 0; at < gids.length; at += 50) {
      if (at) await breathe();
      const gone = [];
      lib._tx(() => {
        for (const gid of gids.slice(at, at + 50)) {
          lib.files.keep.add(gid);
          try { gone.push([gid, lib._deleteIn(gid)]); } finally { lib.files.keep.delete(gid); }
        }
      });
      for (const [gid, meta] of gone) lib._afterDelete(gid, meta);
    }
    lib._tx(() => {
      lib._s('DELETE FROM roots WHERE id = ?').run(id);
      if (this._dormant) lib._s('DELETE FROM dormant WHERE root = ?').run(id);
      if (lib._kvGet('defaultRoot') === id) lib._kvSet('defaultRoot', null);
      lib._logIn('*');
    });
    this._probes.delete(id);
    lib._push('control', { type: 'FOLDERS_CHANGED' });
  }

  // ── removed.json ──
  // Source `source` of folder `root` noted as removed from the library (linked-source.js removed.json),
  // so a check doesn't add it again: read, changed and written whole, one write at a time per folder,
  // through the gate (`work` as writable). The note carries the source's fingerprint as its files are
  // now (as a check reads it), not as the index last had it. Resolves once it is written — before what
  // it stands for is deleted — and rejects when it can't be.
  noteRemoved(root, source, { work = null } = {}) {
    const run = (this._removed.get(root) || Promise.resolve()).then(() => this._writeRemoved(root, source, work));
    this._removed.set(root, run.catch(() => {}));
    return run;
  }
  async _writeRemoved(root, source, work) {
    this.assertWritable(root, work);
    const file = path.join(this.dir(root), ...linkedSource.REMOVED_FILE.split('/'));
    const text = await fsp.readFile(file, 'utf8').catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
    const fingerprint = await fingerprintNow(this.library, root, source) ?? source.fingerprint;
    const list = linkedSource.withRemoved(linkedSource.parseRemoved(text), { ...source, fingerprint });
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await replaceFile(file, Buffer.from(linkedSource.removedText(list)));
  }
}
