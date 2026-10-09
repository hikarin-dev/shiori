# Changelog

## v1.2.0 — 2026-10-09

### Added

- Backups now run in a progress window that shows how far along they are and about how long is left, with **Cancel**. Until it finishes, the page behind it can't be used or left by accident, other Shiori tabs can't start another backup or clear the library, and Shiori Desktop asks before quitting.
- Dropping a backup on the library page restores it in the same progress window.
- Before restoring, Shiori checks the whole backup and shows what it holds: when it was made, how many galleries and pages, and its size. Nothing is written until you choose **Restore**. Galleries that can't be restored are listed and left out, and the rest is restored.
- If a restore stops part-way, importing the same file again offers to carry on where it stopped instead of writing everything again.
- **Settings → Storage → Check a backup file** reads a backup through and checks that it is complete and intact, without changing your library.
- Full backups now record a checksum for every picture, so restoring or checking one confirms each picture is exactly the one saved. Backups made by 1.2.0 can't be opened by older versions of Shiori; backups from older versions still import.
- Shiori Desktop makes full backups itself: you choose where the file goes, it's written straight there, and Shiori shows where it was saved, with **Show in folder**.

### Changed

- Importing a full backup into Shiori Desktop is about three times faster, and its galleries are complete in your library folder when the import finishes.
- A backup is recognised by what's in it, not by its name: a large backup your browser left as `Unconfirmed ….crdownload` after its download failed at the very end can be imported or checked as it is, without renaming it.
- Making a full backup in the browser now reads every picture once to check it before handing the file to your downloads, so a picture that can't be read is reported instead of breaking the download partway.
- Backups now carry only your display and reading preferences. Which library a device uses, its connection to Shiori Desktop, your translation server's address and access token, and other details of the device stay behind — also when you restore a backup made by an earlier version.
- When a website uses the Shiori Desktop library, full backups are made in Shiori Desktop (**Settings → Storage → Export** there).
- Backup files are named after your local date.

### Fixed

- Restoring a gallery whose pages already belong to another gallery in your library no longer takes them away from it; that gallery is left out and listed.
- A restore that stops part-way (out of disk space, Shiori Desktop closed) no longer leaves a gallery half-written, and says how many galleries were restored.
- A gallery that already had more pages than the backup shows its true page count after a restore.
- Restoring gallery details (`.shi`) no longer resets the page count of a gallery it couldn't read at that moment.
- A gallery that changes while a backup is being made is saved as it is at the end.

## v1.1.2 — 2026-10-09

### Fixed

- A full library backup is now saved as an ordinary download of one `.shioridb` file, which your browser lists with its size and time left. The way 1.1.1 saved it could fail right at the end. With a very large backup (tens of GB), Chrome's own safety check can still end the download with "Failed – System busy" even though the whole file was saved. It's left in your Downloads folder as `Unconfirmed ….crdownload`: rename it to end in `.shioridb` and it's a complete backup.
- Shiori Desktop no longer closes with an error when you import a backup, or move a browser library into it, that holds very large galleries.

## v1.1.1 — 2026-10-09

### Fixed

- A full library backup of any size now saves as one `.shioridb` file. It goes to your browser's downloads instead of a save dialog, because very large libraries (tens of GB) used to end with an empty `.shioridb` and a leftover `.crswap` file. Keep the tab open until Settings says the backup was downloaded. If an earlier export left you with that pair, the `.crswap` file is the complete backup: delete the empty `.shioridb` and rename the `.crswap` file to end in `.shioridb`.
- Shiori Desktop installed from a developer-mode build can check for updates again instead of reporting "No published versions on GitHub".

## v1.1.0 — 2026-10-08

### Added

- **Archiving** in Shiori Desktop: **Archive** on a gallery's or series' page packs it into one uncompressed ZIP or CBZ in your library folder, the same file its export would be, and Shiori reads it straight from there. **Settings → System → Archive galleries left alone** can do it by itself once a gallery hasn't been opened or changed for a day, a week or a month (off unless you choose), and **Archive format** picks ZIP or CBZ. Edits to an archived gallery, new pages and translations are added to the archive without writing the rest of it again; it's rewritten whole only when a change replaces much of it. A gallery open in the reader, or whose folder holds files you put there yourself, stays a folder.
- **Settings → Library → Gallery export**: export as ZIP or CBZ, or be asked each time, and choose whether to **Include translations**. The export question can **Remember my choice**. A CBZ also holds ComicInfo.xml so other comic readers show the gallery's details, and an export is named after its gallery.
- Drop a folder laid out like a Shiori export into Shiori and it imports like its ZIP, translations included. Dropping a whole Shiori Desktop library folder imports each gallery and series in it.
- Shiori Desktop: **Settings → Storage → Total Disk Writes** counts everything the library writes. Hover it to see the split by where it went (the library folder, this computer's app data, the files you saved) and by kind: pages, translations, gallery details, the library database, thumbnails.
- The disk-writes count also includes the files you save (exports, backups) and the temporary copies imports make.
- **Settings → Experimental → Overlay Scrollbars** (Chrome, Edge and other Chromium browsers): scrollbars that float over the page and shrink or hide when not in use.

### Changed

- Shiori Desktop keeps each gallery as a plain folder laid out exactly like its export: the pages in `images/`, translations and study layers next to them, its details in `metadata.json`. A series keeps its chapters together in one folder. A page is written to disk once and moved into place, and adding pages never writes the other pages again. Translations now live with the gallery in your library folder instead of on this computer's drive.
- Shiori Desktop writes a gallery's details when you change them, when a download, import or translation finishes, or when you leave a gallery you were reading, instead of on a timer; a save that changes nothing writes nothing. The library database writes about half as much for each page added.
- Shiori Desktop no longer keeps a browser cache, and imports without an extra temporary copy, so downloads and imports are written to disk once.
- Shiori Desktop no longer checks the whole library folder at every start; **Settings → System → Check the library folder** does that when you ask. Its own `.shiori` folder inside the library folder is hidden, and temporary folders it leaves there are cleaned up.
- Shiori Desktop finds its library again when the drive comes back under a different letter, or the library folder is moved or renamed.
- Shiori Desktop deletes a gallery's files outright instead of moving them to the Recycle Bin, and moves an Explorer window out of a folder before deleting or moving it.
- A page opened at Shiori Desktop's own address in your browser always uses the desktop library; while the app is closed, the page waits for it.
- Reader: dragging a page image out of the reader now needs Ctrl held as you start dragging.
- Upgrading from Shiori Desktop 1.0.13 or 1.0.14: your galleries are found again in your library folder on first start. Translations made in those versions aren't carried over.

### Fixed

- Galleries from different sites that happen to share a reference number are kept apart. If you use the browser extension, update it to this version as well: an older one can't add pages to this version of Shiori.
- Deleting a gallery while Explorer shows its folder no longer makes Explorer complain that the folder is gone, or crash.
- Exporting with translations turned off now leaves them out of a ZIP as well as a CBZ.
- Job progress shows in every window using the Shiori Desktop library, including a browser tab at the desktop app's address.
- Reader: a long jump in the strip view no longer stops partway while pages load.

## v1.0.14 — 2026-10-03

### Added

- Shiori Desktop: **Settings → System** has an **Updates** section. **Check for updates** shows a newer version as it downloads, and **Restart to update** installs it once it's ready.
- Shiori Desktop: **Developer mode** in **Settings → System** takes updates from builds made on your own computer (`npm run dev-update` in the desktop folder) instead of the published releases.

### Changed

- Shiori Desktop: **Settings → Desktop app** is now **Settings → System**.
- Shiori Desktop: the title bar and the taskbar show just the page's name ("Library", "Settings"), without "Shiori" before it.

## v1.0.13 — 2026-10-03

### Added

- **Shiori Desktop**, an optional Windows app that keeps your library as files on your computer. Each gallery is a .cbz file (or a .zip, or a folder of images) with its details inside, so other comic readers can open it too. Translations and covers are kept separately, so your files stay as they are. Galleries you move or rename outside the app are found again, one whose files are gone shows **Files missing** until they're back, and archives or image folders you put in the library folder yourself join the library.
- In Shiori Desktop, the title bar has back and forward buttons, closing the window keeps Shiori running in the tray (you can turn this off), and quitting while an import or translation is running asks whether to wait for it, stop it, or keep Shiori open. Its own settings (library folder, file format, port, connected sites) are in **Settings → Desktop app**, and full or metadata backups can be restored in it.
- Use your Shiori Desktop library from the website: **Settings → Storage → Library location → Use Shiori Desktop…**. Shiori Desktop asks whether to allow the site, then Shiori offers to move the galleries this browser holds. An interrupted move carries on where it stopped, and this browser keeps its copies until you delete them. **Settings → Desktop app → Connected sites** lists the sites you allowed, each with **Disconnect**.
- When Shiori Desktop isn't running, the site asks you to open it or to continue in this browser for now; once it's back, Shiori offers to move what you saved meanwhile and switch back. If your browser asks to let the site connect to apps on this device, allow it; if it's blocked, Shiori tells you where to allow it.
- Volumes: a series lists its volumes apart from its chapters, with a switch between chapters and volumes on the series page that is remembered, and the reader reads volumes one after another like chapters.
- Chapters are labelled with their own numbers, decimals included ("Ch. 23.5"), and a series counts its chapters and extras separately ("125 chapters · 13 extras").
- A series card shows the progress while its chapter details are being fetched.

### Fixed

- A gallery no longer loses a page from its count, or disappears from the library, when pages arrive while its count is being updated; a series no longer ends up a page short; and sizes stay current after every change.
- A chapter with no pages saved yet now opens in the reader, and loads when it can be downloaded, instead of being skipped.
- Deleting a series while its chapter details were still being fetched no longer brings its chapters back.
- Re-downloading a gallery replaces its pages in place, so an interrupted re-download never leaves it with fewer pages.
- Exporting a series as a zip keeps each chapter's number.
- Reader: a page that is still loading no longer shows the browser's broken-image icon, and scrolling page by page in the strip view glides smoothly and keeps up with a fast mouse wheel in every browser.
- Library cards no longer jitter when you hover them while a series is being updated.
- One update notice per new version, without repeated notices after an update is published.
- The Firefox download in **Settings → Extension** now installs without Firefox blocking it.

## v1.0.12 — 2026-10-01

### Added

- Settings → Extension now offers the download that fits your browser. Firefox gets its own version, signed by Mozilla, that stays installed: after **Download**, choose **Continue to Installation**, then **Add**. Other browsers get the same download as before.

## v1.0.11 — 2026-10-01

### Added

- Import more than archives. Pick or drop PDFs and images (JPG, PNG, WebP, GIF, AVIF), or drag in whole folders. Images dropped together become one gallery; a folder becomes one gallery named after it, its subfolders included, and any archives or PDFs inside it become galleries of their own. Each PDF page becomes one page, drawn at the size of the scan inside it and stored without further loss of quality. AVIF images inside .cbz and .zip archives import too.
- Favorites: click the heart on a card, or **Add to favorites** on a gallery's page, and search `favorite:"yes"` to see them. Favoriting doesn't move a gallery in "Last Updated".
- Galleries can now have a category (manga, doujinshi, …) and a rating (safe, suggestive, erotica, pornographic). **Settings → Library upgrades → Category and rating** fills them in for your existing galleries from the source details they already have. Nothing is downloaded, and galleries keep their place in "Last Updated".
- Filter the library by category and rating with the new **Filter** button: click an option to show only it, click again to hide it, and once more to reset. Your filter is remembered.
- Add, change or remove a gallery's tags. As you type, the tags already in your library are suggested, most used first; category and rating are picked from a list.
- The search box suggests filters and tags as you type, and shows each finished filter as a block. Hold Alt and click a card's heart, translate button or source to search for galleries like it.
- Reader: navigation direction and page direction are now separate settings, and **Cover offset** adds a blank page before each chapter's first page in double-page view, so the cover sits alone.
- Settings: choose whether the top bar shows the storage totals, and whether cards show their category as the first tag.
- Hovering the image total in the top bar lists your images by page resolution.

### Changed

- Every confirmation and message now opens in Shiori's own dialog instead of the browser's. Clearing the library or resetting everything asks twice.
- Shiori looks the same everywhere: one set of colours, buttons, dialogs and tooltips on every page, and less motion when your system asks for it.
- The page thumbnails on a gallery's page appear much faster.
- Reader: the page and its translation now change together when you turn a page, so the original no longer flashes underneath and the text no longer jumps.
- Merging galleries into a series keeps one category, the first chapter's, and the highest rating, instead of adding them all up.
- The **Upload** button is now called **Import**.

### Fixed

- A series stays a favorite when its first chapter changes, whether you reorder the chapters or remove the first one.
- Galleries with AVIF pages show every page on the gallery's page, use their first page as the cover, and keep all their pages when exported and imported again.
- Restoring a full backup in another browser now lets Shiori run its one-time repairs on the restored library, instead of skipping them.

## v1.0.10 — 2026-09-28

### Changed

- New translation defaults: Hayai for text recognition, DeepSeek for translation and the shiori renderer, with larger text detection and inpainting sizes and a wider cleanup area around the text. Study data now saves text, and translation snapshots are off. Updating to this version applies these defaults once to your existing settings; your server, target language and other choices are kept.
- The target language now sits in the Config card of Settings → Translation, right below the pipeline. The separate Language and model card is gone.
- Hovering a gallery's size, or the storage total, now lists original pages and other data on separate lines. The page-size tooltip spells out "average".

### Fixed

- Web addresses no longer look like they are missing a slash. The interface font joined some character pairs into a single symbol, so "https://" could show as "https: /".

## v1.0.9 — 2026-09-27

### Added

- Translating a gallery again only redoes what changed. With **Save translation snapshots** on (Settings → Translation), each page keeps what every translation step produced, so switching the renderer, for example, re-runs just that last step instead of the whole page.
- **Re-run from…**: right-click a translated gallery's card to redo every page from one step onward (text detection, text recognition, translation, inpainting or rendering), reusing the steps before it.
- **Page properties**: press I in the reader, or use the page's new right-click menu, to see everything stored for a page: its images and how each step of its translation was made.
- **Send feedback** on a translated page from the reader: mark what went wrong, add a note, and send it for review or export it as a ZIP.
- Library cards show a gallery's average page size, and its size split into original pages and translations.
- A notice tells you when a new version of Shiori is ready, and updating applies it to every open tab at once.

### Changed

- Settings → Translation now offers exactly what your translation server can run: its models, options and languages, with the rest under **Advanced settings…**.
- Shiori now stores each image once, so changing a gallery no longer rewrites its pages. Existing libraries get a one-time choice: convert gradually as galleries change, or all at once.

## v1.0.8 — 2026-08-29

### Fixed

- Updates now take effect straight away. The offline copy of the app was tied to the version number shown in Settings → About, so anything shipped between releases could leave a browser running a mix of old and new code until the next version bump.
- Series covers no longer get replaced by a chapter's cover. When a card turned into a series while its cover was still being prepared, the older request could finish last and overwrite the series cover with the wrong image. Both covers are now kept apart and a late one is discarded.
- Series with very long chapter lists are no longer rejected. Anything past 500 chapters failed to save at all, so the longest-running series never made it into the library.

## v1.0.7 — 2026-08-24

### Added

- Settings has a new Extension section offering the browser extension for download whenever one isn't connected. It steps aside on its own once the extension is installed and takes the section over.

### Fixed

- Furigana now appears on galleries whose source never labelled a language. The readings had been captured during translation all along, but were only ever shown when the gallery carried a Japanese language tag — so galleries without one silently lost them.
- Reader: holding the mouse button and scrolling now turns exactly one page per click of the wheel. At higher browser zoom or display scaling it took two clicks to move a single page, because one click of the wheel covers less distance the further in you are zoomed.
- Reader: holding the mouse button and scrolling now also works with the pointer near the very top of the page. The invisible strip that slides the header back into view was swallowing the gesture, so it did nothing at all in that band.

## v1.0.6 — 2026-07-30

### Added

- Full backups now carry your settings. A `.shioridb` backup includes your translation server configuration, app language, and reader preferences, so restoring it on another browser or machine brings back a ready-to-use Shiori instead of a factory-fresh one.
- Settings → Danger Zone now offers **Factory Reset** next to Clear All. Clear All empties the library along with any queued jobs and half-finished imports but keeps your preferences; Factory Reset additionally erases every setting, including your translation server details.

### Changed

- Progress and error messages now follow your chosen language everywhere. Imports, downloads, and translations previously reported some of their status in English whatever the setting, and several newer screens had no translations outside English.
- Choosing a different target language for a gallery you've already translated now translates it again into the new language, instead of relabelling the translation you already had.
- A gallery counts as translated only once every page has succeeded. Galleries where some pages failed now show as partially translated, so you can run them again to fill in the rest.
- Translated pages take noticeably less storage space.
- Series pages open immediately: the chapter list appears straight away and chapter thumbnails fill in as they are ready, instead of the page waiting for the whole series first.
- The interface font ships with the app, so it looks right offline and on the very first load.

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

- Connect a translation server and translate whole galleries in one click
- Translated pages are stored next to the originals — nothing is overwritten, and you can revert at any time
- A full settings panel covers engines, languages, text detection, inpainting quality, and typesetting, with sensible presets

### Settings

- About panel with this changelog
- Lifetime disk-write counter
- Clear-all with double confirmation
