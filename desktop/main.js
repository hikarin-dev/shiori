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

// ── Settings: { libraryDir, port, bounds, lang, closeToTray } in the app's data folder ──
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
function sendTitlebar({ view, bar }) {
  if (bar.webContents.isDestroyed() || view.webContents.isDestroyed()) return;
  const history = view.webContents.navigationHistory;
  bar.webContents.send('titlebar:state', { canGoBack: history.canGoBack(), canGoForward: history.canGoForward(),
    title: view.webContents.getTitle(), labels: { back: t('back'), forward: t('forward') } });
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
  contents.on('page-title-updated', (_event, title) => win.setTitle(title || 'Shiori'));   // the taskbar's name for it
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

// ── Settings → Desktop app ──
function shellState() {
  const settings = readSettings();
  return {
    closeToTray: settings.closeToTray !== false,
    libraryDir: libraryDirOf(settings), dataDir: dataDirOf(libraryDir),
    writeFormat: library.files.writeFormat(), comicInfo: library.files.comicInfo(),
    port: settings.port || 0, ports: PORTS, url: server.url, version: app.getVersion(),
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
    case 'restart': requestQuit({ relaunch: true }); return true;
    default: throw new Error(`no action ${action}`);
  }
});

// A folder chosen for the library, or null.
async function pickFolder(current, parent = null) {
  const options = { title: t('choose_folder'), defaultPath: current, properties: ['openDirectory', 'createDirectory'] };
  const { canceled, filePaths } = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  return canceled || !filePaths[0] ? null : path.resolve(filePaths[0]);
}

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

let quitting = false, closingAfterJobs = false, relaunchAfter = false;

// Quit for real, after asking when work is still running: close once it finishes (from the tray),
// stop it and close now, or stay.
async function requestQuit({ relaunch = false } = {}) {
  if (quitting) return;
  relaunchAfter = relaunchAfter || relaunch;
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
  else relaunchAfter = false;
}

function waitForJobs() {
  if (!closingAfterJobs || quitting) return;
  activeJobs().then((jobs) => { if (!closingAfterJobs) return; if (jobs.count) setTimeout(waitForJobs, 3000); else reallyQuit(); });
}

// Every gallery waiting to be packed is packed, then the app ends.
async function reallyQuit() {
  if (quitting) return;
  quitting = true;
  if (relaunchAfter) app.relaunch();
  await library?.files.flush().catch(() => {});
  await server?.close().catch(() => {});
  library?.close();
  tray?.destroy();
  app.quit();
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
  server = await startServer({ library, token, ports, webRoot: UI_ROOT, version: app.getVersion(), origins: [APP_ORIGIN] });
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
  if (app.isPackaged) {
    try {
      const { default: updater } = await import('electron-updater');
      updater.autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    } catch {}
  }
}

app.whenReady().then(start);
