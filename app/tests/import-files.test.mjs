// import-files.test.mjs — what a picked or dropped set of files imports as: each archive and PDF
// is its own gallery, loose images together are one, each dropped folder's images are one more,
// and the zip handed to the import engine carries those images in name order with their bytes
// untouched (AVIF included).
import test from 'node:test';
import assert from 'node:assert/strict';

class SilentBroadcastChannel {
  constructor(name) { this.name = name; this.onmessage = null; }
  postMessage() {}
  close() {}
}
globalThis.BroadcastChannel = SilentBroadcastChannel;

const { groupImports, importBytes, isImportable, droppedImports } = await import('../js/import-files.js');
const { unzip, sortImageEntries, MIME } = await import('../js/import-cbz.js');

const file = (name, bytes = [1, 2, 3]) => new File([new Uint8Array(bytes)], name);

// A fake drop of Files and folders ({ name, children }). A folder hands its entries over two at a
// time, as a browser's batched readEntries does.
function fakeEntry(node) {
  if (node instanceof File) return { name: node.name, isDirectory: false, file: (ok) => ok(node) };
  return {
    name: node.name, isDirectory: true,
    createReader() {
      const rest = node.children.map(fakeEntry);
      return { readEntries: (ok) => setTimeout(() => ok(rest.splice(0, 2))) };
    },
  };
}
const fakeDrop = (...nodes) => ({
  items: nodes.map((n) => ({ kind: 'file', webkitGetAsEntry: () => fakeEntry(n), getAsFile: () => n instanceof File ? n : null })),
});

test('archives and PDFs are one gallery each; loose images are one more, in name order', () => {
  const groups = groupImports([
    file('page 10.jpg'), file('Vol 1.cbz'), file('page 2.avif'), file('notes.txt'),
    file('scan.pdf'), file('page 1.PNG'),
  ]);
  assert.deepEqual(groups.map((g) => g.name), ['scan.pdf', 'Vol 1.cbz', 'page.zip']);
  assert.deepEqual(groups[2].files.map((f) => f.name), ['page 1.PNG', 'page 2.avif', 'page 10.jpg']);
  assert.equal(isImportable(file('notes.txt')), false);
});

test('loose images are named for what their names share, else for the first image', () => {
  assert.equal(groupImports([file('My Title - 002.jpg'), file('My Title - 001.jpg')])[0].name, 'My Title.zip');
  assert.equal(groupImports([file('Ch3 - 01.jpg'), file('Ch3 - 02.jpg')])[0].name, 'Ch3.zip');
  assert.equal(groupImports([file('002.jpg'), file('001.jpg')])[0].name, '001.zip');
  assert.equal(groupImports([file('cover.webp')])[0].name, 'cover.zip');
});

test('loose images reach the import engine as pages in order, bytes untouched', async () => {
  const [group] = groupImports([file('b 10.jpg', [10]), file('b 9.avif', [9]), file('b 1.gif', [1])]);
  const pages = sortImageEntries(await unzip((await importBytes(group)).slice().buffer));
  assert.deepEqual(pages.map((p) => [p.filename, [...p.data]]), [['1.gif', [1]], ['2.avif', [9]], ['3.jpg', [10]]]);
  assert.equal(MIME.avif, 'image/avif');
});

test('a dropped folder is one gallery named after it, subfolders flattened in path order', async () => {
  const { files, folders } = await droppedImports(fakeDrop(
    { name: 'My Series', children: [
      { name: 'Ch 10', children: [file('01.jpg')] },
      file('.hidden.jpg'), file('notes.txt'), file('extra.pdf'),
      { name: 'Ch 2', children: [file('02.png'), file('01.avif'), file('10.gif')] },
    ] },
    { name: 'Vol. 1', children: [file('a.webp')] },
    { name: 'empty', children: [file('readme.txt')] },
    file('loose.cbz'),
  ));
  const groups = groupImports(files, folders);
  assert.deepEqual(groups.map((g) => g.name), ['loose.cbz', 'extra.pdf', 'My Series.zip', 'Vol. 1.zip']);
  assert.deepEqual(groups[2].files.map((f) => f.name), ['01.avif', '02.png', '10.gif', '01.jpg']);
});

test('an archive is handed over as it is', async () => {
  const [group] = groupImports([file('a.zip', [7, 8, 9])]);
  assert.deepEqual([...new Uint8Array(await importBytes(group))], [7, 8, 9]);
});
