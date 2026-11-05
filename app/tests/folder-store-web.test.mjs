// folder-store-web.test.mjs — the folder store conformance suite (folder-store.conformance.mjs) on the
// website's adapter (storage/folder-store-web.js), under Node over real temporary folders (plan §6.1,
// §6.4).
import test from 'node:test';
import { conformance, websiteFixture } from './folder-store.conformance.mjs';

// The website's own library: run against the desktop library (npm run test:desktop), there is none.
if (globalThis.__desktopLibrary) test('folder store conformance (website)', { skip: 'run by npm test' }, () => {});
else conformance('website', websiteFixture);
