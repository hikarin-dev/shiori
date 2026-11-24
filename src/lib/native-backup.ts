// native-backup.ts — a backup the desktop app was making or restoring when its window was reloaded,
// followed again (backup-ui.js attachNativeBackup): asked for once a document, by whichever page shows
// first (Library, Settings → Storage), as each of 1.3's pages asked as it loaded. Asked twice in one
// document it would take a backup this window is making or restoring itself for one left behind (a
// second progress window, or an import waiting for an answer cancelled).
//
// Only the desktop app's window keeps such a backup: elsewhere nothing is loaded for it.
let asked = false;

export function attachNativeBackupOnce() {
  if (asked) return;
  asked = true;
  if (!(globalThis as { shioriDesktop?: unknown }).shioriDesktop) return;
  import('@lib/backup-ui.js').then((m) => m.attachNativeBackup()).catch(() => {});
}
