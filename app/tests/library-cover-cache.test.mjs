import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const library = readFileSync(join(repo, 'app', 'js', 'library.js'), 'utf8');
const services = readFileSync(join(repo, 'app', 'js', 'services.js'), 'utf8');

const helperNames = ['coverCacheKey', 'coverCacheGalleryId', 'coverRequestMatchesEntry'];
const helpers = helperNames.map((name) => {
  const match = library.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
  assert.ok(match, `${name} must remain a standalone policy helper`);
  return match[0];
});
const policy = new Function(`${helpers.join('\n')}\nreturn { ${helperNames.join(', ')} };`)();

test('gallery and series covers occupy distinct cache roles', () => {
  assert.equal(policy.coverCacheKey('123', false), '123:gallery');
  assert.equal(policy.coverCacheKey('123', true), '123:series');
  assert.equal(policy.coverCacheGalleryId('123:series'), '123');
});

test('a late fallback response cannot replace a series cover', () => {
  const series = { id: '123', isSeries: true };
  assert.equal(policy.coverRequestMatchesEntry({ preferSeries: false }, series, true), false);
  assert.equal(policy.coverRequestMatchesEntry({ preferSeries: true }, series, true), true);
  assert.match(services, /preferSeries: !!requester\.preferSeries/,
    'the cover service must echo the requested role with each result');
});
