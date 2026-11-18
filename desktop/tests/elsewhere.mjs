// elsewhere.mjs — another app's work on a library folder, for the desktop tests that check what the
// library does when another app changed a gallery there (D4: it catches up on a generation it didn't
// publish or read). Another app publishes as Shiori does: a new generation of the gallery's manifest
// (format v2, app/js/storage/gallery-manifest.js), by another writer.
import fs from 'node:fs';
import path from 'node:path';
import { manifestIn, placeIn, publishIn } from '../server/folder-store.js';
import { manifest as format } from '../server/shared.js';

export const OTHER_WRITER = 'a1b2c3d4e5f60708';

// The gallery whose folder (or linked overlay) is `dir` published anew by another app: its descriptions
// as `change(texts)` makes them (texts: name → text, those the current manifest names), over the
// generation there — its place held as that app holds it, having read that generation.
export async function publishElsewhere(dir, change) {
  const now = await manifestIn(dir);
  if (now.kind !== 'ok') throw new Error(`${dir} has no manifest to publish over (${now.kind})`);
  const { descriptions, ...next } = now.value;
  const texts = {};
  for (const [name, at] of Object.entries(descriptions)) texts[name] = fs.readFileSync(path.join(dir, ...at.split('/')), 'utf8');
  const at = await placeIn(dir, next.galleryId, { known: format.tokenOf(now.value), writer: OTHER_WRITER });
  if (at.kind !== 'ok') throw new Error(`${dir} can't be held (${at.kind})`);
  await publishIn(at.place, { ...next, generation: next.generation + 1, writer: OTHER_WRITER }, change(texts));
}

// A description's JSON text with `patch` merged in.
export const patched = (text, patch) => JSON.stringify({ ...JSON.parse(text), ...patch });
