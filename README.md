# Shiori 栞

A local-first gallery **library and reader** that runs entirely in your browser. Galleries live in IndexedDB on your machine — no server, no account, no telemetry. Install it as a PWA and it works offline.

![](icons/icon128.png)

## What it does

- **Library** — a windowed grid of every gallery you've stored, with cover thumbnails, page counts, sizes, tags, search, and sorting. Scales to large libraries: only the visible page of cards is ever loaded.
- **Reader** — scroll-strip, single-page, and double-page modes, a draggable thumbnail strip, a page scrubber, and full keyboard navigation. Pages stream straight out of IndexedDB as blob URLs.
- **Import** — drop `.cbz` / `.zip` archives onto the library (multiple at once) and they become galleries. Each file shows live progress and finishes in the background even if you close the tab.
- **Export** — any gallery exports as a `.cbz` with its metadata bundled, re-importable losslessly. Shift-click exports metadata only.
- **Backups** — lightweight metadata-only backups (`.shi`) or full-library backups including images (`.shioridb`) for moving between browsers or machines.
- **Translation** — point it at a self-hosted [manga-image-translator](https://github.com/zyddnys/manga-image-translator) server and translate whole galleries; translated pages are stored alongside the originals and toggled in the reader.
- **Search** — partial matches on ID, title, and tags; `tag:"name"` / `artist:"name"` typed filters; click any tag chip to add it to the search.
- **Safe mode** — one click blurs covers and scrambles titles/tags for screen-sharing.

## Running it

Shiori is a static site with no build step — any web server works. From the repo root, for example:

```
npx serve -p 5500 .        # or VS Code Live Server, nginx, …
```

Then open `http://localhost:5500/` (it lands in the library at `/app/library`). Use the same origin every time: the library is stored per-origin in IndexedDB. If you roll your own server, make sure `.js` files are served as `text/javascript` (ES modules refuse to load otherwise); the included `404.html` keeps the clean URLs working on static hosts like GitHub Pages.

For an app-like experience, install it as a PWA (install icon in the address bar). The service worker caches the shell, so it opens instantly and works offline.

## Keyboard reference (reader)

| Control | Action |
|---|---|
| `←` `↑` `W` `A` | Previous page |
| `→` `↓` `S` `D` `Space` | Next page |
| `Shift` + navigation key | First / last page |
| `Home` / `End` | First / last page |
| `1` / `2` / `3` | Single page / double page / scroll strip |
| `T` | Toggle thumbnail strip |
| `?` / `Esc` | Shortcuts overlay |

In the thumbnail strip: drag to swipe, `Shift`+drag to scrub, click to jump. The library grid pages with `←`/`→` too.

## Companion extension

The app is deliberately **site-agnostic**: it contains no site-specific code. A separate companion browser extension (not part of this repository) can plug in at runtime to capture pages while you browse, download whole galleries, and fetch metadata — the app discovers it automatically and shows those actions only when it's present. Without it, everything above still works on imported archives.

## Storage & privacy

- Everything is stored in your browser profile's IndexedDB for this origin. Nothing leaves your machine except requests you initiate (e.g. to your own translation server).
- Settings → Danger Zone → **Clear All** wipes the library.
- No analytics, no telemetry, no third-party requests.

## Tech

- Pure HTML/CSS/JS ES modules — no build step, no framework, one vendored file (`marked` for the changelog).
- IndexedDB stores image **Blobs** (not base64), with windowed index-cursor queries so memory stays bounded by what's on screen.
- A PWA service worker serves the app shell stale-while-revalidate and runs durable jobs (imports, translation) that survive tab closes.
- Live updates everywhere via `BroadcastChannel`: every open tab reflects a change the moment it lands in the database.
