// What the overview reads, through the app's one query cache (T4, src/lib/library-query.ts):
//
//   - the page's frame (['overview', g]): which gallery the address names (?g=; a chapter's id shows its
//     series, as 1.3's render() resolved it), whether it is a series, its members in order (id, own
//     title, number, kind), and what the owner's record says of the series (its title, when it was
//     posted). A series' members are read as 1.3 read them (api.series.chapters: a member whose library
//     folder is hidden or removed is not listed), and each member's gallery goes into its own entry
//     (lib/gallery.ts's key), where the library's change feed keeps it up to date: a row and the hero
//     are drawn from those entries, so one chapter changing draws its row. An entry already newer than
//     the read is left as it is.
//   - the tags' counts (['tag-counts', keys]): how many library entries carry each of the owner's
//     tags, read when the owner's tags change (1.3's refreshTags), never because time passed.
//
// The frame is read again when the library says the owner, the gallery the address names or anything
// at all ('*') changed: at once, and once more at the end of a 500 ms window of such words (the change
// feed's own pace). A member's own change is its entry's, read by the feed.
//
// The owner stays the one the page found (1.3 kept ownerId across renders): the frame is resolved from
// it, so a gallery the address named that leaves the series later leaves the page on the series.
//
// An edit the page makes to what the frame holds (the series' title, a chapter's title, the order) is
// drawn before the library answers (editFrame, as editGallery is for a gallery): on the frame at once,
// held over every read begun before the library has it, and dropped if the library refuses it. So a
// title saved while a change of the same gallery is being read is never drawn back to the old one
// (what 1.3 held its whole page back for, _suppressRenderUntil).
import type { QueryClient } from '@tanstack/react-query';
import * as api from '@lib/api.js';
import { SETTLE_MS, galleryKey, readMark, withEdits } from '@/lib/library-query';

export type Ref = { id: string; title: string; number?: unknown; kind?: 'volume' };
export type Entity = {
  id: string;
  count?: number; numPages?: number; size?: number; origSize?: number;
  tags?: { type: string; name: string }[];
  translated?: boolean; missing?: boolean; archived?: boolean; favorite?: boolean; linked?: boolean;
  sourceId?: string; sourceUrl?: string; source?: string;
  uploadDate?: unknown; addedAt?: number; medianPage?: unknown; aggMedianPage?: unknown;
  [field: string]: unknown;
};
export type Frame =
  | { found: false }
  | { found: true; ownerId: string; isSeries: boolean; refs: Ref[]; seriesTitle: unknown; uploadDate: unknown };

export const overviewKey = (g: string) => ['overview', g] as const;

type Member = { id: string; title?: string; number?: unknown; kind?: string; entity: Entity | null };

// Each gallery read goes into its own entry, unless that entry is newer than this read.
function seed(client: QueryClient, gid: string, g: Entity | null, started: number, mark: number) {
  const key = galleryKey(gid);
  if ((client.getQueryState(key)?.dataUpdatedAt ?? 0) > started) return;
  client.setQueryData(key, withEdits(gid, g, mark), { updatedAt: started });
}

// The frame, resolved from `from` (the address's gallery the first time, the owner found after).
// `key`: the address's gallery (the frame's query), whose edits are laid over the read.
export async function readFrame(client: QueryClient, from: string, key = from): Promise<Frame> {
  const started = Date.now(), mark = readMark();
  const series = await api.series.resolve(from) as { ownerId: string } | null;
  const ownerId = series ? String(series.ownerId) : from;
  const owner = await api.galleries.get(ownerId) as Entity | null;
  if (!owner && !series) return { found: false };
  const members: Member[] = series ? await api.series.chapters(ownerId) as Member[] : [{ id: ownerId, title: '', entity: owner }];
  const meta = await api.meta.get(ownerId) as { seriesTitle?: unknown; uploadDate?: unknown } | null;
  seed(client, ownerId, owner, started, mark);
  for (const m of members) if (m.id !== ownerId) seed(client, String(m.id), m.entity, started, mark);
  return withFrameEdits(key, {
    found: true, ownerId, isSeries: !!series,
    refs: members.map((m) => ({ id: String(m.id), title: m.title || '', ...(m.number != null ? { number: m.number } : {}), ...(m.kind === 'volume' ? { kind: 'volume' as const } : {}) })),
    seriesTitle: meta?.seriesTitle, uploadDate: meta?.uploadDate,
  }, mark);
}

// ── The page's own edits of the frame ──
type Found = Extract<Frame, { found: true }>;
type FrameEdit = { apply: (frame: Found) => Found; from: number };
const frameEdits = new Map<string, FrameEdit[]>();   // by the address's gallery

// The frame as a read begun at `mark` gives it, with the edits the library did not hold then laid
// over it, in the order they were made. A read begun after the library has an edit ends it.
function withFrameEdits(key: string, frame: Found, mark: number): Found {
  const list = frameEdits.get(key);
  if (!list) return frame;
  const kept = list.filter((edit) => !(edit.from && mark >= edit.from));
  if (kept.length) frameEdits.set(key, kept); else frameEdits.delete(key);
  return kept.reduce((f, edit) => edit.apply(f), frame);
}

// Edits the frame of the address's gallery `key`: `apply` is on the frame at once (in the frame of the
// press), `write` asks the library for it. A write that throws or answers false is refused: the edit is
// dropped and the frame read again as the library has it. Answers whether it was done.
export async function editFrame(client: QueryClient, key: string, apply: (frame: Found) => Found, write: () => Promise<unknown>) {
  const edit: FrameEdit = { apply, from: 0 };
  frameEdits.set(key, [...(frameEdits.get(key) ?? []), edit]);
  client.setQueryData<Frame>(overviewKey(key), (frame) => (frame?.found ? apply(frame) : frame));
  let done = false;
  try { done = (await write()) !== false; } finally {
    const list = frameEdits.get(key) ?? [];
    if (done) edit.from = readMark() + 1;
    else if (list.includes(edit)) { const rest = list.filter((e) => e !== edit); if (rest.length) frameEdits.set(key, rest); else frameEdits.delete(key); }
    client.invalidateQueries({ queryKey: overviewKey(key) }).catch(() => {});
  }
  return done;
}

// The tags' counts: { key → n }.
export const tagCountsKey = (keys: string[]) => ['tag-counts', keys] as const;
export async function readTagCounts(keys: string[]): Promise<Map<string, number>> {
  return keys.length ? await api.galleries.tagCounts({ keys }) as Map<string, number> : new Map();
}

type Watch = (cb: (gid: string) => void) => () => void;

// Follows the change feed for the frame: a word about one of `ids()` (or '*') reads it again at once,
// and words in the `settle` ms after a read end in one more read at its close. Returns what stops it.
export function followFrame(watch: Watch, ids: () => readonly string[], read: () => void, settle = SETTLE_MS) {
  let timer: ReturnType<typeof setTimeout> | null = null, again = false;
  const close = () => { timer = null; if (again) go(); };
  const go = () => { again = false; read(); timer = setTimeout(close, settle); };
  const off = watch((gid) => {
    if (gid !== '*' && !ids().includes(String(gid))) return;
    if (timer) again = true; else go();
  });
  return () => { off(); if (timer) clearTimeout(timer); };
}
