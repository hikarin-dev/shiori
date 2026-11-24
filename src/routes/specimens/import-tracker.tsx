// ImportTracker's specimens: a batch under way as 1.3's Tasks page captured it (tasks-import-batch:
// "Shelf", 4 of 12 titles, one skipped and one failed, a title under way, run by this tab), at the
// width of Tasks' list; and the same with its titles open. The batch's news is held still (a store
// that never changes), its times counted from when it is drawn, so its pace and "now" read the same.
import { useState } from 'react';
import { contextId } from '@lib/platform.js';
import { ImportTracker } from '@/components/import-tracker';
import type { Batch, BatchStore, Title } from '@/lib/import-batches';
import { Section, Shape, tag } from './specimen';

const TITLES: Title[] = [
  { name: 'Alpha', status: 'done' }, { name: 'Beta', status: 'done' }, { name: 'Gamma', status: 'importing' },
  { name: 'Delta', status: 'skipped' }, { name: 'Epsilon', status: 'failed', error: 'The file could not be read.' },
  { name: 'Zeta', status: 'waiting' },
];

function stillStore(open: boolean): BatchStore {
  const now = Date.now();
  const batch: Batch = {
    id: 'import-1790000009000',
    job: { gid: 'import-1790000009000', kind: 'import', status: 'progress', name: 'Shelf', total: 12, done: 4, imported: 3, skipped: 1, failed: 1,
      bytes: 96 * 1024 * 1024, bytesDone: 31 * 1024 * 1024, startedAt: now - 42000, movedAt: now - 1000, at: now,
      current: { name: 'Gamma', done: 7, total: 20, bytes: 9 * 1024 * 1024 }, runner: { kind: 'tab', page: 'tasks', id: contextId } },
    stopping: false,
    list: { open, filter: 'all', shown: 200, titles: open ? TITLES : null },
  };
  const snapshot = { batches: [batch], tick: 0 };
  const none = () => {};
  return { subscribe: () => none, getSnapshot: () => snapshot, start: none, stop: none, running: () => 1,
    stopBatch: none, stopAll: none, dismiss: none, toggleList: none, filter: none, more: none } as unknown as BatchStore;
}

export function ImportTrackerSpecimens() {
  const [stores] = useState(() => ({ closed: stillStore(false), open: stillStore(true) }));
  return (
    <Section id="import-tracker" title="Import tracker">
      <Shape id="ib" name="Import batch" used="Library, Overview and Tasks: a batch of imports while it runs and after (the kind, where it runs, its name and size, Titles, Stop; the bar, the tally with the pace, the title under way, the issues).">
        <div className="w-[912px] max-w-[calc(100vw-40px)]">
          <ImportTracker store={stores.closed} panelData={tag('ib', 'running', 'rest')} />
        </div>
        <div className="w-[912px] max-w-[calc(100vw-40px)]">
          <ImportTracker store={stores.open} panelData={tag('ib', 'titles', 'rest')} />
        </div>
      </Shape>
    </Section>
  );
}
