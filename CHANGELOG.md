# Changelog

## v1.0.5 — 2026-07-14

### Added

- Reader: a new settings panel (the gear in the top bar) gathers the reading options in one place — page mode, reading direction, where the progress bar sits, how pages fit the screen, the gap between pages, and a zoom control. Your choices are remembered.
- Reader: right-to-left reading direction, for manga read that way — it flips the page-turn taps and arrows and reverses the double-page spread.
- Reader: the progress bar can now be placed on any edge of the screen (or hidden), and shows a slim segment per page that fills in as you read and marks which pages are already downloaded.
- Series pages: every chapter now has its own Translate button with a live progress bar, and Shift+click reverts a translated chapter to the original. The button is hidden while the translation server is unreachable.

### Changed

- Series pages now show download, replace, and translation progress right on the chapter row, and the progress keeps going if you reload the page mid-job.
- Page counts, image counts, and file sizes across the app now follow your language's number formatting.
- Study mode: vertical Japanese text now stands single letters, numbers, and symbols upright while leaving words sideways, and source-text detection recognizes Chinese (including simplified and traditional) as well as Japanese, for the correct character shapes.
- Reader: when the header is unpinned it now tucks fully out of the way for a cleaner full-screen page, sliding back when you move the pointer to the top edge or scroll up.

## v1.0.4 — 2026-07-09

### Added

- Series can now carry their own cover, shown on the library card and the series page. Covers are included in gallery/series exports and backups, and restored on import.
- Gallery cards show each source site's own icon next to the gallery id. Icons are stored inside Shiori, so they keep working offline; the id itself now links straight to the gallery's source page.
- New "Gallery cards" settings: choose when the card quick-action buttons appear (on hover, always, or hidden), and whether to hide the language flag that matches the app's own language.
- Series pages gained per-chapter download and replace buttons (Shift+click a chapter's download to replace it from a CBZ, Shift+click remove for a quick delete), and the page updates just the affected chapter row while downloads run instead of repainting everything.
- The download button on a series card fetches every chapter that's missing pages; if the whole series is already downloaded it offers a full re-download.
- A standalone gallery's title can now be edited from its overview page, just like a series title.
- Shift+click a series' export button to save a metadata-only bundle of all its chapters.
- Reader: new fit-to-page controls — Shift+E fits the page width, Shift+Q fits the page height, and the fit persists as you turn pages. + / − fine-tune the fitted size, and Ctrl+0 resets it.
- Reader: press N to toggle the pinned header, hold the left mouse button and scroll the wheel to flip pages, and Escape now also opens the keyboard-shortcuts help when nothing needs dismissing.
- Series read in single/double page mode now show the chapter navigation pill above the first page and below the last page, matching the scroll strip.

### Changed

- A series' tags are now kept separately from each chapter's own tags: merging galleries into a series builds the series' tag list without touching the chapters, and adding or removing a tag on a series card edits the series list only.
- Importing a series export now removes chapters that are no longer part of the imported series, so a shorter re-import doesn't leave hidden leftovers behind.
- Backups now include the source-site icons and series covers (older backups still import fine).

### Fixed

- Series whose first chapter has no downloaded pages now show their cover on the library card instead of an empty box.
- The source-site icon button shows a link icon until the site's own icon is available, instead of an empty square.
- Safe mode no longer leaves the real source address reachable through a card's id link while it's active.
- Series covers that couldn't be fetched while offline are retried later instead of staying stuck on the chapter cover until a reload.
- Restoring a large backup no longer floods open pages with per-cover refreshes mid-import.
- The reader's page slider no longer swallows keyboard shortcuts after you've used it, and its handle now shows the accent color in Firefox.

## v1.0.3 — 2026-07-03

### Added

- Settings now has a side navigation with clear sections — Library, Reader, Translation, and Storage — instead of one long page. Your existing settings are unchanged, just reorganized.
- New Translation setting "Study mode generation": choose what a translation stores for Study mode — Off (fastest), Text only (each bubble's original and translated text), or Text and image (the full bubble layers, as before). New translations default to Off.
- New Reader setting "Study mode display": show revealed bubbles as the exact translated image, or as selectable text you can copy. Pages that only have text data show text automatically.
- Study bubbles shown as text now use the same comic-lettering font as the translated pages, sized and cased to match the typeset image.

### Changed

- Whole-gallery translation is substantially faster — roughly half the time it took before on the same settings — and the server now balances several translation requests fairly instead of making everyone wait for the first one to finish.
- Study bubbles are pixel-perfect again: revealed bubbles no longer crop off parts of the lettering, and text from one bubble no longer bleeds into a neighbouring one. Revealing every bubble on a page now reproduces the translated page exactly.

### Fixed

- Stopping a translation now ends it cleanly everywhere — previously a cancelled translation could quietly restart itself from the beginning.
- Pressing Escape in Study mode now properly hides the revealed bubbles.

## v1.0.2 — 2026-06-17

### Changed

- Cleaner web addresses: the library now opens at the site root and the other pages drop the `/app/` from their links (`…/settings`, `…/reader`). Any old `…/app/…` bookmarks should be updated.
- Gallery titles now follow your app language — when the app is set to Japanese a gallery's Japanese title shows; otherwise titles fall back to English.
- A card's language flags now cover every language a gallery is in, not just one. The flag for your own app language is hidden, and the generic "translated" marker no longer hides a gallery's real languages.

### Added

- Adding a language to a gallery now offers a dropdown of the supported languages and their flags, instead of typing it by hand.

## v1.0.1 — 2026-06-14

### Added

- The whole app now speaks 12 languages — pick yours under Settings → Language: English, 日本語, Deutsch, Français, 简体中文, 繁體中文, 한국어, Español, Português, Русский, Tiếng Việt, and Bahasa Indonesia.
- Every library card shows a flag for its language — click it to filter your library to that language, just like clicking a tag. Galleries you translate now carry the flag of the language you translated them into.
- Add your own tags to any gallery right from its card, and `Shift`+click a tag to remove it.
- Reader: zoom pages in and out with `+` / `−`, and scroll with `W` / `S`.

### Fixed

- Reader: a pinned header now always keeps the page fully below it, even as you scroll.
- Tooltips follow your cursor smoothly and no longer get clipped at the edge of the screen.
- When the library toolbar shrinks, the upload button stays in reach and the stats sit neatly on one row.
- Card action buttons no longer flicker or stick while you hold `Shift`.

## v1.0.0 — 2026-06-12

First release of Shiori as a standalone app. Your library lives entirely in your browser — no server, no account — and works offline as an installable PWA.

### Library

- Grid of all your galleries with cover thumbnails, titles, page counts, sizes, and tags
- Search by ID, title, or tags — type several words to combine them, or use `tag:"name"` / `artist:"name"` to filter a specific tag type; click any tag on a card to add it to the search
- Sort by most recent, last updated, largest, most pages, or gallery ID
- Pages of 30 galleries with quick pagination, including keyboard paging with `←` / `→`
- Live progress bars on every card — downloads, imports, and translations update in real time, in every open tab
- Safe mode: one click blurs covers and scrambles titles and tags for screen-sharing
- Quick actions on each card: read, download, translate, open on source site, export, delete — hold `Shift` to reveal each button's alternate action

### Reader

- Three view modes: scroll strip, single page, and double page — switch with `1` / `2` / `3` or the toolbar
- Pages appear instantly and load outward from where you are, so jumping anywhere is fast
- Thumbnail strip: drag to swipe through it, `Shift`+drag to scrub the page, click to jump, and drag its top edge to resize
- Page scrubber, page counter, and full keyboard navigation (`?` shows all shortcuts)
- Remembers your view mode, thumbnail state, and strip height between sessions
- Galleries with a stored translation open in translated view, with a one-click toggle back to the originals

### Importing & exporting

- Drop `.cbz` / `.zip` files anywhere on the library (or use the Upload button) — several at once is fine, each shows its own progress
- Imports keep running even if you close the tab
- Export any gallery as a `.cbz` with its metadata bundled — re-importing restores everything; `Shift`+click exports just the metadata
- Backups: a small metadata-only file (`.shi`) or your full library including images (`.shioridb`), restorable on any machine

### Translation

- Connect a self-hosted manga-image-translator server and translate whole galleries in one click
- Translated pages are stored next to the originals — nothing is overwritten, and you can revert at any time
- A full settings panel covers engines, languages, text detection, inpainting quality, and typesetting, with sensible presets

### Settings

- About panel with this changelog
- Lifetime disk-write counter
- Clear-all with double confirmation
