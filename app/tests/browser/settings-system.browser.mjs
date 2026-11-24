// settings-system.browser.mjs — Settings → System as the one page draws it (src/routes/settings/
// system.tsx), held against 1.3's page (desktop-settings.js). The panel is the desktop app's window's
// alone, so both pages run with a stand-in for the window's bridge (`shioriDesktop.shell`), installed
// before any script of the page runs: it keeps every call it receives and answers from a state of its
// own, and reaches nothing (no request, no socket; the harness refuses any other address anyway). The
// desktop app itself is never started.
//
//   - Where it shows: only in the desktop app's window, its nav item before Storage.
//   - One table of actions driven on both pages: after each, the calls the bridge received (in order,
//     with their arguments), the question asked if any, and the words, switches and buttons on the
//     panel, the same on both. A restart is asked about and answered Later; Restart now, Restart to
//     update and anything that would restart or update the app are never pressed.
//   - An update followed every 700 ms while it is under way: each state the line passes through, kept
//     by an observer in the page as it changes.
//   - The phone form, and leaving the page five times leaving nothing behind.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';

const NEW = '/settings-next';   // step 5e: '/settings'
const OLD = '/settings';        // 1.3's page, while it answers /settings
const PAGES = [['1.3\'s page', OLD], ['the new page', NEW]];

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

const skip = (t) => { if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return true; } return false; };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (page, fn, arg) => page.evaluate(fn, arg);

// The stand-in bridge: the app's state (System's and the archiving card's), the calls kept in
// window.__shell, an update's progress as a list of states `updateState` answers one by one.
function bridge() {
  const LONG = 'C:\\Users\\someone with a rather long name\\AppData\\Roaming\\Shiori\\a folder nested quite deep\\and deeper still\\library-index';
  let state = {
    closeToTray: false, url: 'http://127.0.0.1:9/', port: 0, ports: [41000, 41001, 41002, 41003], lan: false, lanUrls: null,
    sites: ['https://a.example', 'http://127.0.0.1:9'],
    extensions: [{ name: 'Add-on One', version: '1.0.0', dir: 'C:\\addons\\one' }, { dir: 'C:\\addons\\broken', error: 'Manifest file is missing' }],
    version: '1.4.0', dataDir: LONG, devUpdates: false, devFeed: 'http://127.0.0.1:9/feed/', update: { status: 'idle' },
    archiveAfter: 'week', archiveFormat: 'zip',
  };
  window.__updates = [];
  window.__shell = [];
  window.shioriDesktop = { shell: async (action, ...args) => {
    window.__shell.push(JSON.parse(JSON.stringify([action, ...args])));
    switch (action) {
      case 'state': return state;
      case 'set':
        state = { ...state, [args[0]]: args[1] };
        if (args[0] === 'lan') state.lanUrls = args[1] ? ['http://192.0.2.10:41000/', 'http://[2001:db8::1]:41000/'] : null;
        return state;
      case 'updateState': return window.__updates.length > 1 ? window.__updates.shift() : window.__updates[0] ?? state.update;
      case 'checkUpdates': return state;
      case 'addExtension': state = { ...state, extensions: [...state.extensions, { name: 'Added', version: '2.0', dir: 'D:\\added' }] }; return state;
      case 'removeExtension': state = { ...state, extensions: state.extensions.filter((e) => e.dir !== args[0]) }; return state;
      case 'forgetSite': state = { ...state, sites: state.sites.filter((s) => s !== args[0]) }; return state;
      default: return null;
    }
  } };
  // Every state the update's line passes through, kept as it changes (a state may stand for 700 ms).
  const seen = window.__lines = [];
  new MutationObserver(() => {
    const line = document.getElementById('deskUpdateStatus')?.textContent;
    if (line && seen.at(-1) !== line) seen.push(line);
  }).observe(document, { subtree: true, childList: true, characterData: true });
}

// What the panel shows: its words (but a select's list: 1.3's native one holds every option, the drawn
// one its choice), the port chosen, the switches, the buttons shown and whether each is off.
function view() {
  const panel = document.getElementById('panelDesktop');
  const shown = (el) => !!el && el.getClientRects().length > 0;
  const words = panel.cloneNode(true);
  words.querySelectorAll('select, [data-slot^="select"]').forEach((x) => x.remove());
  const port = document.getElementById('deskPort');
  return {
    words: words.textContent.replace(/\s+/g, ''),
    port: port.tagName === 'SELECT' ? port.selectedOptions[0]?.textContent : port.textContent,
    switches: ['deskTray', 'deskLan', 'deskDev'].map((id) => document.getElementById(id).checked ?? document.getElementById(id).getAttribute('aria-checked') === 'true'),
    buttons: [...panel.querySelectorAll('button:not([data-slot^="select"]):not([role="switch"])')].filter(shown).map((b) => [b.id, b.textContent.trim(), b.disabled]),
    code: [...panel.querySelectorAll('code')].map((c) => c.textContent),
  };
}

// The question on top, if any (notice.js's on 1.3's page, the notice host's on the new one), and
// pressing its button named `label`; installed in the page as window.__question and window.__answer.
function questions() {
  const top = () => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter((x) => x.getClientRects().length).at(-1);
  window.__question = () => {
    const d = top();
    return d ? { title: d.querySelector('h2')?.textContent ?? '', text: d.querySelector('p')?.textContent ?? '',
      buttons: [...d.querySelectorAll('button')].filter((b) => b.getClientRects().length).map((b) => b.textContent.trim()).filter(Boolean) } : null;
  };
  window.__answer = (label) => {
    const b = [...(top()?.querySelectorAll('button') || [])].find((x) => x.textContent.trim() === label);
    b?.click();
    return !!b;
  };
  // The update row's buttons that show, and the gaps before, between and after them inside the row
  // (its padding taken off): all 0 but the 8px between two when they take the row's whole width.
  window.__share = () => {
    const shown = ['deskInstallUpdate', 'deskCheckUpdates'].map((id) => document.getElementById(id)).filter((b) => b.getClientRects().length);
    const row = shown[0].closest('.toggle-row, [data-slot="setting-row"]');
    const box = row.getBoundingClientRect(), style = getComputedStyle(row);
    const edges = [box.left + parseFloat(style.paddingLeft), ...shown.flatMap((b) => { const r = b.getBoundingClientRect(); return [r.left, r.right]; }), box.right - parseFloat(style.paddingRight)];
    return { shown: shown.map((b) => b.id), gaps: edges.flatMap((edge, i) => (i % 2 ? [Math.round(edge - edges[i - 1])] : [])) };
  };
}

async function open(t, path, { viewport, early } = {}) {
  const context = await browser.createBrowserContext();
  t.after(() => context.close().catch(() => {}));
  const page = await openPage(context, origin);
  await page.evaluateOnNewDocument(bridge);
  await page.evaluateOnNewDocument(questions);
  if (early) await page.evaluateOnNewDocument(early);
  if (viewport) await page.setViewport(viewport);
  await page.goto(`${origin}${path}`, { waitUntil: 'load' });
  await until(page, () => !!document.getElementById('navDesktop') && !!document.getElementById('deskVersion')?.textContent, null, { what: 'System' });
  // (Pressed again until it shows: 1.3's markup is there before its script listens.)
  await until(page, () => { const p = document.getElementById('panelDesktop'); if (!p.classList.contains('active')) document.getElementById('navDesktop').click(); return p.classList.contains('active'); }, null, { what: 'System shown' });
  return page;
}

// The port chosen from its list: 1.3's native select, the new page's drawn one (by its label).
async function choosePort(page, label) {
  if (await run(page, () => document.getElementById('deskPort').tagName === 'SELECT')) {
    const value = await run(page, (l) => [...document.getElementById('deskPort').options].find((o) => o.textContent === l).value, label);
    await page.select('#deskPort', value);
    return;
  }
  await page.click('#deskPort');
  await page.waitForSelector('[data-slot="select-list"][data-open] [data-slot="select-option"]');
  await pause(300);   // (a drawn list takes no press in its first moments)
  await until(page, (l) => {
    const o = [...document.querySelectorAll('[data-slot="select-list"][data-open] [data-slot="select-option"]')].find((x) => x.textContent === l);
    o?.click();
    return !document.querySelector('[data-slot="select-list"][data-open]');
  }, label, { what: `${label} chosen` });
}

// A switch pressed as a person presses it: 1.3's label, the new page's switch (its id is on its hidden
// checkbox on both).
async function flip(page, id) {
  const target = await page.evaluateHandle((id) => document.querySelector(`label[for="${id}"]`) || document.getElementById(id).parentElement.querySelector('[role="switch"]'), id);
  await target.click();
}
const calls = (page) => run(page, () => window.__shell.splice(0));
const asked = (page) => until(page, () => window.__question(), null, { what: 'the question' });
async function later(page) {
  await until(page, () => window.__answer('Later'), null, { what: 'Later' });
  await until(page, () => !window.__question(), null, { what: 'no question' });
}
const settle = async (page) => { await pause(250); };

// Each step: what it does on the page, and what it waits for (the same on both); it returns what
// else it saw (a question, the update's lines).
const STEPS = [
  ['drawn', async () => {}],
  ['the tray switched on', async (p) => { await flip(p, 'deskTray'); await until(p, () => window.__shell.some((c) => c[0] === 'set'), null, { what: 'stored' }); }],
  ['another port chosen: a restart asked, Later', async (p) => {
    await choosePort(p, '41001');
    const q = await asked(p);
    await later(p);
    return q;
  }],
  ['the network opened: a restart asked, Later; the addresses shown', async (p) => {
    await flip(p, 'deskLan');
    const q = await asked(p);
    await later(p);
    await until(p, () => document.getElementById('deskLanUrls').textContent.includes('192.0.2.10'), null, { what: 'the addresses' });
    return q;
  }],
  ['this computer on no network', async (p) => {
    await run(p, async () => { window.__noNet = true; });
    await flip(p, 'deskLan');
    await asked(p); await later(p);
    await flip(p, 'deskLan');
    await asked(p); await later(p);
  }],
  ['a site disconnected', async (p) => {
    await run(p, () => document.querySelector('[data-forget="https://a.example"]').click());
    await until(p, () => !document.querySelector('[data-forget="https://a.example"]'), null, { what: 'gone' });
  }],
  ['every site disconnected', async (p) => {
    await run(p, () => document.querySelector('[data-forget]').click());
    await until(p, () => !document.querySelector('[data-forget]'), null, { what: 'none' });
  }],
  ['an add-on added', async (p) => {
    await p.click('#deskAddExtension');
    await until(p, () => !!document.querySelector('[data-remove-extension="D:\\\\added"]'), null, { what: 'added' });
  }],
  ['an add-on removed', async (p) => {
    await run(p, () => document.querySelector('[data-remove-extension="C:\\\\addons\\\\one"]').click());
    await until(p, () => !document.querySelector('[data-remove-extension="C:\\\\addons\\\\one"]'), null, { what: 'removed' });
  }],
  ['every add-on removed', async (p) => {
    for (let i = 0; i < 2; i++) {
      await run(p, () => document.querySelector('[data-remove-extension]').click());
      await until(p, (n) => document.querySelectorAll('[data-remove-extension]').length === n, 1 - i, { what: 'removed' });
    }
  }],
  ['Check for updates: followed until one is ready', async (p) => {
    await run(p, () => { window.__lines.length = 0; window.__updates.push({ status: 'checking' }, { status: 'downloading', version: '1.4.1', percent: 40 }, { status: 'downloading', version: '1.4.1' }, { status: 'ready', version: '1.4.1' }); });
    await p.click('#deskCheckUpdates');
    await until(p, () => /1\.4\.1/.test(document.getElementById('deskUpdateStatus').textContent) && document.getElementById('deskInstallUpdate').getClientRects().length > 0
      && !document.getElementById('deskCheckUpdates').disabled, null, { what: 'ready', timeout: 8000 });
    await pause(1600);   // (nothing more is asked once it is ready)
    return run(p, () => window.__lines.slice());
  }],
  ['developer mode on: followed until it says there is none', async (p) => {
    await run(p, () => { window.__lines.length = 0; window.__updates.length = 0; window.__updates.push({ status: 'checking' }, { status: 'none' }); });
    await flip(p, 'deskDev');
    await until(p, () => !document.getElementById('deskCheckUpdates').disabled && window.__shell.some((c) => c[0] === 'updateState'), null, { what: 'settled', timeout: 8000 });
    await pause(1600);
    return run(p, () => window.__lines.slice());
  }],
  ['an update that fails', async (p) => {
    await run(p, () => { window.__lines.length = 0; window.__updates.length = 0; window.__updates.push({ status: 'error', error: 'net::ERR_TIMED_OUT' }); });
    await p.click('#deskCheckUpdates');
    await until(p, () => /ERR_TIMED_OUT/.test(document.getElementById('deskUpdateStatus').textContent), null, { what: 'the error', timeout: 8000 });
    await pause(1600);
    return run(p, () => window.__lines.slice());
  }],
  ['the data folder opened', async (p) => { await p.click('#deskOpenData'); await until(p, () => window.__shell.some((c) => c[0] === 'openDataFolder'), null, { what: 'asked' }); }],
  ['in Japanese', async (p) => {
    await run(p, async () => (await import('/app/js/i18n.js')).setLang('ja'));
    await until(p, () => document.getElementById('navDesktop').textContent !== 'System', null, { what: 'Japanese' });
    await pause(300);
  }],
];

test('the desktop app\'s window (a stand-in for its bridge): the same calls, questions and words as 1.3\'s page, after each of a table of actions', async (t) => {
  if (skip(t)) return;
  const seen = [];
  for (const [, path] of PAGES) {
    const page = await open(t, path);
    // (On no network: the addresses the bridge answers are none.)
    await run(page, () => {
      const shell = window.shioriDesktop.shell;
      window.shioriDesktop.shell = async (action, ...args) => {
        const out = await shell(action, ...args);
        return out && window.__noNet && out.lan ? { ...out, lanUrls: [] } : out;
      };
    });
    await settle(page);
    await calls(page);   // (what both asked as they loaded: the state, for System and the archiving card)
    const steps = [];
    for (const [name, step] of STEPS) {
      const saw = await step(page);
      await settle(page);
      steps.push({ name, saw: saw ?? null, calls: await calls(page), view: await run(page, view), question: await run(page, () => window.__question()) });
    }
    seen.push(steps);
    assert.deepEqual(page.problems, [], path);
  }
  const [old, now] = seen;
  for (let i = 0; i < STEPS.length; i++) {
    // 1.3's page showed Restart to update in every state (its .hidden class had no rule): the new page
    // shows it only when an update is ready, as 1.3's code meant (§5.3, new). Compared without it, and
    // held below.
    const drop = (s) => ({ ...s, view: { ...s.view, buttons: s.view.buttons.filter(([id]) => id !== 'deskInstallUpdate') } });
    assert.deepEqual(drop(now[i]), drop(old[i]), `after "${STEPS[i][0]}"`);
  }
  const byName = (steps, name) => steps.find((s) => s.name === name);
  // The calls, as 1.3's page made them.
  assert.deepEqual(byName(old, 'the tray switched on').calls, [['set', 'closeToTray', true]]);
  assert.deepEqual(byName(old, 'another port chosen: a restart asked, Later').calls, [['set', 'port', 41001]]);
  assert.deepEqual(byName(old, 'another port chosen: a restart asked, Later').saw.buttons, ['Later', 'Restart now']);
  assert.deepEqual(byName(old, 'the data folder opened').calls, [['openDataFolder']]);
  assert.deepEqual(byName(old, 'Check for updates: followed until one is ready').saw,
    ['Checking for updates…', 'Downloading version 1.4.1… 40%', 'Downloading version 1.4.1… 0%', 'Version 1.4.1 is ready to install.']);
  assert.deepEqual(byName(old, 'Check for updates: followed until one is ready').calls.map((c) => c[0]), ['checkUpdates', 'updateState', 'updateState', 'updateState', 'updateState']);
  // Restart to update: only while an update is ready, on the new page.
  const install = (s) => s.view.buttons.some(([id]) => id === 'deskInstallUpdate');
  assert.deepEqual(now.map(install), STEPS.map(([name]) => name === 'Check for updates: followed until one is ready'));
  assert.ok(old.every(install), '1.3 showed it in every state');
  // Nothing that restarts or updates the app was asked for.
  for (const steps of seen) for (const s of steps) assert.ok(!s.calls.some((c) => ['restart', 'installUpdate'].includes(c[0])), s.name);
});

test('System shows in the desktop app\'s window alone, its nav item before Storage', async (t) => {
  if (skip(t)) return;
  const navs = [];
  for (const [, path] of PAGES) {
    const page = await open(t, path);
    navs.push(await run(page, () => [...document.querySelectorAll('#settingsNav .nav-item')].map((b) => b.id).filter((id) => id !== 'navExtension' && id !== 'navOptional')));
    const context = await browser.createBrowserContext();
    t.after(() => context.close().catch(() => {}));
    const plain = await openPage(context, origin);
    await plain.goto(`${origin}${path}`, { waitUntil: 'load' });
    await until(plain, () => !!document.getElementById('navStorage') && !!document.getElementById('clearAllBtn'), null, { what: 'Settings' });
    await pause(500);
    assert.deepEqual(await run(plain, () => [!!document.getElementById('navDesktop'), !!document.getElementById('panelDesktop')]), [false, false], `${path}: not in a browser`);
    assert.deepEqual(plain.problems, []);
  }
  assert.deepEqual(navs[1], navs[0]);
  assert.deepEqual(navs[0], ['navLibrary', 'navReader', 'navTranslation', 'navDesktop', 'navStorage']);
});

test('the phone form, an update ready: nothing runs past the cards or the screen; a long path wraps', async (t) => {
  if (skip(t)) return;
  const seen = [];
  // (Ready: Restart to update beside Check, the row's widest.)
  const ready = () => {
    const shell = window.shioriDesktop.shell;
    window.shioriDesktop.shell = async (action, ...args) => {
      const out = await shell(action, ...args);
      return action === 'state' ? { ...out, update: { status: 'ready', version: '1.4.1' } } : out;
    };
  };
  for (const [, path] of PAGES) {
    const page = await open(t, path, { viewport: { width: 390, height: 844, isMobile: true, hasTouch: true }, early: ready });
    await settle(page);
    seen.push(await run(page, () => {
      const out = [];
      for (const card of document.querySelectorAll('#panelDesktop > *')) {
        const box = card.getBoundingClientRect();
        if (!box.width) continue;
        for (const el of card.querySelectorAll('button, code, [id]:not(input)')) {
          const r = el.getBoundingClientRect();
          if (r.width && (r.left < box.left - 0.5 || r.right > box.right + 0.5)) out.push(el.id || el.textContent.slice(0, 20));
        }
      }
      const data = document.getElementById('deskDataPath').getBoundingClientRect();
      return { scroll: document.documentElement.scrollWidth - innerWidth, out, wraps: data.height > 20, share: window.__share() };
    }));
    assert.deepEqual(page.problems, []);
  }
  assert.deepEqual(seen[1], seen[0]);
  assert.deepEqual(seen[0], { scroll: 0, out: [], wraps: true, share: { shown: ['deskInstallUpdate', 'deskCheckUpdates'], gaps: [0, 8, 0] } }, 'the two fill the row');
  // No update ready: Check alone has the row's width, as every row's one button on the phone form.
  // (The new page only: 1.3's showed Restart to update in every state.)
  const page = await open(t, NEW, { viewport: { width: 390, height: 844, isMobile: true, hasTouch: true } });
  await settle(page);
  assert.deepEqual(await run(page, () => window.__share()), { shown: ['deskCheckUpdates'], gaps: [0, 0] });
});

test('leaving the page leaves nothing behind: /settings-next → /tasks → /settings-next, five times, an update followed each time', async (t) => {
  if (skip(t)) return;
  const context = await browser.createBrowserContext();
  t.after(() => context.close().catch(() => {}));
  const page = await openPage(context, origin);
  await page.evaluateOnNewDocument(bridge);
  await page.evaluateOnNewDocument(() => {
    const live = window.__live = { timers: new Set() };
    const { setTimeout: st, clearTimeout: ct } = window;
    window.setTimeout = function (fn, ms, ...a) { const id = st.call(this, (...x) => { live.timers.delete(id); return typeof fn === 'function' ? fn(...x) : undefined; }, ms, ...a); if (ms === 700) live.timers.add(id); return id; };
    window.clearTimeout = function (id) { live.timers.delete(id); return ct.call(this, id); };
  });
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await until(page, () => !!document.getElementById('tkList'), null, { what: 'Tasks' });
  await page.evaluate((to) => { const a = document.createElement('a'); a.href = to; a.id = 'toSettings'; document.body.append(a); }, NEW);
  const held = async () => {
    const cdp = await page.createCDPSession();
    const listeners = async (expr) => {
      const { result } = await cdp.send('Runtime.evaluate', { expression: expr });
      return (await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId })).listeners.map((l) => l.type).sort();
    };
    const out = { window: await listeners('window'), document: await listeners('document'),
      ...await page.evaluate(() => ({ follows: window.__live.timers.size, nodes: document.getElementsByTagName('*').length })) };
    await cdp.detach();
    return out;
  };
  const visit = async (i, first) => {
    if (first) await page.$eval('#toSettings', (a) => a.click()); else await page.evaluate(() => history.forward());
    await until(page, () => !!document.getElementById('deskVersion')?.textContent, null, { what: 'System' });
    await page.click('#navDesktop');
    // An update under way while the page is left: its follow must not outlive the page.
    await run(page, () => { window.__updates.length = 0; window.__updates.push({ status: 'checking' }); });
    await page.click('#deskCheckUpdates');
    await until(page, () => document.getElementById('deskCheckUpdates').disabled, null, { what: 'checking' });
    await page.evaluate(() => history.back());
    await until(page, () => location.pathname === '/tasks' && !document.getElementById('settingsNav') && !!document.getElementById('tkList'), null, { what: `Tasks again (${i})` });
  };
  await visit(0, true);
  await pause(1600);
  const first = await held();
  for (let i = 1; i <= 5; i++) await visit(i, false);
  // Left while the update was being followed: nothing is asked of the bridge from then on.
  const left = await run(page, () => window.__shell.filter((c) => c[0] === 'updateState').length);
  await pause(1600);
  assert.equal(await run(page, () => window.__shell.filter((c) => c[0] === 'updateState').length), left, 'nothing more asked once the page is left');
  assert.deepEqual(await held(), first, 'after five more visits, what is held is what it was after the first');
  assert.equal(first.follows, 0, 'no follow left waiting');
  assert.deepEqual(page.problems, []);
});
