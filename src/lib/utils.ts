// cn() — joins class names and settles conflicts between Tailwind utilities, the last one winning.
// Told the theme's own names (./cn-config.ts); its tables are compiled from them by the build's script
// (build/cn-tables.mjs → ./cn-tables.ts), not at every page's start.
import { createCn } from 'cn/engine';
import tables from './cn-tables.ts';

export { TOKENS } from './cn-config.ts';

export const cn = createCn(tables);

// classCache() — a component's classes for one set of choices, worked out once. Its variants and cn()
// are pure, and a page draws the same few looks by the hundred (a library page: 180 buttons, some 400
// tags), each of which would otherwise run its every compound variant again. `key` names the choices
// (everything `make` reads, the caller's own class names included); `make` runs for a key not seen.
export function classCache() {
  const kept = new Map<string, string>();
  return (key: string, make: () => string) => {
    let classes = kept.get(key);
    if (classes === undefined) {
      if (kept.size >= 1000) kept.clear();   // (class names made up as it goes must not pile up)
      classes = make();
      kept.set(key, classes);
    }
    return classes;
  };
}
