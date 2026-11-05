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
| `gallery-manifest.js` | Format v2: a gallery's manifest (the only writer and parser), what a publication writes and may collect, how a gallery's folder is read back (by its manifest, else by v1's rules), deletion's check of a file against what Shiori recorded. |
| `folder-content.js` | What a folder or archive in a library folder is: a gallery of Shiori's, a series, or neither. |
| `folder-owner.js` | Which app keeps a library folder: its claim file and how to read it. |
| `folder-lifecycle.js` | A library folder's states, what each allows (the write gate), its jobs, how a removal ends. |
| `linked-source.js` | Content Shiori didn't make (linked galleries): their overlays, `source.json`, `removed.json`. |
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
- **A gallery's directory** is touched only through `Root.gallery(dir, gid)`; only `reserve()`
  makes a directory a gallery's. New bytes go to a new name (`writeNew`), never over a file.
- **A generation** is committed by one atomic manifest write (`publish`): `<gallery>/.shiori/gallery.json`,
  or `gallery.json` in a linked gallery's overlay. It names every picture's file, with the size and
  modification time Shiori wrote it with, and the descriptions, stored by their content
  (`.shiori/d/<sha-256>.json`: one that doesn't match its name is corrupt). The usual description
  files (`metadata.json` and the others) are copies written after the commit, never read by a v2
  reader. A folder without a manifest is format v1, read by today's rules; a file its descriptions
  name that isn't there is a problem (`missing-file`), never a cue to fall back. Deletion takes the
  exact files Shiori recorded writing, by name, size and modification time (`deleteNamed`): a file
  changed since is left and reported.
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

The adapters carry every library-folder call of both apps, with the libraries' own checks, and both
libraries publish and read format v2 through them. Still to come, by the plan's steps: identity-
verified roots, positive gallery identity and the desktop's containment in every operation (S5).
