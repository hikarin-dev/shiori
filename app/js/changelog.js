// changelog.js — CHANGELOG.md as the About dialog shows it, drawn by marked (vendor/marked.min.js, a
// classic script the page loads and hands in), with a heading rule of its own: the file's title is
// left out, and a version's heading is split into its number and its date.

const SET_UP = new WeakSet();

// The changelog `text` (Markdown) as HTML.
export function renderChangelog(marked, text) {
  if (!SET_UP.has(marked)) {
    SET_UP.add(marked);
    marked.use({
      gfm: true,
      renderer: {
        heading({ text, depth }) {
          if (depth === 1) return '';
          if (depth === 2) {
            const m = text.match(/^(.+?) — (.+)$/);
            if (m) return `<h2><span class="cl-ver">${m[1]}</span><span class="cl-date">${m[2]}</span></h2>\n`;
            return `<h2>${text}</h2>\n`;
          }
          return false;
        }
      }
    });
  }
  return marked.parse(text);
}

// What shows when the changelog could not be read.
export const CHANGELOG_UNAVAILABLE = '<p>Changelog unavailable.</p>';
