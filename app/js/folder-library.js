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
import { OWN_FILES, MANIFEST_FILE, TEMPORARY, galleryIdOf, classifyFolder, classifyArchive } from './storage/folder-content.js';
import { LINKED_DIR, SOURCE_FILE, REMOVED_FILE, IMAGE_NAME, ARCHIVE_NAME, overlayDir, sourceText, parseSource, parseRemoved, isRemoved,
  folderPrint, folderContent, crcHex, metaFromName, planTitles, zipTitles, sortPictures, linkedPages, keepsDerived, sameSource, sameProvenance,
  pdfReady, pdfWaits, matchSources, PDF_HEAD, pdfPrint, drawnFrom, isDrawing } from './storage/linked-source.js';
import { DESCRIPTION_FILES, descriptionStamp, layoutPath, extOfType, describedFiles, derivedRecord } from './storage/gallery-files.js';
import { PICTURE_DIRS, readGallery, parseManifest, tokenOf, namedPictures } from './storage/gallery-manifest.js';
import { withoutPersonal } from './storage/personal.js';
import { sha256Hex } from './zip-read.js';
import { uploadDateSeconds } from './gallery-model.js';

let K = null;   // the kernel db.js hands over (createFolderLibrary)

// The folder layer over db.js's kernel `kernel` — its IndexedDB transactions, records, folder
// registry and write gate, and the pictures' storage (db.js lists what it hands over). Resolves the
// operations db.js exports.
export function createFolderLibrary(kernel) {
  K = kernel;
  return { foldersList, foldersWaiting, folderAdd, folderClaim, folderSetDefault, folderAllow, folderHide, folderShow,
    folderRemove, folderSetAside, foldersPending, folderScan, folderDismiss, pdfsWaiting, pdfSource, addRendered, pdfFailed, leftBehind, fingerprintNow };
}

// An item of folder `id`'s Needs attention list ({ reason, path }) put away: a check that finds it
// again lists it again.
async function folderDismiss(id, item) {
  await K.dismiss(String(id), { reason: String(item?.reason ?? ''), path: String(item?.path ?? '') });
  platform.control.send({ type: 'FOLDERS_CHANGED' });
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
// [{ id, kind: 'browser'|'folder', name, isDefault, access, galleries, size, removable, hidden?,
// attention? }]. `access`: 'granted', 'prompt' (one click lets this page use it: folderAllow),
// 'unavailable' (not there), 'other-library' (another library folder is at its place) or 'taken'
// (another app holds it, `owner` which). A hidden place counts the galleries it hid. `attention`: its
// Needs attention list (D15: what its last check found, and what happened since), [{ reason, path,
// gid? }].
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
      attention: await K.attentionOf(f.id).catch(() => []), ...(taken ? { owner: _ownerOf(claim) } : {}) });
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
    const text = await folderFiles.libraryText(probe, handle).catch((e) => {
      throw new BackendError('unavailable', `${LIBRARY_FILE} can't be read: ${e?.message || e}`);
    });
    if (text != null) {
      const id = JSON.parse(text)?.id;
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
  K.forgetGrant(id);
  const { state } = await K.access(id);   // never another library folder at its path (principle 1)
  if (state === 'other-library') throw Object.assign(new BackendError('unavailable', `another library folder is at library folder ${id}'s path`), { reason: 'other-library' });
  if (state !== 'granted') throw new BackendError('unavailable', `library folder ${id} can't be reached`);
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
// kernel's mount check; pictures still in this browser for it move once it is shown, while what its
// galleries had changed before is published there in the background) until it is shown again
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
  K.settleFolders().catch(() => {});   // what its galleries had changed before, published there in the background (plan §3.4)
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
  if (!discard && !(now.state === 'granted' && now.owned)) {   // its removal couldn't write back, nor delete what it owes
    const n = (await _unsavedIn(id)).length + (await K.deletions(id)).filter(d => !d.unfound).length;
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
  // The notes of linked sources let go from it (deleted before, or moved out above) written there, and
  // the folders of galleries deleted from it (or moved out) deleted: one still owed is as unsaved as a
  // gallery (forgotten, the folder would add its source, or the gallery, again).
  await K.publishRemoved(id, work);
  await K.applyDeletions(id, work).catch(() => {});
  await _finishUnfound(id, work).catch(() => {});
  const owed = [...await K.removedNotes(id), ...(await K.deletions(id)).filter(d => !d.unfound)].map(n => n.gid);
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
// Folder `id` let go by this library: its claim released, when it holds it and can reach it as itself.
async function _release(id) {
  const folder = await K.folderById(id);
  K.forgetGrant(id);
  if (!folder || (await K.access(id)).state !== 'granted') return;
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
  await K.forgetRetiring(id).catch(() => {});   // files it would have deleted there stay with the folder
  await K.forgetDeletions(id).catch(() => {});  // and galleries' folders likewise
  await K.forgetAttention(id).catch(() => {});
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
// notes of removed sources still owed to a folder are written there (db.js publishRemoved), and
// galleries' folders a deletion let go are deleted (db.js applyDeletions).
async function foldersPending() {
  await _unsetAside().catch(() => {});
  for (const id of new Set((await K.removedNotes().catch(() => [])).map(n => n.folder))) K.publishRemoved(id);
  K.applyDeletions().catch(() => {});
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
      const tx = K.tx(db, [S.STORE, S.META, S.GALLERY, S.COVER, S.BLOB, S.DORMANT, S.PERSONAL], 'readwrite');
      tx._work = { kind: 'migration', folder };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(K.txError(tx));
      tx.objectStore(S.DORMANT).delete(rec.gid);
      if (!there && !known.has(rec.gid)) for (const blob of _asideBlobIds(rec)) tx.objectStore(S.BLOB).delete(blob);
      if (!restore) return;
      if (rec.meta) { tx.objectStore(S.META).put(K.canonicalMeta(rec.meta)); K.importMarksIn(tx, rec.gid, rec.meta); }
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
//    holds (matchSources): one whose files changed is read again, one removed before stays out, and
//    the rest join — one renamed or moved outside the app among them (plan D5: the gallery that was
//    there shows as missing, _markMissing), an archive's new chapters as a series, a PDF once its
//    pages are drawn;
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
  if (!root) {
    // Another library folder at its place is never read as it, nor its galleries adopted (T01).
    if ((await K.access(id)).state === 'other-library') throw Object.assign(new BackendError('unavailable', `another library folder is at library folder ${id}'s place`), { reason: 'other-library' });
    throw new BackendError('unavailable', `library folder ${id} can't be reached`);
  }
  const run = { id, root, name: folder.name || '', stopped, known: new Set(await K.transferIds()), marked: await K.marked(), added: [], updated: new Set(),
    problems: [], unreferenced: [] };
  const kept = (await _placedIn(id)).filter(g => g.dir);
  const step = _steps(run, onProgress);

  step.begin('lf.task_checking', 0);
  // Galleries' folders a deletion let go are deleted first; one still waiting isn't looked into: never
  // adopted again, whole or half deleted (N2, N4).
  await K.applyDeletions(id).catch(() => {});
  const deletions = await K.deletions().catch(() => []);
  const deleting = deletions.filter(d => d.folder === id && !d.unfound).map(d => d.dir);
  // A deleted gallery whose folder wasn't where its deletion had it (renamed or moved by hand): its
  // folder, met here, is deleted, never adopted (F4, S10).
  run.deleted = new Map(deletions.filter(d => d.unfound).map(d => [String(d.gid), d]));
  const found = await _walk(run, new Set([...kept.filter(g => !g.linked).map(g => g.dir), ...deleting].map(d => d.toLowerCase())));
  const titles = await _linkedTitles(run, found, step);
  run.removed = await _removedOf(run);
  // Overlays that can't be read now are reported and null: no title joins as new this time (matchSources:
  // one may be about it; review 6 F2), nor while removed.json can't be read (F4).
  const overlays = await _overlaysOf(id, root).catch(() => { run.problems.push({ path: LINKED_DIR, reason: 'unreadable' }); return null; });
  const plan = matchSources({ found: titles, kept: kept.filter(g => g.linked).map(g => ({ gid: String(g.galleryId), source: g.linked })),
    overlays, known: run.known, removed: run.removed });
  // A folder of pictures kept without its content (kept before it was recorded) has it recorded as it is
  // now, so a picture replaced in place by one of the same size is told from now on.
  for (const s of plan.same) {
    const g = kept.find(k => String(k.galleryId) === s.gid);
    if (g?.linked && g.linked.content == null && s.title.content) await K.patchStat(s.gid, (cur) => (cur.linked ? { ...cur, linked: { ...cur.linked, content: s.title.content } } : cur));
  }

  step.begin('lf.task_adding', found.own.length + plan.changed.length + plan.new.length);
  for (const own of found.own) {
    if (stopped()) break;
    await _joinOwn(run, own, kept);
    step.tick();
  }
  for (const c of plan.changed) {
    if (stopped()) break;
    await _relink(run, c.title, c.gid);
    step.tick();
  }
  await _linkNew(run, plan.new, step);
  if (!stopped()) await _markMissing(run, kept, plan);

  step.begin('lf.task_comparing', kept.length);
  for (const stat of kept) {
    if (stopped()) break;
    if (await _catchUp(run, stat)) await _leftovers(run, stat);
    step.tick();
  }
  const changed = [...run.added, ...run.updated];
  await _tidySeriesLinks(changed, run.id);
  for (const gid of changed) K.publishFeed(gid);
  // What it found, for the folder's Needs attention list (D15), and a deletion whose gallery's folder it
  // didn't meet forgotten — not when it was stopped part way.
  if (!stopped()) await K.noteChecked(id, [...run.problems, ...run.unreferenced]).catch(() => {});
  if (!stopped()) await K.forgetUnfound(id).catch(() => {});
  return { added: run.added.length, updated: run.updated.size, problems: run.problems, stopped: !!stopped() };
}
// The linked galleries kept here (`kept`) marked missing while their source isn't where it was —
// renamed, moved or deleted outside the app (plan D5: such a source is another; its gallery's overlay,
// what the library added to it, is kept until the gallery is deleted) — and no longer once it is back.
// A source that couldn't be looked at now is left as the gallery has it (principle 6).
async function _markMissing(run, kept, plan) {
  const away = new Set(plan.missing.map(m => m.gid));
  for (const g of kept.filter(k => k.linked)) {
    const gid = String(g.galleryId);
    const missing = away.has(gid) ? await folderFiles.isThere(run.id, run.root, g.linked.path).then(there => !there, () => !!g.missing) : false;
    if (missing === !!g.missing) continue;
    await K.patchStat(gid, (cur) => { const { missing: was, ...rest } = cur; return missing ? { ...rest, missing: true } : rest; });
    K.publishFeed(gid);
  }
}
// Pictures in kept gallery `stat`'s folder (it names the gallery: _catchUp) that nothing refers to —
// not its records, not a file waiting to retire — and old enough that no write under way is making
// them (a write cut short before its records committed): reported in `run.unreferenced` ({ path,
// reason: 'unreferenced', gid }), never deleted (D16: Shiori deletes only what it recorded writing).
const LEFTOVER_AGE_MS = 10 * 60 * 1000;
async function _leftovers(run, stat) {
  if (stat.packed || stat.linked) return;
  const gid = String(stat.galleryId);
  try {
    const mine = await K.wantedDescriptions(gid);
    if (!mine || mine.stat.dir !== stat.dir) return;
    const named = new Set([...namedPictures(mine.next.files), ...mine.retiring.map(n => n.path)]);
    for (const [path, f] of await folderFiles.picturesIn(run.id, run.root, stat.dir)) {
      if (!named.has(path) && Date.now() - f.mtime >= LEFTOVER_AGE_MS) run.unreferenced.push({ path: `${stat.dir}/${path}`, reason: 'unreferenced', gid });
    }
  } catch { /* what can't be listed now is looked at again by the next check */ }
}
// Deletions waiting `unfound` in folder `id` (their gallery's folder wasn't where they had it: F4)
// finished before the folder is let go (its removal: `work`): its galleries looked for as a check finds
// them, one naming such a gallery deleted where it is (db.js deletedFound) — once the folder is forgotten,
// nothing would keep the next library adding it from adopting it again.
async function _finishUnfound(id, work) {
  const unfound = new Map((await K.deletions(id)).filter(d => d.unfound).map(d => [String(d.gid), d]));
  const root = unfound.size ? await K.rootOf(id, { work }) : null;
  if (!root) return;
  const found = await _walk({ id, root, name: '', stopped: () => false, problems: [] }, new Set());
  for (const own of found.own) {
    const d = !own.series && unfound.get(own.id);
    if (d && (own.kind === 'zip') === ARCHIVE_NAME.test(d.dir)) await K.deletedFound(d, id, own.path, work);
  }
}
// A check's progress, step by step (each counted on its own).
function _steps(run, onProgress) {
  let step = 'lf.task_checking', total = 0, done = 0;
  return {
    begin(next, n) { step = next; total = n; done = 0; onProgress(0, total, run.added.length, step); },
    tick() { onProgress(Math.min(++done, total), total, run.added.length, step); },
  };
}

// What folder `run.id` holds — hidden files and folders, the library's own .shiori, and Shiori's
// temporary names (folder-content.js TEMPORARY: another app's write under way, or one cut short) left
// out; folders as deep as WALK_DEPTH — { own: Shiori's own galleries found ({ kind: 'dir' | 'zip', path,
// id, legacy? } — or { kind: 'zip', path, series } for a series export), ownPaths: where they and the
// galleries the library keeps there are (not looked into: `skip`, lower-cased), files: [{ path }]
// everything else }. A gallery's folder still as its reservation made it (classifyFolder `reserved`) is
// Shiori's but no gallery found: what was to be put in it may never have committed (S12, review 4 F2).
// A folder that can't be listed, an archive that can't be read, are reported.
const WALK_DEPTH = 12;
async function _walk(run, skip, from = '') {
  const out = { own: [], ownPaths: [], files: [] };
  const walk = async (path, depth) => {
    if (run.stopped()) return;
    if (path && skip.has(path.toLowerCase())) { out.ownPaths.push(path); return; }
    let entries;
    try { entries = await folderFiles.list(run.id, run.root, path); } catch { run.problems.push({ path: path || '.', reason: 'unreadable' }); return; }
    const what = path ? await _classifyDir(run, path, entries) : { kind: 'other' };
    if (!what) { out.ownPaths.push(path); return; }   // its description unreadable: left as it is
    if (what.kind === 'gallery') {
      if (!what.reserved) out.own.push({ kind: 'dir', path, id: what.id, legacy: !!what.legacy });
      out.ownPaths.push(path);
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === '__MACOSX' || TEMPORARY.test(e.name)) continue;
      const p = path ? `${path}/${e.name}` : e.name;
      if (e.kind === 'directory') { if (depth < WALK_DEPTH) await walk(p, depth + 1); continue; }
      if (ARCHIVE_NAME.test(e.name)) {
        const zip = skip.has(p.toLowerCase()) ? { kept: true } : await _classifyZip(run, p);
        if (zip) { if (zip.kind) out.own.push(zip); if (!zip.corrupt) out.ownPaths.push(p); continue; }
      }
      if (what.kind !== 'series') out.files.push({ path: p });   // beside a series' members: its own files
    }
  };
  await walk(from, from ? from.split('/').length : 0);
  return out;
}
// The titles a check of folder `id` (its handle `root`) would find in its folder `dir` (what a gallery's
// deletion left there: db.js _applyDeletions): [{ kind, path, inner?, fingerprint }], each fingerprint as
// its files are now (null when they can't be read).
async function leftBehind(id, root, dir) {
  // An archive left whole (the person's files in it: F6) is noted as itself — a check never adopts the
  // gallery it describes again (_joinOwn) — as it is now.
  if (ARCHIVE_NAME.test(dir)) return [{ kind: 'zip', path: dir, fingerprint: (await K.archiveOf(id, root, dir).catch(() => null))?.fingerprint ?? null }];
  const run = { id, root, name: '', stopped: () => false, problems: [] };
  const titles = await _linkedTitles(run, await _walk(run, new Set(), dir), { begin() {}, tick() {} });
  return titles.map(t => ({ kind: t.kind, path: t.path, ...(t.inner ? { inner: t.inner } : {}), fingerprint: t.fingerprint }));
}
// What folder `path` (its `entries`) is: folder-content.js classifyFolder, from those of its own files
// it has. One whose description can't be read is reported and null: nothing is concluded from it —
// read neither as Shiori's nor as linked (F06).
async function _classifyDir(run, path, entries) {
  const names = new Set(entries.filter(e => e.kind === 'file').map(e => e.name));
  const dirs = new Set(entries.filter(e => e.kind === 'directory').map(e => e.name));
  const texts = {};
  for (const name of OWN_FILES) {
    const [top] = name.split('/');
    if (!(top === name ? names : dirs).has(top)) continue;
    try { texts[name] = await folderFiles.readText(run.id, run.root, `${path}/${name}`); } catch {
      run.problems.push({ path: `${path}/${name}`, reason: 'unreadable' });
      return null;
    }
  }
  return classifyFolder(texts);
}
// What the archive at `path` is: Shiori's own (folder-content.js classifyArchive) — { kind: 'zip',
// path, id, legacy? } or, a series export, { kind: 'zip', path, series } — or null (linked). One that
// can't be read, its descriptions included, is reported and left out: { corrupt: true }.
async function _classifyZip(run, path) {
  let archive;
  const texts = {};
  try {
    archive = await K.archiveOf(run.id, run.root, path);
    for (const name of OWN_FILES) { const e = archive?.entries.get(name); if (e) texts[name] = await _entryText(e); }
  } catch (e) {
    run.problems.push({ path, reason: e instanceof DOMException ? 'unreadable' : 'corrupt' });   // its file, or what it holds
    return { corrupt: true };
  }
  if (!archive) return { corrupt: true };   // gone meanwhile
  const what = classifyArchive([...archive.entries.keys()], texts);
  if (what.kind === 'gallery') return { kind: 'zip', path, id: what.id, legacy: !!what.legacy };
  if (what.kind === 'series') return { kind: 'zip', path, series: what.series };
  return null;
}
const _entryText = async (entry) => new TextDecoder().decode(await entry.read());

// ── Shiori's own galleries ──

// A gallery in the gallery format found in the folder (`found`: a folder, an archive read in place,
// or a series export's chapters — `inner` each one's folder in it) joined to the library. One the
// library has is a copy, left alone and reported ('duplicate': O3, S10) — unless it keeps it in this
// folder at a place that is gone: read again where it is now. One whose gallery was deleted, its folder
// not where the deletion had it, is deleted here instead (F4); an archive a deletion left whole, as it
// was left (removed.json: the person's files in it, F6), is left — as is every such archive while
// removed.json can't be read (`run.removed` null: review 6 F4), till a check reads it.
async function _joinOwn(run, found, kept) {
  if (found.legacy) { run.problems.push({ path: found.path, reason: 'unsupported' }); return; }
  if (found.series) {
    for (const c of found.series.chapters) if (c.present) await _joinOwn(run, { kind: 'zip', path: found.path, inner: `${c.folder}/`, id: c.id }, kept);
    return;
  }
  try {
    if (!run.known.has(found.id)) {
      const deleted = run.deleted.get(found.id);
      if (deleted) { if (!found.inner && (found.kind === 'zip') === ARCHIVE_NAME.test(deleted.dir)) await K.deletedFound(deleted, run.id, found.path); return; }
      if (found.kind === 'zip' && !found.inner && (!run.removed || (run.removed.length
        && isRemoved(run.removed, { kind: 'zip', path: found.path, fingerprint: (await K.archiveOf(run.id, run.root, found.path))?.fingerprint ?? null })))) return;
      const gid = await _adopt(run, found);
      if (gid) { run.known.add(gid); run.added.push(gid); }
      return;
    }
    const was = kept.find(g => String(g.galleryId) === found.id && !g.linked);
    if (!was || _samePlace(was, found)) return;
    if (await _there(run, was)) { run.problems.push({ path: found.path, reason: 'duplicate', gid: found.id }); return; }
    if (await _adopt(run, found, { replace: found.id })) run.updated.add(found.id);
  } catch (e) { run.problems.push({ path: `${found.path}${found.inner ? `/${found.inner}` : ''}`, reason: _failure(e) }); }
}
// Why a gallery couldn't be read or joined, for `problems`: its files couldn't be read (_readFormat's
// 'unreadable'), are damaged ('corrupt') or miss a file they name ('missing-file'), or it couldn't be
// stored ('adopt-failed').
const _failure = (e) => (['unreadable', 'corrupt', 'missing-file'].includes(e?.reason) ? e.reason : 'adopt-failed');
const _samePlace = (stat, found) => stat.dir === found.path && (stat.packed?.inner || '') === (found.inner || '');
// Whether a kept gallery's place is still there: its archive, or its folder naming it (galleryIn) — one
// that can't be read is.
async function _there(run, stat) {
  if (stat.packed) return folderFiles.readFile(run.id, run.root, stat.dir).then(Boolean, () => true);
  const whose = await folderFiles.galleryIn(run.id, run.root, stat.dir, String(stat.galleryId));
  return whose.kind === 'ok' || whose.kind === 'unreadable';
}

// What a gallery in the gallery format holds, read where it lies (storage/gallery-manifest.js
// readGallery: by its manifest, format v2, else by v1's rules): { texts (its descriptions,
// DESCRIPTION_FILES, as read), meta, records, bubbles, manifest (its covers/manifest.json, parsed),
// generation (its manifest; null for v1), token (what it was published at: gallery-manifest.js tokenOf,
// or v1's stamp), files (path in the gallery → { size, type, mtime }: images/ and what was made from its
// pages), pictures (which file holds each picture), ref(path) (a reference to that file where it lies;
// null when it isn't there) }. `found`: { kind: 'dir', path } a folder, or { kind: 'zip', path, inner }
// an archive — `inner` the gallery's folder in a series export ('' for an archive of its own). What
// isn't there holds nothing; anything else that can't be read fails the read whole, with `reason:
// 'unreadable'` (F06): a gallery read in part would lose what it couldn't see. One damaged (T08) or
// missing a file it names (T09) fails with `reason` 'corrupt' or 'missing-file'.
async function _readFormat(folder, root, found) {
  try {
    return await (found.kind === 'zip' ? _readArchive(folder, root, found.path, found.inner || '') : _readDir(folder, root, found.path));
  } catch (e) {
    throw e instanceof BackendError ? e : Object.assign(new BackendError('unavailable', `${found.path} couldn't be read: ${e?.message || e}`), { reason: 'unreadable' });
  }
}
async function _readDir(folder, root, dir) {
  const { read, files } = await folderFiles.loadGallery(folder, root, dir);
  return _format(_readable(read, dir), files, (path) => ({ $path: path, folder, dir }));
}
async function _readArchive(folder, root, path, inner) {
  const archive = await K.archiveOf(folder, root, path);
  if (!archive) throw new BackendError('not-found', `${path} isn't there`);
  const files = new Map();
  for (const [name, e] of archive.entries) {
    if (!name.startsWith(inner)) continue;
    const rel = name.slice(inner.length);
    if (IMAGE_NAME.test(rel) && PICTURE_DIRS.includes(rel.slice(0, rel.lastIndexOf('/')))) files.set(rel, { size: e.size });
  }
  const read = await readGallery({ area: '.shiori/', archive: true, files, text: async (rel) => { const e = archive.entries.get(`${inner}${rel}`); return e ? _entryText(e) : null; } });
  return _format(_readable(read, path), files, (p) => ({ $path: `${inner}${p}`, folder, dir: path, zip: 1 }));
}
// A gallery's read that can't be taken as it is (damaged, or missing a file it names) thrown, with its
// reason.
function _readable(read, at) {
  if (read.kind === 'ok') return read;
  throw Object.assign(new BackendError('invalid', `${at}: ${read.kind === 'corrupt' ? read.detail : `${read.files.join(', ')} not there`}`), { reason: read.kind });
}
function _format(read, listed, at) {
  const files = new Map([...listed].map(([p, f]) => [p, { size: f.size, type: K.typeOfName(p), ...(f.mtime ? { mtime: f.mtime } : {}) }]));
  return { texts: read.texts, meta: read.meta, records: read.records, bubbles: read.bubbles, manifest: read.covers, generation: read.manifest,
    token: read.token, files, pictures: read.pictures, ref: (path) => (files.has(path) ? { ...at(path), ...files.get(path) } : null) };
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
    stamp: read.token, replace, extra: found.kind === 'zip' ? { packed: { inner: found.inner || '' } } : {} });
}

// A gallery read from its folder stored: its metadata, stat record (`extra` on it) and pages in one
// transaction, then its stat rebuilt and a cover of its own put. `replace`: a gallery the library
// keeps, read again — its records as they were going first (its files staying), and only while
// nothing of it waits to be written to its folder, as that transaction finds it (its mark of changes
// not written there, pictures held back in this browser): local changes win. Resolves its id, or null
// when it wasn't read again.
async function _storeAdopted({ folder, dir, gid, record, pages, ownCover = {}, stamp = null, replace = null, stale = false, extra = {} }) {
  const now = Date.now();
  const db = await K.openDB();
  const S = K.stores;
  const stored = await new Promise((resolve, reject) => {
    const tx = K.tx(db, [S.STORE, S.META, S.GALLERY, S.COVER, S.BLOB, S.PERSONAL], 'readwrite');
    tx._work = { kind: 'adopt', folder };
    let waits = false;
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => (waits ? resolve(false) : reject(K.txError(tx)));
    // A description an earlier version wrote may carry the person's favorite (storage/personal.js): taken
    // into this library's marks when the gallery joins it — never when it is read again — and the
    // description published again without it.
    const personal = withoutPersonal(record) !== record;
    const put = () => {
      tx.objectStore(S.META).put(K.canonicalMeta(record));
      if (!replace) K.importMarksIn(tx, gid, record);
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
      K.logIn(tx, gid, { mark: stale || personal });   // its folder describes it as read — unless `stale`: to be published again
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

// Gallery `stat`, kept in the folder, read again when what it was published at there changed since this
// library last published or read it (D4: another app published a generation of it) — unless it has
// changes of its own waiting to be published there: they win (a hint here, checked again as it is
// stored), and the case is reported ('changed-both'). A v1 folder stamped before stamps existed counts
// as changed only when its descriptions differ from this library's. Its folder must name it (principle
// 2): one put at its place by hand is reported ('conflict') and never read as it. Resolves whether its
// folder is its own now.
async function _catchUp(run, stat) {
  const gid = String(stat.galleryId);
  if (!stat.packed) {
    const whose = await folderFiles.galleryIn(run.id, run.root, stat.dir, gid);
    if (whose.kind === 'conflict') run.problems.push({ path: stat.dir, reason: 'conflict', gid });
    if (whose.kind === 'unreadable') run.problems.push({ path: stat.dir, reason: 'unreadable' });
    if (whose.kind !== 'ok') return false;
  }
  if (run.updated.has(gid) || K.busy(gid)) return true;
  const where = stat.packed ? { kind: 'zip', path: stat.dir, inner: stat.packed.inner || '', id: gid } : { kind: 'dir', path: stat.dir, id: gid };
  let at;
  try { at = await _tokenAt(run, where, gid); } catch (e) { run.problems.push({ path: stat.dir, reason: e?.reason === 'corrupt' ? 'corrupt' : 'unreadable' }); return true; }
  if (at.id !== gid || at.token === stat.stamp) return true;
  if (!stat.stamp && at.texts) {
    const mine = await K.wantedDescriptions(gid);
    if (mine && descriptionStamp(K.textsOf(mine.wanted)) === at.token) { await K.patchStat(gid, (cur) => ({ ...cur, stamp: at.token })); return true; }
  }
  if (stat.spilled || run.marked.has(gid)) {
    if (stat.stamp) run.problems.push({ path: stat.dir, reason: 'changed-both', gid });
    return true;
  }
  try {
    const again = stat.linked ? await _adoptLinked(run, stat.linked, { replace: gid }) : await _adopt(run, where, { replace: gid });
    if (again) run.updated.add(gid);
  } catch (e) { run.problems.push({ path: stat.dir, reason: _failure(e) }); }
  return true;
}
// What a gallery's place (`where`: _readFormat's) was last published at, and the gallery it names:
// { token, id, texts } — by its manifest (gallery-manifest.js tokenOf; `texts` null), else, format v1,
// its descriptions' stamp and texts. Rejects when it can't be read, or its manifest is damaged (`reason`
// 'corrupt').
async function _tokenAt(run, where, gid) {
  let manifest;
  if (where.kind === 'zip') {
    const e = (await K.archiveOf(run.id, run.root, where.path))?.entries.get(`${where.inner}${MANIFEST_FILE}`);
    manifest = e ? parseManifest(await _entryText(e), { galleryId: gid, archive: true }) : { kind: 'missing' };
  } else {
    manifest = await folderFiles.manifestIn(run.id, run.root, where.path, gid);
    if (manifest.kind === 'unreadable') throw Object.assign(new Error(manifest.error), { reason: 'unreadable' });
  }
  if (manifest.kind === 'corrupt') throw Object.assign(new Error(manifest.detail), { reason: 'corrupt' });
  if (manifest.kind === 'ok') return { token: tokenOf(manifest.value), id: manifest.value.galleryId, texts: null };
  const texts = await _descriptionsAt(run, where);
  return { token: descriptionStamp(texts), id: galleryIdOf(texts['metadata.json']), texts };
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
      out.push({ ...title, pictures: at?.pictures || [], size: at?.size ?? null, fingerprint: at?.fingerprint ?? null, content: at?.content ?? null });
    }
    step.tick();
  }
  return out;
}
// An archive's titles (linked-source.js zipTitles), each with its pictures and the archive's
// fingerprint — none, reported, when it can't be read now (its file, or what it holds), and none when it
// is gone meanwhile (as the shared rule takes it).
async function _zipTitlesOf(run, t) {
  let archive;
  try { archive = await K.archiveOf(run.id, run.root, t.path); } catch (e) {
    run.problems.push({ path: t.path, reason: e instanceof DOMException ? 'unreadable' : 'corrupt' });
    return [];
  }
  if (!archive) return [];
  return zipTitles([...archive.entries.keys()]).map(z => ({ kind: 'zip', path: t.path, ...(z.inner ? { inner: z.inner } : {}), chapter: z.chapter,
    pictures: _zipPictures(z.pictures, archive), size: archive.size, fingerprint: archive.fingerprint }));
}
// An archive's pictures (`names`, in order) as its directory has them: [{ name, size, crc }] — each with
// its CRC-32, the content signal its page records (principle 7, T07).
const _zipPictures = (names, archive) => names.map(name => ({ name, size: archive.entries.get(name).size, crc: crcHex(archive.entries.get(name).crc) }));
// A title's pictures where they are, in order — [{ name (in its folder, or the archive), size, crc (an
// archive's) | mtime (a folder's) }] — its size and fingerprint (a PDF's: its size and its first
// megabyte's hash; it has no pictures of its own; a folder's: its `content` too, folderContent hashed).
// Null, reported, when they can't be read.
async function _titlePictures(run, title) {
  try {
    if (title.kind === 'zip') {
      const archive = await K.archiveOf(run.id, run.root, title.path);
      const mine = archive && zipTitles([...archive.entries.keys()]).find(z => z.inner === (title.inner || ''));
      if (!mine) return null;
      return { pictures: _zipPictures(mine.pictures, archive), fingerprint: archive.fingerprint, size: archive.size };
    }
    if (title.kind === 'dir') {
      const pictures = [];
      for (const e of await folderFiles.list(run.id, run.root, title.path)) {
        if (e.kind !== 'file' || !IMAGE_NAME.test(e.name) || e.name.startsWith('.')) continue;
        const file = await e.file();
        pictures.push({ name: e.name, path: e.name, size: file.size, mtime: file.lastModified });
      }
      const sorted = sortPictures(pictures);
      const hash = (text) => sha256Hex(new TextEncoder().encode(text));
      return { pictures: sorted, fingerprint: await hash(folderPrint(sorted)), content: await hash(folderContent(sorted)), size: sorted.reduce((n, p) => n + p.size, 0) };
    }
    const file = await folderFiles.readFile(run.id, run.root, title.path);
    if (!file) return null;
    return { pictures: [], fingerprint: await _pdfPrint(file), size: file.size };
  } catch {
    run.problems.push({ path: title.path, reason: 'unreadable' });
    return null;
  }
}
const _pdfPrint = async (file) => pdfPrint(file.size, await sha256Hex(await file.slice(0, PDF_HEAD).arrayBuffer()));
// Source `source`'s fingerprint as its files are now in folder `id` (its handle `root`; null when they
// can't be read): what a note that it was removed carries (db.js publishRemoved), so a source changed
// since the library last checked it isn't taken for a new one (N3; the desktop's folders.js does alike).
async function fingerprintNow(id, root, source) {
  return (await _titlePictures({ id, root, problems: [] }, source))?.fingerprint ?? null;
}

// The overlays folder `id` holds (.shiori/linked/*/source.json): [{ galleryId, source }]. Rejects when
// they can't be read now (the listing, or an overlay's source.json: none there only as the shared rule
// takes it, folder-store-web.js) — never a list with one left out, whose source would join again as a
// new gallery without what the library added to it (review 6 F2).
async function _overlaysOf(id, root) {
  const out = [];
  for (const e of await folderFiles.list(id, root, LINKED_DIR)) {
    if (e.kind !== 'directory') continue;
    const read = parseSource(await folderFiles.readText(id, root, `${LINKED_DIR}/${e.name}/${SOURCE_FILE}`));
    if (read && read.galleryId === e.name) out.push(read);
  }
  return out;
}
// Gallery `gid`'s overlay in folder `id`: { source, images: [{ name }] (its pages of its own) }, or null.
// Rejects when it can't be read now (as _overlaysOf).
async function _overlayOf(id, root, gid) {
  const read = parseSource(await folderFiles.readText(id, root, `${overlayDir(gid)}/${SOURCE_FILE}`));
  if (!read || read.galleryId !== String(gid)) return null;
  const images = (await folderFiles.list(id, root, `${overlayDir(gid)}/images`)).filter(e => e.kind === 'file').map(e => ({ name: e.name }));
  return { source: read.source, images };
}
// The sources removed from the library the folder notes (removed.json), and those noted but not written
// there yet (db.js removedNotes, written first when they can be): removed as well, where they were
// whatever their files are now (F12). Null, reported, when removed.json can't be read now (none there
// only as the shared rule takes it): a check then joins nothing it may note (review 6 F4).
async function _removedOf(run) {
  await K.publishRemoved(run.id);
  const owed = (await K.removedNotes(run.id)).map(({ linked: { fingerprint, ...where } }) => where);
  try { return [...parseRemoved(await folderFiles.readText(run.id, run.root, REMOVED_FILE)), ...owed]; } catch {
    run.problems.push({ path: REMOVED_FILE, reason: 'unreadable' });
    return null;
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
// Gallery `gid`, a linked gallery the library keeps here, read again from `title` — its source, where it
// was, its files changed. A PDF's pages are its overlay's, drawn from the file as it was: its overlay
// notes the file as it is now, so its pages are drawn again (pdfsWaiting) — the gallery keeping the old
// ones meanwhile (F10).
async function _relink(run, title, gid) {
  try {
    // What the library changed of it and hasn't published yet is published first: read again, it keeps
    // those changes, and only what was made from a picture that changed goes (S8: a source changed in
    // place while a change waited kept a translation of its old picture over the new one).
    if (run.marked.has(gid)) await K.describe(gid).catch(() => {});
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
// written over: the error is thrown (F06); nor is one naming another gallery (principle 2: reason
// 'conflict'). Resolves { dir: the overlay's folder, was: the source its source.json named before (null:
// none) }.
async function _overlayFor(run, title, gid, at = null) {
  const dir = overlayDir(gid);
  const path = `${dir}/${SOURCE_FILE}`;
  const text = await folderFiles.readText(run.id, run.root, path);
  const had = parseSource(text ?? '');
  const fingerprint = at?.fingerprint ?? title.fingerprint ?? null;
  const mine = had?.galleryId === String(gid);
  if (had && !mine) throw Object.assign(new BackendError('conflict', `the overlay at ${dir} names another gallery`), { reason: 'conflict' });
  const want = sourceText(gid, { kind: title.kind, path: title.path, ...(title.inner ? { inner: title.inner } : {}), size: at?.size ?? title.size ?? null,
    fingerprint, ...(mine ? { rendered: had.source.rendered, failed: had.source.failed } : {}) });
  if (text !== want) await folderFiles.writeFile(run.id, run.root, path, want);
  return { dir, was: mine ? had.source : null };
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
  const kept = replace ? (await K.galleryGet(gid))?.linked : null;
  const { dir, was } = await _overlayFor(run, title, gid, at);
  // Whether its source is as the library was last told of it (the source it keeps, for one read again;
  // else its overlay's source.json): what a page recorded before content signals were may keep.
  const unchanged = sameSource(replace ? kept : was, at);
  const read = await _readFormat(run.id, run.root, { kind: 'dir', path: dir });
  const entries = _entriesOf(read.records);
  const now = Date.now();
  const overlay = [...read.files].filter(([p]) => /^images\/[^/]+$/.test(p)).map(([p, f]) => ({ name: p.slice('images/'.length), size: f.size }));
  // A page of its source records the picture's content signal with it (principle 7: its provenance).
  const source = (p) => ({ $path: p.name, folder: run.id, dir: title.path, ro: 1, ...(title.kind === 'zip' ? { zip: 1 } : {}), size: p.size, type: K.typeOfName(p.name),
    ...(p.crc ? { crc: p.crc } : {}), ...(p.mtime != null ? { mtime: p.mtime } : {}) });
  // Its pages of its own: those its manifest names (format v2), else as its descriptions say (v1).
  const listedAs = read.generation ? new Set(read.pictures.pages.values()) : describedFiles(read.records, read.manifest);
  const own = read.generation ? overlay.filter(f => listedAs.has(`images/${f.name}`)) : overlay;
  let stale = false;   // a page's source picture isn't the one its overlay recorded: published again
  const pages = linkedPages(at.pictures, own, listedAs).map((p) => {
    const entry = entries.get(p.n);
    const url = entry?.url && K.keyPage(entry.url) === p.n ? entry.url : `local://${gid}/${p.n}.${p.name.match(/\.(\w+)$/)?.[1]?.toLowerCase() || 'jpg'}`;
    const made = keepsDerived(p, entry?.source, unchanged) ? derivedRecord(read.pictures, read.bubbles, p.n, entry, read.ref) : {};
    if (p.from === 'source' && entry?.source && !sameProvenance(entry.source, p)) stale = true;
    return { url, n: p.n, record: { url, blob: p.from === 'overlay' ? read.ref(`images/${p.name}`) : source(p), mediaId: String(entry?.mediaId ?? gid),
      galleryId: gid, cachedAt: entry?.cachedAt || now, size: p.size, ...made } };
  });
  if (!pages.length) return null;
  const record = galleryIdOf(read.texts['metadata.json']) === gid ? { ...read.meta, galleryId: gid }
    : { galleryId: gid, ...(await _namedMeta(run, title, gid)), numPages: pages.length, isLocalImport: true, source: '' };
  const linked = { kind: title.kind, path: title.path, ...(title.inner ? { inner: title.inner } : {}), ...(at.fingerprint ? { fingerprint: at.fingerprint } : {}),
    ...(at.content ? { content: at.content } : {}) };
  return _storeAdopted({ folder: run.id, dir, gid, record, pages, ownCover: _ownCovers(read),
    stamp: read.texts['metadata.json'] != null ? read.token : null, replace, stale, extra: { linked } });
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
// (drawFailed: tried again once it changes). One whose file or overlay can't be read now isn't offered,
// nor any of a folder whose overlays or removed.json can't be (one may be a PDF removed from the
// library: review 6 F4).
async function pdfsWaiting() {
  const { byId } = await K.folders();
  const known = new Set(await K.transferIds());
  const out = [];
  for (const f of byId.values()) {
    const root = mounted(f.state) ? await K.rootOf(f.id) : null;
    if (!root) continue;
    let removed, overlays;
    try { [removed, overlays] = [parseRemoved(await folderFiles.readText(f.id, root, REMOVED_FILE)), await _overlaysOf(f.id, root)]; } catch { continue; }
    for (const over of overlays) {
      if (over.source.kind !== 'pdf') continue;
      try {
        const file = await folderFiles.readFile(f.id, root, over.source.path);
        if (!file) continue;
        const joined = known.has(over.galleryId);
        const print = joined ? over.source.fingerprint : await _pdfPrint(file);
        if (!joined && isRemoved(removed, { ...over.source, fingerprint: print })) continue;
        if (!pdfWaits(over.source, (await _overlayOf(f.id, root, over.galleryId))?.images, print)) continue;
        out.push({ folder: f.id, gid: over.galleryId, path: over.source.path, name: over.source.path.split('/').pop() });
      } catch { /* not offered */ }
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
// The PDF a waiting gallery is drawn from: { file (a File), token (its fingerprint, as read: the version
// a drawing of it is for — addRendered and pdfFailed take it back, T10) }. A File is the file as it was
// when read: should it change, reading it fails rather than give another version's bytes.
async function pdfSource(folder, gid) {
  const { root, source } = await _waitingPdf(folder, gid);
  const file = await folderFiles.readFile(folder, root, source.path);
  if (!file) throw new BackendError('not-found', `the PDF waiting as gallery ${gid} isn't there`);
  return { file, token: await _pdfPrint(file) };
}
// Waiting gallery `gid`'s PDF in folder `folder` read again, for a drawing of the version `token` names
// (pdfSource's): { root, source } while the file is still that version (linked-source.js drawnFrom); else
// rejects with BackendError 'conflict' (`reason` 'stale'), nothing written — it waits to be drawn as it
// is now.
async function _drawnAt(folder, gid, token) {
  const { root, source } = await _waitingPdf(folder, gid);
  const file = await folderFiles.readFile(folder, root, source.path).catch(() => null);
  if (!drawnFrom(token, file ? await _pdfPrint(file) : null)) {
    throw Object.assign(new BackendError('conflict', `the PDF waiting as gallery ${gid} isn't the version drawn`), { reason: 'stale' });
  }
  return { root, source };
}
// A waiting PDF's pages, drawn (`pages`: Blobs in order) from the version of its file `token` names
// (pdfSource's), kept in its overlay — only a drawing (linked-source.js isDrawing: one page at least, each
// with bytes) of the file as it still is (_drawnAt, read again just before the commit too) — each page
// written, then its source.json told how many and the version they were drawn from (`rendered`, last:
// until then a check doesn't take the pages drawn so far for a gallery) — and the gallery joined to the
// library, while the folder's lock is held (one at a time with its check). One the library has, drawn
// again, has its pages replaced in one commit (db.js replacePages), then its marker. Resolves its id;
// rejects when it couldn't join.
async function addRendered(folder, gid, pages, token) {
  if (!isDrawing(pages)) throw new BackendError('invalid', 'no pages drawn');
  return folderFiles.withLock(FOLDER_LOCK(folder), async () => {
    const { root, source } = await _drawnAt(folder, gid, token);
    const dir = overlayDir(gid);
    const marker = () => folderFiles.writeFile(folder, root, `${dir}/${SOURCE_FILE}`,
      sourceText(gid, { ...source, fingerprint: token, rendered: { pages: pages.length, fingerprint: token }, failed: null }));
    if (await K.galleryGet(gid)) {
      await K.replacePages(String(gid), pages, { before: () => _drawnAt(folder, gid, token) });
      await marker();
      await K.patchStat(String(gid), (cur) => (cur.linked ? { ...cur, linked: { ...cur.linked, fingerprint: token } } : cur));
      return String(gid);
    }
    for (const [i, blob] of pages.entries()) {
      await folderFiles.writeFile(folder, root, `${dir}/${layoutPath.original(i + 1, extOfType(blob.type) || 'webp')}`, blob);
    }
    if (!(await K.rootOf(folder))) throw new BackendError('unavailable', `library folder ${folder} can't be written to`);
    await _drawnAt(folder, gid, token);
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
// A waiting PDF a page couldn't draw from the version `token` names (pdfSource's; it is damaged, or
// locked): noted in its source.json (`failed`, with that version's fingerprint), so it isn't tried again
// on every page until the file changes (linked-source.js drawFailed) — only while the file is still that
// version (_drawnAt): a failure to draw an earlier one notes nothing.
async function pdfFailed(folder, gid, token) {
  const { root, source } = await _drawnAt(folder, gid, token);
  await folderFiles.writeFile(folder, root, `${overlayDir(gid)}/${SOURCE_FILE}`, sourceText(gid, { ...source, failed: { fingerprint: token, at: Date.now() } }));
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
