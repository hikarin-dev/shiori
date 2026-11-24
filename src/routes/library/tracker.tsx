// The library's import tracker (1.3's #importTracker): a panel per batch of imports, and a drop being
// read, under the toolbar and as wide as the grid's cards. Loaded and drawn from the first time the page
// has something for it (a batch's word, one under way as the page shows, a drop being read); from then
// on its store follows the batches while the page shows, and hides it with nothing to show.
//
// 1.3's margins (library.css #importTracker): 1512px wide at most, 24px in at the sides, 16 under it
// (12 in and 10 under at 600px or less).
import { useEffect, useState } from 'react';
import { ImportTracker } from '@/components/import-tracker';
import { createBatchStore, type BatchStore } from '@/lib/import-batches';

export function LibraryTracker({ onStore }: { onStore: (store: BatchStore | null) => void }) {
  const [store] = useState(createBatchStore);
  useEffect(() => {
    store.start();
    onStore(store);
    return () => { onStore(null); store.stop(); };
  }, [store, onStore]);
  return (
    <ImportTracker store={store} id="importTracker"
      className="mx-auto mb-[16px] max-w-[1512px] px-[24px] [@media(max-width:600px)]:mb-[10px] [@media(max-width:600px)]:px-[12px]" />
  );
}
