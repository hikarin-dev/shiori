// writes.js — every byte the desktop library writes to disk, by kind, kept across sessions in its
// data folder (writes.json; its own small writes aren't counted). The library counts each file it
// writes where it writes it — an archive by what each entry holds, plus its structure (headers and
// directory) — and the database by its write-ahead log: every frame SQLite appends there, and each
// page a checkpoint writes back into library.db (library.js). Renames move no bytes and deletions
// write none, so neither counts. What Chromium writes for the windows (its caches) isn't the
// library's and isn't here.
import fs from 'node:fs';

export const KINDS = ['pages', 'pictures', 'descriptions', 'archive', 'database', 'thumbnails', 'exports'];
// The kinds written to the library folder's drive; database and thumbnails go to this computer's app
// data, exports (files saved from a window: main.js) wherever the person saves them.
export const LIBRARY_DRIVE = new Set(['pages', 'pictures', 'descriptions', 'archive']);
const DESCRIPTIONS = /^(metadata\.json|image_records\.json|series\.json|ComicInfo\.xml|study\/bubbles\.json|covers\/manifest\.json)$/;

// What a file in the gallery format holds, by its path in the gallery's folder or archive.
export const kindOfName = (name) => (/^images\//.test(name) ? 'pages' : DESCRIPTIONS.test(name) ? 'descriptions' : 'pictures');

export class WriteMeter {
  constructor(file) {
    this.file = file;
    this.by = {};
    this.since = Date.now();
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved && typeof saved.by === 'object') Object.assign(this, { by: saved.by, since: Number(saved.since) || this.since });
    } catch {}
    this._timer = null;
  }

  add(kind, bytes) {
    if (!(bytes > 0)) return;
    this.by[kind] = (this.by[kind] || 0) + bytes;
    if (!this._timer) {
      this._timer = setTimeout(() => this.save(), 60_000);
      this._timer.unref?.();
    }
  }

  // An archive's writes (zip.js): each entry by what it holds, the rest as its structure.
  addArchive({ entries, structure }) {
    for (const [name, bytes] of entries) this.add(kindOfName(name), bytes);
    this.add('archive', structure);
  }

  snapshot() {
    const by = Object.fromEntries(KINDS.filter(k => this.by[k]).map(k => [k, this.by[k]]));
    return { total: Object.values(by).reduce((a, b) => a + b, 0), by, since: this.since };
  }

  reset() {
    this.by = {};
    this.since = Date.now();
    this.save();
  }

  save() {
    clearTimeout(this._timer);
    this._timer = null;
    try { fs.writeFileSync(this.file, JSON.stringify({ by: this.by, since: this.since })); } catch {}
  }
}
