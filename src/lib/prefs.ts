// prefs.ts — preferences as controls read and write them, kept outside React (read with
// useSyncExternalStore): over platform.kv, with a table saying what each key's control shows of what
// is stored and what it stores (Settings' own: app/js/settings-prefs.js).
//
//   - load() reads every key once; a page draws only after it, so no control paints its default and
//     then jumps to the saved value.
//   - get(key) is what the key's control shows; set(key, value) stores what the table writes for it,
//     and every control of that key shows it at once.
//   - While started, a change another tab makes to any of the keys (or its storage cleared) is read
//     again and shown: one subscription for whoever started it. start() reads every key again too, for
//     what changed while nobody listened. stop() undoes it; start() may follow again.
//
// Pure: the store (platform.kv's get, set and watch) and the table are handed in
// (app/tests/prefs.test.mjs).

export type Stored = Record<string, unknown>;
export type Kv = {
  get(keys: string[]): Promise<Stored>;
  set(values: Stored): void;
  watch(changed: (key: string | null) => void): () => void;
};
export type Pref = {
  readonly also?: readonly string[];
  read(value: unknown, stored: Stored): unknown;
  write(value: never): unknown;
};

export function createPrefs(kv: Kv, table: Readonly<Record<string, Pref>>) {
  const keys = Object.keys(table);
  const stored = new Set(keys.flatMap((key) => [key, ...(table[key].also ?? [])]));
  let shown: Stored = {};
  let loaded = false;
  const listeners = new Set<() => void>();
  let off: (() => void) | null = null;
  // Each read and write counts here, so a read that started before a write never lands over it.
  let writes = 0;

  const publish = () => { for (const listener of [...listeners]) listener(); };

  // Every key read from the store, and what each control shows worked out again; told only when
  // something shown changed.
  async function read() {
    const before = writes;
    const values = await kv.get([...stored]);
    if (before !== writes) return;
    const next: Stored = {};
    for (const key of keys) next[key] = table[key].read(values[key], values);
    const changed = !loaded || keys.some((key) => !Object.is(next[key], shown[key]));
    shown = next;
    loaded = true;
    if (changed) publish();
  }

  return {
    load: read,
    get loaded() { return loaded; },

    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    // What the control for `key` shows.
    get(key: string): unknown {
      if (!(key in table)) throw new Error(`prefs: no preference "${key}"`);
      return shown[key];
    },
    // The control for `key` took `value`: stored as the table writes it.
    set(key: string, value: unknown) {
      const pref = table[key];
      if (!pref) throw new Error(`prefs: no preference "${key}"`);
      writes++;
      const out = pref.write(value as never);
      kv.set({ [key]: out });
      const next = pref.read(out, { [key]: out });
      if (Object.is(next, shown[key])) return;
      shown = { ...shown, [key]: next };
      publish();
    },

    start() {
      if (off) return;
      off = kv.watch((key) => { if (key === null || stored.has(key)) read().catch(() => {}); });
      read().catch(() => {});
    },
    stop() {
      if (!off) return;
      off();
      off = null;
    },
  };
}

export type Prefs = ReturnType<typeof createPrefs>;
