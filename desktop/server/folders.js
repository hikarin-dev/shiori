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
import { disk, replaceFile, ioFailures, containIn, textIn, textNow, ownDirIn } from './folder-store.js';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { owner as claims, lifecycle, linked as linkedSource, contract, BackendError } from './shared.js';
import { libraryId, identityAt, samePath } from './files.js';
import { scanLibrary, finishUnfound } from './scan.js';
import { fingerprintNow, titlesIn, removedOf, archiveRemoved } from './linked.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS roots (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('shown', 'hidden', 'removing')),
  first INTEGER NOT NULL DEFAULT 0,
  added_at REAL NOT NULL,
  epoch INTEGER,
  removal TEXT,
  handover TEXT
);
CREATE TABLE IF NOT EXISTS places (gid TEXT PRIMARY KEY, root TEXT NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS places_root ON places (root);
CREATE TABLE IF NOT EXISTS removed_notes (gid TEXT PRIMARY KEY, root TEXT NOT NULL, overlay TEXT NOT NULL, source TEXT NOT NULL, stamp TEXT, epoch INTEGER) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS attention (root TEXT NOT NULL, reason TEXT NOT NULL, path TEXT NOT NULL, gid TEXT, event INTEGER NOT NULL DEFAULT 0,
  at REAL NOT NULL, PRIMARY KEY (root, reason, path)) WITHOUT ROWID;
`;
// `roots`: `first` for the library's own folder; `epoch` the claim's counter this library last held it
// at (folder-owner.js: to tell, once it is added back, whether another app had it meanwhile);
// `removal` while it is being removed: { moveTo, discard, before } — where its galleries go first, whether
// the person chose to lose what can't be written there, and the state it goes back to should the
// removal be kept; `handover` while it came (back) to this library and its check hasn't read it since
// (folder-owner.js handoverOf: { at, wait }, written before the claim, cleared once the check has read it).
// `removed_notes`: a linked gallery let go (deleted, or moved out as the library's
// own) whose source's note in its folder's removed.json is still owed (publishRemoved) — written by the
// transaction that let it go, so the note is never lost, and its overlay (`overlay`, its path as
// files.js keeps it) deleted once the note is there. `attention`: what a folder's "Needs attention"
// list shows (D15: noteChecked, note) — `path` in the folder, `gid` the gallery it is about, `event`
// for what happened once (a change waiting here dropped for another app's newer generation, files a
// deletion left) rather than what a check finds.
// The galleries out of the library: those placed in a folder that isn't shown (one no longer known
// among them).
const UNMOUNTED = `CREATE VIEW IF NOT EXISTS unmounted AS
  SELECT gid, root FROM places WHERE root NOT IN (SELECT id FROM roots WHERE state = 'shown')`;
const IDENTITY_TTL = 2000;   // how long which folder a path holds, as read for reading, is taken as it is
const HANDOVER_POLL_MS = 50;   // how often a hand-over's check looks at the clock while it waits out the other app's window
const PAUSE = new Int32Array(new SharedArrayBuffer(4));   // a synchronous wait (Atomics.wait on it): the claim's rename tried again

// A moment for the windows' requests: long work on a folder waits for it every so often.
const breathe = () => new Promise((resolve) => setImmediate(resolve));
const parse = (s) => (s == null ? null : JSON.parse(s));
const refusal = (code, reason, message) => Object.assign(new BackendError(code, message), { reason });
const isDir = (dir) => { try { return disk.statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true; } catch { return false; } };
const within = (a, b) => { const rel = path.relative(b, a); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

export class Folders {
  constructor(library) {
    this.library = library;
    this._probes = new Map();    // id → { read, access, at }: its claim as last read (for folder-owner.js CLAIM_TTL_MS)
    this._known = new Map();     // id → the last claim read of it: what the commit gate knows (folder-owner.js knownAfter)
    this._ids = new Map();       // id → { status, path, failures, at }: which folder its path held, as last read (_identity)
    this._jobs = new Map();      // id → the job in its queue: { kind, stop, cancel, phase, run }
    this._removed = new Map();   // id → its removed.json's last write (publishRemoved: one at a time)
    this._rescanning = null;     // the check of every folder under way: { stop }
    this._dormant = false;       // whether galleries an earlier version set aside are still kept (`dormant`)
    this._nudged = new Map();    // id → when its hand-over's check was last started again by itself (handOverSoon)
    this._rereads = new Map();   // id → the timer reading its claim again, its read having failed during its hand-over
    this._stopped = new Set();   // ids whose hand-over's check the person stopped: not started again until they act on it
    this._waited = new Map();    // id → { at, since }: the hand-over this process first waited on, and since when (waitLeft)
  }
  get primaryId() { return this.library.primaryId; }

  // ── Opening ──
  // The tables, what earlier versions kept elsewhere taken over (P10), and every folder's claim read
  // (one no app holds becomes this library's).
  async open() {
    const lib = this.library;
    lib._db.exec(SCHEMA);
    // An index made before S31: its removal notes' token and claim's counter (none — a note made then is
    // weighed as one made before S29a: removedIn).
    const noted = new Set(lib._db.prepare('PRAGMA table_info(removed_notes)').all().map(c => c.name));
    for (const [name, type] of [['stamp', 'TEXT'], ['epoch', 'INTEGER']]) if (!noted.has(name)) lib._db.exec(`ALTER TABLE removed_notes ADD COLUMN ${name} ${type}`);
    // An index made before S32: its folders' hand-over marks (none — no folder of it is being handed over).
    if (!lib._db.prepare('PRAGMA table_info(roots)').all().some(c => c.name === 'handover')) lib._db.exec('ALTER TABLE roots ADD COLUMN handover TEXT');
    lib._tx(() => this._migrateIn());
    lib._db.exec(UNMOUNTED);
    lib._stmts.clear();
    // Every disk call inside one of its folders is checked for links from now on, and an answer of "not
    // found" there taken only while the folder is there as itself (folder-store.js containIn): their
    // paths and ids as the index has them, read again once one is added or forgotten.
    this._paths = null;
    this._uncontain = containIn(() => (this._paths ??= this._rows().map(r => ({ path: r.path, id: r.id }))));
    await this._restoreSetAside();
    for (const id of this.ids()) this.probe(id);
  }
  close() {
    this._uncontain?.();
    for (const t of this._rereads.values()) clearTimeout(t);
    this._rereads.clear();
  }
  // Removals the app was closed in the middle of go on, and notes of removed sources still owed are
  // written.
  resume() {
    for (const r of this._rows()) if (r.state === 'removing') this._remove(r.id).catch(() => {});
    for (const { root } of this.library._s('SELECT DISTINCT root FROM removed_notes').all()) this.publishRemoved(root).catch(() => {});
    // A hand-over the app was closed (or killed) in the middle of: its check starts again by itself.
    for (const r of this._rows()) if (r.handover) this.handOver(r.id);
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
      if (this.has(root) && this.reach(root).status === 'ok') await this._restoreFrom(root);
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
        const there = !b.files || disk.existsSync(lib.files._abs(b.files.path));
        const taken = lib._s('SELECT 1 FROM stats WHERE gid = ?').get(gid) || lib._s('SELECT 1 FROM meta WHERE gid = ?').get(gid)
          || (b.pages || []).some(p => lib._pageRowByKey(p.key));
        const home = b.files ? lib.files._split(b.files.path).root : this.has(b.home) ? b.home : root;
        lib.asFolderWork(home, () => lib._tx(() => {
          lib._s('DELETE FROM dormant WHERE gid = ?').run(gid);
          if (!there || taken) return;
          if (b.meta) { lib._metaPutRaw(parse(b.meta)); lib._importMarks(gid, parse(b.meta)); }
          lib._statPut(parse(b.stat));
          for (const p of b.pages || []) lib._pagePutRow({ gid, n: p.n, key: p.key, w: p.w, h: p.h, orig: parse(p.orig), record: parse(p.record) });
          if (b.cover) lib._coverPut(b.cover);
          const f = b.files;
          if (f) {
            lib._s(`INSERT OR REPLACE INTO files (gid, path, format, state, packed_at, pending, unpack, used_at, tail, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(gid, f.path, f.format, f.state, f.packed_at ?? null, f.pending ?? 0, f.unpack ?? 0, f.used_at ?? null, f.tail ?? null, f.source ?? null);
          } else lib._s('INSERT OR REPLACE INTO places (gid, root) VALUES (?, ?)').run(gid, home);   // kept nowhere yet: still that folder's
          lib._logIn(gid);
          back.push(gid);
        }));
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
  // Where folder `id` is registered: its path as the index has it, whatever is there now — for showing
  // it and telling folders apart, never for I/O (dir).
  path(id) {
    const row = this._row(id);
    if (!row) throw new BackendError('not-found', `no library folder ${id}`);
    return row.path;
  }
  // Folder `id`'s path for I/O (principle 1): only while it holds that folder (reach: its library.json
  // names it). Otherwise refused, as 'unavailable' — `reason` 'other-library' when another library
  // folder (or a folder naming none) is at its path, 'unavailable' when nothing can be reached there.
  // Every path the library reads or writes in a library folder starts here (library.js rootDir).
  dir(id) {
    const opened = this.reach(id);
    if (opened.status === 'ok') return opened.at;
    throw refusal('unavailable', opened.status, `library folder ${id} is ${opened.status === 'other-library' ? 'not at its path' : 'out of reach'}`);
  }
  // Folder `id` opened for `purpose` (the folder store contract's open, contract.js: folder-store.js
  // folderStore is its face): { status: 'ok', at } — its path — or a refusal (contract.js refused):
  // 'unavailable' (no such folder, nothing there), 'other-library' (its path holds another library
  // folder: never read, scanned, adopted or written as it), and for a purpose other than 'read', as
  // the shared rule weighs its state and claim (folder-lifecycle.js refusalFor). Its identity, as read
  // for a read, is taken as it is for IDENTITY_TTL, or until an I/O call in a library folder fails;
  // `fresh`, and every other purpose, read it again.
  reach(id, purpose = 'read', { fresh = false } = {}) {
    const row = this._row(id);
    if (!row) return contract.refused('unavailable');
    if (purpose === 'read') {
      const here = this._identity(row, { fresh });
      return here === 'ok' ? { status: 'ok', at: row.path } : contract.refused(here);
    }
    const { identity, access } = this.probe(id, { fresh });
    const why = identity !== 'ok' ? identity : lifecycle.refusalFor({ state: row.state, owned: access === 'mine', handover: access === 'handover', reachable: true }, purpose);
    return why ? contract.refused(why) : { status: 'ok', at: row.path };
  }
  // Which folder folder `row`'s path holds now: 'ok' (its .shiori/library.json names it — written once,
  // when the folder first joined a library: files.js libraryId), 'other-library' (a folder there whose
  // library.json names another, or none), or 'unavailable' (no folder there, or its library.json can't
  // be read). Read again once IDENTITY_TTL has passed, after an I/O call in a library folder failed
  // (folder-store.js ioFailures), or when `fresh`. Only 'ok' is taken as it is meanwhile: a folder out
  // of reach, or another at its path, is looked at again by the next read, so one brought back is read
  // at once (S8: a drive plugged back in read nothing for two seconds).
  _identity(row, { fresh = false } = {}) {
    const hit = this._ids.get(row.id);
    if (!fresh && hit?.status === 'ok' && hit.path === row.path && hit.failures === ioFailures() && Date.now() - hit.at < IDENTITY_TTL) return hit.status;
    const status = identityAt(row.path, row.id);
    this._ids.set(row.id, { status, path: row.path, failures: ioFailures(), at: Date.now() });
    return status;
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
  // What folder `dir`'s claim file says (folder-owner.js readClaim); one that can't be read is damaged —
  // "not found" too, but as the shared rule takes it (folder-store.js textNow: one answer while the drive
  // is away for a moment never makes a folder another app holds this library's again; review 6 F10).
  _readClaim(dir) {
    let text;
    try { text = textNow(this._claimFile(dir)); } catch (e) { text = e; }
    return claims.readClaim(text);
  }
  // A claim written whole — beside the file, then renamed over it — in a folder that is there: never one
  // made again where a folder was (a drive away, a folder moved or deleted). The rename is tried again a few
  // times while Windows refuses it for a moment (the other app reading the file), as replaceFile does (S33).
  _writeClaim(dir, claim) {
    if (!isDir(dir)) throw refusal('unavailable', 'unavailable', `${dir} can't be reached`);
    const file = this._claimFile(dir);
    const temp = `${file}.${crypto.randomBytes(4).toString('hex')}.shiori-tmp`;
    ownDirIn(dir);
    try {
      disk.writeFileSync(temp, claims.claimText(claim));
      for (let attempt = 0; ; attempt++) {
        try { disk.renameSync(temp, file); break; } catch (e) {
          if (attempt >= 3 || !['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) throw e;
          Atomics.wait(PAUSE, 0, 0, 20 * 2 ** attempt);
        }
      }
    } catch (e) {
      disk.rmSync(temp, { force: true });
      throw e;
    }
  }
  _setEpoch(id, epoch) { this.library._s('UPDATE roots SET epoch = ? WHERE id = ?').run(epoch, id); }
  _ownerOf(read) { return read?.state === 'claim' ? { ...(read.by || {}), active: !!read.owner, at: read.at } : null; }

  // Whether folder `id` can be reached now (looked at every time: a drive goes at any moment) and, when
  // it can, which app keeps it: `access` (folder-owner.js — 'mine', 'taken' or 'unknown') and the claim
  // as read (`read`), read again once CLAIM_TTL_MS has passed. One no app holds (or this library let go
  // itself, untouched since) is claimed now — written, then read back; one that can't be is not this
  // library's. A claim whose read failed (readClaim `unread`) is kept for no time, as an identity out of
  // reach is: the next probe reads it again, so one failure refuses only the call it met (C1). Every claim
  // read is what the commit gate knows from then on (`_known`, folder-owner.js knownAfter: one that failed
  // says nothing). A folder is reached only where its path holds it (_identity, read afresh for every
  // probe: each change to a folder's files is weighed by one): another folder there — a drive letter or
  // mount point given to another disk, the folder replaced — is not it (`identity` 'other-library'), and
  // is neither claimed, read as it, nor written to (F01, T01).
  probe(id, { fresh = false } = {}) {
    const row = this._row(id);
    const identity = row ? this._identity(row, { fresh: true }) : 'unavailable';
    if (identity !== 'ok') return { reachable: false, access: null, read: null, identity };
    let hit = this._probes.get(row.id);
    if (fresh || !hit || Date.now() - hit.at >= claims.CLAIM_TTL_MS) {
      hit = { ...this._access(row), at: Date.now() };
      if (hit.read?.unread) this._probes.delete(row.id); else this._probes.set(row.id, hit);
      // (A claim of this library's being handed over is no other app's: the gate weighs the hand-over apart, handingOver.)
      const known = claims.knownAfter(this._known.get(row.id), hit.read, hit.access === 'mine' || hit.access === 'handover', hit.at);
      if (known) this._known.set(row.id, known);
      // Its claim's read failing while it is handed over: read again in a moment, so its check comes back (S33).
      if (hit.read?.unread && row.handover && !this._rereads.has(row.id)) {
        const t = setTimeout(() => { this._rereads.delete(row.id); try { if (this.has(row.id)) this.probe(row.id, { fresh: true }); } catch {} }, claims.HANDOVER_RETRY_MS);
        t.unref?.();
        this._rereads.set(row.id, t);
      }
    }
    if (hit.access === 'handover') this.handOverSoon(row.id);
    return { reachable: true, access: hit.access, read: hit.read, identity };
  }
  // Whether the library knows another app holds folder `id` — what the commit gate weighs (library.js
  // _heldCheck): the last claim it read of it (`_known`), weighed by folder-owner.js heldElsewhere. One
  // naming another app refuses until a later read says otherwise; a read that failed, or the folder out
  // of reach, changes nothing of it. None read yet, or read longer ago than the claim's time to live, it
  // is read again first (probe: at most one read per time to live, none for a change inside it).
  // `read` false: what is known alone, never read again (no file call: the gate of a folder being handed over).
  heldElsewhere(id, { read = true } = {}) {
    const known = () => claims.heldElsewhere(this._known.get(String(id)));
    if (read && known().again) this.probe(String(id), { fresh: true });
    return known().held;
  }
  // Whether folder `id` came (back) to this library and its check hasn't read it since (its mark: handover)
  // — the commit gate weighs it first (library.js _heldCheck), from the index alone: no file call.
  handingOver(id) { return !!this._row(id)?.handover; }
  // What the library knew of folder `id`'s claim forgotten — the claim as last read, and what the commit
  // gate knows: this library claimed it, let it go, or forgot the folder.
  _forgetClaim(id) {
    this._probes.delete(id);
    this._known.delete(id);
  }
  // Whether folder `row`'s path holds that folder now (_identity, read afresh).
  _here(row) { return this._identity(row, { fresh: true }) === 'ok'; }
  _access(row) {
    const me = this._me();
    const handover = claims.handoverIn(row.handover);   // read with the row: the mark is written before the claim
    const read = this._readClaim(row.path);
    const access = claims.access(read, me, row.epoch, handover);
    if (access !== 'free') return { read, access };
    const { claim } = claims.nextClaim(read, me, this._label(), { held: row.epoch });
    try { this._writeClaim(row.path, claim); } catch {}
    const back = this._readClaim(row.path);
    const now = claims.access(back, me, claim.epoch, handover);
    if (now !== 'mine' && now !== 'handover') return { read: back, access: now === 'free' ? 'unknown' : now };
    this._setEpoch(row.id, claim.epoch);
    return { read: back, access: now };
  }
  // Folder `dir` claimed by this library (nextClaim): written, then read back. Another app's claim, or
  // one that can't be checked, is refused — reason 'claimed', `owner` who — unless `force` (the person
  // chose to take it over). `before(claim, handover)` runs once it is decided, before the claim file is
  // written: `handover` the hand-over it begins (folder-owner.js handoverOf: the claim replaced wasn't this
  // library's), null for none — the caller records it there, so a kill after it leaves the folder to be read.
  // Returns { claim, handover }.
  _claimFor(dir, { force = false, held = null, before = () => {} } = {}) {
    const me = this._me();
    const claimed = (read) => Object.assign(refusal('invalid', 'claimed', `${dir} is in use by another app`), { owner: this._ownerOf(read) });
    const read = this._readClaim(dir);
    const now = Date.now();
    const got = claims.nextClaim(read, me, this._label(), { held, force, now });
    if (got.refused) throw claimed(got.refused);
    const handover = got.changed ? claims.handoverOf(read, me, held, now) : null;
    before(got.claim, handover);
    if (got.changed) this._writeClaim(dir, got.claim);
    const back = this._readClaim(dir);
    if (claims.access(back, me, got.claim.epoch) !== 'mine') throw claimed(back);
    return { claim: got.claim, handover };
  }
  // Folder `id`'s hand-over (folder-owner.js), as its row keeps it: null for none.
  handover(id) { return claims.handoverIn(this._row(id)?.handover); }
  // Folder `id`'s hand-over recorded (`handover`), or ended (null) — what was known of its claim forgotten, so
  // every gate weighs it from now on (probe).
  _setHandover(id, handover) {
    this.library._s('UPDATE roots SET handover = ? WHERE id = ?').run(handover ? JSON.stringify(handover) : null, String(id));
    this._probes.delete(String(id));
  }

  // ── The gate ──
  // Whether folder `id`'s files may be changed now (folder-lifecycle.js writeAllowed): it can be
  // reached, this library holds its claim, and its state allows it — 'shown', 'removing' for `work`
  // 'removal' (its removal's own write-back), or 'hidden' for `work` 'publish' (the publication of
  // what was committed before it was hidden). In front of every change to a folder's files.
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
  // being removed), 'unavailable' (out of reach), 'other-library' (another library folder at its path)
  // or 'taken' (another app keeps it, or its claim can't be checked).
  _refusal(id) {
    const state = this.state(id);
    if (!state) return new BackendError('not-found', `no library folder ${id}`);
    if (state !== 'shown') return refusal('invalid', 'hidden', `library folder ${id} is hidden or being removed`);
    const { reachable, identity, access } = this.probe(id);
    if (reachable && access === 'handover') return refusal('unavailable', 'handover', `library folder ${id} is being read after it came back`);
    if (reachable) return refusal('unavailable', 'taken', `library folder ${id} is in use by another app`);
    return identity === 'other-library' ? refusal('unavailable', 'other-library', `another library folder is at library folder ${id}'s path`)
      : refusal('unavailable', 'unavailable', `library folder ${id} can't be reached`);
  }

  // ── What the windows do with folders (Settings → Storage) ──
  // The library's folders, the first one first, those being removed left out: [{ id, kind, name, path,
  // isDefault, access, galleries, size, removable, hidden?, owner? }] — `access` 'granted', 'taken'
  // (another app keeps it: `owner` who, null when its claim can't be read), 'other-library' (another
  // library folder is at its path) or 'unavailable' (out of reach). A hidden one counts the galleries it
  // holds, out of the library meanwhile.
  async list() {
    const lib = this.library;
    const tally = new Map(lib._s('SELECT p.root, count(*) AS n, total(s.size) AS size FROM places p JOIN stats s ON s.gid = p.gid GROUP BY p.root')
      .all().map(r => [r.root, { galleries: Number(r.n), size: Number(r.size) }]));
    const defaultId = this.defaultRoot();
    return this._rows().filter(r => r.state !== 'removing').map((r) => {
      const { reachable, access, read, identity } = this.probe(r.id, { fresh: true });
      // One being handed over is this library's, its check reading it (shown as granted, its task running).
      const taken = reachable && access !== 'mine' && access !== 'handover';
      return { id: r.id, kind: 'folder', name: path.basename(r.path) || r.path, path: r.path, isDefault: r.id === defaultId,
        access: !reachable ? identity : taken ? 'taken' : 'granted', removable: !r.first, attention: this.attention(r.id),
        ...(tally.get(r.id) || { galleries: 0, size: 0 }), ...(r.state === 'hidden' ? { hidden: true } : {}),
        ...(taken ? { owner: this._ownerOf(read) } : {}), ...(reachable && access === 'handover' ? { handover: true } : {}) };
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
    if (!(await disk.stat(abs).then(st => st.isDirectory(), () => false))) throw new BackendError('invalid', `${abs} is not a folder`);
    const known = this._rows().find(r => samePath(r.path, abs));
    if (known?.state === 'hidden') return this.show(known.id);
    // One listed with its hand-over's mark whose claim was never written (the app killed between the two) is
    // claimed now, as that add would have: refused as an add is where another app holds it, unless `force`.
    if (known?.state === 'shown' && known.handover && this._here(known) && !['mine', 'handover'].includes(this.probe(known.id, { fresh: true }).access)) {
      await this._takeBack(known.id, { force });
      return { id: known.id, restored: 0 };
    }
    if (known?.state === 'shown') return { id: known.id, restored: 0, existed: true };
    if (known) return this._addBack(known, { force });
    for (const root of [...this.paths(), lib.dataDir]) {
      if (within(abs, root) || within(root, abs)) throw refusal('invalid', 'nested', `${abs} is inside a library folder, or holds one`);
    }
    const id = libraryId(abs);
    if (this.has(id)) throw refusal('invalid', 'copy', `${abs} is a copy of one of the library's folders`);
    // A folder another app had (its claim, active or let go, or one that can't be checked) is handed over: the
    // folder is listed with its mark before the claim is written, and read before anything else is done there.
    // One this library let go itself, untouched since (`released`: the claim's counter it left), is its own again.
    const insert = (claim, handover) => lib._s(`INSERT INTO roots (id, path, state, first, added_at, epoch, handover) VALUES (?, ?, 'shown', 0, ?, ?, ?)`)
      .run(id, abs, Date.now(), claim.epoch, handover ? JSON.stringify(handover) : null);
    let listed = false;
    let got;
    try {
      got = this._claimFor(abs, { force, held: this._released(id), before: (claim, handover) => { if (handover) { insert(claim, handover); listed = true; } } });
    } catch (e) {
      if (listed) lib._s('DELETE FROM roots WHERE id = ?').run(id);
      throw e;
    }
    if (!listed) insert(got.claim, null);
    this._paths = null;
    this._forgetClaim(id);
    try { lib._hide(path.join(abs, '.shiori')); } catch {}
    lib._push('control', { type: 'FOLDERS_CHANGED' });
    if (got.handover) this.handOver(id);
    return { id, restored: 0 };
  }
  // The claim's counter this library left on folder `id` as it let it go and forgot it (_release), or null:
  // added again untouched since, the folder is its own (no hand-over).
  _released(id) { return this.library._kvGet('releasedEpochs')?.[id] ?? null; }

  // Folder `row`, being removed, added back (P7). Its claim is read first: another app's, or one that
  // can't be checked, is refused unless forced (R21). Unchanged since this library held it, and before
  // the removal's last step, the removal ends and its galleries are back as they were. Otherwise the
  // removal ends first, and the folder is added as any other: checked from scratch (or, the removal
  // kept, as it is now).
  async _addBack(row, { force }) {
    const me = this._me();
    const here = this._here(row);   // else another folder is at its path: that one is added, once this removal ends
    const read = here ? this._readClaim(row.path) : null;
    if (here && ['taken', 'unknown'].includes(claims.access(read, me, row.epoch)) && !force) {
      throw Object.assign(refusal('invalid', 'claimed', `${row.path} is in use by another app`), { owner: this._ownerOf(read) });
    }
    const job = this._jobs.get(row.id);
    if (here && claims.unchangedSince(read, me, row.epoch) && job?.phase !== 'forget') {
      if (job) {
        job.cancel = job.stop = true;
        await job.run.catch(() => {});
      }
      this._setState(row.id, 'shown');
      this._forgetClaim(row.id);
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
  // app's) while galleries of it have what only this library has, or a gallery's folder there waits to
  // be deleted (found where it was, or not: `unfound`), is refused (reason 'unsaved',
  // `galleries` how many) — unless `discard`: that is lost. Asked again while it is being removed, the
  // removal goes on (started again if it was stopped). Resolves { id, galleries }: how many leave.
  async remove(id, { moveTo = null, discard = false } = {}) {
    const lib = this.library;
    const row = this._row(id);
    if (!row) throw new BackendError('not-found', `no library folder ${id}`);
    if (row.first) throw new BackendError('invalid', 'the first library folder stays');
    // One being handed over is removed once its check has read it (its write-back from what was read, S32):
    // refused for now ('handover') while it can be reached and read.
    if (row.state !== 'removing' && this.probe(id).access === 'handover') throw this._refusal(id);
    if (row.state !== 'removing') {
      if (moveTo != null) {
        if (moveTo === id) throw new BackendError('invalid', 'not a place to move to');
        this.path(moveTo);
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
        const n = this._unsavedIn(id).length + this._dormantIn(id) + lib.files._deletingRows(id).length;
        if (n) throw Object.assign(refusal('invalid', 'unsaved', `${n} galleries have changes not saved to library folder ${id}`), { galleries: n });
      }
      if (next) lib._kvSet('defaultRoot', next === this.primaryId ? null : next);
      this._setState(id, 'removing', { moveTo, discard: !!discard, before: row.state });
    }
    this._remove(id).catch(() => {});
    return { id, galleries: this.galleriesIn(id).length };
  }

  // Folder `id` hidden (not the default one) — at once: it stays listed, and its galleries leave the
  // library until it is shown again. A check of it under way stops. What its galleries had changed
  // before is published there in the background (plan §3.4: the one write a hidden folder takes).
  // Resolves { id, galleries }: how many left.
  async hide(id) {
    const row = this._row(id);
    if (!row || row.state === 'removing') throw new BackendError('not-found', `no library folder ${id}`);
    if (row.state === 'hidden') return { id, galleries: 0 };
    if (!lifecycle.canHide({ state: row.state, isDefault: this.defaultRoot() === id })) throw refusal('invalid', 'default', 'the default folder stays shown');
    const job = this._jobs.get(id);
    if (job?.kind === 'scan') job.stop = true;
    this._setState(id, 'hidden');
    for (const gid of this.galleriesIn(id)) if (!this._nothingWaits(gid) && this.library.files._row(gid)) this.library.files.settle(gid).catch(() => {});
    return { id, galleries: this.galleriesIn(id).length };
  }

  // Hidden folder `id` shown again: its galleries are back in the library at once, and what waited for
  // the folder is written there — its series links tidied first, as a check of it would (library.js _tidyFolder: a
  // tidy passed over while it was hidden is done, S40). Resolves { id, restored }.
  async show(id) {
    const row = this._row(id);
    if (!row) throw new BackendError('not-found', `no library folder ${id}`);
    if (!lifecycle.canShow(row)) return { id, restored: 0 };
    this._setState(id, 'shown');
    try { this.library._tidyFolder([id]); } catch {}
    this.library.files.resume();
    this.handOver(id);   // one hidden in the middle of its hand-over is read now
    return { id, restored: this.galleriesIn(id).length };
  }

  // Where new galleries go: a folder shown, held and reachable (else refused, as _refusal says) — one being
  // handed over too (S32): what is made there meanwhile waits staged until its check has read it, as a
  // gallery only this library has.
  async setDefault(id) {
    this.path(id);
    const facts = this._facts(id);
    if (!lifecycle.canSetDefault({ ...facts, owned: facts.owned || this.probe(id).access === 'handover' })) throw this._refusal(id);
    this.library._kvSet('defaultRoot', id === this.primaryId ? null : id);
    this.library._push('control', { type: 'FOLDERS_CHANGED' });
  }

  // Folder `id`, taken over by another app (or its claim unreadable), held by this library again — from
  // a click, the person told what that risks. The claim replaced wasn't this library's, so this is a
  // hand-over (folder-owner.js): its mark recorded before the claim is written, the folder's check started
  // (handOver) — what the other app did there is read before anything is changed or written here, then what
  // waited for it meanwhile is settled into it. A claim that was this library's already settles at once.
  async claim(id) { return this._takeBack(id, { force: true }); }
  // Folder `id` of the library's claimed by it again — over another app's claim only with `force` (refused as an add
  // is, reason 'claimed', else). Resolves 'granted'.
  async _takeBack(id, { force }) {
    const row = this._row(id);
    if (!row) throw new BackendError('not-found', `no library folder ${id}`);
    if (!this._here(row)) throw this._refusal(id);   // out of reach, or another folder at its path
    const { claim, handover } = this._claimFor(row.path, { force, held: row.epoch, before: (_, h) => { if (h) this._setHandover(id, h); } });
    this._setEpoch(id, claim.epoch);
    this._forgetClaim(id);
    this.library._push('control', { type: 'FOLDERS_CHANGED' });
    if (handover || this.handover(id)) this.handOver(id);
    else this._settleIn(id).catch(() => {});
    return 'granted';
  }
  // What waited for folder `id`'s galleries settled into it (each through its place held). Resolves once done.
  _settleIn(id) {
    const files = this.library.files;
    files.resume();
    return Promise.all(this.galleriesIn(id).map(gid => files.settle(gid).catch(() => {})));
  }
  // Folder `id`'s hand-over carried on, where it has one: its check started (scan), as a task the windows
  // list — joined by a check a window asks for. At the claim, the app's start (resume), and once it is shown.
  handOver(id) {
    const row = this._row(id);
    if (row?.state !== 'shown' || !this.handover(id)) return;
    this.scan(id).catch(() => {});
  }
  // The same where no check of folder `id` is under way (S33, review 10 A1): the folder answered as being handed over
  // (probe), or the commit gate refused a change for that — so a check that ended without reading it (out of reach, its
  // claim's read failing, stopped by a hide) comes back by itself once that changes. At most once every
  // HANDOVER_RETRY_MS, and not while the person keeps its check stopped (stop) — until they act on the folder.
  handOverSoon(id) {
    const key = String(id);
    if (this._jobs.has(key) || this._stopped.has(key)) return;
    const now = performance.now();
    if (now - (this._nudged.get(key) ?? -Infinity) < claims.HANDOVER_RETRY_MS) return;
    this._nudged.set(key, now);
    setImmediate(() => {
      if (this._jobs.has(key) || this._stopped.has(key)) return;   // (one started meanwhile — the check that asked, say)
      try { this.handOver(key); } catch {}   // (the library closed meanwhile)
    });
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
  // that folder's work (library.js asFolderWork: what it changes of galleries placed there, out of the
  // library, is let through; nothing else is) — `job.stop` asks it to stop where it is.
  _queue(id, kind, start) {
    const running = this._jobs.get(id);
    const plan = lifecycle.jobPlan(running?.kind ?? null, kind, { stopping: !!running?.stop });
    if (plan === 'join') return running.run;
    if (plan === 'refuse') throw refusal('invalid', 'removing', `library folder ${id} is being removed`);
    const job = { kind, stop: false, cancel: false, phase: null, run: null };
    const before = plan === 'after' ? (running.stop = true, running.run.catch(() => {})) : null;
    job.run = (async () => {
      await before;
      return this.library.asFolderWork(id, () => start(job));
    })().finally(() => {
      if (this._jobs.get(id) === job) this._jobs.delete(id);
      if (job.again) this.handOver(id);   // a hand-over begun once this check had read: a check of its own (scan)
    });
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
  // A hidden folder, one another app keeps, or one whose path holds another library folder (T01: never
  // read as it) isn't checked; one being removed isn't the library's any more. Resolves what scan.js
  // found.
  async scan(id) {
    const row = this._row(id);
    if (!row || row.state === 'removing') throw new BackendError('not-found', `no library folder ${id}`);
    if (row.state === 'hidden') throw refusal('invalid', 'hidden', `library folder ${id} is hidden`);
    const { reachable, access, identity } = this.probe(id);
    if ((reachable && access !== 'mine' && access !== 'handover') || identity === 'other-library') throw this._refusal(id);
    this._stopped.delete(String(id));   // asked for: a hand-over's check the person had stopped comes back by itself again
    return this._queue(id, 'scan', (job) => this._announce(id, { labelKey: 'lf.task_checking', doneKey: 'lf.task_done' }, async (progress) => {
      // A folder being handed over is read first (_readBack); it stays to be read where that couldn't be done.
      const back = this.handover(id) ? await this._readBack(id, job, progress) : null;
      if (back && !back.read) return back.left;
      const found = await this.library._bulkRun(() => scanLibrary(this.library, { roots: [id], stopped: () => job.stop, onProgress: progress, joined: new Set(back?.read.added ?? []) }));
      if (back) for (const k of ['moved', 'missing', 'found', 'added', 'updated']) found[k] = [...new Set([...back.read[k], ...found[k]])];
      // What it found for the folder's Needs attention list — not when it couldn't look at it, or stopped.
      const unchecked = found.problems.some(p => p.reason === 'unreachable' || p.reason === 'other-library');
      if (!found.stopped && !unchecked) this.noteChecked(id, [...found.problems, ...found.unreferenced.map(u => ({ path: u.path, reason: 'unreferenced', gid: u.gid }))]);
      if (back) await this._settleIn(id);   // then what waited for its galleries goes there, each through its place held
      // A hand-over begun while this check was past its read ("Take back" again, joined to it): read by one of its own
      // once this one has ended (S33, review 10 A1).
      job.again = !found.stopped && !!this.handover(id);
      return { found: found.added.length, updated: found.updated.length, problems: found.problems.length, stopped: found.stopped, result: found };
    }));
  }

  // Folder `id`'s hand-over read (folder-owner.js), inside its check: once the other app's window has passed
  // (readsFrom, on the app's clock; nothing of the folder read or written meanwhile), every gallery this library
  // keeps there read against its place, and what the folder holds walked, as a check does — but nothing written
  // or deleted there, no work left over from before carried out, and no gallery passed over as busy (scan.js
  // scanLibrary `handover`); then its mark cleared, so the folder is this library's from then on — the rest of
  // the check (what it owes the folder first) and what waited for its galleries following. A hand-over begun
  // again meanwhile ("Take back" once more) is read again from its own start. Resolves { read } (what the read
  // found), or { left } where the folder couldn't be read whole now (stopped, out of reach): the mark stays,
  // the folder to be read by its next check (the next start, the person's "Check now", its showing).
  async _readBack(id, job, progress) {
    for (;;) {
      const handover = this.handover(id);
      if (!handover) return { read: { moved: [], missing: [], found: [], added: [], updated: [] } };
      let again = false;
      // (Never longer than the window of this process's own running time, whatever the clock says: waitLeft.)
      if (this._waited.get(id)?.at !== handover.at) this._waited.set(id, { at: handover.at, since: performance.now() });
      const since = this._waited.get(id).since;
      for (let left; !job.stop && (left = claims.waitLeft(handover, Date.now(), performance.now() - since)) > 0;) {
        await new Promise((r) => setTimeout(r, Math.min(left, HANDOVER_POLL_MS)));
        if ((again = this.handover(id)?.at !== handover.at)) break;   // ended, or begun again, meanwhile
      }
      if (again) continue;
      // Its claim not this library's (another app's since, or the claim never written): no hand-over under way —
      // nothing read, the mark kept for the next "Take back".
      if (!job.stop && this.probe(id, { fresh: true }).access !== 'handover') {
        return { left: { found: 0, updated: 0, problems: 0, stopped: false, result: { moved: [], missing: [], found: [], added: [], updated: [], removed: 0, problems: [], unreferenced: [], stopped: false } } };
      }
      const read = job.stop ? { moved: [], missing: [], found: [], added: [], updated: [], removed: 0, problems: [], unreferenced: [], stopped: true }
        : await this.library._bulkRun(() => scanLibrary(this.library, { roots: [id], handover: true, stopped: () => job.stop, onProgress: progress }));
      const unchecked = read.problems.some(p => p.reason === 'unreachable' || p.reason === 'other-library');
      if (read.stopped || unchecked) return { left: { found: read.added.length, updated: read.updated.length, problems: read.problems.length, stopped: !!read.stopped, result: read } };
      if (this.handover(id)?.at !== handover.at) continue;
      this._setHandover(id, null);
      this.library._push('control', { type: 'FOLDERS_CHANGED' });
      return { read };
    }
  }

  // Every folder shown that this library may write to checked, each through its own queue, one after
  // another (a check of one already under way is joined) — and one being handed over, its check being what
  // makes it this library's (S33). Resolves what they found, together.
  async rescan() {
    const all = { moved: [], missing: [], found: [], added: [], updated: [], removed: 0, problems: [], unreferenced: [], stopped: false };
    const run = this._rescanning = { stop: false };
    try {
      for (const id of this._rows().filter(r => r.state === 'shown' && (this.writable(r.id) || this.probe(r.id).access === 'handover')).map(r => r.id)) {
        if (run.stop) { all.stopped = true; break; }
        const found = await this.scan(id).catch(() => null);   // hidden or being removed meanwhile: left out
        if (!found) continue;
        for (const k of ['moved', 'missing', 'found', 'added', 'updated', 'problems', 'unreferenced']) all[k].push(...found[k]);
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
  // A hand-over's check the person stops stays stopped until they act on that folder again (handOverSoon).
  stop(id) {
    const held = (key, job) => { if (job.kind === 'scan' && this.handover(key)) this._stopped.add(key); };
    if (id === 'all') {
      if (this._rescanning) this._rescanning.stop = true;
      for (const [key, job] of this._jobs) if (job.kind === 'scan') { job.stop = true; held(key, job); }
      return;
    }
    const job = this._jobs.get(String(id));
    if (job) { job.stop = true; held(String(id), job); }
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
  //    or left with the folder (it can't be — that folder hidden, removed or taken over before the
  //    move commits: reported as `left`);
  // 2. every gallery placed in it, while the folder can be written to, written back there — what waits
  //    settled in (pictures not yet in their place among it), a folder of its own for one with none,
  //    every description that differs — and counted saved only when that succeeded; while it can't be
  //    written to, a gallery counts as saved only when nothing waits for it (its folder has
  //    everything); the notes of linked sources let go from it written too;
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
      for (const gid of required) if (!files._row(gid)) { try { files.claim(gid, lib._metaGet(gid), 'removal'); } catch {} }
      for (const [i, gid] of required.entries()) {
        if (job.stop) return stopped();
        if (await this._writeBack(gid)) saved.add(gid);
        progress(i + 1, required.length, saved.size, 'lf.task_removing');
        if (i % 20 === 19) await breathe();
      }
      for (const gid of required) if (!saved.has(gid) && !discard && !job.stop && await this._writeBack(gid)) saved.add(gid);
    } else for (const gid of required) if (this._nothingWaits(gid)) saved.add(gid);
    if (job.stop) return stopped();
    // The notes of linked sources let go from it (deleted before, or moved out above) written there, and
    // the folders of galleries deleted from it (or moved out by a copy) deleted — those not where their
    // deletion had them looked for, as a check would (finishUnfound): one still owed — not finished where
    // it was met, or perhaps in what couldn't be read — is as unsaved as a gallery (forgotten, the folder
    // would add its source, or the gallery, again).
    await this.publishRemoved(id, { work: 'removal' });
    await files.applyDeletions({ root: id, work: 'removal' }).catch(() => {});
    await finishUnfound(lib, id, 'removal').catch(() => {});
    const owed = [...lib._s('SELECT gid FROM removed_notes WHERE root = ?').all(id), ...files._deletingRows(id)].map(r => r.gid);
    const { forget, unsaved } = lifecycle.removalOutcome({ required: [...required, ...owed], saved, discard });
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
  // descriptions (those that differ, and its series') written. Resolves whether it counts as saved
  // (folder-lifecycle.js savedAtRemoval): the folder now has everything the library has of it — or nothing
  // of it waits here and its place is surely gone (files._whose, under the shared rule: renamed, moved or
  // deleted by hand, or by the other app; S30), asked only then.
  async _writeBack(gid) {
    const files = this.library.files;
    if (!files._row(gid)) return false;
    let written = false;
    try {
      await files.place(gid, { work: 'removal' });
      const { ok } = await files.describe(gid, { all: true, work: 'removal' });
      written = ok && this._nothingWaits(gid);
    } catch {}
    const waits = !this._nothingWaits(gid);
    const place = written || waits ? null : (await files._whose(files._row(gid).path, gid).catch(() => null))?.kind;
    return lifecycle.savedAtRemoval({ written, waits, place });
  }
  // Whether gallery `gid` has nothing only the library has: a folder of its own, its changes
  // published, nothing staged for it, nothing to take out of its archive.
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
    const row = this._row(id);
    if (!row || !this._here(row)) return;
    const next = claims.releasedClaim(this._readClaim(row.path), this._me());
    if (next) {
      try {
        this._writeClaim(row.path, next);
        this.library._kvSet('releasedEpochs', { ...(this.library._kvGet('releasedEpochs') || {}), [id]: next.epoch });
      } catch {}
    }
    this._forgetClaim(id);
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
          lib.files._end(gid);   // forgotten: a gallery the folder joins again under its id is another (files.js life)
        }
      });
      for (const [gid, meta] of gone) lib._afterDelete(gid, meta);
    }
    lib._tx(() => {
      lib._s('DELETE FROM roots WHERE id = ?').run(id);
      lib._s('DELETE FROM removed_notes WHERE root = ?').run(id);   // written, or lost by the person's choice
      lib.files.forgetDeletionsIn(id);                              // likewise
      lib._s('DELETE FROM attention WHERE root = ?').run(id);
      if (this._dormant) lib._s('DELETE FROM dormant WHERE root = ?').run(id);
      if (lib._kvGet('defaultRoot') === id) lib._kvSet('defaultRoot', null);
      lib._logIn('*');
    });
    this._paths = null;
    this._forgetClaim(id);
    this._ids.delete(id);
    lib._push('control', { type: 'FOLDERS_CHANGED' });
  }

  // ── Needs attention (D15) ──
  // What folder `root`'s check found that the person may want to act on — `problems` ([{ path, reason,
  // gid? }]: what it couldn't read or join, a gallery's folder holding something else now, files
  // nothing refers to) — in place of what its last check found; what happened once (`event`) stays
  // until dismissed. A check that couldn't look at the folder, or was stopped, changes nothing.
  noteChecked(root, problems) {
    const lib = this.library;
    lib._tx(() => {
      lib._s('DELETE FROM attention WHERE root = ? AND event = 0').run(root);
      for (const p of problems) this._put(root, p, false);
    });
  }
  // Something about folder `root` to show there ({ reason, path, gid? }); `event`: kept by later checks.
  note(root, problem, { event = false } = {}) {
    try { this._put(root, problem, event); } catch {}
  }
  _put(root, { reason, path: at = '', gid = null }, event) {
    this.library._s('INSERT OR REPLACE INTO attention (root, reason, path, gid, event, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(root, String(reason), String(at), gid == null ? null : String(gid), event ? 1 : 0, Date.now());
  }
  // Folder `root`'s list: [{ reason, path, gid? }], oldest first.
  attention(root) {
    return this.library._s('SELECT reason, path, gid FROM attention WHERE root = ? ORDER BY at, reason, path').all(root)
      .map(r => ({ reason: r.reason, path: r.path, ...(r.gid ? { gid: r.gid } : {}) }));
  }
  // An item of folder `root`'s list put away (a check that finds it again shows it again).
  dismiss(root, { reason, path: at = '' }) {
    this.library._s('DELETE FROM attention WHERE root = ? AND reason = ? AND path = ?').run(String(root), String(reason), String(at));
    this.library._push('control', { type: 'FOLDERS_CHANGED' });
  }

  // ── removed.json ──
  // Inside the transaction letting linked gallery `gid` of folder `root` go (deleted, or moved out as
  // the library's own): its source `source` is noted as removed (`removed_notes`), so a check of the
  // folder never adds it again — published to removed.json once that commits (publishRemoved), and
  // till then counted as removed by every check (removedWaiting). `overlay`: its overlay's path,
  // deleted once the note is there. `stamp`: the token the gallery was last published or read at there;
  // with the claim's counter the folder is held at now (`epoch`), what the overlay's deletion is weighed by
  // (files.js hold, S29a's rule 3).
  removedIn(root, gid, overlay, source, stamp = null) {
    const epoch = this.library._s('SELECT epoch FROM roots WHERE id = ?').get(root)?.epoch ?? null;
    this.library._s('INSERT OR REPLACE INTO removed_notes (gid, root, overlay, source, stamp, epoch) VALUES (?, ?, ?, ?, ?, ?)')
      .run(String(gid), root, overlay, JSON.stringify(source), stamp, epoch);
  }
  // Whether archive `rel` of folder `root` is one its removed.json notes as removed, as a check weighs it
  // (linked.js archiveRemoved): an archive a deletion, or the other app's unpack (D17), left whole for the
  // person's files in it (S10's F6) — theirs, no gallery's place any more (files.js _whose: review 6 F7).
  // Rejects when removed.json can't be read now.
  async noted(root, rel) { return archiveRemoved(this.library, root, rel, await removedOf(this.library, root)); }
  // The sources of folder `root` noted as removed but not yet in its removed.json, as a check weighs
  // them (linked-source.js isRemoved): where they were, whatever their files are now.
  removedWaiting(root) {
    return this.library._s('SELECT source FROM removed_notes WHERE root = ?').all(root)
      .map(({ source }) => { const { fingerprint, ...where } = parse(source); return where; });
  }
  // The notes folder `root` is owed written to its removed.json (linked-source.js), then the overlays
  // they stand for deleted: read, changed and written whole, one write at a time per folder, through
  // the gate (`work` as writable). Each note carries its source's fingerprint as its files are now (as
  // a check reads it), not as the index last had it. A note is cleared only once it is written; one
  // that can't be now waits — tried again at the app's next start, the folder's next check, and by its
  // removal, which doesn't forget a folder still owed one. Resolves whether none waits.
  publishRemoved(root, { work = null } = {}) { return this._inRemoved(root, () => this._publishRemoved(root, work)); }
  // `fn` once the writes to folder `root`'s removed.json before it have ended: one at a time per folder.
  _inRemoved(root, fn) {
    const run = (this._removed.get(root) || Promise.resolve()).then(fn);
    this._removed.set(root, run.catch(() => {}));
    return run;
  }
  // Folder `root`'s removed.json read, `sources` noted in it (linked-source.js withRemoved, each with its
  // fingerprint as given) and written whole, through the gate (`work` as writable). Rejects when it can't be
  // — read too: none there only as the shared rule takes it (textIn), so a list that answers "not found"
  // for a moment is never written anew without its earlier notes (review 6 F4).
  async _writeRemoved(root, sources, work) {
    this.assertWritable(root, work);
    const file = path.join(this.dir(root), ...linkedSource.REMOVED_FILE.split('/'));
    let list = linkedSource.parseRemoved(await textIn(file));
    for (const s of sources) list = linkedSource.withRemoved(list, s);
    await disk.mkdir(path.dirname(file), { recursive: true });
    await replaceFile(file, Buffer.from(linkedSource.removedText(list)));
  }
  // What folder `rel` of folder `root` holds (what a gallery's deletion left there: files.js _leftBehind),
  // noted as removed now — every title a check would find in it, as its files are now (linked.js
  // titlesIn) — so no check adds it as a gallery. Rejects when it can't be.
  noteRemovedIn(root, rel, { work = null } = {}) {
    return this._inRemoved(root, async () => {
      const titles = await titlesIn(this.library, root, rel);
      if (titles.length) await this._writeRemoved(root, titles, work);
    });
  }
  async _publishRemoved(root, work) {
    const lib = this.library;
    // A linked gallery's deletion made before another app took the folder over, which published its overlay
    // there since, is dropped (files.js hold, S29a's rule 3): its source isn't noted removed, its overlay
    // stays, and the gallery joins again as the folder has it — reported once. One moved out (still in the
    // library) is noted whatever: its overlay is weighed as it goes (files.js _removeOwn).
    const notes = [];
    for (const n of lib._s('SELECT gid, overlay, source, stamp, epoch FROM removed_notes WHERE root = ?').all(root)) {
      const forget = () => lib._s('DELETE FROM removed_notes WHERE gid = ? AND source = ?').run(n.gid, n.source);
      if (lib.files._row(n.gid) || (await lib.files.hold(n.gid, { rel: n.overlay, known: n.stamp, deletion: { epoch: n.epoch, forget } })).kind !== 'dropped') notes.push(n);
    }
    if (!notes.length) return !lib._s('SELECT 1 FROM removed_notes WHERE root = ? LIMIT 1').get(root);
    try {
      const sources = [];
      for (const n of notes) {
        const source = parse(n.source);
        sources.push({ ...source, fingerprint: await fingerprintNow(lib, root, source) ?? source.fingerprint });
      }
      await this._writeRemoved(root, sources, work);
    } catch (e) {
      console.warn(`[shiori] removed sources couldn't be noted in library folder ${root} yet:`, String(e?.message || e));
      return false;
    }
    lib._tx(() => { for (const n of notes) lib._s('DELETE FROM removed_notes WHERE gid = ? AND source = ?').run(n.gid, n.source); });
    for (const n of notes) await lib.files._removeOwn(n.overlay, n.gid, work, n);
    return !lib._s('SELECT 1 FROM removed_notes WHERE root = ? LIMIT 1').get(root);
  }
}
