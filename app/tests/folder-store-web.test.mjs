// folder-store-web.test.mjs — the folder store conformance suite (folder-store.conformance.mjs) on the
// website's adapter, under Node over real temporary folders (plan §6.1, §6.4). The adapter is handed
// in once there is one: from S2 today's code through a thin temporary adapter, from S3
// storage/folder-store-web.js.
import { conformance } from './folder-store.conformance.mjs';

conformance('website', null);
