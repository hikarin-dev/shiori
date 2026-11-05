// contract.js — the folder store contract: what both apps' adapters (the website's over File System
// Access, the desktop's over node fs) offer the libraries for every byte they read or write in a
// library folder, as types, plus the few helpers that build and judge its typed results. No I/O here,
// and nothing app-specific: like the rest of app/js/storage/, it imports nothing outside it but the
// app's dependency-free id and title rules (enforced by architecture-fitness.test.mjs), and its types
// are checked by tsc (storage-types.test.mjs).
//
// The contract, in short (the plan's §3.2–3.4 is the full statement):
// - open(root, { purpose }) is the only way to a Root, and a Root the only capability for I/O. open()
//   checks that the folder at the path is the library folder registered under that id (its
//   .shiori/library.json names it), that this app may do `purpose` there (its claim and state:
//   folder-lifecycle.js writeAllowed), and refuses otherwise with one of REFUSALS. A Root opened to
//   read has no write methods. Its identity is checked again when stale and after any I/O error.
// - Reads are typed and never throw for a file that is missing or can't be read (ReadResult); a parse
//   adds 'corrupt' (ParseResult). Only 'ok' and 'missing' may change what a library has stored
//   (mayChangeState): 'corrupt' and 'unreadable' are reported, and what was stored is kept.
// - An existing gallery directory is touched only after it names the gallery (Root.gallery); only
//   reserve() makes a directory a gallery's. New bytes go to a new name (writeNew), never over a file.
//   A generation is committed by one atomic manifest write (publish). Deletion takes the exact files
//   Shiori recorded writing, by name, size and modification time (deleteNamed).
// - A write's promise resolves once the library's own index has committed it ("committed"); the
//   folder holds it once a manifest naming it is published ("published").

// ── Opening a library folder ──

/** What a Root is opened for. 'read': reading only (a check, a page); 'write': ordinary changes;
 * 'publish': publishing changes committed before the folder was hidden (the one write a hidden
 * folder takes); 'removal': a removal's write-back; 'claim': the claim file itself.
 * @typedef {'read' | 'write' | 'publish' | 'removal' | 'claim'} Purpose */
/** @type {readonly Purpose[]} */
export const PURPOSES = Object.freeze(['read', 'write', 'publish', 'removal', 'claim']);

/** Why open() refused. 'unavailable': the folder can't be reached (its drive gone, no such path);
 * 'other-library': another library folder is at the path (another id in its library.json, or none);
 * 'no-permission': the website hasn't the person's permission for it now; 'not-owned': another app
 * holds its claim, or its claim can't be checked; 'hidden': its state doesn't allow the purpose
 * (hidden, or being removed).
 * @typedef {'unavailable' | 'other-library' | 'no-permission' | 'not-owned' | 'hidden'} Refusal */
/** @type {readonly Refusal[]} */
export const REFUSALS = Object.freeze(['unavailable', 'other-library', 'no-permission', 'not-owned', 'hidden']);

/** A library folder as the library registered it: its id, and where it is (a path on the desktop, a
 * directory handle on the website).
 * @template L
 * @typedef {{ id: string, location: L }} FolderRef */

/** @template {ReadRoot} R
 * @typedef {{ status: 'ok', root: R } | { status: Refusal, detail: string | null }} OpenResult */

/** A refused open().
 * @param {Refusal} status
 * @param {string | null} [detail] what was found, for the person (the other library's name, the error)
 * @returns {{ status: Refusal, detail: string | null }} */
export const refused = (status, detail = null) => ({ status, detail });

/** An adapter: how one app reaches its library folders.
 * @template L
 * @typedef {{
 *   open(root: FolderRef<L>, options: { purpose: 'read' }): Promise<OpenResult<ReadRoot>>,
 *   open(root: FolderRef<L>, options: { purpose: Exclude<Purpose, 'read'> }): Promise<OpenResult<WriteRoot>>,
 * }} FolderStore */

// ── Typed results ──

/** @typedef {{ kind: 'missing' }} Missing */
/** @typedef {{ kind: 'unreadable', error: string }} Unreadable */
/** @typedef {{ kind: 'corrupt', detail: string }} Corrupt */

/** A file read: its bytes (or text), size in bytes and modification time (ms).
 * @template T
 * @typedef {{ kind: 'ok', data: T, size: number, mtime: number } | Missing | Unreadable} ReadResult */

/** A description read and parsed: a file that is there but isn't what it should be is 'corrupt'.
 * @template T
 * @typedef {{ kind: 'ok', value: T } | Missing | Corrupt | Unreadable} ParseResult */

/** @type {Missing} */
export const MISSING = Object.freeze({ kind: 'missing' });

/** A read that failed for another reason than the file not being there (EACCES, EBUSY, a damaged
 * disk, NotReadableError).
 * @param {unknown} error
 * @returns {Unreadable} */
export const unreadable = (error) => ({ kind: 'unreadable', error: error instanceof Error ? error.message : String(error) });

/** @param {string} detail what is wrong with it @returns {Corrupt} */
export const corrupt = (detail) => ({ kind: 'corrupt', detail });

/** Whether a read or parse result may change what a library has stored (principle 6): only what was
 * read whole ('ok') or found not there ('missing'). A 'corrupt' or 'unreadable' one is reported,
 * and the stored records (and the stamp or generation they were read at) are kept.
 * @param {{ kind: string }} result
 * @returns {boolean} */
export const mayChangeState = (result) => result.kind === 'ok' || result.kind === 'missing';

/** A text read parsed by `parse` (which returns the value, or null for text that isn't one): the
 * read's own 'missing' or 'unreadable' kept, text that doesn't parse 'corrupt'.
 * @template T
 * @param {ReadResult<string>} read
 * @param {(text: string) => T | null} parse
 * @param {string} [what] the file, for the detail
 * @returns {ParseResult<T>} */
export function parsed(read, parse, what = 'file') {
  if (read.kind !== 'ok') return read;
  let value = null;
  try { value = parse(read.data); } catch {}
  return value == null ? corrupt(`${what} is not valid`) : { kind: 'ok', value };
}

/** An entry of a directory listed. A 'link' is a symbolic link or junction (the desktop sees them;
 * the website never does).
 * @typedef {{ name: string, kind: 'file' | 'dir' | 'link', size: number, mtime: number }} Entry */
/** @typedef {{ kind: 'ok', entries: Entry[] } | Missing | Unreadable} ListResult */

/** Reading a range of a file (bytes `start` to `end`, end excluded), for archives read in place.
 * @typedef {{ start?: number, end?: number }} Range */

// ── A gallery's manifest (format v2: the plan's §4; gallery-manifest.js parses and writes it) ──

/** The files of one page: each slot's file, canonical names included (`studyText`: each bubble's text
 * layer, null for a bubble without one).
 * @typedef {{ original?: string, translated?: string, studyBg?: string, studyText?: (string | null)[],
 *   masks?: { raw?: string, text?: string } }} PageFiles */
/** For a linked gallery's page, the source picture it shows: name and size, plus the archive entry's
 * CRC-32 or the file's modification time.
 * @typedef {{ name: string, size: number, crc?: string, mtime?: number }} SourceSignal */
/** @typedef {{
 *   format: 'shiori-gallery', version: 2, galleryId: string, generation: number,
 *   files: { pages: Record<string, PageFiles>, covers: { gallery?: string, series?: string } },
 *   sizes: Record<string, [number, number]>,
 *   sources?: Record<string, SourceSignal>,
 *   descriptions: Record<string, string>,
 *   writer: string,
 * }} Manifest */

// ── A library folder opened ──

/** A file Shiori wrote, as it recorded it: what deleteNamed later checks it against.
 * @typedef {{ name: string, size: number, mtime: number }} WrittenFile */

/** A gallery's directory, opened to read: its path in the library folder, the gallery it is, and its
 * current manifest.
 * @typedef {{
 *   name: string, gid: string,
 *   manifest(): Promise<ParseResult<Manifest>>,
 *   read(rel: string, range?: Range): Promise<ReadResult<Uint8Array>>,
 * }} GalleryView */

/** A gallery's directory, opened to write.
 * - writeNew: a new file for `slot` (its layout name without extension, as gallery-files.js
 *   layoutPath gives it): the layout name if free, else NNNN-<hex>.<ext>; never over an existing file.
 * - publish: the generation's descriptions written as new files named by their content, then the
 *   manifest in one atomic write (the commit point), then the stable-named copies as a best effort.
 * - deleteNamed: removes the listed files whose size and modification time still match; one that
 *   differs, or can't be checked, is left and reported. The directory goes once it is empty.
 * - sweep: removes this gallery's own temporary files (*.shiori-tmp, -new, -old) older than
 *   `olderThan` (ms), none of `reserved`.
 * @typedef {GalleryView & {
 *   writeNew(slot: string, ext: string, bytes: Uint8Array): Promise<WrittenFile>,
 *   publish(next: { manifest: Manifest, descriptions: Record<string, string> }): Promise<{ generation: number }>,
 *   deleteNamed(files: WrittenFile[]): Promise<{ deleted: string[], kept: { name: string, why: 'changed' | 'missing' | 'unreadable' }[] }>,
 *   sweep(options: { olderThan: number, reserved: string[] }): Promise<{ removed: string[] }>,
 * }} GalleryDir */

/** What Root.gallery() found at a directory: the gallery, nothing, or a directory that names another
 * gallery (`found`: its id) or none (`found`: null).
 * @template D
 * @typedef {{ kind: 'ok', dir: D } | Missing | { kind: 'conflict', found: string | null }} GalleryResult */

/** A source Shiori didn't make (a linked gallery's archive, folder of pictures or PDF), read-only.
 * @typedef {{
 *   path: string,
 *   read(rel?: string, range?: Range): Promise<ReadResult<Uint8Array>>,
 *   list(rel?: string): Promise<ListResult>,
 * }} SourceHandle */
/** @typedef {{ kind: 'ok', source: SourceHandle } | { kind: 'outside' } | Missing | Unreadable} SourceResult */

/** The library folder's own .shiori/ area (owner.json, removed notes, staging).
 * @typedef {{
 *   read(rel: string): Promise<ReadResult<string>>,
 *   list(rel: string): Promise<ListResult>,
 * }} PrivateView */
/** @typedef {PrivateView & {
 *   write(rel: string, text: string): Promise<WrittenFile>,
 *   remove(rel: string): Promise<void>,
 * }} PrivateArea */

/** A library folder opened to read. Paths are '/'-separated and relative to the folder.
 * @typedef {{
 *   id: string, purpose: Purpose,
 *   read(rel: string, range?: Range): Promise<ReadResult<Uint8Array>>,
 *   list(rel: string): Promise<ListResult>,
 *   gallery(dir: string, gid: string): Promise<GalleryResult<GalleryView>>,
 *   source(path: string): Promise<SourceResult>,
 *   private: PrivateView,
 * }} ReadRoot */

/** A library folder opened to write: its galleries opened to write, reserve() (the only operation
 * that makes a directory a gallery's: an exclusive reservation that writes its first manifest) and
 * writes to its .shiori/ area. A write rejects with the I/O error that failed it.
 * @typedef {Omit<ReadRoot, 'gallery' | 'private'> & {
 *   gallery(dir: string, gid: string): Promise<GalleryResult<GalleryDir>>,
 *   reserve(nameHint: string, gid: string, manifest: Manifest): Promise<GalleryDir>,
 *   private: PrivateArea,
 * }} WriteRoot */
