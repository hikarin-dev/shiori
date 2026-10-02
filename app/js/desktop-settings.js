// desktop-settings.js — Settings → Desktop app, shown only in the desktop app's window: closing to
// the tray, the library folder (open, change, check again), how new galleries are saved, the local
// server's port, and the app's version and data folder. Each setting is the desktop app's own,
// read and changed through the window's bridge to it (`shioriDesktop.shell`).
import { t, applyTranslations } from './i18n.js';
import { confirmDialog } from './notice.js';

const shell = (action, ...args) => globalThis.shioriDesktop.shell(action, ...args);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const SWITCH = (id, label) => `
  <label class="switch-control" for="${id}">
    <input type="checkbox" id="${id}" data-i18n-aria="${label}">
    <span class="switch-track" aria-hidden="true"></span>
  </label>`;

function markup() {
  return `
  <div class="section">
    <div class="section-header"><h2 class="section-title" data-i18n="set.desk_window"></h2></div>
    <div class="section-body">
      <div class="field">
        <div class="field-label" data-i18n="set.desk_tray"></div>
        <div class="field-desc" data-i18n="set.desk_tray_desc"></div>
        ${SWITCH('deskTray', 'set.desk_tray')}
      </div>
    </div>
  </div>
  <div class="section">
    <div class="section-header"><h2 class="section-title" data-i18n="set.desk_folder"></h2></div>
    <div class="section-body">
      <div class="toggle-row">
        <div class="toggle-info">
          <div class="toggle-name"><code id="deskFolderPath"></code></div>
          <div class="toggle-desc" data-i18n="set.desk_folder_desc"></div>
        </div>
        <span class="desk-actions">
          <button class="btn-mini" id="deskOpenFolder" type="button" data-i18n="set.desk_open"></button>
          <button class="btn-mini" id="deskChangeFolder" type="button" data-i18n="set.desk_change"></button>
        </span>
      </div>
      <div class="toggle-row">
        <div class="toggle-info">
          <div class="toggle-name" data-i18n="set.desk_rescan"></div>
          <div class="toggle-desc" data-i18n="set.desk_rescan_desc"></div>
        </div>
        <button class="btn-mini" id="deskRescan" type="button" data-i18n="set.desk_rescan_btn"></button>
      </div>
      <div class="status-msg hidden" id="deskFolderStatus" role="status" aria-live="polite"></div>
    </div>
  </div>
  <div class="section">
    <div class="section-header"><h2 class="section-title" data-i18n="set.desk_new"></h2></div>
    <div class="section-body">
      <div class="field">
        <label class="field-label" for="deskFormat" data-i18n="set.desk_format"></label>
        <div class="field-desc" data-i18n="set.desk_format_desc"></div>
        <select class="field-input" id="deskFormat">
          <option value="cbz" data-i18n="set.desk_format_cbz"></option>
          <option value="zip" data-i18n="set.desk_format_zip"></option>
          <option value="folder" data-i18n="set.desk_format_folder"></option>
        </select>
      </div>
      <div class="field">
        <div class="field-label" data-i18n="set.desk_comicinfo"></div>
        <div class="field-desc" data-i18n="set.desk_comicinfo_desc"></div>
        ${SWITCH('deskComicInfo', 'set.desk_comicinfo')}
      </div>
    </div>
  </div>
  <div class="section">
    <div class="section-header"><h2 class="section-title" data-i18n="set.desk_connection"></h2></div>
    <div class="section-body">
      <div class="toggle-row">
        <div class="toggle-info">
          <div class="toggle-name" data-i18n="set.desk_server"></div>
          <div class="toggle-desc"><code id="deskServerUrl"></code></div>
        </div>
      </div>
      <div class="field">
        <label class="field-label" for="deskPort" data-i18n="set.desk_port"></label>
        <div class="field-desc" id="deskPortDesc"></div>
        <select class="field-input" id="deskPort"></select>
      </div>
    </div>
  </div>
  <div class="section">
    <div class="section-header"><h2 class="section-title" data-i18n="set.desk_about"></h2></div>
    <div class="section-body">
      <div class="toggle-row">
        <div class="toggle-info">
          <div class="toggle-name" id="deskVersion"></div>
          <div class="toggle-desc"><span data-i18n="set.desk_data_desc"></span> <code id="deskDataPath"></code></div>
        </div>
        <button class="btn-mini" id="deskOpenData" type="button" data-i18n="set.desk_open"></button>
      </div>
    </div>
  </div>`;
}

function status(text, type = 'ok') {
  const el = document.getElementById('deskFolderStatus');
  el.textContent = text;
  el.classList.remove('hidden', 'ok', 'err');
  el.classList.add(type);
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.classList.add('hidden'); el.textContent = ''; }, 6000);
}

// The tab and its panel, before Storage.
export async function initDesktopSettings() {
  const nav = document.getElementById('settingsNav');
  const panels = document.querySelector('.settings-panels');
  if (!nav || !panels || document.getElementById('panelDesktop')) return;
  const button = document.createElement('button');
  Object.assign(button, { className: 'nav-item', id: 'navDesktop', type: 'button' });
  button.dataset.panel = 'panelDesktop';
  button.dataset.i18n = 'set.nav_desktop';
  button.setAttribute('aria-controls', 'panelDesktop');
  nav.insertBefore(button, document.getElementById('navStorage'));
  const panel = document.createElement('div');
  Object.assign(panel, { className: 'panel', id: 'panelDesktop' });
  panel.setAttribute('aria-labelledby', 'navDesktop');
  panel.setAttribute('aria-hidden', 'true');
  panel.innerHTML = markup();
  panels.insertBefore(panel, document.getElementById('panelStorage'));
  applyTranslations(nav);
  applyTranslations(panel);

  const $ = (id) => document.getElementById(id);
  let state = await shell('state');
  const render = () => {
    $('deskTray').checked = state.closeToTray;
    $('deskFolderPath').textContent = state.libraryDir;
    $('deskFormat').value = state.writeFormat;
    $('deskComicInfo').checked = state.comicInfo;
    $('deskServerUrl').textContent = state.url;
    $('deskPortDesc').textContent = t('set.desk_port_desc', { port: state.ports[0] });
    $('deskPort').innerHTML = [0, ...state.ports].map(p =>
      `<option value="${p}"${p === state.port ? ' selected' : ''}>${p ? p : esc(t('set.desk_port_auto'))}</option>`).join('');
    $('deskVersion').textContent = t('set.desk_version', { version: state.version });
    $('deskDataPath').textContent = state.dataDir;
  };
  render();
  window.addEventListener('shiori-lang-change', render);

  const restart = async (body) => {
    if (await confirmDialog({ title: t('set.desk_restart_title'), body, ok: t('set.desk_restart_ok'), cancel: t('set.desk_later') })) shell('restart');
  };
  const set = async (key, value) => { state = await shell('set', key, value); render(); };

  $('deskTray').addEventListener('change', (e) => set('closeToTray', e.target.checked));
  $('deskFormat').addEventListener('change', (e) => set('writeFormat', e.target.value));
  $('deskComicInfo').addEventListener('change', (e) => set('comicInfo', e.target.checked));
  $('deskPort').addEventListener('change', async (e) => {
    await set('port', Number(e.target.value));
    restart(t('set.desk_restart_port'));
  });
  $('deskOpenFolder').addEventListener('click', () => shell('openLibraryFolder'));
  $('deskOpenData').addEventListener('click', () => shell('openDataFolder'));
  $('deskChangeFolder').addEventListener('click', async () => {
    const chosen = await shell('chooseLibraryFolder');
    if (!chosen) return;
    state = await shell('state');
    render();
    restart(t('set.desk_restart_folder', { path: chosen }));
  });
  $('deskRescan').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const r = await shell('rescan');
      const lines = [['set.desk_scan_added', r.added], ['set.desk_scan_moved', r.moved], ['set.desk_scan_missing', r.missing], ['set.desk_scan_back', r.found]]
        .filter(([, n]) => n).map(([key, n]) => t(key, { n }));
      status(lines.length ? lines.join(' · ') : t('set.desk_scan_none'));
    } catch (err) {
      status(String(err?.message || err), 'err');
    } finally {
      e.target.disabled = false;
    }
  });
}
