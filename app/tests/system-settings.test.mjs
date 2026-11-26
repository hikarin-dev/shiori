// system-settings.test.mjs — Settings → System's rules (app/js/system-settings.js), held against 1.3's
// own code: the lines as desktop-settings.js had them, copied verbatim below as oracles over stand-in
// elements, give the same port choices, the same add-on names and the same update line (its words,
// Restart to update shown, Check off and the state followed) for the same states, in every language.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.BroadcastChannel = class { postMessage() {} close() {} addEventListener() {} removeEventListener() {} };
const _ls = new Map();
globalThis.localStorage = { getItem: (k) => (_ls.has(k) ? _ls.get(k) : null), setItem: (k, v) => _ls.set(k, String(v)), removeItem: (k) => _ls.delete(k) };
globalThis.window ??= globalThis;
globalThis.addEventListener ??= () => {};
globalThis.dispatchEvent ??= () => true;
globalThis.CustomEvent ??= class extends Event { constructor(type, init) { super(type); this.detail = init?.detail; } };
// (A document with nothing to translate in it: setLang() walks one.)
globalThis.document ??= { documentElement: { lang: 'en' }, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };
const { t, setLang, SUPPORTED } = await import('../js/i18n.js');
const { portChoices, addOnName, updateView, UPDATE_FOLLOW_MS } = await import('../js/system-settings.js');

// ── 1.3's code, verbatim but for its elements (stand-ins with the same properties) ────────────────
function oracle() {
  const els = {};
  const $ = (id) => (els[id] ??= { textContent: '', innerHTML: '', disabled: false, classList: { hidden: false, toggle(name, on) { if (name === 'hidden') this.hidden = on; } } });
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  let state;
  const ports = () => {
    $('deskPort').innerHTML = [0, ...state.ports].map(p =>
      `<option value="${p}"${p === state.port ? ' selected' : ''}>${p ? p : esc(t('set.desk_port_auto'))}</option>`).join('');
    return $('deskPort').innerHTML;
  };
  const extName = (ext) => esc(ext.name ? `${ext.name} ${ext.version || ''}` : ext.dir);
  const UPDATE_TEXT = {
    idle: () => t('set.desk_check_desc'), checking: () => t('set.desk_checking'), none: () => t('set.desk_up_to_date'),
    downloading: (u) => t('set.desk_downloading', { version: u.version, percent: u.percent ?? 0 }),
    ready: (u) => t('set.desk_ready', { version: u.version }), error: (u) => t('set.desk_update_error', { error: u.error }),
    unavailable: () => t('set.desk_update_unavailable'),
  };
  let following = null;
  const followed = [];
  const setTimeout = (fn, ms) => { followed.push(ms); return 1; };
  const renderUpdate = () => {
    const u = state.update || { status: 'idle' };
    $('deskUpdateStatus').textContent = (UPDATE_TEXT[u.status] || UPDATE_TEXT.idle)(u);
    $('deskInstallUpdate').classList.toggle('hidden', u.status !== 'ready');
    $('deskCheckUpdates').disabled = u.status === 'checking' || u.status === 'downloading';
    if ((u.status === 'checking' || u.status === 'downloading') && !following) {
      following = setTimeout(async () => {
        following = null;
      }, 700);
    }
  };
  return {
    ports: (s) => { state = s; return ports(); },
    extName,
    update: (s) => {
      state = s; following = null; followed.length = 0;
      renderUpdate();
      return { text: $('deskUpdateStatus').textContent, ready: !$('deskInstallUpdate').classList.hidden, busy: $('deskCheckUpdates').disabled, followed: [...followed] };
    },
  };
}

// The new module's port choices drawn as 1.3 drew them.
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const drawn = (state) => portChoices(state).map(({ value: p, label }) => `<option value="${p}"${p === state.port ? ' selected' : ''}>${esc(label)}</option>`).join('');

const PORTS = [
  { ports: [47153, 47154, 47155], port: 0 },
  { ports: [47153, 47154, 47155], port: 47154 },
  { ports: [47153], port: 47153 },
  { ports: [5000, 5001], port: 9999 },
];
const ADD_ONS = [
  { name: 'Reader tools', version: '1.2.0', dir: 'C:\\addons\\reader' },
  { name: 'No version', dir: '/opt/addon' },
  { dir: 'C:\\Users\\someone\\Desktop\\unpacked <one> & "two"' },
  { name: '', version: '3', dir: 'D:\\x' },
];
const UPDATES = [
  undefined, null, { status: 'idle' }, { status: 'checking' }, { status: 'none' },
  { status: 'downloading', version: '1.4.0', percent: 42 }, { status: 'downloading', version: '1.4.0' },
  { status: 'ready', version: '1.4.0' }, { status: 'error', error: 'net::ERR_INTERNET_DISCONNECTED' },
  { status: 'unavailable' }, { status: 'something new' },
];

test('the port\'s choices, as 1.3\'s page offered them, in every language', async () => {
  const o = oracle();
  for (const lang of SUPPORTED) {
    await setLang(lang);
    for (const state of PORTS) assert.equal(drawn(state), o.ports(state), `${lang} ${JSON.stringify(state)}`);
  }
  await setLang('en');
  assert.deepEqual(portChoices(PORTS[1]).map((c) => c.value), [0, 47153, 47154, 47155]);
});

test('an add-on\'s name, as 1.3\'s page wrote it', () => {
  const o = oracle();
  for (const ext of ADD_ONS) assert.equal(esc(addOnName(ext)), o.extName(ext), JSON.stringify(ext));
});

test('the update\'s line for each state: its words, Restart to update, Check off and followed, as 1.3\'s page drew them', async () => {
  const o = oracle();
  for (const lang of SUPPORTED) {
    await setLang(lang);
    for (const update of UPDATES) {
      const old = o.update({ update });
      const { text, ready, busy } = updateView(update);
      assert.deepEqual({ text, ready, busy, followed: busy ? [UPDATE_FOLLOW_MS] : [] }, old, `${lang} ${JSON.stringify(update)}`);
    }
  }
  await setLang('en');
});
