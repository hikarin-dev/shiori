// app-update.js — tells the user when a newer version of the app is ready, and applies it everywhere
// at once. A new version shows up two ways: the service worker is replaced (a new sw.js takes
// over), or the worker finds an app file changed on the server when it checks its cached copy.
// Updating brings every cached file up to date, then reloads this tab, every other app tab and the
// app's other pages (its agent), so nothing keeps running the old code.

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

export async function applyUpdate() {
  _updating = true;
  const reg = await navigator.serviceWorker?.getRegistration().catch(() => null);
  try { await reg?.update(); } catch {}
  // A new worker takes over by itself once installed: wait for it before refreshing the files.
  if (reg?.installing || reg?.waiting) {
    await new Promise((resolve) => {
      navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
      setTimeout(resolve, 20000);
    });
  }
  await askWorker({ __shioriRefreshShell: true }, 30000);
  platform.control.send({ type: 'APP_UPDATED', context: platform.contextId });
  location.reload();
}

if ('serviceWorker' in navigator) {
  // A worker replacing the one this page started with means newer code is live — unless it is the
  // other kind (the site's library moved between this browser and the desktop app; boot.js).
  const startedWith = navigator.serviceWorker.controller?.scriptURL;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (startedWith && navigator.serviceWorker.controller?.scriptURL === startedWith) offer();
  });
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
