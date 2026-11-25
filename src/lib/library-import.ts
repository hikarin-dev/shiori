// library-import.ts — what the library page does with files picked with Import or dropped on it (1.3's
// _handleImportFiles and its drop handler, app/js/library.js), loaded at the first press or drop: the
// page's own load takes none of it.
//
//   - A pick or a drop: each file that imports (an archive, a PDF, a picture) goes to the import; one
//     that doesn't is a backup if what is in it says so, whatever it is named (a download left as
//     "… .crdownload"), and is otherwise left out. The backups are restored first, each behind its own
//     progress window (backup-ui.js), and the page is read again; then the rest is imported
//     (import-tracker.js importDropped: several titles ask first, then go as one batch the tracker
//     shows; a single title says how it ended unless it simply imported).
//   - A drop's folders are read first (import-files.js droppedImports), the reading told as it goes.
//
// The import, the backups and the batch are the app's modules, as 1.3's page called them.
import { IMPORT_ACCEPT, droppedImports, groupImports, isImportable } from '@lib/import-files.js';
import type { DropItems } from './drop-items';

// What Import's picker offers: what imports, and the backups (1.3's #cbzFileInput).
export const PICK_ACCEPT = `${IMPORT_ACCEPT},.shi,.shioridb,.crdownload,.crswap`;

type Folder = { name: string; entries: { file: File | null; path: string }[] };

// `reread`: the page and its totals read again, after a backup is restored. `leftOut`: the files a
// drop's folders held that are none of what imports.
export async function handleImportFiles(files: File[], folders: Folder[] = [], { leftOut = 0, reread }: { leftOut?: number; reread: () => Promise<unknown> }) {
  const media: File[] = [], backups: File[] = [];
  const probe = files.some((file) => !isImportable(file)) ? (await import('@lib/backup.js')).probeBackup as (file: File) => Promise<unknown> : null;
  for (const file of files) {
    if (isImportable(file)) media.push(file);
    else if (await probe!(file)) backups.push(file);
    else leftOut++;
  }
  if (backups.length) {
    await ((await import('@lib/backup-ui.js')).importBackups as (files: File[]) => Promise<void>)(backups);
    await reread();
  }
  if (!media.length && !folders.length) return;
  const { importDropped } = await import('@lib/import-tracker.js');
  await (importDropped as (groups: unknown[], what: object) => Promise<void>)(groupImports(media, folders as never), { files: media, folders, leftOut });
}

// The drop's files and folders read (its folders' lists in full), the reading told as it goes:
// `onFound(n)` with how many files the folders have shown so far.
export async function readDrop(drop: DropItems, onFound: (found: number) => void) {
  const started = Date.now();
  const read = await (droppedImports as (dt: DropItems, onProgress: (found: number) => void) => Promise<{ files: File[]; folders: Folder[]; leftOut: number }>)(drop, onFound);
  if (read.folders.length) {
    const { logImport } = await import('@lib/import-log.js');
    logImport('listed', { folders: read.folders.length, files: read.folders.reduce((n, f) => n + f.entries.length, 0), leftOut: read.leftOut, ms: Date.now() - started });
  }
  return read;
}
