// What can run things for the library's cards, asked as 1.3's page asked it (app/js/library.js,
// "Helper availability" and "Translation server status"):
//   - whether downloads are possible: sites.js's state (the helper's answer, seeded from the last one
//     seen), asked again at once, 800 ms, 2.5 s and 6.5 s after the page shows (the first answer past
//     sites.js's grace window settles a stale "there"), every 20 s, and when the tab is shown again; a
//     real change draws every card again (its download or Replace) and, the helper there, asks for the
//     sources' icons; an answer that changed nothing, the helper there, asks for them too;
//   - whether the translation server answers (TRANSLATOR_PING): taken as not until it does, so its
//     button never shows and then goes; asked at once, every 20 s and when the tab is shown again.
// Returns the sites' state's version (it changes with each real change) and the server's.
import { useEffect, useState, useSyncExternalStore } from 'react';
import * as platform from '@lib/platform.js';
import { helperAvailable, onSitesChanged, updateSitesStatus } from '@lib/sites.js';
import type { IconStore } from '@/lib/source-icons';

let sitesVersion = 0;
const subscribeSites = (changed: () => void) => onSitesChanged(() => { sitesVersion++; changed(); });
const getSitesVersion = () => sitesVersion;

export const POLL_MS = 20000;
const EARLY = [800, 2500, 6500];

export function useRunners(icons: IconStore) {
  const sites = useSyncExternalStore(subscribeSites, getSitesVersion);
  const [translatorOnline, setTranslatorOnline] = useState(false);

  useEffect(() => {
    let live = true;
    const ping = () => {
      Promise.resolve(platform.rpc({ type: 'TRANSLATOR_PING' })).then((resp: { online?: boolean } | null) => {
        if (live) setTranslatorOnline(!!(resp && resp.online));
      }).catch(() => {});
    };
    const helper = async () => {
      const changed = await updateSitesStatus().catch(() => false);
      if (live && !changed && helperAvailable()) icons.warm();
    };
    // The helper answering after all (or again): its sources' icons asked for.
    const offSites = onSitesChanged(({ available }: { available: boolean }) => { if (available) icons.warm(); });
    ping();
    helper();
    const timers = EARLY.map((ms) => setTimeout(helper, ms));
    const polls = [setInterval(ping, POLL_MS), setInterval(helper, POLL_MS)];
    const shown = () => { if (!document.hidden) { ping(); helper(); } };
    document.addEventListener('visibilitychange', shown);
    return () => {
      live = false;
      offSites();
      for (const timer of timers) clearTimeout(timer);
      for (const poll of polls) clearInterval(poll);
      document.removeEventListener('visibilitychange', shown);
    };
  }, [icons]);

  return { sites, translatorOnline };
}
