<p align="center">
  <img src="icons/icon512.png" width="96" alt="Shiori">
</p>

<h1 align="center">Shiori 栞</h1>

<p align="center">
  A manga library, reader and translator that runs in your browser.
  <br><br>
  <a href="https://shiori.cc">shiori.cc</a>
  &nbsp;·&nbsp;
  <a href="CHANGELOG.md">Changelog</a>
</p>

---

Shiori stores your galleries in your browser, shows them as a searchable library, and includes a reader and a translation feature. It needs no account, and it works offline.

## Library

- Each gallery has a card showing its cover, page count, size, tags and language.
- Search by title, tag or artist. Clicking a tag or language flag filters the library by it.
- Sort by most recent, last updated, size, page count or publication date.
- Add or remove your own tags on any gallery.

## Series

- Chapters of the same series can be grouped on one card.
- A series page lists its chapters under the series cover.
- The reader can continue from one chapter into the next.

## Reader

- Scroll, single-page and two-page modes.
- Left-to-right or right-to-left reading.
- Fit to width or height, and zoom.
- A thumbnail strip, and a progress bar that can sit on any edge of the screen.
- Reading preferences are remembered. Press `?` for the list of keyboard shortcuts.

## Translation

With a translation server connected under **Settings → Translation**, Shiori can translate a whole gallery or a single chapter. Each page goes through text detection, text recognition, translation, removal of the original lettering, and typesetting. You choose the target language and the model for each step.

- Original pages are kept. You can switch between translated and original pages, or remove a translation.
- With **Save translation snapshots** on, translating again after a settings change only repeats the steps affected by it.
- Problems on a translated page can be marked and sent as feedback.

## Study mode

Study mode shows the original page of a translated gallery. Clicking a speech bubble reveals its translation, one bubble at a time, so the two can be compared. The original text can also be displayed as selectable text, with furigana and vertical layout.

Study mode uses data saved at translation time. Turn on **Study data** under **Settings → Translation** before translating.

## Storage and privacy

- The library is stored in your browser. There is no account, analytics or tracking.
- Data leaves your device only when you send it: pages you translate, and feedback you submit.
- Shiori works offline and can be installed as an app from the browser's address bar.
- **Safe mode** blurs covers and scrambles titles and tags, for screen sharing.

## Import, export and backups

- Import `.cbz` and `.zip` files by dropping them onto the library. Imports continue in the background if you close the tab.
- Export any gallery as a `.cbz` that includes its details.
- Back up only the library's details (`.shi`), or everything including images and settings (`.shioridb`). Either restores in another browser or on another computer.

## Languages

English, 日本語, Deutsch, Français, 简体中文, 繁體中文, 한국어, Español, Português, Русский, Tiếng Việt and Bahasa Indonesia.

## Getting started

1. Open [shiori.cc](https://shiori.cc).
2. Drop `.cbz` or `.zip` files onto the library.
3. To translate, connect a translation server under **Settings → Translation**.

Each browser keeps its own library. To move it, make a full backup and restore it in the other browser.

<details>
<summary>Hosting your own copy</summary>

<br>

Shiori is a static site and can be served by any web server. From the repository root, for example:

```
npx serve -p 5500 .
```

Then open `http://localhost:5500/`. Each address keeps its own library, so use the same one every time.

</details>

## License

[MIT](LICENSE)
