// folder-library.js — the website library's folders, as the person manages them: which folders it
// keeps galleries in, what can be done with one (add it, take it back, make it the default, hide it,
// show it, remove it — folder-lifecycle.js says what each state allows), a removal's work (what the
// library has of the folder's galleries written back, each confirmed, before the folder and their
// records are forgotten), and checking a folder: what it holds, classified by folder-content.js —
// Shiori's own galleries (folders and archives in the gallery format, read where they lie) and
// everything else, linked (linked-source.js: read in place, what Shiori adds kept in an overlay) —
// joined to the library, what another app changed read again, and what couldn't be read reported,
// never passed over in silence. A folder's PDFs wait for a page to draw their pages.
//
// Taken out of db.js, which keeps the IndexedDB kernel and the pictures' storage in folders (where a
// gallery's pictures go, the write gate, the commit protocol) and hands this module what it needs of
// them (createFolderLibrary): every record here is written in the kernel's transactions (its mount
// check and change log in each), and every folder file through its gate (rootOf). db.js exports what
// createFolderLibrary returns under the same names, for api.js.
//
// Work on one folder — its check, its removal's write-back, a PDF's pages joining it, adding it back
// while it is being removed — runs while lock shiori:folder:<id> is held, across every tab and the
// service worker (storage/folder-store-web.js withLock): two checks never adopt one title twice, and
// a check never reads a folder its removal is forgetting. Which job runs, and which waits or is
// refused, is folder-scan.js's to decide (folder-lifecycle.js jobPlan). Every file it reads or writes
// in a folder goes through that module, the website's folder store adapter.

import * as platform from './platform.js';
import * as folderFiles from './storage/folder-store-web.js';
import { BackendError } from './backend-error.js';
import { nextClaim, releasedClaim, unchangedSince } from './storage/folder-owner.js';
import { mounted, canHide, nextDefault, removalOutcome } from './storage/folder-lifecycle.js';
import { OWN_FILES, galleryIdOf, classifyFolder, classifyArchive } from './storage/folder-content.js';
import { LINKED_DIR, SOURCE_FILE, REMOVED_FILE, IMAGE_NAME, ARCHIVE_NAME, overlayDir, sourceText, parseSource, parseRemoved, isRemoved,
  folderPrint, metaFromName, planTitles, zipTitles, sortPictures, linkedPages, keepsDerived, pdfReady, pdfWaits, matchSources } from './storage/linked-source.js';
import { DESCRIPTION_FILES, descriptionStamp, layoutPath, extOfType, folderPictures, describedFiles, derivedRecord } from './storage/gallery-files.js';
import { sha256Hex } from './zip-read.js';
import { uploadDateSeconds } from './gallery-model.js';

let K = null;   // the kernel db.js hands over (createFolderLibrary)

// The folder layer over db.js's kernel `kernel` — its IndexedDB transactions, records, folder
// registry and write gate, and the pictures' storage (db.js lists what it hands over). Resolves the
// operations db.js exports.
export function createFolderLibrary(kernel) {
  K = kernel;
  return { foldersList, foldersWaiting, folderAdd, folderClaim, folderSetDefault, folderAllow, folderHide, folderShow,
    folderRemove, folderSetAside, foldersPending, folderScan, pdfsWaiting, pdfSource, addRendered, pdfFailed };
}

const FOLDER_LOCK = (id) => `shiori:folder:${id}`;
const _refuse = (reason, message, extra = {}) => { throw Object.assign(new BackendError('invalid', message), { reason }, extra); };
const _notFound = (id) => new BackendError('not-found', `no library folder ${id}`);
// The galleries kept in folder `id`: their stat records.
const _placedIn = async (id) => (await K.galleryGetAll()).filter(g => g.folder === id);
// Whether gallery `g` (its stat record) is kept in place `id` — for this browser, in no folder of the
// library's (`f`: the kernel's folders()).
const _keptIn = (id, g, f) => (id === K.BROWSER ? K.placeKey(g, f) === K.BROWSER : g.folder === id);
// Another app's claim as the person is told of it: who (`by`), whether it still holds it, since when —
// null for a claim that can't be read.
const _ownerOf = (read) => (read?.state === 'claim' ? { ...(read.by || {}), active: !!read.owner, at: read.at } : null);

// Folder record `record` (or this browser's) put in state `state` — what a removal kept on it dropped —
// with a trace in the change log in the same transaction: which galleries are in the library changed,
// and a window that missed the live notice reads everything again when it catches up (changesSince).
async function _putPlace(record, state) {
  const { removal, ...rest } = record;
  await K.folderWrite((store, tx) => { store.put({ ...rest, state }); K.logIn(tx, '*'); });
  folderFiles.forgetFolder(record.id);
  K.forgetGrant(record.id);
  K.muchLater();
}

// ── The library's folders ──

// Where the library is kept: this browser, then each library folder in the order they were added —
// [{ id, kind: 'browser'|'folder', name, isDefault, access, galleries, size, removable, hidden? }].
// `access`: 'granted', 'prompt' (one click lets this page use it: folderAllow), 'unavailable' (not
// there) or 'taken' (another app holds it, `owner` which). A hidden place counts the galleries it hid.
async function foldersList() {
  const { byId, defaultId, browser } = await K.folders();
  const tally = new Map([[K.BROWSER, { galleries: 0, size: 0 }], ...[...byId.keys()].map(id => [id, { galleries: 0, size: 0 }])]);
  for (const g of await K.galleryGetAll()) {
    const t = tally.get(g.folder && byId.has(g.folder) ? g.folder : K.BROWSER);
    t.galleries++;
    t.size += Number(g.size) || 0;
  }
  const counts = (place) => ({ ...tally.get(place.id), ...(place.state === 'hidden' ? { hidden: true } : {}) });
  const out = [{ id: K.BROWSER, kind: 'browser', name: '', isDefault: !defaultId, access: 'granted', removable: false, ...counts(browser) }];
  for (const f of [...byId.values()].sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0))) {
    K.forgetGrant(f.id);
    const { state, owned, claim } = await K.access(f.id);
    const taken = state === 'granted' && !owned;
    out.push({ id: f.id, kind: 'folder', name: f.name, isDefault: f.id === defaultId,
      access: taken ? 'taken' : state === 'denied' ? 'prompt' : state, removable: true, ...counts(f),
      ...(taken ? { owner: _ownerOf(claim) } : {}) });
  }
  return out;
}

// The library folders holding galleries that this page may not use yet, but may with one click
// (folderAllow): [{ id, name }]. A hidden folder isn't asked for: nothing of it is read or written
// until it is shown. Reads no gallery unless some folder waits.
async function foldersWaiting() {
  const { byId } = await K.folders();
  const waiting = [];
  for (const f of byId.values()) if (mounted(f.state) && await folderFiles.permission(f.handle) === 'prompt') waiting.push(f);
  if (!waiting.length) return [];
  const used = new Set((await K.galleryGetAll()).map(g => g.folder).filter(Boolean));
  return waiting.filter(f => used.has(f.id)).map(f => ({ id: f.id, name: f.name }));
}

// A folder's own id, kept in its .shiori/library.json — the file a desktop library folder keeps its
// id in, the same format — and written the first time: the folder is known by it wherever it is
// reached from (another drive letter, a folder renamed or moved), and removing it from the library
// and adding it again finds what it held. A file that can't be read is an error, never a reason to
// start over under a new id.
const LIBRARY_FILE = '.shiori/library.json';
async function _folderIdOf(handle) {
  const probe = `probe-${Date.now()}-${Math.random()}`;
  try {
    const file = await folderFiles.readFile(probe, handle, LIBRARY_FILE).catch((e) => {
      throw new BackendError('unavailable', `${LIBRARY_FILE} can't be read: ${e?.message || e}`);
    });
    if (file) {
      const id = JSON.parse(await file.text())?.id;
      if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) throw new BackendError('invalid', `${LIBRARY_FILE} names no library id`);
      return id;
    }
    const id = K.randomId();
    await folderFiles.writeFile(probe, handle, LIBRARY_FILE, JSON.stringify({ format: 'shiori-library', version: 1, id }, null, 2));
    return id;
  } finally { folderFiles.forgetFolder(probe); }
}

// A folder the person picked (its handle) joins the library's folders, claimed by this library
// (folder-owner.js). Its galleries are found by checking it (folderScan, which the caller runs next —
// a task of its own). Added back while it is being removed, with its claim untouched since this
// library let it go (unchangedSince) and its removal short of forgetting it (_callOffRemoval), the
// removal ends and its galleries are back as they were; otherwise once that removal has ended, as a
// folder never seen (another app had it meanwhile: what the library has of it is out of date and
// goes, the check reading it as it is). Resolves { id,
// restored } — for a folder already among them, its id and `existed`. Refused (`invalid`): a folder
// inside another of them or holding one (reason 'nested'), a copy of one of them (reason 'copy': it
// carries the same id), and one another app holds (reason 'claimed', `owner` who) — unless `force`:
// this library takes it over.
async function folderAdd(handle, { force = false } = {}) {
  if (handle?.kind !== 'directory') throw new BackendError('invalid', 'not a folder');
  if (await folderFiles.permission(handle) !== 'granted') throw new BackendError('unavailable', 'the folder can\'t be used');
  const id = await _folderIdOf(handle);
  const listed = await _listedAs(id, handle);
  if (listed) return listed;
  const me = await K.me();
  const read = await K.readClaim(id, handle);
  const leaving = (await K.folders()).removing.get(id) || null;
  const got = nextClaim(read, me, K.myLabel(), { held: leaving?.epoch ?? null, force });
  if (got.refused) _refuse('claimed', 'the folder is in use by another app', { owner: _ownerOf(got.refused) });
  if (leaving && unchangedSince(read, me, leaving.epoch ?? null)) {
    if (got.changed) await K.writeClaim(id, handle, got.claim);
    if (await _callOffRemoval({ ...leaving, name: handle.name, handle, epoch: got.claim.epoch })) return { id, restored: (await _placedIn(id)).length };
    // Its removal is past its point of no return (F11): once it has ended, the folder is added afresh.
  }
  return folderFiles.withLock(FOLDER_LOCK(id), async () => {
    const f = await K.folders();
    if (f.byId.has(id)) return _listedAs(id, handle);   // its removal was kept
    if (f.removing.has(id)) await _forget(id);           // stopped half way: what it had is out of date
    if (got.changed) await K.writeClaim(id, handle, got.claim);
    await _putPlace({ id, name: handle.name, handle, addedAt: Date.now(), epoch: got.claim.epoch }, 'shown');
    return { id, restored: 0 };
  });
}
// Folder `record.id`'s removal called off, the folder shown again as `record` has it — in a
// transaction that finds it still being removed and short of its point of no return (`removal.phase`
// 'forget', set by _enterForget in a transaction of its own: IndexedDB puts one after the other).
// Resolves whether it was.
async function _callOffRemoval(record) {
  let done = false;
  await K.folderWrite((store, tx) => {
    const req = store.get(record.id);
    req.onsuccess = () => {
      if (req.result?.state !== 'removing' || req.result.removal?.phase === 'forget') return;
      const { removal, ...rest } = record;
      store.put({ ...rest, state: 'shown' });
      K.logIn(tx, '*');
      done = true;
    };
  });
  if (done) { folderFiles.forgetFolder(record.id); K.forgetGrant(record.id); K.muchLater(); }
  return done;
}
// Removing folder `id`, its point of no return: from here it forgets the folder, and adding it back
// waits for that (_callOffRemoval) — in a transaction that finds it still being removed (not added
// back meanwhile). Resolves whether it was.
async function _enterForget(id) {
  let done = false;
  await K.folderWrite((store) => {
    const req = store.get(id);
    req.onsuccess = () => {
      if (req.result?.state !== 'removing') return;
      store.put({ ...req.result, removal: { ...req.result.removal, phase: 'forget' } });
      done = true;
    };
  });
  return done;
}

// Folder `id` (read through `handle`) as the library lists it already — { id, restored, existed }, a
// hidden one shown — or null when it doesn't. Refused when `handle` is a copy of one of them, or
// nests in one or holds one.
async function _listedAs(id, handle) {
  const { byId } = await K.folders();
  const active = byId.get(id);
  if (active) {
    if (!(await folderFiles.sameFolder(active.handle, handle))) _refuse('copy', 'the folder is a copy of one of the library\'s folders');
    return active.state === 'hidden' ? folderShow(id) : { id, restored: 0, existed: true };
  }
  for (const f of byId.values()) {
    if (await f.handle.resolve(handle).catch(() => null) || await handle.resolve(f.handle).catch(() => null)) {
      _refuse('nested', 'a library folder inside another would hold the same galleries twice');
    }
  }
  return null;
}

// Folder `id`, taken over by another app, held by this library again (from a click — the person told
// what that risks): what waited in this browser for it moves out. Resolves its access.
async function folderClaim(id) {
  const folder = (await K.folders()).byId.get(id);
  if (!folder) throw _notFound(id);
  if (await folderFiles.permission(folder.handle) !== 'granted') throw new BackendError('unavailable', `library folder ${id} can't be reached`);
  const { claim, changed } = nextClaim(await K.readClaim(id, folder.handle), await K.me(), K.myLabel(), { held: folder.epoch ?? null, force: true });
  if (changed) await K.writeClaim(id, folder.handle, claim);
  await K.noteEpoch(id, claim.epoch);
  K.forgetGrant(id);
  const { owned } = await K.access(id);   // read back: this library's only if the claim now says so
  if (owned) K.settleFolders().catch(() => {});
  return owned ? 'granted' : 'taken';
}

// Where new galleries go: folder `id`, or this browser (BROWSER) — a place shown, and not a folder
// another app holds (reason 'taken').
async function folderSetDefault(id) {
  const folder = id == null || id === K.BROWSER ? null : String(id);
  const { place, hidden } = await K.placeOf(folder || K.BROWSER);
  if (!place) throw _notFound(folder);
  if (hidden) _refuse('hidden', 'a hidden place is never the default');
  if (folder) {
    const a = await K.access(folder);
    if (a.state === 'granted' && !a.owned) _refuse('taken', 'a folder another app keeps is never the default');
  }
  await K.folderWrite((store) => store.put({ id: K.DEFAULT_FOLDER, folder }));
}

// This page asks the person to let it use folder `id` (from a click), and moves out what waited in
// this browser for it once it may. Resolves the folder's access, as foldersList gives it.
async function folderAllow(id) {
  const folder = (await K.folders()).byId.get(id);
  if (!folder) throw _notFound(id);
  const state = await folderFiles.permission(folder.handle, { ask: true });
  K.forgetGrant(id);
  if (state === 'granted') {
    platform.control.send({ type: 'FOLDERS_CHANGED' });
    K.settleFolders().catch(() => {});
  }
  return state === 'denied' ? 'prompt' : state;
}

// ── Hiding and showing ──

// Place `id` (a folder of the library's, or this browser: BROWSER) hidden — at once: it stays listed,
// state 'hidden', and its galleries leave the library (out of it while it is hidden: nothing of
// theirs moves, and nothing is written to it — a write to one of them is refused as it commits, the
// kernel's mount check; what they owe the folder is written once it is shown) until it is shown again
// (folderShow). The default place can't be hidden. Resolves { id, galleries }: how many left.
async function folderHide(id) {
  const key = String(id);
  const { place, hidden } = await K.placeOf(key);
  if (!place) throw _notFound(key);
  if (hidden) return { id: key, galleries: 0 };
  const f = await K.folders();
  if (!canHide({ state: place.state, isDefault: key === (f.defaultId || K.BROWSER) })) _refuse('default', 'the default place stays shown');
  const galleries = (await K.galleryGetAll()).filter(g => _keptIn(key, g, f)).length;
  await _putPlace(place, 'hidden');
  return { id: key, galleries };
}

// Hidden place `id` shown again: its galleries are back in the library at once, and what waited while
// it was hidden is written there. Resolves { id, restored }.
async function folderShow(id) {
  const key = String(id);
  const { place, hidden } = await K.placeOf(key);
  if (!place) throw _notFound(key);
  if (!hidden) return { id: key, restored: 0 };
  await _putPlace(place, 'shown');
  K.settleFolders().catch(() => {});
  const f = await K.folders();
  return { id: key, restored: (await K.galleryGetAll()).filter(g => _keptIn(key, g, f)).length };
}

// ── Removing a folder ──

// Folder `id` leaves the library's folders — at once (its state 'removing', `removal` { moveTo,
// discard, before }): it is no longer listed, new galleries no longer go to it, and its galleries
// leave the library (a write to one is refused as it commits). What it still owes the folder is
// folderSetAside's work, a task of its own (folder-scan.js), carried on by the next page opened should
// it be cut short (foldersPending). `moveTo`: a place its galleries are moved to first — one that can
// take them now (shown, and a folder this context may write to: refused, reason 'move-to', else; the
// page asks the person's leave first). A folder this context can't write to now while galleries of it
// have what only this library has is refused (reason 'unsaved', `galleries` how many) — unless
// `discard`: that is lost. The default leaves with it (folder-lifecycle.js nextDefault: this browser,
// or the first other folder that can be the default; none — reason 'default'). Resolves { id,
// galleries }: how many leave it.
async function folderRemove(id, { moveTo = null, discard = false } = {}) {
  const f = await K.folders();
  const folder = f.byId.get(id);
  if (!folder) throw _notFound(id);
  const to = moveTo == null ? null : String(moveTo);
  if (to) {
    const place = to === K.BROWSER ? f.browser : to !== id ? f.byId.get(to) : null;
    if (!place || !mounted(place.state)) throw new BackendError('not-found', `no place ${to} to move to`);
    if (to !== K.BROWSER && !(await K.usable(to))) _refuse('move-to', `library folder ${to} can't take galleries now`);
  }
  let next;
  if (f.defaultId === id) {
    next = nextDefault(await _places(f), id);
    if (!next) _refuse('default', 'no other place is shown to keep new galleries in');
  }
  const galleries = (await _placedIn(id)).length;
  const now = await K.access(id);
  if (!discard && !(now.state === 'granted' && now.owned)) {   // its removal couldn't write back
    const n = (await _unsavedIn(id)).length;
    if (n) _refuse('unsaved', `${n} galleries have changes not saved to library folder ${id}`, { galleries: n });
  }
  await K.folderWrite((store, tx) => {
    store.put({ ...folder, state: 'removing', removal: { moveTo: to, discard: !!discard, before: folder.state } });
    if (next) store.put({ id: K.DEFAULT_FOLDER, folder: next === K.BROWSER ? null : next });
    K.logIn(tx, '*');
  });
  K.muchLater();
  return { id, galleries };
}
// The library's places as folder-lifecycle.js weighs them: this browser first, then each folder in
// the order they were added — { id, state, owned, reachable }.
async function _places(f) {
  const out = [{ id: K.BROWSER, state: f.browser.state, owned: true, reachable: true }];
  for (const folder of [...f.byId.values()].sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0))) {
    const a = await K.access(folder.id);
    out.push({ id: folder.id, state: folder.state, owned: a.owned, reachable: a.state === 'granted' });
  }
  return out;
}

// What folder `id`, removed, still owes it — while lock shiori:folder:<id> is held:
// 1. its galleries moved to the place chosen, each on its own: `moved`, or `left` (one that couldn't
//    be — that place hidden, removed or taken over before the move commits: it stays among the rest);
// 2. every gallery still placed there (the required set) written back while the write gate lets its
//    removal write there (`work`: its own, _workOn): what waits in this browser moved out, a folder of its own
//    for one with none, every description that differs — each confirmed positively (_writeBack).
//    While it may not write there, a gallery with nothing waiting counts as saved. The notes of
//    linked sources let go from it are written there too;
// 3. folder-lifecycle.js removalOutcome: with something unsaved and the person not having chosen to
//    lose it, the removal is kept — the folder back in the state it had before (a hidden one stays
//    hidden), an error (`errorKey` 'lf.task_kept', `unsaved` and `left` how many);
// 4. else its point of no return (_enterForget: from here adding it back waits), then the folder is
//    let go (another app may take it without asking — one out of reach keeps its claim, and the next
//    app to add it asks) and forgotten, its galleries' records with it.
// `onProgress(done, total)` as it goes; it ends there once `stopped()`, or once the folder is added
// back. Resolves { removed (galleries forgotten with it), moved, left, stopped }.
async function folderSetAside(id, opts = {}) {
  return K.bulkRun(() => folderFiles.withLock(FOLDER_LOCK(id), () => _setAside(String(id), opts)));
}
async function _setAside(id, { onProgress = () => {}, stopped = () => false } = {}) {
  const work = { kind: 'removal', folder: id };   // folder work (db.js _workOn): this folder's removal
  const still = async () => (await K.folders()).removing.get(id) || null;
  const out = { removed: 0, moved: 0, left: 0, stopped: false };
  const halt = async () => (stopped() || !(await still()) ? { ...out, stopped: true } : null);
  const first = await still();
  if (!first) return { ...out, stopped: true };
  if (first.removal?.moveTo) {
    const ids = (await _placedIn(id)).map(g => String(g.galleryId));
    onProgress(0, ids.length);
    for (const [i, gid] of ids.entries()) {
      const end = await halt();
      if (end) return end;
      try { if (await K.relocate(gid, first.removal.moveTo, () => {}, { work })) out.moved++; } catch { out.left++; }
      onProgress(i + 1, ids.length);
    }
  }
  const required = await _placedIn(id);
  const saved = new Set();
  const marked = await K.marked();
  onProgress(0, required.length);
  for (const [i, g] of required.entries()) {
    const end = await halt();
    if (end) return end;
    const gid = String(g.galleryId);
    if (await K.usable(id, { work }) ? await _writeBack(id, g) : !_waiting(g, marked)) saved.add(gid);
    onProgress(i + 1, required.length);
  }
  // One not written (the folder out of reach for a moment) is tried once more.
  if (await K.usable(id, { work })) for (const g of required) if (!saved.has(String(g.galleryId)) && await _writeBack(id, g)) saved.add(String(g.galleryId));
  const end = await halt();
  if (end) return end;
  // The notes of linked sources let go from it (deleted before, or moved out above) written there: one
  // still owed is as unsaved as a gallery (forgotten, the folder would add its source again).
  await K.publishRemoved(id, work);
  const owed = (await K.removedNotes(id)).map(n => n.gid);
  const place = await still();
  const { forget, unsaved } = removalOutcome({ required: [...required.map(g => String(g.galleryId)), ...owed], saved, discard: !!place.removal?.discard });
  if (!forget) {
    await _putPlace(place, place.removal?.before || 'shown');
    throw Object.assign(new BackendError('unavailable', `what library folder ${id} is owed couldn't be written there: it stays`),
      { errorKey: 'lf.task_kept', unsaved: unsaved.length, ...(out.left ? { left: out.left } : {}) });
  }
  if (!(await _enterForget(id))) return { ...out, stopped: true };   // added back meanwhile
  await _release(id).catch(() => {});
  await _forget(id);
  return { ...out, removed: required.length };
}
// Gallery `g` (its stat record) of folder `id` written back there by its removal — its galleries take
// no writes meanwhile (out of the library: the mount check), so what is written now is all it has.
// Resolves whether it is confirmed saved: described there, nothing left in this browser, a folder of
// its own.
async function _writeBack(id, g) {
  const gid = String(g.galleryId), work = { kind: 'removal', folder: id };
  if (g.spilled) await K.relocate(gid, id, () => {}, { work }).catch(() => {});
  if (!g.dir) {
    await K.writing(gid, async (w) => {
      const root = await K.rootOf(id, { work });
      const dir = root && await K.reserveDir(gid, id, root, null, w);
      if (dir) await K.patchStat(gid, (cur) => (cur.dir ? null : { ...cur, dir }));
      w.committed = !!dir;
    }).catch(() => {});
  }
  K.cancelDescribe(gid);
  const described = await K.describe(gid, { work }).catch(() => ({ ok: false }));
  const now = await K.galleryGet(gid);
  return described.ok && !!now && !now.spilled && !!now.dir;
}
// Whether gallery `g` has something only this library has — pictures waiting in this browser, changes
// not written to its folder yet (`marked`), no folder of its own there (described only here) — which
// forgetting its folder would lose.
const _waiting = (g, marked) => !!g.spilled || marked.has(String(g.galleryId)) || !g.dir;
async function _unsavedIn(id) {
  const marked = await K.marked();
  return (await _placedIn(id)).filter(g => _waiting(g, marked));
}
// Folder `id` let go by this library: its claim released, when it holds it and can reach it.
async function _release(id) {
  const folder = await K.folderById(id);
  if (!folder || await folderFiles.permission(folder.handle) !== 'granted') return;
  const next = releasedClaim(await K.readClaim(id, folder.handle), await K.me());
  if (next) await K.writeClaim(id, folder.handle, next);
}
// Folder `id` forgotten: every record of its galleries gone (their files stay — the folder has what
// the library had of them), and the folder with them, a trace in the change log: added again, it is
// checked as one never seen.
async function _forget(id) {
  await _dropRecords(id);
  const owed = await K.removedNotes(id);   // written, or lost by the person's choice
  await K.folderWrite((store, tx) => { store.delete(id); for (const n of owed) store.delete(n.id); K.logIn(tx, '*'); });
  folderFiles.forgetFolder(id);
  K.muchLater();
}
// The galleries of folder `folder` let go — their records deleted, their files kept.
async function _dropRecords(folder) {
  const gids = (await _placedIn(folder)).map(g => String(g.galleryId));
  const db = await K.openDB();
  const S = K.stores;
  for (let at = 0; at < gids.length; at += 50) {
    const gone = [];
    await new Promise((resolve, reject) => {
      const tx = K.tx(db, [S.STORE, S.META, S.GALLERY, S.COVER, S.BLOB], 'readwrite');
      tx._keepFiles = true;
      tx._work = { kind: 'forget', folder };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(K.txError(tx));
      for (const gid of gids.slice(at, at + 50)) K.deleteIn(tx, gid, (meta) => gone.push([gid, meta]));
    });
    for (const [gid, meta] of gone) K.afterDelete(gid, meta);
  }
}

// What a page should carry on with: folders being removed whose task hasn't ended — { setAside: [{ id,
// name, moving }] } (`moving`: its galleries are moved elsewhere first) — a folder an earlier version
// removed among them (IndexedDB 19 made it one being removed, so its removal writes back what only the
// library has of it before forgetting it). Galleries an earlier version set aside (the dormant store)
// are brought back first — out of the library still while their folder is hidden or being removed —
// and notes of removed sources still owed to a folder are written there (db.js publishRemoved).
async function foldersPending() {
  await _unsetAside().catch(() => {});
  for (const id of new Set((await K.removedNotes().catch(() => [])).map(n => n.folder))) K.publishRemoved(id);
  const { removing } = await K.folders();
  return { setAside: [...removing.values()].map(f => ({ id: f.id, name: f.name || '', moving: !!f.removal?.moveTo })) };
}
async function _unsetAside() {
  const db = await K.openDB();
  const folders = await new Promise((resolve, reject) => {
    const tx = K.tx(db, K.stores.DORMANT, 'readonly');
    const req = tx.objectStore(K.stores.DORMANT).getAll();
    tx.oncomplete = () => resolve(new Set((req.result || []).map(r => r.folder)));
    tx.onerror = () => reject(K.txError(tx));
  });
  for (const folder of folders) await K.bulkRun(() => _restoreDormant(folder));
}
// The images in the blob store a gallery's records an earlier version set aside refer to: their ids.
const _asideBlobIds = (rec) => [...rec.pages.flatMap(p => K.PAGE.slots(p)), ...(rec.cover ? K.COVER.slots(rec.cover) : [])]
  .map(([obj, key]) => obj[key]?.[K.REF]).filter(id => typeof id === 'string');
// The galleries place `folder` held when an earlier version removed or hid it, back in the library as
// they were — but not one whose own folder is no longer in it (its images go with it), nor one the
// library has meanwhile. Resolves how many.
async function _restoreDormant(folder) {
  const db = await K.openDB();
  const S = K.stores;
  const aside = await new Promise((resolve, reject) => {
    const tx = K.tx(db, S.DORMANT, 'readonly');
    const req = tx.objectStore(S.DORMANT).index('folder').getAll(IDBKeyRange.only(folder));
    tx.oncomplete = () => resolve(req.result || []);
    tx.onerror = () => reject(K.txError(tx));
  });
  if (!aside.length) return 0;
  const root = await K.readRootOf(folder);
  const known = new Set(await K.transferIds());
  const back = [];
  for (const rec of aside) {
    const there = !root || !rec.stat?.dir || (await folderFiles.list(folder, root, rec.stat.dir).catch(() => [])).length > 0;
    const restore = there && !known.has(rec.gid);
    await new Promise((resolve, reject) => {
      const tx = K.tx(db, [S.STORE, S.META, S.GALLERY, S.COVER, S.BLOB, S.DORMANT], 'readwrite');
      tx._work = { kind: 'migration', folder };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(K.txError(tx));
      tx.objectStore(S.DORMANT).delete(rec.gid);
      if (!there && !known.has(rec.gid)) for (const blob of _asideBlobIds(rec)) tx.objectStore(S.BLOB).delete(blob);
      if (!restore) return;
      if (rec.meta) tx.objectStore(S.META).put(K.canonicalMeta(rec.meta));
      const { undescribed, ...stat } = rec.stat;   // its folder's removal or showing writes it there
      tx.objectStore(S.GALLERY).put(stat);
      const images = tx.objectStore(S.STORE);
      for (const page of rec.pages) images.put(K.stash(tx, page, [], K.PAGE));
      if (rec.cover) tx.objectStore(S.COVER).put(K.stash(tx, rec.cover, [], K.COVER));
      K.logIn(tx, rec.gid);
    });
    if (restore) { back.push(rec.gid); known.add(rec.gid); }
  }
  await _tidySeriesLinks(back, folder);
  for (const gid of back) K.publishFeed(gid);
  return back.length;
}

// ── Checking a folder ──

// What folder `id` holds read into the library, while lock shiori:folder:<id> is held (one check at a
// time, never during its removal):
// 1. what it holds (_walk): Shiori's own galleries — folders and archives in the gallery format, a
//    series export's chapters (folder-content.js) — and everything else, as linked titles
//    (linked-source.js planTitles; an archive's from it, zipTitles), each with its fingerprint as it
//    is now;
// 2. joining: an own gallery the library hasn't is read where it lies (an archive in place, unpacked
//    on its first change); one it keeps here whose place is gone (renamed, moved, packed or unpacked
//    by hand or by another app) is read again where it is now — any other it has is a copy, left
//    alone. Linked titles are matched with what the library keeps here and the overlays the folder
//    holds (matchSources): one moved or renamed takes its gallery along (an archive's chapters by
//    their folder in it), one whose files changed is read again, one removed before stays out, and
//    the rest join — an archive's new chapters as a series, a PDF once its pages are drawn;
// 3. comparing: galleries it keeps whose descriptions another app changed there are read again.
// Every re-read is guarded where it commits: a gallery with changes of its own still to be written to
// its folder, or pictures waiting in this browser, is left as it is (local changes win). A series
// link to a gallery not there is kept (_tidySeriesLinks). `onProgress(done, total, added, step)` as
// it goes, each step counted on its own: 'lf.task_checking', 'lf.task_adding', 'lf.task_comparing';
// it ends there once `stopped()`. Resolves { added, updated, problems: [{ path, reason }] — what
// couldn't be read ('unreadable': a folder or file; 'corrupt': an archive; 'unsupported': a format
// this library doesn't read; 'adopt-failed': a gallery that couldn't join) — stopped }.
async function folderScan(id, opts = {}) {
  return K.bulkRun(() => folderFiles.withLock(FOLDER_LOCK(id), () => _check(String(id), opts)));
}
async function _check(id, { onProgress = () => {}, stopped = () => false } = {}) {
  const folder = await K.folderById(id);
  if (!folder) throw _notFound(id);
  if (folder.state !== 'shown') _refuse(folder.state === 'hidden' ? 'hidden' : 'removing', `library folder ${id} is ${folder.state}`);
  const root = await K.rootOf(id);
  if (!root) throw new BackendError('unavailable', `library folder ${id} can't be reached`);
  const run = { id, root, name: folder.name || '', stopped, known: new Set(await K.transferIds()), added: [], updated: new Set(), problems: [] };
  const kept = (await _placedIn(id)).filter(g => g.dir);
  const step = _steps(run, onProgress);

  step.begin('lf.task_checking', 0);
  const found = await _walk(run, new Set(kept.filter(g => !g.linked).map(g => g.dir.toLowerCase())));
  const titles = await _linkedTitles(run, found, step);
  const plan = matchSources({ found: titles, kept: kept.filter(g => g.linked).map(g => ({ gid: String(g.galleryId), source: g.linked })),
    overlays: await _overlaysOf(id, root), known: run.known, removed: await _removedOf(run) });

  step.begin('lf.task_adding', found.own.length + plan.moved.length + plan.changed.length + plan.new.length);
  for (const own of found.own) {
    if (stopped()) break;
    await _joinOwn(run, own, kept);
    step.tick();
  }
  for (const m of [...plan.moved, ...plan.changed]) {
    if (stopped()) break;
    await (m.kept === false ? _link(run, m.title, m.gid) : _relink(run, m.title, m.gid));
    step.tick();
  }
  await _linkNew(run, plan.new, step);

  step.begin('lf.task_comparing', kept.length);
  for (const stat of kept) {
    if (stopped()) break;
    await _catchUp(run, stat);
    step.tick();
  }
  const changed = [...run.added, ...run.updated];
  await _tidySeriesLinks(changed, run.id);
  for (const gid of changed) K.publishFeed(gid);
  return { added: run.added.length, updated: run.updated.size, problems: run.problems, stopped: !!stopped() };
}
// A check's progress, step by step (each counted on its own).
function _steps(run, onProgress) {
  let step = 'lf.task_checking', total = 0, done = 0;
  return {
    begin(next, n) { step = next; total = n; done = 0; onProgress(0, total, run.added.length, step); },
    tick() { onProgress(Math.min(++done, total), total, run.added.length, step); },
  };
}

// What folder `run.id` holds — hidden files and folders, and the library's own .shiori, left out;
// folders as deep as WALK_DEPTH — { own: Shiori's own galleries found ({ kind: 'dir' | 'zip', path, id,
// legacy? } — or { kind: 'zip', path, series } for a series export), ownPaths: where they and the
// galleries the library keeps there are (not looked into: `skip`, lower-cased), files: [{ path }]
// everything else }. A folder that can't be listed, an archive that can't be read, are reported.
const WALK_DEPTH = 12;
async function _walk(run, skip) {
  const out = { own: [], ownPaths: [], files: [] };
  const walk = async (path, depth) => {
    if (run.stopped()) return;
    if (path && skip.has(path.toLowerCase())) { out.ownPaths.push(path); return; }
    let entries;
    try { entries = await folderFiles.list(run.id, run.root, path); } catch { run.problems.push({ path: path || '.', reason: 'unreadable' }); return; }
    const what = path ? await _classifyDir(run, path, entries) : { kind: 'other' };
    if (!what) { out.ownPaths.push(path); return; }   // its description unreadable: left as it is
    if (what.kind === 'gallery') { out.own.push({ kind: 'dir', path, id: what.id, legacy: !!what.legacy }); out.ownPaths.push(path); return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === '__MACOSX') continue;
      const p = path ? `${path}/${e.name}` : e.name;
      if (e.kind === 'directory') { if (depth < WALK_DEPTH) await walk(p, depth + 1); continue; }
      if (ARCHIVE_NAME.test(e.name)) {
        const zip = skip.has(p.toLowerCase()) ? { kept: true } : await _classifyZip(run, p);
        if (zip) { if (zip.kind) out.own.push(zip); if (!zip.corrupt) out.ownPaths.push(p); continue; }
      }
      if (what.kind !== 'series') out.files.push({ path: p });   // beside a series' members: its own files
    }
  };
  await walk('', 0);
  return out;
}
// What folder `path` (its `entries`) is: folder-content.js classifyFolder, from those of its own files
// it has. One whose description can't be read is reported and null: nothing is concluded from it —
// read neither as Shiori's nor as linked (F06).
async function _classifyDir(run, path, entries) {
  const names = new Set(entries.filter(e => e.kind === 'file').map(e => e.name));
  const texts = {};
  for (const name of OWN_FILES) {
    if (!names.has(name)) continue;
    try { texts[name] = await folderFiles.readText(run.id, run.root, `${path}/${name}`); } catch {
      run.problems.push({ path: `${path}/${name}`, reason: 'unreadable' });
      return null;
    }
  }
  return classifyFolder(texts);
}
// What the archive at `path` is: Shiori's own (folder-content.js classifyArchive) — { kind: 'zip',
// path, id, legacy? } or, a series export, { kind: 'zip', path, series } — or null (linked). One that
// can't be read is reported and left out: { corrupt: true }.
async function _classifyZip(run, path) {
  let archive;
  try { archive = await K.archiveOf(run.id, run.root, path); } catch (e) {
    run.problems.push({ path, reason: e instanceof DOMException ? 'unreadable' : 'corrupt' });   // its file, or what it holds
    return { corrupt: true };
  }
  if (!archive) return { corrupt: true };   // gone meanwhile
  const texts = {};
  for (const name of OWN_FILES) { const e = archive.entries.get(name); if (e) texts[name] = await _entryText(e).catch(() => null); }
  const what = classifyArchive([...archive.entries.keys()], texts);
  if (what.kind === 'gallery') return { kind: 'zip', path, id: what.id, legacy: !!what.legacy };
  if (what.kind === 'series') return { kind: 'zip', path, series: what.series };
  return null;
}
const _entryText = async (entry) => new TextDecoder().decode(await entry.read());

// ── Shiori's own galleries ──

// A gallery in the gallery format found in the folder (`found`: a folder, an archive read in place,
// or a series export's chapters — `inner` each one's folder in it) joined to the library. One the
// library has is a copy, left alone — unless it keeps it in this folder at a place that is gone: read
// again where it is now.
async function _joinOwn(run, found, kept) {
  if (found.legacy) { run.problems.push({ path: found.path, reason: 'unsupported' }); return; }
  if (found.series) {
    for (const c of found.series.chapters) if (c.present) await _joinOwn(run, { kind: 'zip', path: found.path, inner: `${c.folder}/`, id: c.id }, kept);
    return;
  }
  try {
    if (!run.known.has(found.id)) {
      const gid = await _adopt(run, found);
      if (gid) { run.known.add(gid); run.added.push(gid); }
      return;
    }
    const was = kept.find(g => String(g.galleryId) === found.id && !g.linked);
    if (was && !_samePlace(was, found) && !(await _there(run, was)) && await _adopt(run, found, { replace: found.id })) run.updated.add(found.id);
  } catch (e) { run.problems.push({ path: `${found.path}${found.inner ? `/${found.inner}` : ''}`, reason: _failure(e) }); }
}
// Why a gallery couldn't be read or joined, for `problems`: its files couldn't be read (_readFormat's
// 'unreadable'), or it couldn't be stored ('adopt-failed').
const _failure = (e) => (e?.reason === 'unreadable' ? 'unreadable' : 'adopt-failed');
const _samePlace = (stat, found) => stat.dir === found.path && (stat.packed?.inner || '') === (found.inner || '');
// Whether a kept gallery's place is still there: its archive, or its folder.
async function _there(run, stat) {
  if (stat.packed) return folderFiles.readFile(run.id, run.root, stat.dir).then(Boolean, () => true);   // one that can't be read is there
  return (await folderFiles.list(run.id, run.root, stat.dir).catch(() => [null])).length > 0;
}

// What a gallery in the gallery format holds, read where it lies: { texts (its descriptions,
// DESCRIPTION_FILES, as read), meta, records, bubbles, manifest (parsed), files (path in the gallery →
// { size, type }: images/ and what was made from its pages), pictures (which file holds each picture:
// gallery-files.js folderPictures), ref(path) (a reference to that file where it lies; null when it
// isn't there) }. `found`: { kind: 'dir', path } a folder, or { kind: 'zip', path, inner } an archive —
// `inner` the gallery's folder in a series export ('' for an archive of its own). What isn't there
// holds nothing; anything else that can't be read fails the read whole, with `reason: 'unreadable'`
// (F06): a gallery read in part would lose what it couldn't see.
const FORMAT_DIRS = ['images', 'translated', 'study/bg', 'study/text', 'pipeline', 'covers'];
async function _readFormat(folder, root, found) {
  try {
    return await (found.kind === 'zip' ? _readArchive(folder, root, found.path, found.inner || '') : _readDir(folder, root, found.path));
  } catch (e) {
    throw e instanceof BackendError ? e : Object.assign(new BackendError('unavailable', `${found.path} couldn't be read: ${e?.message || e}`), { reason: 'unreadable' });
  }
}
async function _readDir(folder, root, dir) {
  const texts = {};
  for (const name of DESCRIPTION_FILES) texts[name] = await folderFiles.readText(folder, root, `${dir}/${name}`);
  const files = new Map();
  for (const sub of FORMAT_DIRS) {
    for (const e of await folderFiles.list(folder, root, `${dir}/${sub}`)) {
      if (e.kind !== 'file' || !IMAGE_NAME.test(e.name)) continue;
      const file = await e.file().catch((err) => { if (err?.name === 'NotFoundError') return null; throw err; });   // gone meanwhile
      if (file) files.set(`${sub}/${e.name}`, { size: file.size, type: K.typeOfName(e.name) });
    }
  }
  return _format(texts, files, (path) => ({ $path: path, folder, dir }));
}
async function _readArchive(folder, root, path, inner) {
  const archive = await K.archiveOf(folder, root, path);
  if (!archive) throw new BackendError('not-found', `${path} isn't there`);
  const texts = {};
  for (const name of DESCRIPTION_FILES) {
    const e = archive.entries.get(`${inner}${name}`);
    texts[name] = e ? await _entryText(e) : null;
  }
  const files = new Map();
  for (const [name, e] of archive.entries) {
    if (!name.startsWith(inner)) continue;
    const rel = name.slice(inner.length);
    if (IMAGE_NAME.test(rel) && FORMAT_DIRS.includes(rel.slice(0, rel.lastIndexOf('/')))) files.set(rel, { size: e.size, type: K.typeOfName(rel) });
  }
  return _format(texts, files, (p) => ({ $path: `${inner}${p}`, folder, dir: path, zip: 1 }));
}
function _format(texts, files, at) {
  const json = (name) => { try { return texts[name] == null ? null : JSON.parse(texts[name]); } catch { return null; } };
  const records = json('image_records.json'), manifest = json('covers/manifest.json');
  return { texts, meta: json('metadata.json'), records, bubbles: json('study/bubbles.json') || {}, manifest, files,
    pictures: folderPictures(files.keys(), { records, manifest }), ref: (path) => (files.has(path) ? { ...at(path), ...files.get(path) } : null) };
}
// Its covers of its own, both roles, as covers/manifest.json names them (gallery-files.js
// folderPictures): { cover?, seriesCover? }.
function _ownCovers({ pictures, ref }) {
  const out = {};
  if (pictures.covers.gallery) out.cover = ref(pictures.covers.gallery);
  if (pictures.covers.series) out.seriesCover = ref(pictures.covers.series);
  return out;
}
// The image_records.json entries of a gallery's description, by page number.
const _entriesOf = (records) => new Map((Array.isArray(records) ? records : []).map(r => [K.keyPage(r?.url), r]).filter(([n]) => n != null));

// Own gallery `found` (_readFormat's) joined to the library, its records referring to its files where
// they lie — an archive's as its entries (`packed`: it stays an archive until its first change unpacks
// it). Its page numbers are its pictures' (sparse ones kept) and its records its description's.
// `replace`: a gallery the library keeps, read again from there. Resolves its id, or null when there
// is nothing to read (or it wasn't read again: _storeAdopted).
async function _adopt(run, found, { replace = null } = {}) {
  const read = await _readFormat(run.id, run.root, found);
  const gid = replace || found.id;
  if (galleryIdOf(read.texts['metadata.json']) !== gid) return null;   // described as another gallery now
  const entries = _entriesOf(read.records);
  const now = Date.now();
  const pages = [...read.pictures.pages].map(([n, path]) => {
    const entry = entries.get(n);
    const url = entry?.url && K.keyPage(entry.url) === n ? entry.url : `local://${gid}/${n}.${path.match(/\.(\w+)$/)[1].toLowerCase()}`;
    return { url, n, record: { url, blob: read.ref(path), mediaId: String(entry?.mediaId ?? gid), galleryId: gid,
      cachedAt: entry?.cachedAt || now, size: read.files.get(path).size, ...derivedRecord(read.pictures, read.bubbles, n, entry, read.ref) } };
  });
  return _storeAdopted({ folder: run.id, dir: found.path, gid, record: { ...read.meta, galleryId: gid }, pages, ownCover: _ownCovers(read),
    stamp: descriptionStamp(read.texts), replace, extra: found.kind === 'zip' ? { packed: { inner: found.inner || '' } } : {} });
}

// A gallery read from its folder stored: its metadata, stat record (`extra` on it) and pages in one
// transaction, then its stat rebuilt and a cover of its own put. `replace`: a gallery the library
// keeps, read again — its records as they were going first (its files staying), and only while
// nothing of it waits to be written to its folder, as that transaction finds it (its mark of changes
// not written there, pictures held back in this browser): local changes win. Resolves its id, or null
// when it wasn't read again.
async function _storeAdopted({ folder, dir, gid, record, pages, ownCover = {}, stamp = null, replace = null, extra = {} }) {
  const now = Date.now();
  const db = await K.openDB();
  const S = K.stores;
  const stored = await new Promise((resolve, reject) => {
    const tx = K.tx(db, [S.STORE, S.META, S.GALLERY, S.COVER, S.BLOB], 'readwrite');
    tx._work = { kind: 'adopt', folder };
    let waits = false;
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => (waits ? resolve(false) : reject(K.txError(tx)));
    const put = () => {
      tx.objectStore(S.META).put(K.canonicalMeta(record));
      tx.objectStore(S.GALLERY).put({ galleryId: gid, count: 0, size: 0, latestAt: now, addedAt: Number(gid) || now,
        uploadDate: uploadDateSeconds(record.uploadDate ?? 0) || 0, folder, dir, ...(record.parentId ? { parentId: String(record.parentId) } : {}),
        ...(stamp ? { stamp } : {}), ...extra });
      const images = tx.objectStore(S.STORE);
      for (const p of pages) {
        // A key another gallery's page is stored under stays that gallery's: this page takes its own.
        const prev = images.get(p.url);
        prev.onsuccess = () => {
          const rec = prev.result ? { ...p.record, url: `local://${gid}/${p.n}.${p.url.match(/\.(\w+)$/)?.[1] || 'jpg'}` } : p.record;
          images.put(K.stash(tx, rec, [], K.PAGE));
        };
      }
      K.logIn(tx, gid, { mark: false });   // its folder describes it as read
    };
    if (!replace) { put(); return; }
    tx._keepFiles = true;
    const mark = tx.objectStore(S.UNDESCRIBED).get(gid);
    const stat = tx.objectStore(S.GALLERY).get(gid);
    stat.onsuccess = () => {
      if (mark.result || stat.result?.spilled) { waits = true; tx.abort(); return; }
      K.deleteIn(tx, gid, put);
    };
  });
  if (!stored) return null;
  if (replace) platform.control.send({ type: 'COVER_INVALIDATED', galleryId: gid });
  await K.rebuildGalleryEntry(gid, { silent: true, mark: false });
  // A cover of its own, where its folder keeps one (rebuilding pointed the cover at the first page).
  if (Object.keys(ownCover).length) {
    await new Promise((resolve, reject) => {
      const tx = K.tx(db, [S.COVER, S.BLOB], 'readwrite');
      K.putCoverPatch(tx, gid, ownCover, { mark: false });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(K.txError(tx));
    });
  }
  return gid;
}

// Gallery `stat`, kept in the folder, read again when its descriptions there changed since this
// library last wrote or read them (another app wrote to the folder) — unless it has changes of its own
// waiting to be written there: they win (a hint here, checked again as it is stored). A gallery
// stamped before stamps existed counts as changed only when its descriptions differ from this
// library's.
async function _catchUp(run, stat) {
  const gid = String(stat.galleryId);
  if (run.updated.has(gid) || stat.spilled || K.busy(gid)) return;
  const where = stat.packed ? { kind: 'zip', path: stat.dir, inner: stat.packed.inner || '', id: gid } : { kind: 'dir', path: stat.dir, id: gid };
  let texts;
  try { texts = await _descriptionsAt(run, where); } catch { run.problems.push({ path: stat.dir, reason: 'unreadable' }); return; }
  if (galleryIdOf(texts['metadata.json']) !== gid) return;
  const stamp = descriptionStamp(texts);
  if (stamp === stat.stamp) return;
  if (!stat.stamp) {
    const mine = await K.wantedDescriptions(gid);
    if (mine && descriptionStamp(K.textsOf(mine.wanted)) === stamp) { await K.patchStat(gid, (cur) => ({ ...cur, stamp })); return; }
  }
  try {
    const again = stat.linked ? await _adoptLinked(run, stat.linked, { replace: gid }) : await _adopt(run, where, { replace: gid });
    if (again) run.updated.add(gid);
  } catch (e) { run.problems.push({ path: stat.dir, reason: _failure(e) }); }
}
// The descriptions a gallery's place holds (`where`: _readFormat's): DESCRIPTION_FILES' texts.
async function _descriptionsAt(run, where) {
  const texts = {};
  if (where.kind === 'zip') {
    const archive = await K.archiveOf(run.id, run.root, where.path);
    for (const name of DESCRIPTION_FILES) { const e = archive?.entries.get(`${where.inner}${name}`); texts[name] = e ? await _entryText(e) : null; }
  } else {
    for (const name of DESCRIPTION_FILES) texts[name] = await folderFiles.readText(run.id, run.root, `${where.path}/${name}`);
  }
  return texts;
}

// ── Linked galleries ──

// The linked titles folder `run.id` holds (linked-source.js planTitles — an archive's titles from it,
// zipTitles), each with its pictures, size and fingerprint as they are now (`fingerprint` null when
// they can't be read: reported).
async function _linkedTitles(run, found, step) {
  const planned = planTitles(found.files, run.name, found.ownPaths);
  step.begin('lf.task_checking', planned.length);
  const out = [];
  for (const t of planned) {
    if (run.stopped()) break;
    const titles = t.kind === 'zip' ? await _zipTitlesOf(run, t) : [{ kind: t.kind, path: t.path, ...(t.kind === 'dir' ? { name: t.name } : {}) }];
    for (const title of titles) {
      const at = title.pictures ? title : await _titlePictures(run, title);
      out.push({ ...title, pictures: at?.pictures || [], size: at?.size ?? null, fingerprint: at?.fingerprint ?? null });
    }
    step.tick();
  }
  return out;
}
// An archive's titles (linked-source.js zipTitles), each with its pictures and the archive's
// fingerprint.
async function _zipTitlesOf(run, t) {
  const archive = await K.archiveOf(run.id, run.root, t.path).catch(() => null);
  if (!archive) { run.problems.push({ path: t.path, reason: 'corrupt' }); return []; }
  return zipTitles([...archive.entries.keys()]).map(z => ({ kind: 'zip', path: t.path, ...(z.inner ? { inner: z.inner } : {}), chapter: z.chapter,
    pictures: z.pictures.map(name => ({ name, size: archive.entries.get(name).size })), size: archive.size, fingerprint: archive.fingerprint }));
}
// A title's pictures where they are, in order — [{ name (in its folder, or the archive), size }] — its
// size and fingerprint (a PDF's: its size and its first megabyte's hash; it has no pictures of its
// own). Null, reported, when they can't be read.
async function _titlePictures(run, title) {
  try {
    if (title.kind === 'zip') {
      const archive = await K.archiveOf(run.id, run.root, title.path);
      const mine = archive && zipTitles([...archive.entries.keys()]).find(z => z.inner === (title.inner || ''));
      if (!mine) return null;
      return { pictures: mine.pictures.map(name => ({ name, size: archive.entries.get(name).size })), fingerprint: archive.fingerprint, size: archive.size };
    }
    if (title.kind === 'dir') {
      const pictures = [];
      for (const e of await folderFiles.list(run.id, run.root, title.path)) {
        if (e.kind !== 'file' || !IMAGE_NAME.test(e.name) || e.name.startsWith('.')) continue;
        const file = await e.file();
        pictures.push({ name: e.name, path: e.name, size: file.size });
      }
      const sorted = sortPictures(pictures);
      return { pictures: sorted, fingerprint: await sha256Hex(new TextEncoder().encode(folderPrint(sorted))), size: sorted.reduce((n, p) => n + p.size, 0) };
    }
    const file = await folderFiles.readFile(run.id, run.root, title.path);
    if (!file) return null;
    return { pictures: [], fingerprint: await _pdfPrint(file), size: file.size };
  } catch {
    run.problems.push({ path: title.path, reason: 'unreadable' });
    return null;
  }
}
const _pdfPrint = async (file) => `${file.size}:${await sha256Hex(await file.slice(0, 1024 * 1024).arrayBuffer())}`;

// The overlays folder `id` holds (.shiori/linked/*/source.json): [{ galleryId, source }].
async function _overlaysOf(id, root) {
  const out = [];
  for (const e of await folderFiles.list(id, root, LINKED_DIR).catch(() => [])) {
    if (e.kind !== 'directory') continue;
    const read = parseSource(await folderFiles.readText(id, root, `${LINKED_DIR}/${e.name}/${SOURCE_FILE}`).catch(() => null));
    if (read && read.galleryId === e.name) out.push(read);
  }
  return out;
}
// Gallery `gid`'s overlay in folder `id`: { source, images: [{ name }] (its pages of its own) }, or null.
async function _overlayOf(id, root, gid) {
  const read = parseSource(await folderFiles.readText(id, root, `${overlayDir(gid)}/${SOURCE_FILE}`).catch(() => null));
  if (!read || read.galleryId !== String(gid)) return null;
  const images = (await folderFiles.list(id, root, `${overlayDir(gid)}/images`).catch(() => [])).filter(e => e.kind === 'file').map(e => ({ name: e.name }));
  return { source: read.source, images };
}
// The sources removed from the library the folder notes (removed.json: none when it can't be read,
// reported), and those noted but not written there yet (db.js removedNotes, written first when they
// can be): removed as well, where they were whatever their files are now (F12).
async function _removedOf(run) {
  await K.publishRemoved(run.id);
  const owed = (await K.removedNotes(run.id)).map(({ linked: { fingerprint, ...where } }) => where);
  try { return [...parseRemoved(await folderFiles.readText(run.id, run.root, REMOVED_FILE)), ...owed]; } catch {
    run.problems.push({ path: REMOVED_FILE, reason: 'unreadable' });
    return owed;
  }
}

// New titles joining the library (matchSources' `new`): each a linked gallery of its own — as its
// overlay's gallery, when the folder holds one made for it — and an archive's new chapters a series
// named after it (the import does the same).
async function _linkNew(run, entries, step) {
  const series = new Map();   // archive path → its new chapters
  for (const { title, gid } of entries) {
    if (run.stopped()) return;
    if (title.chapter && !gid) {
      if (!series.has(title.path)) series.set(title.path, []);
      series.get(title.path).push(title);
      continue;
    }
    await _link(run, title, gid || null);
    step.tick();
  }
  for (const [path, chapters] of series) {
    const made = [];
    for (const title of chapters) {
      if (run.stopped()) return;
      const gid = await _link(run, title, null);
      if (gid) made.push({ id: gid, title: title.inner.replace(/\/$/, '').split('/').pop() });
      step.tick();
    }
    if (made.length >= 2) {
      await K.seriesWrite(made[0].id, made, { seriesTitle: metaFromName(path.split('/').pop()).title })
        .catch(() => run.problems.push({ path, reason: 'adopt-failed' }));
    }
  }
}
// Title `title` joined to the library as a linked gallery (`gid`: its overlay's, or none) — a PDF only
// once its pages are drawn (pdfReady: the page drawing them wrote its marker last), its overlay made
// meanwhile so a page draws them (pdfsWaiting). Resolves its id, or null.
async function _link(run, title, gid) {
  try {
    if (title.kind === 'pdf') {
      const over = gid ? await _overlayOf(run.id, run.root, gid) : null;
      if (!over || !pdfReady(over.source, over.images)) { await _overlayFor(run, title, gid || K.nextGalleryId()); return null; }
    }
    const made = await _adoptLinked(run, title, { gid });
    if (made) { run.known.add(made); run.added.push(made); }
    return made;
  } catch (e) {
    run.problems.push({ path: title.path, reason: _failure(e) });
    return null;
  }
}
// Gallery `gid`, a linked gallery the library keeps here, read again from `title` — its source where
// it is now (moved or renamed), or its files changed. A PDF's pages are its overlay's, drawn from the
// file as it was: it follows its file when moved, and when changed, its overlay notes the file as it is
// now, so its pages are drawn again (pdfsWaiting) — the gallery keeping the old ones meanwhile (F10).
async function _relink(run, title, gid) {
  try {
    if (title.kind === 'pdf') {
      const over = await _overlayOf(run.id, run.root, gid);
      if (over && over.source.fingerprint !== title.fingerprint) await _overlayFor(run, title, gid);
      if (!over || over.source.fingerprint !== title.fingerprint || !pdfReady(over.source, over.images)) return;
    }
    if (await _adoptLinked(run, title, { replace: gid })) run.updated.add(gid);
  } catch (e) { run.problems.push({ path: title.path, reason: _failure(e) }); }
}

// Title `title`'s overlay, made as gallery `gid`'s: its source.json written as `title` is now (`at`:
// its pictures read, else `title`'s own) — a PDF's markers kept, each saying the version of the file it
// is for (its pages drawn from, or drawing them failed: pdfWaits). One that can't be read is never
// written over: the error is thrown (F06). Resolves the overlay's folder.
async function _overlayFor(run, title, gid, at = null) {
  const dir = overlayDir(gid);
  const path = `${dir}/${SOURCE_FILE}`;
  const text = await folderFiles.readText(run.id, run.root, path);
  const had = parseSource(text);
  const fingerprint = at?.fingerprint ?? title.fingerprint ?? null;
  const mine = had?.galleryId === String(gid);
  const want = sourceText(gid, { kind: title.kind, path: title.path, ...(title.inner ? { inner: title.inner } : {}), size: at?.size ?? title.size ?? null,
    fingerprint, ...(mine ? { rendered: had.source.rendered, failed: had.source.failed } : {}) });
  if (text !== want) await folderFiles.writeFile(run.id, run.root, path, want);
  return dir;
}

// Title `title` of the folder (linked-source.js: an archive, a folder of pictures, a PDF) joined to the
// library as a linked gallery: its pages referring to its files where they are (read-only), and what
// Shiori keeps of it in its overlay — whose own page NNNN stands in for the source's (linkedPages) —
// as gallery `gid` (its overlay's, when it has one) or a new one. Its metadata is its overlay's when
// there is one, else what its name and folders say. What was made from a page stays with it only while
// the page shows the source picture it was made from (keepsDerived); the files of what is dropped stay
// in the overlay, never read back: its description ties them to that picture.
// `replace`: a gallery the library keeps, read again (from its overlay, its files where `title` says
// now). Resolves its id, or null when it has no pages (or wasn't read again: _storeAdopted).
async function _adoptLinked(run, title, { gid: given = null, replace = null } = {}) {
  const at = title.pictures ? title : await _titlePictures(run, title);
  if (!at) return null;
  const gid = replace || given || K.nextGalleryId();
  if (!replace && run.known.has(gid)) return null;
  const dir = await _overlayFor(run, title, gid, at);
  const read = await _readFormat(run.id, run.root, { kind: 'dir', path: dir });
  const entries = _entriesOf(read.records);
  const now = Date.now();
  const overlay = [...read.files].filter(([p]) => /^images\/[^/]+$/.test(p)).map(([p, f]) => ({ name: p.slice('images/'.length), size: f.size }));
  const source = (p) => ({ $path: p.name, folder: run.id, dir: title.path, ro: 1, ...(title.kind === 'zip' ? { zip: 1 } : {}), size: p.size, type: K.typeOfName(p.name) });
  const pages = linkedPages(at.pictures, overlay, describedFiles(read.records, read.manifest)).map((p) => {
    const entry = entries.get(p.n);
    const url = entry?.url && K.keyPage(entry.url) === p.n ? entry.url : `local://${gid}/${p.n}.${p.name.match(/\.(\w+)$/)?.[1]?.toLowerCase() || 'jpg'}`;
    const made = keepsDerived(p, entry?.source) ? derivedRecord(read.pictures, read.bubbles, p.n, entry, read.ref) : {};
    return { url, n: p.n, record: { url, blob: p.from === 'overlay' ? read.ref(`images/${p.name}`) : source(p), mediaId: String(entry?.mediaId ?? gid),
      galleryId: gid, cachedAt: entry?.cachedAt || now, size: p.size, ...made } };
  });
  if (!pages.length) return null;
  const record = galleryIdOf(read.texts['metadata.json']) === gid ? { ...read.meta, galleryId: gid }
    : { galleryId: gid, ...(await _namedMeta(run, title, gid)), numPages: pages.length, isLocalImport: true, source: '' };
  const linked = { kind: title.kind, path: title.path, ...(title.inner ? { inner: title.inner } : {}), ...(at.fingerprint ? { fingerprint: at.fingerprint } : {}) };
  return _storeAdopted({ folder: run.id, dir, gid, record, pages, ownCover: _ownCovers(read),
    stamp: read.texts['metadata.json'] != null ? descriptionStamp(read.texts) : null, replace, extra: { linked } });
}
// What a title's name and folders say of it: an archive's chapter is named after its folder in it,
// its tags the archive's.
async function _namedMeta(run, title, gid) {
  const parts = title.path.split('/');
  const file = parts.pop();
  if (title.kind === 'zip' && title.inner) {
    const chapter = title.inner.replace(/\/$/, '').split('/').pop();
    return { title: { english: chapter, japanese: '', pretty: chapter }, tags: metaFromName(file, parts).tags };
  }
  return metaFromName(title.kind === 'dir' ? (title.name || file || run.name || gid) : file, parts);
}

// ── PDFs a library folder holds, drawn by a page ──

// The PDFs found in the library's folders (a check made each an overlay) whose pages wait to be drawn
// (linked-source.js pdfWaits): [{ folder, gid, path, name }] — only in folders shown that this context
// may write to — not drawn yet, or drawn from another version of the file than the one there now (F10:
// for a gallery the library has, the one its last check found, so that a page doesn't read every PDF
// of the library) — and not one removed from the library, or whose drawing failed for the file as it is
// (drawFailed: tried again once it changes).
async function pdfsWaiting() {
  const { byId } = await K.folders();
  const known = new Set(await K.transferIds());
  const out = [];
  for (const f of byId.values()) {
    const root = mounted(f.state) ? await K.rootOf(f.id) : null;
    if (!root) continue;
    const removed = parseRemoved(await folderFiles.readText(f.id, root, REMOVED_FILE).catch(() => null));
    for (const over of await _overlaysOf(f.id, root)) {
      if (over.source.kind !== 'pdf') continue;
      const file = await folderFiles.readFile(f.id, root, over.source.path).catch(() => null);   // can't be read now: not offered
      if (!file) continue;
      const joined = known.has(over.galleryId);
      const print = joined ? over.source.fingerprint : await _pdfPrint(file);
      if (!joined && isRemoved(removed, { ...over.source, fingerprint: print })) continue;
      if (!pdfWaits(over.source, (await _overlayOf(f.id, root, over.galleryId))?.images, print)) continue;
      out.push({ folder: f.id, gid: over.galleryId, path: over.source.path, name: over.source.path.split('/').pop() });
    }
  }
  return out;
}
// Waiting gallery `gid`'s overlay in folder `folder`, as the write gate lets it be written: { root,
// source }.
async function _waitingPdf(folder, gid) {
  const root = await K.rootOf(folder);
  if (!root) throw new BackendError('unavailable', `library folder ${folder} can't be written to`);
  const over = (await _overlaysOf(folder, root)).find(o => o.galleryId === String(gid) && o.source.kind === 'pdf');
  if (!over) throw new BackendError('not-found', `no PDF waiting as gallery ${gid}`);
  return { root, source: over.source };
}
// The PDF a waiting gallery is drawn from, as a File.
async function pdfSource(folder, gid) {
  const { root, source } = await _waitingPdf(folder, gid);
  return folderFiles.readFile(folder, root, source.path);
}
// A waiting PDF's pages, drawn (`pages`: Blobs in order), kept in its overlay — each page written, then
// its source.json told how many and the file they were drawn from (`rendered`, last: until then a check
// doesn't take the pages drawn so far for a gallery) — and the gallery joined to the library, while the
// folder's lock is held (one at a time with its check). One the library has, drawn again, has its pages
// replaced in one commit (db.js replacePages), then its marker. Resolves its id; rejects when it
// couldn't join.
async function addRendered(folder, gid, pages) {
  return folderFiles.withLock(FOLDER_LOCK(folder), async () => {
    const { root, source } = await _waitingPdf(folder, gid);
    const dir = overlayDir(gid);
    const file = await folderFiles.readFile(folder, root, source.path).catch(() => null);   // can't be read now: the fingerprint it had
    const fingerprint = file ? await _pdfPrint(file) : source.fingerprint;
    const marker = () => folderFiles.writeFile(folder, root, `${dir}/${SOURCE_FILE}`,
      sourceText(gid, { ...source, fingerprint, rendered: { pages: pages.length, fingerprint }, failed: null }));
    if (await K.galleryGet(gid)) {
      await K.replacePages(String(gid), pages);
      await marker();
      await K.patchStat(String(gid), (cur) => (cur.linked ? { ...cur, linked: { ...cur.linked, fingerprint } } : cur));
      return String(gid);
    }
    for (const [i, blob] of pages.entries()) {
      await folderFiles.writeFile(folder, root, `${dir}/${layoutPath.original(i + 1, extOfType(blob.type) || 'webp')}`, blob);
    }
    if (!(await K.rootOf(folder))) throw new BackendError('unavailable', `library folder ${folder} can't be written to`);
    await marker();
    const run = { id: folder, root, name: (await K.folderById(folder))?.name || '', stopped: () => false,
      known: new Set(await K.transferIds()), added: [], updated: new Set(), problems: [] };
    if (run.known.has(String(gid))) return String(gid);
    const made = await _adoptLinked(run, source, { gid: String(gid) });
    if (!made) throw new BackendError('aborted', `the pages drawn for gallery ${gid} couldn't join the library`);
    await _tidySeriesLinks([made], folder);
    K.publishFeed(made);
    return made;
  });
}
// A waiting PDF a page couldn't draw (it can't be read, or is locked): noted in its source.json
// (`failed`, with the file's fingerprint as it is now), so it isn't tried again on every page until
// the file changes (linked-source.js drawFailed).
async function pdfFailed(folder, gid) {
  const { root, source } = await _waitingPdf(folder, gid);
  const file = await folderFiles.readFile(folder, root, source.path).catch(() => null);   // can't be read: the fingerprint it had
  const fingerprint = file ? await _pdfPrint(file) : source.fingerprint;
  await folderFiles.writeFile(folder, root, `${overlayDir(gid)}/${SOURCE_FILE}`, sourceText(gid, { ...source, failed: { fingerprint, at: Date.now() } }));
}

// ── Series links among galleries read back ──
// A series' links among galleries just read back from folder `folder`: a link to a gallery the library
// doesn't have (yet — its folder may be checked later, or hidden) is kept; one a present gallery
// contradicts is dropped — a chapter listed whose record names another series, a chapter naming a
// series whose list leaves it out. The series that remain have their totals worked out.
async function _tidySeriesLinks(gids, folder) {
  if (!gids.length) return;
  const owners = new Set();
  for (const gid of gids) {
    const meta = await K.metaGet(gid);
    if (!meta) continue;
    const patch = {};
    if (Array.isArray(meta.chapters)) {
      const kept = [];
      for (const c of meta.chapters) {
        const id = String(c?.id ?? '');
        const member = id === gid ? meta : await K.metaGet(id);
        if (!member || id === gid || String(member.parentId || '') === gid) kept.push(c);
      }
      if (kept.length !== meta.chapters.length) patch.chapters = kept.length > 1 ? kept : undefined;
      if (kept.length > 1) owners.add(gid);
    }
    if (meta.parentId) {
      const owner = await K.metaGet(String(meta.parentId));
      const listed = Array.isArray(owner?.chapters) && owner.chapters.some(c => String(c?.id) === gid);
      if (owner && !listed) patch.parentId = undefined;
      else if (owner) owners.add(String(meta.parentId));
    }
    if (!Object.keys(patch).length) continue;
    const S = K.stores;
    const db = await K.openDB();
    await new Promise((resolve, reject) => {
      const tx = K.tx(db, [S.META, S.GALLERY], 'readwrite');
      tx._work = { kind: 'adopt', folder };   // galleries just read back there, or brought back still out of the library
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(K.txError(tx));
      const next = { ...meta };
      for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete next[k]; else next[k] = v; }
      tx.objectStore(S.META).put(K.canonicalMeta(next));
      if ('parentId' in patch) {
        const stats = tx.objectStore(S.GALLERY);
        const req = stats.get(gid);
        req.onsuccess = () => { if (req.result) { const { parentId, ...rest } = req.result; stats.put(rest); } };
      }
      K.logIn(tx, gid);
    });
  }
  for (const oid of owners) await K.refreshSeriesAggregate(oid, { silent: true }).catch(() => {});
}
