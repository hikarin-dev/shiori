// main.js — Shiori Desktop: the app in its own window, over a library kept as files. The main
// process owns the library (server/library.js) and serves it on 127.0.0.1 (server/server.js). Each
// window shows the app's pages at one fixed address, shiori-app://shiori (forwarded to the server,
// so the app's own settings, kept per address, survive a change of port), under a title bar strip
// of its own: back and forward, the page's title, and Windows' window buttons. One instance runs at
// a time; a second launch (or a shiori:// link) brings its window forward. Closing the window can
// leave Shiori in the tray; quitting while work runs asks first.
import { app, BaseWindow, WebContentsView, Menu, Tray, nativeImage, dialog, shell, ipcMain, protocol, net } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// The app's pages: the repository's in development, the packaged copy in an installed build.
const UI_ROOT = app.isPackaged ? path.join(process.resourcesPath, 'ui') : path.resolve(here, '..');
process.env.SHIORI_UI_DIR = path.join(UI_ROOT, 'app');
// Where this run keeps its settings (overridable, so a test run never touches a person's own).
if (process.env.SHIORI_USER_DATA) app.setPath('userData', path.resolve(process.env.SHIORI_USER_DATA));

const { Library } = await import('./server/library.js');
const { startServer } = await import('./server/server.js');
const { translator, pickLanguage, isLanguage } = await import('./i18n.js');

const APP_SCHEME = 'shiori-app';
const APP_ORIGIN = `${APP_SCHEME}://shiori`;
const DEFAULT_PORT = 47153;   // tried first, then the next nine (D14)
const PORTS = Array.from({ length: 10 }, (_, i) => DEFAULT_PORT + i);
const PAGES = new Set(['library', 'reader', 'overview', 'settings']);
const FORMATS = new Set(['cbz', 'zip', 'folder']);
const TITLEBAR_HEIGHT = 32;
const FRAME = { bg: '#0d0d0f', symbols: '#a1a1aa' };   // the app's palette (base.css --bg, --muted)

// The app's pages are a standard, secure origin of their own: storage, modules and fetch as on the web.
protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } }]);

// ── Settings: { libraryDir, port, bounds, lang, closeToTray, sites } in the app's data folder ──
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) || {}; } catch { return {}; }
}
function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}
const libraryDirOf = (settings) => path.resolve(process.env.SHIORI_LIBRARY_DIR || settings.libraryDir || path.join(app.getPath('documents'), 'Shiori Library'));
// Each library folder has its own index and cache, kept on this computer even when the folder is on
// a network drive.
const dataDirOf = (libraryDir) => path.join(app.getPath('userData'), 'libraries',
  crypto.createHash('sha256').update(libraryDir.toLowerCase()).digest('hex').slice(0, 16));
const closeToTray = () => readSettings().closeToTray !== false;

let library = null, server = null, token = null, mainWindow = null, tray = null, libraryDir = null;
const windows = new Map();   // window → { view, bar }
const pending = [];          // shiori:// links that arrived before the window

// Dialogs, the tray and the title bar speak the app's language: the one its window last reported
// (kept in settings for the next start), else the system's.
let lang = 'en';
let t = translator(lang);
function useLanguage(next) {
  lang = next;
  t = translator(lang);
  buildTray();
  for (const parts of windows.values()) sendTitlebar(parts);
}

if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', (_event, argv) => {
  const link = argv.find(a => a.startsWith('shiori://'));
  if (link) openLink(link); else showWindow();
});
app.on('open-url', (event, link) => { event.preventDefault(); openLink(link); });
if (app.isPackaged) app.setAsDefaultProtocolClient('shiori');

// A shiori:// link: shiori://reader?g=… opens that page; anything else brings the window forward.
function openLink(link) {
  if (!server) { pending.push(link); return; }
  let target = null;
  try {
    const url = new URL(link);
    const page = (url.hostname || url.pathname.replace(/^\/+/, '')).toLowerCase();
    if (PAGES.has(page)) target = `/${page}${url.search}`;
  } catch {}
  showWindow(target);
}

function showWindow(target = null) {
  closingAfterJobs = false;
  if (!mainWindow || mainWindow.isDestroyed()) { mainWindow = createWindow(target || '/library'); return; }
  if (target) windows.get(mainWindow).view.webContents.loadURL(APP_ORIGIN + target);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  buildTray();
}

const isApp = (url) => { try { const u = new URL(url); return u.protocol === `${APP_SCHEME}:` && u.hostname === 'shiori'; } catch { return false; } };
const external = (url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); };
const fromApp = (event) => !!server && isApp(event.senderFrame?.url || '');
const partsOf = (contents) => [...windows.values()].find(p => p.view.webContents === contents || p.bar.webContents === contents);
const windowOf = (contents) => [...windows].find(([, p]) => p.view.webContents === contents || p.bar.webContents === contents)?.[0] || null;

// ── Windows: the title bar strip over the app's page ──
// A page's title without the app's name before it ("Shiori — Library" → "Library"): the window is
// Shiori's already.
const pageTitle = (title) => String(title || '').replace(/^Shiori\s*[—–-]\s*/, '') || 'Shiori';
function sendTitlebar({ view, bar }) {
  if (bar.webContents.isDestroyed() || view.webContents.isDestroyed()) return;
  const history = view.webContents.navigationHistory;
  bar.webContents.send('titlebar:state', { canGoBack: history.canGoBack(), canGoForward: history.canGoForward(),
    title: pageTitle(view.webContents.getTitle()), labels: { back: t('back'), forward: t('forward') } });
}

function createWindow(target) {
  const { bounds } = readSettings();
  const win = new BaseWindow({
    width: bounds?.width || 1280, height: bounds?.height || 860, x: bounds?.x, y: bounds?.y,
    minWidth: 640, minHeight: 480, title: 'Shiori', backgroundColor: FRAME.bg, show: false,
    icon: path.join(UI_ROOT, 'icons', 'icon512.png'),
    titleBarStyle: 'hidden', titleBarOverlay: { color: FRAME.bg, symbolColor: FRAME.symbols, height: TITLEBAR_HEIGHT },
  });
  const bar = new WebContentsView({ webPreferences: { preload: path.join(here, 'titlebar-preload.cjs'), contextIsolation: true, sandbox: true } });
  const view = new WebContentsView({ webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true,
    nodeIntegration: false, spellcheck: false } });
  for (const v of [bar, view]) v.setBackgroundColor(FRAME.bg);
  win.contentView.addChildView(view);
  win.contentView.addChildView(bar);
  const parts = { view, bar };
  windows.set(win, parts);

  const layout = () => {
    const [width, height] = win.getContentSize();
    const top = win.isFullScreen() ? 0 : TITLEBAR_HEIGHT;
    bar.setBounds({ x: 0, y: 0, width, height: top });
    view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
  };
  for (const e of ['resize', 'enter-full-screen', 'leave-full-screen', 'maximize', 'unmaximize']) win.on(e, layout);
  layout();
  if (bounds?.maximized) win.maximize();

  const contents = view.webContents;
  for (const e of ['did-navigate', 'did-navigate-in-page', 'page-title-updated']) contents.on(e, () => sendTitlebar(parts));
  contents.on('page-title-updated', (_event, title) => win.setTitle(pageTitle(title)));   // the taskbar's name for it
  bar.webContents.on('did-finish-load', () => sendTitlebar(parts));
  let shown = false;
  const reveal = () => { if (!shown) { shown = true; win.show(); } };
  contents.once('did-finish-load', reveal);
  setTimeout(reveal, 4000);
  // The app's own pages open in a Shiori window; everything else in the person's browser.
  contents.setWindowOpenHandler(({ url }) => {
    if (isApp(url)) { const u = new URL(url); createWindow(u.pathname + u.search); } else external(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => { if (!isApp(url)) { event.preventDefault(); external(url); } });
  contents.on('before-input-event', (event, input) => { if (shortcut(win, contents, input)) event.preventDefault(); });
  // The mouse's back and forward buttons.
  win.on('app-command', (_event, command) => {
    if (command === 'browser-backward' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    if (command === 'browser-forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
  });

  win.on('close', (event) => {
    if (win === mainWindow) writeSettings({ bounds: { ...win.getNormalBounds(), maximized: win.isMaximized() } });
    if (quitting || win !== mainWindow) return;
    event.preventDefault();
    if (closeToTray()) win.hide(); else requestQuit();
  });
  win.on('closed', () => {
    windows.delete(win);
    for (const v of [view, bar]) if (!v.webContents.isDestroyed()) v.webContents.close();
    if (win === mainWindow) mainWindow = null;
  });
  // Windows signing out or shutting down: nothing may hold it up.
  win.on('session-end', () => { quitting = true; });

  bar.webContents.loadFile(path.join(here, 'titlebar.html'));
  contents.loadURL(APP_ORIGIN + target);
  return win;
}

// The shortcuts a menu would have carried. Returns true when `input` was one.
function shortcut(win, contents, input) {
  if (input.type !== 'keyDown') return false;
  const key = input.key, ctrl = input.control || input.meta, k = key.length === 1 ? key.toLowerCase() : key;
  const history = contents.navigationHistory;
  if ((input.alt && k === 'ArrowLeft') || k === 'BrowserBack') { if (history.canGoBack()) history.goBack(); return true; }
  if ((input.alt && k === 'ArrowRight') || k === 'BrowserForward') { if (history.canGoForward()) history.goForward(); return true; }
  if (k === 'F5' || (ctrl && k === 'r')) { if (input.shift || (ctrl && k === 'F5')) contents.reloadIgnoringCache(); else contents.reload(); return true; }
  if (k === 'F12' || (ctrl && input.shift && k === 'i')) { contents.toggleDevTools(); return true; }
  if (ctrl && (k === '=' || k === '+')) { contents.setZoomLevel(Math.min(5, contents.getZoomLevel() + 0.5)); return true; }
  if (ctrl && (k === '-' || k === '_')) { contents.setZoomLevel(Math.max(-5, contents.getZoomLevel() - 0.5)); return true; }
  if (ctrl && k === '0') { contents.setZoomLevel(0); return true; }
  if (k === 'F11') { win.setFullScreen(!win.isFullScreen()); return true; }
  return false;
}

ipcMain.on('titlebar:back', (event) => { const p = partsOf(event.sender); if (p?.view.webContents.navigationHistory.canGoBack()) p.view.webContents.navigationHistory.goBack(); });
ipcMain.on('titlebar:forward', (event) => { const p = partsOf(event.sender); if (p?.view.webContents.navigationHistory.canGoForward()) p.view.webContents.navigationHistory.goForward(); });

// The page asks where its library is; only the app's own pages are told.
ipcMain.on('shiori:config', (event) => {
  event.returnValue = fromApp(event) ? { url: server.url, token } : null;
});
// The page says which language the app is in (as it loads, and whenever it changes).
ipcMain.on('shiori:lang', (event, value) => {
  if (!fromApp(event) || !isLanguage(value) || value === lang) return;
  writeSettings({ lang: value });
  useLanguage(value);
});

// ── Settings → System ──
function shellState() {
  const settings = readSettings();
  return {
    closeToTray: settings.closeToTray !== false,
    libraryDir: libraryDirOf(settings), dataDir: dataDirOf(libraryDir),
    writeFormat: library.files.writeFormat(), comicInfo: library.files.comicInfo(),
    port: settings.port || 0, ports: PORTS, url: server.url, version: app.getVersion(),
    sites: Object.keys(settings.sites || {}).sort(),
    devUpdates: !!settings.devUpdates, devFeed: DEV_FEED, update, packaged: app.isPackaged,
  };
}
ipcMain.handle('shiori:shell', async (event, action, args = []) => {
  if (!fromApp(event)) throw new Error('not available');
  const [key, value] = args;
  switch (action) {
    case 'state': return shellState();
    case 'set':
      if (key === 'closeToTray' && typeof value === 'boolean') writeSettings({ closeToTray: value });
      else if (key === 'writeFormat' && FORMATS.has(value)) library._kvSet('writeFormat', value);
      else if (key === 'comicInfo' && typeof value === 'boolean') library._kvSet('comicInfo', value);
      else if (key === 'port' && (value === 0 || PORTS.includes(value))) writeSettings({ port: value || undefined });
      else if (key === 'devUpdates' && typeof value === 'boolean') {
        writeSettings({ devUpdates: value || undefined });
        if (update.status !== 'downloading' && update.status !== 'ready') update = { status: 'idle' };
        checkForUpdates();
      }
      else throw new Error(`no setting ${key}`);
      return shellState();
    case 'openLibraryFolder': await shell.openPath(libraryDir); return true;
    case 'openDataFolder': await shell.openPath(dataDirOf(libraryDir)); return true;
    case 'chooseLibraryFolder': {
      const current = libraryDirOf(readSettings());
      const chosen = await pickFolder(current, windowOf(event.sender) || mainWindow);
      if (!chosen || chosen === current) return null;
      writeSettings({ libraryDir: chosen });
      return chosen;
    }
    case 'rescan': {
      const r = await library.rescan();
      return { added: r.added.length, moved: r.moved.length, missing: r.missing.length, found: r.found.length };
    }
    case 'forgetSite': {
      const sites = { ...sitesOf() };
      if (typeof key !== 'string' || !(key in sites)) return shellState();
      delete sites[key];
      writeSettings({ sites });
      server.dropSite(key);
      return shellState();
    }
    case 'restart': requestQuit({ relaunch: true }); return true;
    case 'checkUpdates': checkForUpdates(); return shellState();
    case 'updateState': return update;
    case 'installUpdate': if (update.status === 'ready') requestQuit({ relaunch: true, install: true }); return true;
    default: throw new Error(`no action ${action}`);
  }
});

// A folder chosen for the library, or null.
async function pickFolder(current, parent = null) {
  const options = { title: t('choose_folder'), defaultPath: current, properties: ['openDirectory', 'createDirectory'] };
  const { canceled, filePaths } = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  return canceled || !filePaths[0] ? null : path.resolve(filePaths[0]);
}

// ── Sites allowed to use the library (from a browser: library-location.js in the app) ──
// Each has a token of its own, given once the person allows it here. One question at a time; a
// site that was refused waits a minute before it can ask again.
const sitesOf = () => readSettings().sites || {};
let asking = null;
const refusedUntil = new Map();
const clients = {
  tokenFor: (origin) => sitesOf()[origin] || null,
  siteOf(token) {
    const key = Buffer.from(String(token || ''));
    for (const [origin, given] of Object.entries(sitesOf())) {
      const other = Buffer.from(String(given));
      if (other.length === key.length && crypto.timingSafeEqual(other, key)) return origin;
    }
    return null;
  },
  async approve(origin) {
    if ((refusedUntil.get(origin) || 0) > Date.now() || asking) return null;
    asking = (async () => {
      if (mainWindow) { if (!mainWindow.isVisible()) mainWindow.show(); mainWindow.focus(); }
      const options = { type: 'question', title: 'Shiori', noLink: true, defaultId: 1, cancelId: 1,
        message: t('pair_title', { site: origin }), detail: t('pair_body'), buttons: [t('pair_allow'), t('pair_deny')] };
      const { response } = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
      if (response !== 0) { refusedUntil.set(origin, Date.now() + 60000); return null; }
      const token = crypto.randomBytes(24).toString('base64url');
      writeSettings({ sites: { ...sitesOf(), [origin]: token } });
      return token;
    })();
    try { return await asking; } finally { asking = null; }
  },
};

// ── The tray ──
function buildTray() {
  if (!server) return;
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(path.join(UI_ROOT, 'icons', 'icon32.png')));
    tray.on('click', () => showWindow());
  }
  tray.setToolTip(closingAfterJobs ? `Shiori — ${t('closing_after')}` : 'Shiori');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('open_app'), click: () => showWindow() },
    { type: 'separator' },
    closingAfterJobs
      ? { label: t('quit_now'), click: async () => { await pageCall('cancelJobs'); reallyQuit(); } }
      : { label: t('quit'), click: () => requestQuit() },
  ]));
}

// ── Quitting ──
// The work running in the app's window: { count, titles } (app/js/desktop-shell.js). A window that
// can't say (still loading, or gone) holds nothing up.
async function pageCall(fn) {
  const contents = mainWindow && windows.get(mainWindow)?.view.webContents;
  if (!contents || contents.isDestroyed()) return null;
  const call = contents.executeJavaScript(`import('/app/js/desktop-shell.js').then((m) => m.${fn}())`, true).catch(() => null);
  return Promise.race([call, new Promise(r => setTimeout(() => r(null), 5000))]);
}
const activeJobs = async () => (await pageCall('activeJobs')) || { count: 0, titles: [] };

let quitting = false, closingAfterJobs = false, relaunchAfter = false, installAfter = false;

// Quit for real, after asking when work is still running: close once it finishes (from the tray),
// stop it and close now, or stay. `install`: the downloaded update is installed, and Shiori started
// again by it.
async function requestQuit({ relaunch = false, install = false } = {}) {
  if (quitting) return;
  relaunchAfter = relaunchAfter || relaunch;
  installAfter = installAfter || install;
  const jobs = await activeJobs();
  if (!jobs.count) { reallyQuit(); return; }
  const shown = jobs.titles.slice(0, 5);
  const more = jobs.count - shown.length;
  if (mainWindow && !mainWindow.isVisible()) { mainWindow.show(); mainWindow.focus(); }
  const options = { type: 'question', title: 'Shiori', message: t('quit_jobs_title'), noLink: true, defaultId: 0, cancelId: 2,
    detail: [t('quit_jobs_body'), '', ...shown.map(s => `•  ${s}`), ...(more > 0 ? [t('quit_jobs_more', { n: more })] : [])].join('\n'),
    buttons: [t('quit_wait'), t('quit_cancel'), t('quit_stay')] };
  const { response } = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
  if (response === 0) { closingAfterJobs = true; mainWindow?.hide(); buildTray(); waitForJobs(); }
  else if (response === 1) { await pageCall('cancelJobs'); reallyQuit(); }
  else relaunchAfter = installAfter = false;
}

function waitForJobs() {
  if (!closingAfterJobs || quitting) return;
  activeJobs().then((jobs) => { if (!closingAfterJobs) return; if (jobs.count) setTimeout(waitForJobs, 3000); else reallyQuit(); });
}

// Every gallery waiting to be packed is packed, then the app ends.
async function reallyQuit() {
  if (quitting) return;
  quitting = true;
  if (relaunchAfter && !installAfter) app.relaunch();
  await library?.files.flush().catch(() => {});
  await server?.close().catch(() => {});
  library?.close();
  tray?.destroy();
  if (installAfter && updater) updater.quitAndInstall(true, true);   // the installer starts Shiori again
  else app.quit();
}

// ── Updates ──
// From the published releases (the feed the installer names, app-update.yml), or — in developer
// mode, Settings → System — from builds made on this computer (`npm run dev-update` in desktop/
// serves them at DEV_FEED). Checked at startup and when asked; a newer version downloads by itself
// and is installed when Shiori restarts for it, or next quits. Packaged builds only.
const DEV_FEED = 'http://127.0.0.1:47199/';
let updater = null;
let update = { status: 'idle' };   // idle | checking | none | downloading | ready | error | unavailable (+ version, percent, error)

function releasesFeed() {
  const feed = {};
  try {
    for (const line of fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8').split(/\r?\n/)) {
      const m = /^(\w+):\s*(.+)$/.exec(line);
      if (m) feed[m[1]] = m[2].trim();
    }
  } catch {}
  return feed;
}

async function updaterReady() {
  if (!app.isPackaged) return null;
  if (!updater) {
    ({ autoUpdater: updater } = (await import('electron-updater')).default);
    updater.on('checking-for-update', () => { update = { status: 'checking' }; });
    updater.on('update-not-available', () => { update = { status: 'none' }; });
    updater.on('update-available', (info) => { update = { status: 'downloading', version: info.version, percent: 0 }; });
    updater.on('download-progress', (p) => { update = { ...update, status: 'downloading', percent: Math.floor(p.percent || 0) }; });
    updater.on('update-downloaded', (info) => { update = { status: 'ready', version: info.version }; });
    updater.on('error', (e) => { update = { status: 'error', error: String(e?.message || e).split('\n')[0] }; });
  }
  updater.setFeedURL(readSettings().devUpdates ? { provider: 'generic', url: DEV_FEED } : releasesFeed());
  return updater;
}

// Look for a newer version now (it downloads by itself when there is one); `notify`: say so in a
// system notification once it is ready.
async function checkForUpdates({ notify = false } = {}) {
  if (update.status === 'checking' || update.status === 'downloading' || update.status === 'ready') return;
  let u;
  try { u = await updaterReady(); } catch (e) { update = { status: 'error', error: String(e?.message || e).split('\n')[0] }; return; }
  if (!u) { update = { status: 'unavailable' }; return; }
  await (notify ? u.checkForUpdatesAndNotify() : u.checkForUpdates()).catch(() => {});   // 'error' says why
}
app.on('before-quit', (event) => { if (!quitting && library) { event.preventDefault(); requestQuit(); } });
app.on('window-all-closed', () => { if (quitting) app.quit(); });

// ── Start ──
async function start() {
  const settings = readSettings();
  useLanguage(isLanguage(settings.lang) ? settings.lang : pickLanguage(app.getPreferredSystemLanguages()));
  libraryDir = libraryDirOf(settings);
  for (;;) {
    try {
      fs.mkdirSync(libraryDir, { recursive: true });
      library = await new Library({ dataDir: dataDirOf(libraryDir), libraryDir, trash: (p) => shell.trashItem(p) }).open();
      break;
    } catch (e) {
      const { response } = await dialog.showMessageBox({ type: 'error', buttons: [t('try_again'), t('choose_other'), t('quit')], defaultId: 0,
        message: t('open_failed'), detail: `${libraryDir}\n\n${e?.message || e}` });
      if (response === 1) {
        const chosen = await pickFolder(libraryDir);
        if (chosen) { writeSettings({ libraryDir: chosen }); libraryDir = chosen; }
      }
      if (response === 2) { app.exit(1); return; }
    }
  }
  token = crypto.randomBytes(24).toString('base64url');
  const ports = settings.port ? [settings.port, ...PORTS.filter(p => p !== settings.port), 0] : [...PORTS, 0];
  server = await startServer({ library, token, ports, webRoot: UI_ROOT, version: app.getVersion(), origins: [APP_ORIGIN], clients });
  // The app's pages, served by the local server whatever its port.
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    try {
      return await net.fetch(`${server.url}${url.pathname}${url.search}`, { method: request.method === 'HEAD' ? 'HEAD' : 'GET' });
    } catch (e) {
      console.warn('[shiori] app page request failed:', url.pathname, String(e?.message || e));
      return new Response('', { status: 502 });
    }
  });
  Menu.setApplicationMenu(null);
  buildTray();
  mainWindow = createWindow('/library');
  for (const link of pending.splice(0)) openLink(link);
  const first = process.argv.find(a => a.startsWith('shiori://'));
  if (first) openLink(first);
  // The library folder may have changed while the app was closed.
  library.rescan().catch((e) => console.warn('[shiori] rescan failed:', e));
  checkForUpdates({ notify: true });
}

app.whenReady().then(start);
