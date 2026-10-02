// i18n.test.mjs — the desktop app's menus and dialogs speak the app's language: every string they
// use is one of the app's own (`desk.*`, which locale-parity checks in every language), and the
// language is picked as the app picks it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { translator, pickLanguage, isLanguage } = await import('../i18n.js');
const { LOCALES } = await import('../../app/js/locales.js');

test('every string the desktop app shows is one of the app\'s', () => {
  const source = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  const used = [...new Set([...source.matchAll(/\bt\('(\w+)'/g)].map(m => m[1]))];
  assert.ok(used.length > 12, `found ${used.length}`);
  assert.deepEqual(used.filter(key => LOCALES.en[`desk.${key}`] == null), []);
});

test('a string is in the chosen language, with its placeholders filled', () => {
  assert.equal(translator('ja')('quit'), 'Shiori を終了');
  assert.equal(translator('de')('quit_jobs_more', { n: 3 }), 'und 3 weitere');
  assert.equal(translator('xx')('quit'), 'Quit Shiori', 'an unknown language falls back to English');
});

test('the system\'s languages are matched as the app matches them', () => {
  assert.equal(pickLanguage(['ja-JP', 'en-US']), 'ja');
  assert.equal(pickLanguage(['zh-TW']), 'zh-TW');
  assert.equal(pickLanguage(['zh-Hans-CN']), 'zh-CN');
  assert.equal(pickLanguage(['pt-BR']), 'pt-BR');
  assert.equal(pickLanguage(['nl-NL', 'fr-CA']), 'fr');
  assert.equal(pickLanguage(['nl-NL']), 'en');
  assert.equal(isLanguage('ko'), true);
  assert.equal(isLanguage('xx'), false);
});

test('every desktop string is still used somewhere', () => {
  const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  const main = read('../main.js');
  const settings = read('../../app/js/desktop-settings.js');
  const unused = Object.keys(LOCALES.en).filter(key => (key.startsWith('desk.') && !main.includes(`t('${key.slice(5)}'`))
    || ((key.startsWith('set.desk_') || key === 'set.nav_desktop') && !settings.includes(`'${key}'`) && !settings.includes(`"${key}"`)));
  assert.deepEqual(unused, []);
});
