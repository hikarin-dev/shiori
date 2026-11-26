// languages.test.mjs — a page shows one language, picked once (app/js/languages.js pickLanguage), and
// holds only English and that language's words (app/js/locales/<code>.js). The one page's first
// script (src/start.js) picks the same way, with a copy of the rule a classic script can run, and asks
// for those words first, with the rest of what the page runs; i18n.js waits for them, so t() answers in
// that language from the first time it is asked. Another language's words come when it is chosen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED, LANG_NAMES, pickLanguage } from '../js/languages.js';
import { LOCALES } from '../js/locales.js';
import { WORDS, startData, startScript } from '../../build/start.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// What the page is told in each case: the choice stored ('shiori-lang', null when none), the browser's languages.
const CASES = [
  [null, ['en-US', 'en']], [null, ['ja']], [null, ['ja-JP', 'en']], [null, ['de-CH']], [null, ['zh-TW']], [null, ['zh-HK']],
  [null, ['zh-Hant-TW']], [null, ['ZH']], [null, ['pt-BR']], [null, ['pt-PT']], [null, ['es-419', 'fr']], [null, ['nl', 'fr-CA']],
  [null, ['nl', 'sv']], [null, []], [null, ['ko-KR']], [null, ['id-ID']], [null, ['vi']], [null, ['ru-RU']],
  ['fr', ['ja']], ['zh-CN', ['en']], ['xx', ['ja']], ['', ['ko']], ['EN', ['ja']], ['en', ['de']],
];

test('every language the app names has its words, every key English has', () => {
  assert.deepEqual(Object.keys(LOCALES).sort(), [...SUPPORTED].sort());
  assert.deepEqual(Object.keys(LANG_NAMES).sort(), [...SUPPORTED].sort());
  for (const lang of SUPPORTED) {
    assert.ok(existsSync(join(repo, WORDS.replace('*', lang))), `${lang}'s words are where the page asks for them`);
    assert.deepEqual(Object.keys(LOCALES[lang]).sort(), Object.keys(LOCALES.en).sort(), lang);
  }
});

test('the one page\'s first script picks the language i18n.js shows, and asks for its words first', async () => {
  const vm = await import('node:vm');
  const { ROUTES } = await import('../../src/routes.ts');
  const data = startData({ routes: ROUTES });
  data.entry = 'assets/entry.js';
  data.start = ['assets/start.js', 'app/js/locales/en.js'];
  for (const route of Object.values(data.routes)) route.preload = ['assets/route.js'];
  const script = startScript(data);
  for (const [stored, languages] of CASES) {
    const added = [];
    const document = {
      documentElement: { dataset: {} }, fonts: [],
      head: { append: (el) => added.push(el) },
      createElement: (tag) => ({ tag, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } }),
    };
    vm.runInNewContext(script, { document, location: new URL('http://site.example/tasks'), URL, Object, String,
      sessionStorage: { getItem: () => null }, localStorage: { getItem: () => stored }, navigator: { languages, language: languages[0] },
      requestAnimationFrame: () => {}, setTimeout });
    const lang = pickLanguage(stored, languages);
    const asked = added.filter((el) => el.tag === 'link').map((el) => el.attributes.href);
    const words = asked.filter((href) => href.includes('/locales/'));
    assert.deepEqual(words, lang === 'en' ? ['/app/js/locales/en.js'] : [`/${WORDS.replace('*', lang)}`, '/app/js/locales/en.js'],
      `${JSON.stringify([stored, languages])}: ${lang}'s words, and English (in the start's list)`);
    if (lang !== 'en') assert.equal(asked[0], `/${WORDS.replace('*', lang)}`, 'the language\'s words asked for first');
  }
});

// i18n.js, in a page whose person chose Japanese.
const store = new Map([['shiori-lang', 'ja']]);
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window ??= globalThis;
globalThis.addEventListener ??= () => {};
const changes = [];
globalThis.dispatchEvent = (e) => { changes.push(e.detail); return true; };
globalThis.CustomEvent ??= class extends Event { constructor(type, init) { super(type); this.detail = init?.detail; } };
globalThis.document ??= { documentElement: { lang: 'en' }, querySelectorAll: () => [] };
const i18n = await import('../js/i18n.js');

test('t() answers in the person\'s language from its first word, English where a key has none', () => {
  assert.equal(i18n.getLang(), 'ja');
  assert.equal(i18n.t('common.cancel'), LOCALES.ja['common.cancel']);
  assert.notEqual(i18n.t('common.cancel'), LOCALES.en['common.cancel']);
  assert.equal(i18n.t('no.such.key'), 'no.such.key');
  assert.equal(i18n.t('dlg.detail_pages', { id: 7, n: 3 }), LOCALES.ja['dlg.detail_pages'].replace('{id}', '7').replace('{n}', '3'));
});

test('another language is the page\'s once its words have come; the last one asked for wins', async () => {
  changes.length = 0;
  const first = i18n.setLang('de');
  assert.equal(i18n.getLang(), 'ja', 'not before its words have come');
  await first;
  assert.equal(i18n.getLang(), 'de');
  assert.equal(i18n.t('common.cancel'), LOCALES.de['common.cancel']);
  assert.equal(store.get('shiori-lang'), 'de');
  assert.deepEqual(changes, ['de']);
  // Two asked for one after the other: the second is the one shown, whichever's words come first.
  changes.length = 0;
  await Promise.all([i18n.setLang('ko'), i18n.setLang('fr')]);
  assert.equal(i18n.getLang(), 'fr');
  assert.deepEqual(changes, ['fr']);
  // A code the app does not have is English.
  await i18n.setLang('xx');
  assert.equal(i18n.getLang(), 'en');
  assert.equal(store.get('shiori-lang'), 'en');
});
