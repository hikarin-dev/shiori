// stand-in-helper.mjs — a stand-in for the helper behind the app's bridge (app/js/ext-bridge.js), for
// browser tests: put into a page before its scripts run, it answers the bridge's requests as a helper
// would, for one made-up source ("Site One", a.example), and keeps every request it was sent in
// `window.__helperSaid` (type and fields, in order). It fetches nothing and starts nothing: a download
// asked of it is answered "started" and no more.
export const SITES = { 'a.example': { name: 'Site One', canDownload: true, galleryUrl: 'https://a.example/g/{id}' } };

// The page's storage says the helper was there last time (sites.js's warm start), so the first render
// already offers downloads.
export const HELPER_STATUS = { 'shiori-ext-status': JSON.stringify({ available: true, sites: SITES }) };

export async function standInHelper(page) {
  await page.evaluateOnNewDocument((sites) => {
    window.__helperSaid = [];
    const answer = (msg) => {
      switch (msg?.type) {
        case 'PING': return { ok: true };
        case 'EXT_SITES': return { sites };
        // A link of Site One's: its id from the address.
        case 'EXT_PARSE_URL': {
          const m = /^(?:https?:\/\/)?(?:www\.)?a\.example\/g\/(\d+)/.exec(String(msg.input || '').trim());
          return m ? { ok: true, source: 'a.example', sourceId: m[1], sourceUrl: `https://a.example/g/${m[1]}` } : { ok: false };
        }
        case 'EXT_DOWNLOAD': return { ok: true, started: true };
        case 'EXT_STOP_JOB': return { stopped: false };
        default: return null;
      }
    };
    window.addEventListener('message', (e) => {
      if (e.source !== window || e.data?.__shiori !== 'to-ext') return;
      const { id, msg } = e.data;
      if (msg?.type !== 'PING' && msg?.type !== 'EXT_SITES' && msg?.type !== 'EXT_FETCH_ICON') window.__helperSaid.push(msg);
      const response = answer(msg);
      if (id != null) window.postMessage({ __shiori: 'from-ext', replyTo: id, response }, location.origin);
    });
  }, SITES);
}
