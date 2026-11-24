// runner-page.test.mjs — where a tab's job says it runs (platform.js `runner`): the page named is the one
// showing when it is asked for, as a job is published and as its tag is drawn. In the one page a tab
// moves between pages without a load, so the page is read from the address then, not once as the tab
// opened; a page that is still a document of its own (library, overview, reader) is named as before.
import test from 'node:test';
import assert from 'node:assert/strict';

// A tab's document, opened at /tasks; its address changes as the one page's routes do.
const sent = [];
globalThis.BroadcastChannel = class {
  constructor(name) { this.name = name; }
  postMessage(message) { if (this.name === 'shiori-jobs') sent.push(structuredClone(message)); }
  close() {}
};
globalThis.window ??= globalThis;
globalThis.addEventListener ??= () => {};
globalThis.document = { documentElement: { lang: 'en' }, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };
globalThis.location = { pathname: '/tasks' };
const _ls = new Map([['shiori-lang', 'en']]);
globalThis.localStorage = { getItem: (k) => (_ls.has(k) ? _ls.get(k) : null), setItem: (k, v) => _ls.set(k, String(v)), removeItem: (k) => _ls.delete(k) };
const go = (pathname) => { globalThis.location = { pathname }; };

const platform = await import('../js/platform.js');
const { runnerTag } = await import('../js/runner-tag.js');

test('a tab opened on Tasks and moved to Settings names Settings: as asked, as published, as another tab draws it', async () => {
  assert.equal(platform.runner.kind, 'tab');
  assert.equal(platform.runner.page, 'tasks');
  go('/settings');
  assert.equal(platform.runner.page, 'settings');
  sent.length = 0;
  await platform.jobs.publish({ gid: 'g1', kind: 'folder', status: 'started' });
  platform.jobs.signal({ gid: 'g1', kind: 'folder', status: 'progress' });
  assert.deepEqual(sent.map((j) => j.runner), [{ kind: 'tab', page: 'settings', id: platform.contextId }, { kind: 'tab', page: 'settings', id: platform.contextId }]);
  assert.equal(JSON.stringify(sent[0].runner), JSON.stringify({ kind: 'tab', page: 'settings', id: platform.contextId }), 'the same text a relay sends');
  // Drawn in another tab (another context's id): the page it was published from.
  assert.equal(runnerTag({ ...sent[0].runner, id: 'another-context' }).text, 'Tab · Settings');
  // Back on Tasks: what is published from now on says so; what was sent stays as it was.
  go('/tasks');
  await platform.jobs.publish({ gid: 'g1', kind: 'folder', status: 'progress', done: 1, total: 2 });
  assert.deepEqual(sent.map((j) => j.runner.page), ['settings', 'settings', 'tasks']);
  assert.equal(runnerTag({ ...sent[2].runner, id: 'another-context' }).text, 'Tab · Tasks');
});

test('a page that is still a document of its own is named as before, by its address', () => {
  for (const [pathname, page] of [['/', 'library'], ['/library', 'library'], ['/app/library.html', 'library'], ['/overview', 'overview'],
    ['/app/overview.html', 'overview'], ['/reader', 'reader'], ['/app/reader.html', 'reader'], ['/shiori/reader', 'reader']]) {
    go(pathname);
    assert.equal(platform.runner.page, page, pathname);
    assert.deepEqual(Object.keys(structuredClone(platform.runner)), ['kind', 'page', 'id'], 'the same record, its keys in the same order');
  }
});
