// drop-items.ts — a drop's items kept for reading after the drop event (the library's import, the
// overview's add bar). Plain and small: a page takes it with its own code, so the drop's items are
// copied during the event while the import's modules are still on their way.

// A drop's items as the drop event had them: they can only be listed while it lasts, and the page reads
// them after the import's modules have come.
export type DropItems = { items: { kind: string; webkitGetAsEntry: () => FileSystemEntry | null; getAsFile: () => File | null }[] };

// A drop's items as the drop event has them, for reading after it (they can only be listed while it
// lasts): each file's entry, and its file where it is not a folder.
export function dropItems(dt: DataTransfer): DropItems {
  return { items: [...dt.items].filter((item) => item.kind === 'file').map((item) => {
    const entry = item.webkitGetAsEntry?.() ?? null;
    const file = entry?.isDirectory ? null : item.getAsFile();
    return { kind: 'file', webkitGetAsEntry: () => entry, getAsFile: () => file };
  }) };
}
