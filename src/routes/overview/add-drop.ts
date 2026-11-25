// add-drop.ts — files dropped on the add bar as the next chapters (1.3's wireDrop and importChapters,
// app/js/overview.js), loaded at the drop.
//
// The drop is read as the library reads one (import-files.js droppedImports: a folder's files listed in
// full). A file that is none of what imports (an archive, a PDF, a picture) is told (the first of them),
// and left out. The rest goes to the import as 1.3's page sent it (import-tracker.js importDropped): each
// archive or PDF a chapter, loose pictures together one more, and so each dropped folder's pictures;
// several ask first and go as one batch the page's tracker follows (the desktop app's runner takes it
// where there is one, this browser's worker otherwise, or this page); each new chapter joins the series
// as its turn comes (attachTo: the owner; a volume in the volumes' view). The rows come by the frame read
// again as the series changes, never by hand.
import type { DropItems } from '@/lib/drop-items';
import { alertNotice, t } from '@/lib/gallery-actions';

type Folder = { name: string; entries: unknown[] };

export async function dropChapters(drop: DropItems, owner: () => string | null, kind: () => 'chapter' | 'volume') {
  const { droppedImports, groupImports, isImportable } = await import('@lib/import-files.js');
  const read = await (droppedImports as unknown as (dt: DropItems) => Promise<{ files: File[]; folders: Folder[]; leftOut: number }>)(drop);
  const attachTo = owner();
  if (!attachTo) return;
  const list = [...read.files];
  const rejected = list.find((f) => !isImportable(f));
  if (rejected) alertNotice({ title: t('dlg.file_type_title'), body: t('dlg.file_type_body'), detail: rejected.name, tone: 'error' });
  const media = list.filter((f) => isImportable(f));
  const { importDropped } = await import('@lib/import-tracker.js');
  await (importDropped as (groups: unknown[], what: object) => Promise<void>)(groupImports(media, read.folders as never), {
    files: media, folders: read.folders, leftOut: read.leftOut + list.length - media.length,
    attachTo, meta: kind() === 'volume' ? { kind: 'volume' } : {},
  });
}
