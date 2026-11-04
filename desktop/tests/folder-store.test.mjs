// folder-store.test.mjs — the folder store conformance suite (app/tests/folder-store.conformance.mjs)
// on the desktop's adapter, over real temporary folders (plan §6.1). The adapter is handed in once
// there is one: from S2 today's code through a thin temporary adapter, from S3
// server/folder-store.js.
const { conformance } = await import('../../app/tests/folder-store.conformance.mjs');

conformance('desktop', null);
