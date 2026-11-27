// app-update.js — tells the user when a newer version of the app is ready, and applies it everywhere
// at once. A new version shows up as a new service worker: one waiting (it doesn't take over the
// pages of the version in charge: they load code late, which another version doesn't have), or one
// that took over (a version whose pages can't be asked: 1.3's). Updating tells a waiting worker to
// take over, then reloads this tab, every other app tab and the app's other pages (its agent), so
// nothing keeps running the old code.

import * as platform from './platform.js';
import { t } from './i18n.js';
import { showToast } from './notice.js';

const CHECK_EVERY = 10 * 60 * 1000;   // a tab left open looks for a new version this often at most
let _offered = false;
let _updating = false;

function offer() {
  if (_offered || _updating) return;
  _offered = true;
  showToast({
    text: t('update.available'), action: t('update.now'), closeLabel: t('update.later'),
    onAction: (toast) => { toast.busy(t('update.updating')); applyUpdate(); },
  });
}

// Ask the worker to do something and wait for its answer (null after `ms`, or with no worker).
function askWorker(message, ms) {
  const worker = navigator.serviceWorker?.controller;
  if (!worker) return Promise.resolve(null);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), ms);
    channel.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data); };
    worker.postMessage(message, [channel.port2]);
  });
}

async function applyUpdate() {
  _updating = true;
  const reg = await navigator.serviceWorker?.getRegistration().catch(() => null);
  try { await reg?.update(); } catch {}
  // A new worker installing or waiting: told to take over once it has installed (and once no batch
  // of imports runs in the worker it replaces, which would end with it), then waited for.
  if (reg?.installing || reg?.waiting) {
    const changed = new Promise((resolve) => {
      navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
      setTimeout(resolve, 20000);
    });
    const installing = reg.installing;
    if (installing) await new Promise((resolve) => { installing.addEventListener('statechange', resolve, { once: true }); setTimeout(resolve, 20000); });
    while (reg.waiting && await platform.jobs.workerImporting()) await new Promise((resolve) => setTimeout(resolve, 1000));
    reg.waiting?.postMessage({ __shioriTakeOver: true, by: 'update' });
    await changed;
  }
  await askWorker({ __shioriRefreshShell: true }, 30000);
  platform.control.send({ type: 'APP_UPDATED', context: platform.contextId });
  location.reload();
}

if ('serviceWorker' in navigator) {
  // A worker replacing the one this page started with means newer code is live — unless it is the
  // other kind (the site's library moved between this browser and the desktop app; boot-core.js).
  const startedWith = navigator.serviceWorker.controller?.scriptURL;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (startedWith && navigator.serviceWorker.controller?.scriptURL === startedWith) offer();
  });
  // A newer worker kept waiting while the one in charge imported (sw.js install) takes over once
  // nothing is being imported: should that worker have stopped mid-import, it would wait for ever.
  // (One kept waiting for this version's pages takes over only by their Update: sw.js.)
  navigator.serviceWorker.getRegistration().then(async (reg) => {
    if (reg?.waiting && !await platform.jobs.workerImporting()) reg.waiting.postMessage({ __shioriTakeOver: true });
  }).catch(() => {});
  // A newer version waiting for the pages of the one in charge of this page (of its kind: the site's
  // library kept here or by the desktop app), now or once one found while this page is open has
  // installed. (Once a worker is in charge: on a first visit, once the first has installed.)
  navigator.serviceWorker.ready.then((reg) => {
    const waits = (worker) => !!worker && worker.scriptURL === navigator.serviceWorker.controller?.scriptURL && reg.waiting === worker;
    if (waits(reg.waiting)) offer();
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      worker?.addEventListener('statechange', () => { if (worker.state === 'installed' && waits(worker)) offer(); });
    });
  }).catch(() => {});
  let last = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || Date.now() - last < CHECK_EVERY) return;
    last = Date.now();
    navigator.serviceWorker.getRegistration().then(reg => reg?.update()).catch(() => {});
    navigator.serviceWorker.controller?.postMessage({ __shioriCheckShell: true });
  });
}

platform.control.on((msg) => {
  if (msg?.type === 'APP_UPDATE_AVAILABLE') offer();
  else if (msg?.type === 'APP_UPDATED' && msg.context !== platform.contextId) location.reload();
});
