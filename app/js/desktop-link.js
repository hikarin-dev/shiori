// desktop-link.js — a site's use of the Shiori Desktop library, in a browser (never on a page the
// desktop app serves — its window, or a browser tab at its address — whose library it always is):
//   • Settings → Storage, the library's card: switching between this browser's library and the
//     desktop app's (finding the app, asking it to allow this site, offering to move what this
//     browser holds), moving or deleting what this browser still holds (mountLocation);
//   • when the desktop app can't be reached: a prompt to open it or continue in this browser alone
//     for now, a reminder while continuing, and — once the app is back — an offer to move what was
//     saved meanwhile and switch back; when it runs but no longer lets this site in, a prompt to
//     ask it again or go back to this browser's library; when the browser doesn't let this site
//     reach apps on this device, where to allow it.
//   • a browser tab at the desktop app's own address: when the app is closed, a prompt to open it.
// The location itself is library-location.js's; every page of the site reloads onto a new one.
import * as api from './api.js';
import * as platform from './platform.js';
import { t, applyTranslations } from './i18n.js';
import { formatCount } from './format.js';
import { ask, showProgress, confirmDialog, alertDialog, showToast } from './notice.js';
import { savedLocation, setLocation, fallback, setFallback, findDesktop, pingDesktop, localAccess, requestPairing, desktopHosted } from './library-location.js';
import { browserGalleries, moveToDesktop, clearBrowserLibrary } from './library-move.js';

const OPEN_APP = 'shiori://open';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Every page of the site reloads onto the library it now uses.
function switchTo(loc, { inBrowserForNow = false } = {}) {
  if (loc !== undefined) setLocation(loc);
  setFallback(inBrowserForNow);
  platform.control.send({ type: 'LIBRARY_RESET', context: platform.contextId });
  location.reload();
}

// Move `ids` into the desktop library, with a progress window. Resolves true when all of them moved.
async function move(config, ids) {
  const stop = new AbortController();
  const progress = showProgress({ title: t('dlg.loc_moving'), stopLabel: t('common.cancel'), onStop: () => stop.abort() });
  try {
    const result = await moveToDesktop(config, ids, {
      signal: stop.signal,
      onProgress: (done, total) => progress.update(done, total, t('maint.progress', { done: formatCount(done), total: formatCount(total) })),
    });
    progress.close();
    if (stop.signal.aborted) return false;
    if (result.failed.length) {
      await alertDialog({ title: t('dlg.loc_move_failed'), body: t('dlg.loc_move_failed_body', { n: formatCount(result.failed.length) }),
        detail: result.failed[0].error, tone: 'error' });
      return false;
    }
    return true;
  } catch (e) {
    progress.close();
    await alertDialog({ title: t('dlg.loc_move_failed'), body: String(e?.message || e), tone: 'error' });
    return false;
  }
}

// Ask the desktop app at `url` to let this site use its library, showing that it's waiting for the
// person's answer there. Resolves the token, or null (said so) when it wasn't allowed.
async function pair(url) {
  const waiting = showProgress({ title: t('dlg.loc_pair_title'), body: t('dlg.loc_pair_body') });
  const token = await requestPairing(url);
  waiting.close();
  if (!token) await alertDialog({ title: t('dlg.loc_pair_denied'), tone: 'error' });
  return token;
}

// ── Starting to use the desktop library ──
async function useDesktop(status) {
  if (!(await confirmDialog({ title: t('dlg.loc_connect_title'), body: t('dlg.loc_connect_body'), ok: t('dlg.loc_connect_ok') }))) return;
  let url = null;
  for (;;) {
    status(t('set.loc_finding'));
    url = await findDesktop({ preferred: savedLocation()?.url });
    status('');
    if (url) break;
    if (await localAccess() === 'denied') { await alertDialog({ title: t('dlg.loc_blocked_title'), body: t('dlg.loc_blocked_body'), tone: 'error' }); return; }
    const choice = await ask({ title: t('dlg.loc_not_found_title'), body: t('dlg.loc_not_found_body'), choices: [
      { value: 'open', label: t('gate.open') }, { value: 'retry', label: t('dlg.loc_try_again') }, { value: 'cancel', label: t('common.cancel') }] });
    if (choice === 'cancel') return;
    if (choice === 'open') { location.href = OPEN_APP; await sleep(4000); }
  }
  const token = await pair(url);
  if (!token) return;
  const config = { url, token };
  const ids = await browserGalleries();
  if (ids.length && await confirmDialog({ title: t('dlg.loc_move_title'), body: t('dlg.loc_move_body', { n: formatCount(ids.length) }),
    ok: t('dlg.loc_move_ok'), cancel: t('dlg.loc_move_later') })) {
    if (!(await move(config, ids))) return;
  }
  switchTo(config);
}

// Settings → Storage: where this site's library is, at the top of the library's card
// (library-folders.js): this browser or Shiori Desktop, as a choice of the two, and — on the desktop
// library — what this browser still holds, to move or delete. `el` is the card's place for it;
// `status(text)` its status line. (Not on a page the desktop app serves.)
export async function mountLocation(el, status = () => {}) {
  if (desktopHosted() || !el) return;
  const render = async () => {
    const { saved, away, left, descKey, url } = await locationView();
    const desc = `${esc(t(descKey))}${url ? ` <code>${esc(url)}</code>` : ''}`;
    el.innerHTML = `
      <div class="field">
        <div class="field-label" data-i18n="lf.location"></div>
        <div class="field-desc">${desc}</div>
        <div class="choice-toggle lf-loc" role="group">
          <button type="button" data-loc="browser" class="${saved ? '' : 'active'}" aria-pressed="${!saved}" data-i18n="set.loc_browser"></button>
          <button type="button" data-loc="desktop" class="${saved ? 'active' : ''}" aria-pressed="${!!saved}" data-i18n="set.loc_desktop"></button>
        </div>
      </div>
      ${away ? '<div class="lf-loc-row"><span></span><button class="btn-mini" id="locRetry" type="button" data-i18n="set.loc_retry"></button></div>' : ''}
      ${left ? `<div class="lf-loc-row"><span>${esc(t('set.loc_left', { n: formatCount(left) }))}</span>
        <span class="desk-actions"><button class="btn-mini" id="locMove" type="button" data-i18n="set.loc_move"></button>
        <button class="btn-mini btn-clear-key" id="locDelete" type="button" data-i18n="set.loc_delete"></button></span></div>` : ''}`;
    applyTranslations(el);
    el.querySelector('[data-loc="desktop"]').addEventListener('click', () => chooseDesktop(status));
    el.querySelector('[data-loc="browser"]').addEventListener('click', () => chooseBrowser());
    el.querySelector('#locRetry')?.addEventListener('click', () => retryDesktop(saved));
    el.querySelector('#locMove')?.addEventListener('click', async () => {
      if (await moveLeft(saved, left, status)) render();
    });
    el.querySelector('#locDelete')?.addEventListener('click', async () => {
      if (await deleteLeft(left)) render();
    });
  };
  await render();
  window.addEventListener('shiori-lang-change', render);
}

// What the location says now: `saved` (the desktop library chosen, or null: this browser's), `away`
// (continuing in this browser for now), `left` (galleries this browser still holds, on the desktop
// library), its description's key and the desktop library's address to show after it.
export async function locationView() {
  const saved = savedLocation();
  const away = !!(saved && fallback());
  const left = saved && !away ? (await browserGalleries().catch(() => [])).length : 0;
  return { saved, away, left,
    descKey: !saved ? 'lf.loc_browser_desc' : away ? 'set.loc_fallback_desc' : 'set.loc_desktop_desc', url: saved && !away ? saved.url : '' };
}
// The choice's two buttons: the desktop library (finding the app, asking it, offering to move what
// this browser holds) and this browser's (asked first).
export function chooseDesktop(status) { if (!savedLocation()) useDesktop(status); }
export async function chooseBrowser() {
  if (!savedLocation()) return;
  if (await confirmDialog({ title: t('dlg.loc_browser_title'), body: t('dlg.loc_browser_body'), ok: t('set.loc_use_browser') })) switchTo(null);
}
// Continuing in this browser for now: try the desktop app again.
export const retryDesktop = (saved) => offerReturn(saved, { asked: true });
// What this browser still holds (`left` galleries), moved to the desktop library (said in `status`) or
// deleted (asked first). Each resolves whether it was done.
export async function moveLeft(saved, left, status) {
  if (!(await move(saved, await browserGalleries()))) return false;
  status(t('set.loc_moved', { n: formatCount(left) }));
  return true;
}
export async function deleteLeft(left) {
  if (!(await confirmDialog({ title: t('dlg.loc_delete_title'), body: t('dlg.loc_delete_body', { n: formatCount(left) }), ok: t('dlg.delete'), danger: true }))) return false;
  await clearBrowserLibrary();
  return true;
}

// ── The desktop app can't be reached ──
let _asking = false;

// The desktop app now: 'back' (its library answers this site), 'refused' (it runs, but no longer lets
// this site in: the site was disconnected there), 'blocked' (the browser doesn't let this site reach
// apps on this device) or null (not running). Its last address is asked each time; every one of its
// ports (it may have started on another) only on a `full` check.
async function desktopState({ full = true } = {}) {
  if (await localAccess() === 'denied') return 'blocked';
  const answers = await pingDesktop(savedLocation()?.url);
  if (!answers && !full) return null;
  if (await api.connection.reachable()) return 'back';
  return answers ? 'refused' : null;
}

// Continue in this browser alone for now, once the person has read what that means.
async function continueInBrowser() {
  await alertDialog({ title: t('gate.warn_title'), body: t('gate.warn_body'), tone: 'info' });
  switchTo(undefined, { inBrowserForNow: true });
}

// The browser doesn't let this site reach apps on this device: say where to allow it.
async function blocked() {
  const choice = await ask({ title: t('dlg.loc_blocked_title'), body: t('dlg.loc_blocked_body'), choices: [
    { value: 'retry', label: t('dlg.loc_try_again') },
    { value: 'browser', label: t('gate.browser'), detail: t('gate.browser_detail') }] });
  if (choice === 'retry') location.reload();
  else await continueInBrowser();
}

// The desktop app runs but turns this site away: ask it again, or go back to this browser's library.
async function refused() {
  for (;;) {
    const choice = await ask({ title: t('gate.refused_title'), body: t('gate.refused_body'), choices: [
      { value: 'pair', label: t('gate.ask_again') }, { value: 'browser', label: t('set.loc_use_browser') }] });
    if (choice === 'browser') { switchTo(null); return; }
    const { url } = savedLocation();
    const token = await pair(url);
    if (token) { switchTo({ url, token }); return; }
  }
}

// The desktop app, back: offer to move what was saved meanwhile and switch back. `asked`: the person
// asked to try again (say so when it still can't be reached).
async function offerReturn(saved, { asked = false } = {}) {
  if (_asking) return;
  if (!(await api.desktopReachable(saved))) {
    if (asked) await alertDialog({ title: t('gate.title'), body: t('dlg.loc_not_found_body'), tone: 'info' });
    return;
  }
  _asking = true;
  try {
    const current = savedLocation() || saved;
    const ids = await browserGalleries({ since: fallback()?.since ?? Date.now() });
    const choice = await ask({ title: t('gate.back_title'),
      body: ids.length ? t('gate.back_body', { n: formatCount(ids.length) }) : t('gate.back_body_none'),
      choices: [{ value: 'switch', label: t(ids.length ? 'gate.move_switch' : 'gate.switch') }, { value: 'later', label: t('gate.later') }] });
    if (choice !== 'switch') return;
    if (ids.length && !(await move(current, ids))) return;
    switchTo(undefined);
  } finally { _asking = false; }
}

// Every page of a site using the desktop library: the prompt when the app can't be reached, the
// reminder while continuing without it, and noticing when it is back.
export async function initDesktopGate() {
  if (desktopHosted()) return;
  const saved = savedLocation();
  if (!saved) return;
  if (fallback()) {
    const remind = () => showToast({ text: t('gate.banner'), action: t('gate.retry'), closeLabel: t('common.close'),
      onAction: () => offerReturn(saved, { asked: true }) });
    remind();
    const watch = async () => { await offerReturn(saved); setTimeout(watch, 30000); };
    setTimeout(watch, 30000);
    return;
  }
  const gate = async () => {
    if (_asking) return;
    _asking = true;
    try {
      const state = await desktopState();
      if (state === 'refused') { await refused(); return; }
      if (state === 'blocked') { await blocked(); return; }
      for (;;) {
        // While the question is open, the page reloads as soon as the app answers (or as soon as it
        // can't be reached for another reason, which the reloaded page then says).
        let answered = false;
        const poll = async () => {
          for (let i = 1; !answered; i++) { await sleep(2000); if (!answered && await desktopState({ full: i % 10 === 0 })) location.reload(); }
        };
        poll();
        const choice = await ask({ title: t('gate.title'), body: t('gate.body'), choices: [
          { value: 'open', label: t('gate.open'), detail: t('gate.open_detail') },
          { value: 'browser', label: t('gate.browser'), detail: t('gate.browser_detail') }] });
        answered = true;
        if (choice === 'browser') { await continueInBrowser(); return; }
        location.href = OPEN_APP;
        for (let i = 1; i <= 10; i++) { await sleep(2000); if (await desktopState({ full: i % 5 === 0 })) { location.reload(); return; } }
      }
    } finally { _asking = false; }
  };
  // A read the page was making as the app went away fails as 'unavailable': the prompt is what the
  // person sees of it.
  window.addEventListener('unhandledrejection', (e) => { if (e.reason?.code === 'unavailable') e.preventDefault(); });
  if (!(await api.connection.reachable())) { gate(); return; }
  // Lost later (the app was closed): give it a moment to come back first.
  api.connection.onUnavailable(() => setTimeout(async () => { if (!(await api.connection.reachable())) gate(); }, 5000));
}

// A browser tab at the desktop app's own address: its library is the app's and nowhere else, so
// while the app is closed the one way on is to open it. The page reloads as soon as it is back.
export async function initHostedGate() {
  if (api.capabilities.desktopWindow || !desktopHosted()) return;
  let asking = false;
  const gate = async () => {
    if (asking) return;
    asking = true;
    (async () => { for (;;) { await sleep(2000); if (await api.connection.reachable()) { location.reload(); return; } } })();
    await ask({ title: t('gate.title'), body: t('gate.hosted_body'), choices: [{ value: 'open', label: t('gate.open'), detail: t('gate.open_detail') }] });
    location.href = OPEN_APP;
  };
  window.addEventListener('unhandledrejection', (e) => { if (e.reason?.code === 'unavailable') e.preventDefault(); });
  if (!(await api.connection.reachable())) { gate(); return; }
  api.connection.onUnavailable(() => setTimeout(async () => { if (!(await api.connection.reachable())) gate(); }, 5000));
}
