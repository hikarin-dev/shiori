// gallery.ts — a gallery as a view reads it (T4): useGallery(id), through the app's one query cache
// (library-query.ts), which the library's change feed keeps up to date.
import { useQuery } from '@tanstack/react-query';
import * as api from '@lib/api.js';
import { followChanges, galleryKey, makeQueryClient, readGallery } from './library-query';

export const queryClient = makeQueryClient();

// The cache follows the library's change feed for the page's life, whatever the routes shown: one
// listener, started once with the app (app.tsx), as the tooltip is.
export const followLibrary = () => followChanges(queryClient, api.events.watch);

// What the library holds of a gallery (its metadata and counts, as api.galleries.byIds gives them).
export type Gallery = {
  id: string;
  count?: number;
  parentId?: string | number | null;
  sourceId?: string;
  seriesTitle?: unknown;
  [field: string]: unknown;
};

// A gallery not in the library (yet, or any more), or one that could not be read, is null, as 1.3's
// pages took it. An edit the page made that the library does not hold yet is laid over it.
const read = (id: string): Promise<Gallery | null> => readGallery(id, async () => {
  const [g] = await api.galleries.byIds([id]).catch(() => []);
  return (g as Gallery | undefined) ?? null;
});

// How the gallery `id` is read into the cache (for a view that reads several at once: useQueries).
export const galleryQuery = (id: string) => ({ queryKey: galleryKey(id), queryFn: () => read(id) });

// The gallery `id` (none read while `id` is null): { data } is undefined until first read.
export function useGallery(id: string | null) {
  return useQuery({ queryKey: galleryKey(id ?? ''), queryFn: () => read(id!), enabled: id != null });
}
