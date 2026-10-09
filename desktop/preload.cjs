// preload.cjs — tells the app's page where its library is: the desktop app's local server and its
// pairing token. The main process answers only for the app's own pages. It also carries the page's
// requests to the desktop app (Settings → System, backups: `shell(action, ...args)`), says where on
// disk a file dropped or picked in the page is (`pathOf`: '' for one that isn't a file there), and
// tells the main process which language the app is in, so its dialogs, tray and title bar speak it too.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const config = ipcRenderer.sendSync('shiori:config');
if (config) {
  contextBridge.exposeInMainWorld('shioriDesktop', {
    ...config,
    shell: (action, ...args) => ipcRenderer.invoke('shiori:shell', action, args),
    pathOf: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
  });
  // The language chosen in Settings (i18n.js keeps it in localStorage), else the one the app picked
  // and set on <html lang> once its page loaded; reported again whenever it changes.
  const report = () => {
    let chosen = null;
    try { chosen = localStorage.getItem('shiori-lang'); } catch {}
    ipcRenderer.send('shiori:lang', chosen || document.documentElement.lang || '');
  };
  window.addEventListener('load', report);
  window.addEventListener('shiori-lang-change', report);
}
