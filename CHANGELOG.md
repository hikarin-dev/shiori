# Changelog

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
