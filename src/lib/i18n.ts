// useT() — the app's t() (app/js/i18n.js) for components: a component that calls it draws again when
// the language changes, here or in another tab (i18n.js says so with 'shiori-lang-change').
import { useCallback, useSyncExternalStore } from 'react';
import { getLang, t } from '@lib/i18n.js';

const subscribe = (changed: () => void) => {
  window.addEventListener('shiori-lang-change', changed);
  return () => window.removeEventListener('shiori-lang-change', changed);
};

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

// A new function for each language, so a memoised child handed it draws again too.
export function useT(): Translate {
  const lang = useSyncExternalStore(subscribe, getLang);
  return useCallback<Translate>((key, vars) => t(key, vars), [lang]);
}
