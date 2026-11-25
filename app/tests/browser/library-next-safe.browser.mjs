// library-next-safe.browser.mjs — Safe Mode on /library-next, held to what 1.3's page (/library) gave
// driven alike. On: the covers not rated safe or suggestive blurred, every card's words stood in for as 1.3's
// (the title word by word, each tag, the id's digits: each word against its real one and against 1.3's
// pool), the flags and "+" left, the id no link; a card landing while it is on (the next page, a new
// gallery) the same; off, every real word back. The button's two faces and tips. The choice kept across
// a reload and a change of route. A question about a card shows no cover while Safe Mode blurs that
// card's. Turning it on and off draws no cover again and moves no card.
//
// Two differences, deliberate (§5.3 F56): 1.3 kept the id's link in the markup while it was on
// (data-safe-href), so the real address was there to read; the new page keeps nothing of it. And off,
// 1.3 put back each tag's bare name, so a female or male tag lost its mark until its card's tags were
// drawn again; the new page puts back every tag as it was. (Its record holds both as 1.3 gave them.)
//
// What 1.3's page gave is the record (records/<this file>.<table>.json, records.mjs), 1.3's behaviour as
// measured on 2026-11-25, which a deliberate change of the library's behaviour edits in the same commit.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';
import { readDialog, answer, sleep } from './library-drive.mjs';
import { record } from './records.mjs';

const NEW = '/library-next';
const FILE = basename(fileURLToPath(import.meta.url));
let server, origin, browser;
const BASE = 1790006000000;
const N = 34;   // a second page of four

// 1.3's pool (app/js/library.js GIBBERISH_POOL).
const POOL = ['xelorp', 'blathnar', 'quixum', 'frobzle', 'wumble', 'cranlop', 'dribnak', 'snorvel', 'durple', 'grixon', 'zibble', 'wonkle', 'frumple', 'drabix',
  'squibble', 'grompf', 'twarble', 'blintz', 'clongle', 'frixum', 'snargle', 'wobzle', 'plinkle', 'glorble', 'snortle', 'grumple', 'blixon', 'trixon',
  'yarvok', 'splumf', 'crelbix', 'quznak', 'throble', 'wibzor', 'drangle', 'snorbel', 'glumfix', 'twonkle', 'brixum', 'florkel', 'plorbix', 'snurgal',
  'wramble', 'draxon', 'kribzle', 'glorpan', 'snuffwix', 'blavrok', 'quorple'];

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.evaluate(async ({ base, n }) => {
    const api = await import('/app/js/api.js');
    const png = async (hue) => { const c = new OffscreenCanvas(300, 430); const x = c.getContext('2d'); x.fillStyle = `hsl(${hue} 60% 50%)`; x.fillRect(0, 0, 300, 430); return c.convertToBlob({ type: 'image/png' }); };
    for (let i = 0; i < n; i++) {
      const gid = String(base + i);
      const tags = [{ type: 'category', name: i % 2 ? 'manga' : 'doujinshi' }, { type: 'artist', name: `artist ${i}` }, { type: 'tag', name: `a rather long tag ${i}` },
        { type: 'tag:female', name: 'glasses' }, { type: 'tag:male', name: 'x' }, { type: 'language', name: 'japanese' }];
      // Every fifth rated safe, every fifth after it suggestive (Safe Mode leaves their covers), the rest
      // rated otherwise or not at all.
      tags.push({ type: 'rating', name: ['safe', 'suggestive', 'pornographic', 'questionable'][i % 5] ?? 'unrated' });
      if (i % 5 === 4) tags.pop();
      await api.meta.put({ galleryId: gid, title: { english: `Gallery number ${i} has a title of several words`, japanese: '', pretty: '' }, tags, numPages: 1,
        ...(i % 2 ? { source: 'a.example', sourceId: `90${i}x7`, sourceUrl: `https://a.example/g/90${i}x7` } : {}) });
      await api.pages.put(gid, 1, await png(i * 9));
    }
    await (await import('/app/js/migrations.js')).runMigrations();
  }, { base: BASE, n: N });
  await page.close();
});
after(async () => { await browser?.close(); server?.close(); });

async function open(path, safe) {
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.evaluate((safe) => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('shiori:lib')) localStorage.removeItem(k);
    localStorage.setItem('shiori:libQuickActionsMode', '"always"');
    if (safe == null) localStorage.removeItem('shiori-safe-mode'); else localStorage.setItem('shiori-safe-mode', safe);
  }, safe);
  await page.goto(`${origin}${path}`, { waitUntil: 'load' });
  await shown(page, 30);
  return page;
}
const shown = (page, n) => until(page, (n) => document.querySelectorAll('#grid > .card').length === n
  && [...document.querySelectorAll('#grid > .card img.card-thumb')].every((img) => img.getAttribute('src') && img.complete), n, { what: `${n} cards with covers` });

// In the page: what Safe Mode is, as the page shows it.
function state() {
  const btn = document.getElementById('safeBtn');
  return {
    on: document.body.classList.contains('safe-mode') || /(^| )safe( |$)/.test(document.getElementById('grid').dataset.cardModes || ''),
    button: { tip: btn.dataset.tip, on: btn.classList.contains('active') || btn.getAttribute('aria-pressed') === 'true', icon: [...btn.querySelectorAll('svg *')].map((el) => el.getAttribute('d') ?? `${el.localName}`).join('|') },
    stored: localStorage.getItem('shiori-safe-mode'),
  };
}
// In the page: every card's words, real and shown, and what is blurred.
function cards() {
  return [...document.querySelectorAll('#grid > .card')].map((c) => {
    const id = c.querySelector('.card-id'), title = c.querySelector('.card-title');
    const thumb = c.querySelector('img.card-thumb');
    return {
      gid: c.dataset.galleryId,
      title: title && [title.textContent, title.dataset.original],
      tags: [...c.querySelectorAll('.card-tag[data-original]')].map((t) => [t.textContent, t.dataset.original, t.dataset.type]),
      flags: [...c.querySelectorAll('.card-tag-flag')].map((f) => f.dataset.tip),
      add: c.querySelector('.card-tag-add')?.textContent,
      id: [id.textContent, id.dataset.original, id.getAttribute('href')],
      sfw: c.classList.contains('card-sfw'),
      blur: getComputedStyle(thumb).filter + ' ' + getComputedStyle(thumb).transform,
      // Anything of a source's address in the card's markup, the open button's tip aside (1.3 leaves it).
      address: [...c.querySelectorAll('*')].flatMap((el) => [...el.attributes].filter((a) => a.name !== 'data-tip' && a.name !== 'aria-label' && /a\.example\/g\//.test(a.value)).map((a) => `${el.className}@${a.name}`)),
      openTip: c.querySelector('.card-btn-open').dataset.tip,
    };
  });
}

// A stand-in for a real word: one of 1.3's pool, within two letters of its length where the pool has one.
const near = (real, word) => POOL.includes(word) && (!POOL.some((w) => Math.abs(w.length - real.length) <= 2) || Math.abs(word.length - real.length) <= 2);
// What the rules say of a card's words while Safe Mode is on (true where each holds), and the words as
// they really are, so the two pages compare.
function onRules(card) {
  const [title, real] = card.title ?? ['', ''];
  const words = title.split(' '), reals = real.split(/\s+/);
  const [idShown, idReal, href] = card.id;
  return {
    gid: card.gid, real, tagsReal: card.tags.map(([, r, type]) => `${type}:${r}`), flags: card.flags, add: card.add, idReal, sfw: card.sfw, blur: card.blur, openTip: card.openTip,
    titleStood: words.length === reals.length && words.every((w, i) => near(reals[i], w)),
    tagsStood: card.tags.every(([shown, r]) => near(r, shown)),
    idStood: idShown.length === idReal.length && [...idShown].every((ch, i) => (/\d/.test(idReal[i]) ? /\d/.test(ch) : ch === idReal[i])),
    noLink: href === null,
  };
}
// And off: every real word back.
function offRules(card) {
  const mark = { 'tag:female': ' ♀', 'tag:male': ' ♂' };
  return {
    gid: card.gid, sfw: card.sfw, blur: card.blur,
    titleReal: card.title[0] === card.title[1],
    tagsReal: card.tags.every(([shown, r, type]) => shown === `${r}${mark[type] ?? ''}`),
    // (1.3 put back each tag's bare name: a female or male tag lost its mark until its card's tags were
    // drawn again.)
    tagsBare: card.tags.every(([shown, r]) => shown === r),
    idReal: card.id[0] === card.id[1],
    link: card.id[2],
  };
}

test('on: every card\'s words stood in for as 1.3\'s, the covers blurred, the id no link; a card landing the same; off: every word back', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  let now;
  {
    const page = await open(NEW, null);
    const r = {};
    r.offAtFirst = { state: await page.evaluate(state), cards: (await page.evaluate(cards)).map(offRules) };
    await page.click('#safeBtn');
    await until(page, () => document.querySelector('#grid > .card .card-title')?.textContent !== document.querySelector('#grid > .card .card-title')?.dataset.original, null, { what: 'scrambled' });
    await sleep(300);
    const on = await page.evaluate(cards);
    r.on = { state: await page.evaluate(state), cards: on.map(onRules) };
    // (A digit may come out as itself: some of the thirty ids differ.)
    r.idsChanged = on.some((c) => c.id[0] !== c.id[1]);
    r.address = on.flatMap((c) => c.address);
    // The next page lands while it is on.
    await page.evaluate(() => [...document.querySelectorAll('#pagination button')].find((b) => b.textContent === '2').click());
    await until(page, (base) => document.querySelector('#grid > .card')?.dataset.galleryId === String(base + 3), BASE, { what: 'page 2' });
    await shown(page, 4);
    await sleep(300);
    r.page2 = (await page.evaluate(cards)).map(onRules);
    // A gallery made while it is on, back on page 1: its card lands scrambled.
    await page.evaluate(() => [...document.querySelectorAll('#pagination button')].find((b) => b.textContent === '1').click());
    await shown(page, 30);
    const added = String(BASE + 90);
    await page.evaluate(async (gid) => {
      const api = await import('/app/js/api.js');
      await api.meta.put({ galleryId: gid, title: { english: 'A gallery made just now', japanese: '', pretty: '' }, tags: [{ type: 'tag', name: 'fresh' }], numPages: 1, source: 'a.example', sourceId: '777', sourceUrl: 'https://a.example/g/777' });
      const c = new OffscreenCanvas(300, 430); c.getContext('2d').fillRect(0, 0, 300, 430);
      await api.pages.put(gid, 1, await c.convertToBlob({ type: 'image/png' }));
    }, added);
    await until(page, (gid) => document.querySelector('#grid > .card')?.dataset.galleryId === gid && !!document.querySelector('#grid > .card img.card-thumb')?.getAttribute('src'), added, { what: 'the new gallery\'s card' });
    await sleep(400);
    const landed = (await page.evaluate(cards))[0];
    r.landed = { ...onRules(landed), gid: 'new', address: landed.address };
    await page.evaluate(async (gid) => (await import('/app/js/store.js')).remove(gid), added);
    await until(page, (gid) => document.querySelector('#grid > .card')?.dataset.galleryId !== gid, added, { what: 'the new gallery gone' });
    await shown(page, 30);
    // Off: every word back.
    await page.click('#safeBtn');
    await until(page, () => [...document.querySelectorAll('#grid > .card .card-title')].every((t) => t.textContent === t.dataset.original), null, { what: 'restored' });
    r.off = { state: await page.evaluate(state), cards: (await page.evaluate(cards)).map(offRules) };
    now = r;
    assert.deepEqual(page.problems, []);
    await page.close();
  }
  const was = record(FILE, 'words');
  for (const r of [was, now]) {
    assert.ok(r.on.cards.every((c) => c.titleStood && c.tagsStood && c.idStood), 'every word stood in for');
    assert.ok(r.page2.every((c) => c.titleStood && c.tagsStood && c.idStood), 'the next page\'s too');
    assert.ok(r.landed.titleStood && r.landed.tagsStood && r.landed.idStood && r.landed.noLink, 'a card landing while on');
    assert.ok(r.off.cards.every((c) => c.titleReal && c.idReal), 'every word back');
    assert.ok(r.offAtFirst.cards.every((c) => c.tagsReal), 'the tags as they are');
    assert.ok(r.on.cards.some((c) => c.sfw) && r.on.cards.some((c) => !c.sfw), 'blurred and not');
    assert.ok(r.idsChanged, 'the ids\' digits stood in for');
  }
  // The id's link: gone while it is on, with nothing of it left in the markup (§5.3 F56: 1.3 parked it in
  // data-safe-href).
  assert.ok(now.on.cards.every((c) => c.noLink));
  assert.deepEqual(now.address, []);
  assert.deepEqual({ ...now.landed, address: [] }, { ...now.landed });
  // Off: every tag back as it was, its mark with it (§5.3 F56: 1.3's female and male tags lost theirs).
  assert.ok(now.off.cards.every((c) => c.tagsReal), 'every tag as it was');
  for (const r of [now, was]) for (const c of r.off.cards) { delete c.tagsReal; delete c.tagsBare; }
  delete now.address; delete was.address; delete now.landed.address; delete was.landed.address;
  assert.deepEqual(now, was);
});

test('the choice: kept across a reload and a change of route; the button\'s faces and tips', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  {
    const page = await open(NEW, '1');
    const r = { load: await page.evaluate(state) };
    await page.reload({ waitUntil: 'load' });
    await shown(page, 30);
    r.reload = await page.evaluate(state);
    r.reloadScrambled = (await page.evaluate(cards)).every((c) => onRules(c).titleStood);
    // Away to Tasks (a load), and back.
    await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
    await page.goBack({ waitUntil: 'load' });
    await shown(page, 30);
    r.back = await page.evaluate(state);
    await page.click('#safeBtn');
    await sleep(300);
    r.off = await page.evaluate(state);
    await page.reload({ waitUntil: 'load' });
    await shown(page, 30);
    r.offReload = await page.evaluate(state);
    const now = r;
    assert.deepEqual(page.problems, []);
    await page.close();
    const was = record(FILE, 'choice');
    assert.equal(was.load.on, true);
    assert.equal(was.off.stored, '0');
    assert.deepEqual(now, was);
  }
});

test('the change of route inside the app (the new page): to Tasks and back by history, still on', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await open(NEW, '1');
  const loads = await page.evaluate(() => performance.getEntriesByType('navigation').length);
  await page.evaluate(() => { window.__same = true; const a = document.createElement('a'); a.href = '/tasks'; document.body.append(a); a.click(); a.remove(); });
  await page.waitForSelector('#tkList');
  await page.evaluate(() => history.back());
  await shown(page, 30);
  assert.equal(await page.evaluate(() => window.__same), true, 'no page load');
  assert.equal(await page.evaluate(() => performance.getEntriesByType('navigation').length), loads);
  const s = await page.evaluate(state);
  assert.equal(s.on, true);
  assert.ok((await page.evaluate(cards)).every((c) => onRules(c).titleStood));
  await page.close();
});

test('a question about a card shows no cover while Safe Mode blurs that card\'s', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  {
    const page = await open(NEW, null);
    const ask = async (i) => {
      const card = `#grid > .card[data-gallery-id="${BASE + i}"]`;
      await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: 'center' }), card);
      await page.hover(card);
      await sleep(100);
      await page.click(`${card} .card-btn-del`);
      const d = await readDialog(page);
      await answer(page, 'cancel');
      return d?.cover;
    };
    // Rated by i % 5: 30 safe, 31 suggestive, 32 otherwise (blurred).
    const r = { offBlurred: await ask(32), offSafe: await ask(30) };
    await page.mouse.move(5, 5);
    await page.click('#safeBtn');
    await sleep(300);
    r.onBlurred = await ask(32);
    r.onSafe = await ask(30);
    r.onSuggestive = await ask(31);
    const now = r;
    assert.deepEqual(page.problems, []);
    await page.close();
    const was = record(FILE, 'question');
    assert.deepEqual(was, { offBlurred: 'picture', offSafe: 'picture', onBlurred: 'none yet', onSafe: 'picture', onSuggestive: 'picture' });
    assert.deepEqual(now, was);
  }
});

test('turning it on and off draws no cover again and moves no card', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  {
    const page = await open(NEW, null);
    await page.mouse.move(5, 5);
    await page.evaluate(() => {
      const grid = document.getElementById('grid');
      window.__imgs = [...grid.querySelectorAll('img.card-thumb')];
      window.__cards = [...grid.querySelectorAll(':scope > .card')];
      window.__boxes = () => [...grid.querySelectorAll(':scope > .card')].map((c) => { const r = c.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map((v) => +v.toFixed(2)).join(); });
      window.__at = window.__boxes();
      window.__seen = { src: 0, imgs: 0, cards: 0 };
      new MutationObserver((list) => {
        for (const m of list) {
          if (m.type === 'attributes' && m.target.matches?.('img.card-thumb')) window.__seen.src++;
          for (const n of [...m.addedNodes, ...m.removedNodes]) {
            if (n.nodeType !== 1) continue;
            if (n.matches('img.card-thumb') || n.querySelector('img.card-thumb')) window.__seen.imgs++;
            if (n.matches('.card')) window.__seen.cards++;
          }
        }
      }).observe(grid, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
    });
    const r = [];
    for (let i = 0; i < 4; i++) {
      await page.click('#safeBtn');
      await sleep(400);
      r.push(await page.evaluate(() => ({
        on: document.getElementById('safeBtn').dataset.tip,
        sameImgs: [...document.querySelectorAll('#grid img.card-thumb')].every((img, i) => img === window.__imgs[i]),
        sameCards: [...document.querySelectorAll('#grid > .card')].every((c, i) => c === window.__cards[i]),
        moved: window.__boxes().filter((b, i) => b !== window.__at[i]).length,
        seen: { ...window.__seen },
      })));
    }
    const now = r;
    assert.deepEqual(page.problems, []);
    await page.close();
    const was = record(FILE, 'toggle');
    for (const r of now) assert.deepEqual({ ...r, on: undefined }, { on: undefined, sameImgs: true, sameCards: true, moved: 0, seen: { src: 0, imgs: 0, cards: 0 } });
    assert.deepEqual(now, was);
  }
});
