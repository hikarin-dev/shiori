// folder-store-web.test.mjs — the folder store conformance suite (folder-store.conformance.mjs) on the
// website's adapter, under Node over real temporary folders (plan §6.1, §6.4): until S3 brings
// storage/folder-store-web.js, today's code behind the contract (folder-store-today.mjs).
import test from 'node:test';
import { conformance } from './folder-store.conformance.mjs';
import { websiteToday } from './folder-store-today.mjs';

// The website's own library: run against the desktop library (npm run test:desktop), there is none.
if (globalThis.__desktopLibrary) test('folder store conformance (website)', { skip: 'run by npm test' }, () => {});
else conformance('website', websiteToday);
