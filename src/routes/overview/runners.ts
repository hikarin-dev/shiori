// What can run things for the overview's rows, asked as 1.3's page asked it (app/js/overview.js, its
// boot and updateTranslatorStatus):
//   - whether downloads are possible: sites.js's state (the helper's answer, seeded from the last one
//     seen), asked once as the page shows; a real change (that answer, or any later one sites.js hears
//     of) draws the rows again (a download or Replace);
//   - whether the translation server answers (TRANSLATOR_PING): taken as not until it does, so its
//     buttons never show and then go; asked at once, every 20 s and when the tab is shown again.
// Returns the sites' state's version (it changes with each real change) and the server's.
import { useEffect, useState, useSyncExternalStore } from 'react';
import * as platform from '@lib/platform.js';
import { onSitesChanged, updateSitesStatus } from '@lib/sites.js';

let sitesVersion = 0;
const subscribeSites = (changed: () => void) => onSitesChanged(() => { sitesVersion++; changed(); });
const getSitesVersion = () => sitesVersion;

export const POLL_MS = 20000;

export function useRunners() {
  const sites = useSyncExternalStore(subscribeSites, getSitesVersion);
  const [translatorOnline, setTranslatorOnline] = useState(false);
  useEffect(() => {
    let live = true;
    const ping = () => {
      Promise.resolve(platform.rpc({ type: 'TRANSLATOR_PING' })).then((resp: { online?: boolean } | null) => {
        if (live) setTranslatorOnline(!!(resp && resp.online));
      }, () => { if (live) setTranslatorOnline(false); });
    };
    ping();
    updateSitesStatus().catch(() => false);
    const poll = setInterval(ping, POLL_MS);
    const shown = () => { if (!document.hidden) ping(); };
    document.addEventListener('visibilitychange', shown);
    return () => {
      live = false;
      clearInterval(poll);
      document.removeEventListener('visibilitychange', shown);
    };
  }, []);
  return { sites, translatorOnline };
}
