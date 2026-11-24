// about.ts — what the About dialog shows: the app's version (its web manifest) and its changelog
// (CHANGELOG.md, drawn as app/js/changelog.js says, by marked: vendor/marked.min.js, a classic script,
// loaded into the page the first time). Read once for the page's life; a page that shows About asks
// for it as it shows (1.3 read both at load), so the dialog opens drawn.
import { CHANGELOG_UNAVAILABLE, renderChangelog } from '@lib/changelog.js';
import { siteRoot } from '../entry';

export type About = { version: string; changelog: string };

type Marked = { use(options: unknown): void; parse(text: string): string };

function loadMarked(): Promise<Marked> {
  const own = (globalThis as { marked?: Marked }).marked;
  if (own) return Promise.resolve(own);
  return new Promise((loaded, failed) => {
    const script = document.createElement('script');
    script.src = `${siteRoot}vendor/marked.min.js`;
    script.onload = () => { const marked = (globalThis as { marked?: Marked }).marked; if (marked) loaded(marked); else failed(new Error('marked')); };
    script.onerror = () => failed(new Error('marked'));
    document.head.append(script);
  });
}

let reading: Promise<About> | null = null;

export function readAbout(): Promise<About> {
  return (reading ??= Promise.all([
    fetch(`${siteRoot}app/manifest.webmanifest`).then((r) => r.json()).then((m) => (m?.version ? `v${m.version}` : '')).catch(() => ''),
    Promise.all([loadMarked(), fetch(`${siteRoot}CHANGELOG.md`).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.text(); })])
      .then(([marked, text]) => renderChangelog(marked, text) as string).catch(() => CHANGELOG_UNAVAILABLE),
  ]).then(([version, changelog]) => ({ version, changelog })));
}
