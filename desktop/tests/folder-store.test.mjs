// folder-store.test.mjs — the folder store conformance suite (app/tests/folder-store.conformance.mjs)
// on the desktop's adapter (server/folder-store.js), over real temporary folders (plan §6.1).
const { conformance, desktopFixture } = await import('../../app/tests/folder-store.conformance.mjs');

conformance('desktop', desktopFixture);
