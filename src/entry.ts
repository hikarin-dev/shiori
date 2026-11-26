// entry.ts — what the one page does before it draws anything: finds the address it was opened at.
//
// The app's addresses are clean (/, /settings, /reader?…), one segment under the site's root, and
// pages.js names them; the one page answers every one. A static host answers a clean address it has
// no file for with 404.html, which keeps the address and comes to this page by its file name: the
// address is put back here.
//
// All of it is bundled code rather than an inline script, so the page's policy is a plain
// `script-src 'self'` with no hash to drift from the bytes a host serves.
import { APP_PAGE, pageFile } from '@lib/pages.js';

// The site's root: every address of the app is one segment under it, at a domain's root and under
// a folder alike.
export const siteRoot = new URL('.', location.href).pathname;

const stored = (key: string) => { try { return sessionStorage.getItem(key); } catch { return null; } };

// Opened by its own file name, this page is at the address 404.html kept, or with none kept, at the
// root's. (A kept address is used there only, and never twice.)
export function enter() {
  const kept = stored('shiori-route');
  try { sessionStorage.removeItem('shiori-route'); } catch {}
  if (location.pathname.slice(siteRoot.length) === APP_PAGE) {
    const known = kept != null && pageFile(kept.split(/[?#]/)[0]) != null;
    history.replaceState(null, '', siteRoot + (known ? kept : location.search + location.hash));
  }
}
