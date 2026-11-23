// entry.ts — what the one page does before it draws anything: finds the address it was opened at,
// and decides whether it is the page that answers it.
//
// The app's addresses are clean (/, /settings, /reader?…), one segment under the site's root, and
// pages.js says which file answers each. The service worker serves that file at the clean address.
// So this page finds itself at an address another file answers only when no worker served the
// navigation: a first visit, a hard reload (which bypasses the worker), or a worker that failed.
// Those cases want opposite things, so they are handled separately:
//
//   Worker already installed (hard reload, returning visitor) — it is active and waiting, so
//   reloading is near-instant and the worker answers with the right page, the address left clean.
//
//   First visit — nothing is installed yet, and installing means fetching the app's whole code
//   shell. Waiting for that is a blank screen for several seconds, so it is skipped entirely: the
//   page goes straight to the real file. The app registers the worker from there (boot-core.js), so
//   installation still happens, just with the page already on screen. The address bar shows
//   app/<page>.html for that one visit; every later visit is served by the worker at the clean one.
//
// The retry flag (cleared by the app once it boots, in boot-core.js) stops a worker that cannot take
// over from bouncing the page in a loop.
//
// All of it is bundled code rather than an inline script, so the page's policy is a plain
// `script-src 'self'` with no hash to drift from the bytes a host serves.
import { APP_PAGE, pageFile } from '@lib/pages.js';

// The site's root: every address of the app is one segment under it, at a domain's root and under
// a folder alike.
export const siteRoot = new URL('.', location.href).pathname;

const stored = (key: string) => { try { return sessionStorage.getItem(key); } catch { return null; } };

// Another file answers this address: hand the visitor to it.
async function handOver(file: string): Promise<void> {
  const toFile = () => location.replace(siteRoot + file + location.search + location.hash);

  if (!('serviceWorker' in navigator) || stored('shiori-sw-retry')) return toFile();

  let existing = null;
  try { existing = await navigator.serviceWorker.getRegistration(); } catch {}
  if (!existing || !existing.active) return toFile();   // first visit: don't wait on install

  try { sessionStorage.setItem('shiori-sw-retry', '1'); } catch {}
  try {
    // Bounded even here: a worker stuck activating must not strand the visitor on a blank page.
    await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error('sw timeout')), 4000)),
    ]);
    location.reload();   // the worker answers this one, with the right page, at the clean address
    return;
  } catch {}
  toFile();
}

// Resolves true when this page is the one to draw what the address asks for; false when the visitor
// is on the way to the file that does.
export async function enter(): Promise<boolean> {
  // A static host answers a clean address with 404.html, which keeps the address and comes to this
  // page by its file name. The address is put back; opened by its file name with no address kept,
  // this page is at the root's. (A kept address is used there only, and never twice.)
  const kept = stored('shiori-route');
  try { sessionStorage.removeItem('shiori-route'); } catch {}
  if (location.pathname.slice(siteRoot.length) === APP_PAGE) {
    const known = kept != null && pageFile(kept.split(/[?#]/)[0]) != null;
    history.replaceState(null, '', siteRoot + (known ? kept : location.search + location.hash));
  }

  const file = pageFile(location.pathname.slice(siteRoot.length));
  if (file == null || file === APP_PAGE) return true;   // an address the app doesn't have is drawn as such
  await handOver(file);
  return false;
}
