// desktop-settings.js — Settings → System, shown only in the desktop app's window: closing to the
// tray, the local server's port, whether other devices on the network may open the library, and the
// sites allowed to use it, browser extensions to run in the windows,
// updates (and developer mode, which takes them from builds made on this computer), and the app's
// version and data folder. Each setting is
// the desktop app's own, read and changed through the window's bridge to it (`shioriDesktop.shell`).
// The library's folders (and archiving) are in Settings → Storage (library-folders.js).
import { t, applyTranslations } from './i18n.js';
import { shell, portChoices, addOnName, updateView, UPDATE_FOLLOW_MS, restart } from './system-settings.js';

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
      <div class="field">
        <div class="field-label" data-i18n="set.desk_lan"></div>
        <div class="field-desc" data-i18n="set.desk_lan_desc"></div>
        ${SWITCH('deskLan', 'set.desk_lan')}
      </div>
      <div id="deskLanUrls"></div>
      <div class="toggle-row">
        <div class="toggle-info">
          <div class="toggle-name" data-i18n="set.desk_sites"></div>
          <div class="toggle-desc" data-i18n="set.desk_sites_desc"></div>
        </div>
      </div>
      <div id="deskSites"></div>
    </div>
  </div>
  <div class="section">
    <div class="section-header"><h2 class="section-title" data-i18n="set.desk_ext"></h2></div>
    <div class="section-body">
      <div class="toggle-row">
        <div class="toggle-info">
          <div class="toggle-desc" data-i18n="set.desk_ext_desc"></div>
        </div>
        <button class="btn-mini" id="deskAddExtension" type="button" data-i18n="set.desk_ext_add"></button>
      </div>
      <div id="deskExtensions"></div>
    </div>
  </div>
  <div class="section">
    <div class="section-header"><h2 class="section-title" data-i18n="set.desk_updates"></h2></div>
    <div class="section-body">
      <div class="toggle-row">
        <div class="toggle-info">
          <div class="toggle-name" id="deskUpdateStatus"></div>
        </div>
        <span class="desk-actions">
          <button class="btn-save hidden" id="deskInstallUpdate" type="button" data-i18n="set.desk_restart_update"></button>
          <button class="btn-mini" id="deskCheckUpdates" type="button" data-i18n="set.desk_check"></button>
        </span>
      </div>
      <div class="field">
        <div class="field-label" data-i18n="set.desk_dev"></div>
        <div class="field-desc" id="deskDevDesc"></div>
        ${SWITCH('deskDev', 'set.desk_dev')}
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
    $('deskServerUrl').textContent = state.url;
    $('deskPortDesc').textContent = t('set.desk_port_desc', { port: state.ports[0] });
    $('deskPort').innerHTML = portChoices(state).map(({ value: p, label }) =>
      `<option value="${p}"${p === state.port ? ' selected' : ''}>${esc(label)}</option>`).join('');
    $('deskLan').checked = state.lan;
    // While it is open: the addresses another device opens (none while this computer is on no network).
    $('deskLanUrls').innerHTML = !state.lanUrls ? ''
      : `<div class="toggle-row"><div class="toggle-info">${state.lanUrls.length
        ? `<div class="toggle-name">${esc(t('set.desk_lan_at'))}</div><div class="toggle-desc">${state.lanUrls.map(u => `<code>${esc(u)}</code>`).join('<br>')}</div>`
        : `<div class="toggle-desc">${esc(t('set.desk_lan_none'))}</div>`}</div></div>`;
    $('deskSites').innerHTML = state.sites.length
      ? state.sites.map(site => `<div class="toggle-row"><div class="toggle-info"><div class="toggle-name"><code>${esc(site)}</code></div></div>
          <button class="btn-mini" type="button" data-forget="${esc(site)}">${esc(t('set.desk_disconnect'))}</button></div>`).join('')
      : `<div class="toggle-row"><div class="toggle-info"><div class="toggle-desc">${esc(t('set.desk_sites_none'))}</div></div></div>`;
    $('deskExtensions').innerHTML = state.extensions.length
      ? state.extensions.map(ext => `<div class="toggle-row"><div class="toggle-info">
          <div class="toggle-name">${esc(addOnName(ext))}</div>
          <div class="toggle-desc">${ext.error ? esc(t('set.desk_ext_failed', { error: ext.error })) : `<code>${esc(ext.dir)}</code>`}</div></div>
          <button class="btn-mini" type="button" data-remove-extension="${esc(ext.dir)}">${esc(t('set.desk_ext_remove'))}</button></div>`).join('')
      : `<div class="toggle-row"><div class="toggle-info"><div class="toggle-desc">${esc(t('set.desk_ext_none'))}</div></div></div>`;
    $('deskVersion').textContent = t('set.desk_version', { version: state.version });
    $('deskDataPath').textContent = state.dataDir;
    $('deskDev').checked = state.devUpdates;
    $('deskDevDesc').textContent = t('set.desk_dev_desc', { address: state.devFeed });
    renderUpdate();
  };
  // The update's progress, followed while something is under way.
  let following = null;
  const renderUpdate = () => {
    const u = updateView(state.update);
    $('deskUpdateStatus').textContent = u.text;
    $('deskInstallUpdate').classList.toggle('hidden', !u.ready);
    $('deskCheckUpdates').disabled = u.busy;
    if (u.busy && !following) {
      following = setTimeout(async () => {
        following = null;
        state = { ...state, update: await shell('updateState') };
        renderUpdate();
      }, UPDATE_FOLLOW_MS);
    }
  };
  render();
  window.addEventListener('shiori-lang-change', render);

  const set = async (key, value) => { state = await shell('set', key, value); render(); };

  $('deskTray').addEventListener('change', (e) => set('closeToTray', e.target.checked));
  $('deskPort').addEventListener('change', async (e) => {
    await set('port', Number(e.target.value));
    restart(t('set.desk_restart_port'));
  });
  $('deskLan').addEventListener('change', async (e) => {
    await set('lan', e.target.checked);
    restart(t('set.desk_restart_lan'));
  });
  // Both look for an update at once: follow it from the start.
  const followCheck = () => { state.update = { status: 'checking' }; renderUpdate(); };
  $('deskDev').addEventListener('change', async (e) => { await set('devUpdates', e.target.checked); followCheck(); });
  $('deskCheckUpdates').addEventListener('click', async () => { state = await shell('checkUpdates'); followCheck(); });
  $('deskInstallUpdate').addEventListener('click', () => shell('installUpdate'));
  $('deskAddExtension').addEventListener('click', async () => { state = await shell('addExtension'); render(); });
  $('deskExtensions').addEventListener('click', async (e) => {
    const dir = e.target.closest?.('[data-remove-extension]')?.dataset.removeExtension;
    if (dir) { state = await shell('removeExtension', dir); render(); }
  });
  $('deskSites').addEventListener('click', async (e) => {
    const site = e.target.closest?.('[data-forget]')?.dataset.forget;
    if (site) { state = await shell('forgetSite', site); render(); }
  });
  $('deskOpenData').addEventListener('click', () => shell('openDataFolder'));
}
