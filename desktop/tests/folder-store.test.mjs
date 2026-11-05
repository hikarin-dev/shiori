// folder-store.test.mjs — the folder store conformance suite (app/tests/folder-store.conformance.mjs)
// on the desktop's adapter, over real temporary folders (plan §6.1): until S3 brings
// server/folder-store.js, today's code behind the contract (app/tests/folder-store-today.mjs).
const { conformance } = await import('../../app/tests/folder-store.conformance.mjs');
const { desktopToday } = await import('../../app/tests/folder-store-today.mjs');

conformance('desktop', desktopToday);
