# Storage module

The library folders' format, rules and folder store contract, shared by Shiori's two libraries: the
website's (`app/js/db.js` with `folder-library.js`) and the desktop app's (`desktop/server/`, which
loads these modules through `desktop/server/shared.js`). A library folder is a folder the person gave
the library: each gallery a folder of its own in the gallery format, plus the folder's own `.shiori/`
area. The plan this module is built by is `plans/library-storage-plan.md` (§3 the architecture, §4 the
format).

## What is here

| Module | What it holds |
|---|---|
| `contract.js` | The folder store contract as JSDoc types, and the helpers that build and judge its typed results. |
| `gallery-files.js` | The gallery format: file names and layout, the descriptions, which file holds each picture in a folder of format v1. |
| `gallery-manifest.js` | Format v2: a gallery's manifest (the only writer and parser), what a publication writes and may collect, how a gallery's folder is read back (by its manifest, else by v1's rules), deletion's check of a file against what Shiori recorded, what a gallery's deletion takes, when a folder an earlier version never described may take its gallery's identity. |
| `folder-content.js` | What a folder or archive in a library folder is: a gallery of Shiori's, a series, or neither. |
| `folder-owner.js` | Which app keeps a library folder: its claim file and how to read it. |
| `folder-lifecycle.js` | A library folder's states, what each allows (the write gate), its jobs, how a removal ends. |
| `linked-source.js` | Content Shiori didn't make (linked galleries): their overlays, `source.json`, `removed.json`. A source is where it is: one renamed or moved joins as new (plan D5). |
| `personal.js` | The person's own marks on a gallery (favorite, reading progress): kept by each library in a store of its own, never in a folder (plan D6, D11). |
| `folder-store-web.js` | The website's adapter: the contract over File System Access. |

The desktop's adapter is `desktop/server/folder-store.js`, over node fs.

## The contract

`contract.js` is the full statement; in short:

- **`open(root, { purpose })`** is the only way to a `Root`, and a `Root` the only capability for
  I/O. It checks the folder against the library's registration, claim and state for the purpose
  (`read`, `write`, `publish`, `removal`, `claim`) and otherwise refuses with one of
  `unavailable`, `other-library`, `no-permission`, `not-owned`, `hidden`
  (`folder-lifecycle.js` `refusalFor`). A `Root` opened to read has no write methods.
- **Reads are typed** and never throw for a file that is missing or can't be read: `ok`,
  `missing`, `unreadable`, and for a parse `corrupt`. Only `ok` and `missing` may change what a
  library has stored (`mayChangeState`).
- **Identity.** Which library folder a path (or handle) holds is told by its `.shiori/library.json`
  alone: another library folder there is `other-library`, never read, checked, adopted or written as
  it (principle 1). Each library resolves every folder path it uses through one resolver that asks
  (the desktop's `folders.js` `reach`, the website's `db.js` `_access`); `open()` is its face.
- **A gallery's directory** is touched only while it names the gallery (`Root.gallery(dir, gid)`,
  `folder-content.js` `galleryAt`: its manifest, else its v1 `metadata.json`); only `reserve()` makes a
  directory a gallery's, publishing its first generation there. A directory gone meanwhile is never
  made again by a write into it. New bytes go to a new name (`writeNew`), never over a file.
- **Containment (desktop).** Every call inside a library folder is refused when its path goes through
  a link (symbolic link or junction) below the folder, and a folder deleted or copied whole must hold
  none (principle 5). The website can't see links (File System Access): it relies on the browser.
- **A generation** is committed by one atomic manifest write (`publish`): `<gallery>/.shiori/gallery.json`,
  or `gallery.json` in a linked gallery's overlay. It names every picture's file, with the size and
  modification time Shiori wrote it with, and the descriptions, stored by their content
  (`.shiori/d/<sha-256>.json`: one that doesn't match its name is corrupt). The usual description
  files (`metadata.json` and the others) are copies written after the commit, never read by a v2
  reader. A folder without a manifest is format v1, read by today's rules; a file its descriptions
  name that isn't there is a problem (`missing-file`), never a cue to fall back. Deletion takes the
  exact files Shiori recorded writing, by name, size and modification time (`deleteNamed`): a file
  changed since is left and reported. A whole gallery's folder goes the same way
  (`galleryDeletion`): its recorded pictures, its descriptions, what names it last; a person's own
  file keeps the folder. Its deletion is recorded by the transaction that deletes the gallery, so a
  close or crash only delays it, and a check never adopts a folder waiting for it. A deletion whose
  folder can't be written to now is refused (`unavailable`).
- **Committed and published.** A write's promise resolves once the library's own index has
  committed it; the folder holds it once a manifest naming it is published.

## Rules for this folder

- It imports only its own modules and the app's two dependency-free rules, `../sanitize.js` and
  `../titles.js`: no UI, strings, translation, platform or extension code, no packages, no `node:`
  modules (`app/tests/architecture-fitness.test.mjs`). An adapter uses its platform's globals (File
  System Access, Web Locks); the desktop's lives outside, beside the node modules it uses.
- Its types are checked by `tsc --checkJs --strict` in `npm test` (`app/tests/storage-types.test.mjs`).
- Every read or write of a library folder goes through an adapter: no other app module calls a file
  or folder handle's methods, and no other desktop server module calls node fs on a library folder
  (the fitness tests of both apps).
- Each adapter counts the bytes it writes by kind (pictures, descriptions, archives, the rest:
  `written()`), and the conformance suite holds each operation to the write budget (plan D23).

## Tests

- `app/tests/folder-store.conformance.mjs`: the contract, run on both adapters over real temporary
  folders (`app/tests/folder-store-web.test.mjs`, under Node with `fsa-node.mjs`;
  `desktop/tests/folder-store.test.mjs`).
- `app/tests/folder-handover.test.mjs`: both libraries working on one folder in turn.
- `app/tests/folder-model.test.mjs`: command sequences with faults on both libraries, checked against
  a model after every command.
- A case a later step of the plan fixes is marked `todo` with that step.

## Where it stands

The adapters carry every library-folder call of both apps, both libraries publish and read format v2
through them, every read and check goes through an identity-verified folder, every change to an
existing gallery folder needs the folder to name the gallery, a page is read only while its folder
doesn't name another gallery (checked again within a few seconds), and the desktop refuses links in
every call. What a check finds, and a publication over another app's newer one, are kept per folder
for its "Needs attention" list (D15). A linked page's provenance carries its picture's content signal
(a ZIP entry's CRC-32, a folder file's modification time), and a PDF's drawing — or its failure — is
kept only for the version of the file it read, and only as pages with bytes, and a translation only for
the source picture its page showed when it was read (principle 7: `linked-source.js` keepsDerived,
drawnFrom, isDrawing, pageToken, madeFromPage). A deletion whose folder can't be written is refused
(principle 8), and one cut short is finished from its record by name; what it leaves of a person's
files is noted as removed and reported, never joined as a gallery.
