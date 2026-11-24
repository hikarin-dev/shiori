// translation-store.ts — Settings' Translation panel as a store outside React (read with
// useSyncExternalStore): the stored translation settings and the panel's fields, the server's status,
// what it can run (its capabilities), and saving, as 1.3's Settings page ran them. What is stored, and
// how it is read back, is app/js/translate-settings.js's.
//
//   - start() reads the stored settings (an older schema's migrated and stored once), asks for the
//     capabilities (the copy kept for the server at once, then the server), and checks the server's
//     status. Neither of the two asks the server on its own unless a server was configured: until then
//     the badge says offline and nothing is contacted (the browser would ask the visitor for access
//     to the local network on a first visit). stop() lets go: answers that come later are dropped.
//   - setField() changes a field of the panel as it is typed or chosen (nothing stored);
//     commit() stores the settings with the panel's fields, the way a change of that field did in
//     1.3 (the server's address and token check the connection again).
//   - apply(control) reads an edited control (translate-settings.js's applyControl) into the settings
//     and stores them; reset() puts the server's recommendations back; check() asks the server now.
//   - Saving says how it went: a status for the caller's status line (refused when the address isn't
//     a web address, as 1.3 said).
//
// Pure: the store, the server, the rules (translate-settings.js, and translate.js's server address
// and whether one is configured) are handed in (app/tests/translation-store.test.mjs).
import type * as SettingsRules from '@lib/translate-settings.js';
import type * as TranslateRules from '@lib/translate.js';

export type Rules = typeof SettingsRules & Pick<typeof TranslateRules, 'hasConfiguredServer' | 'serverUrlFromSettings'>;

export type Settings = Record<string, unknown> & { params: Record<string, unknown> };
export type Fields = { serverUrl: string; serverToken: string; studyModeGeneration: string; saveSnapshots: boolean; keepSnapshotsOnRevert: boolean };
export type Caps = { stages: unknown[]; presets?: { id: string; values: Record<string, unknown> }[] } & Record<string, unknown>;
export type Badge = 'checking' | 'online' | 'offline';
export type Control = Parameters<Rules['applyControl']>[2];
export type Saved = { text: string; tone: 'ok' | 'err' } | null;

export type Deps = {
  rules: Rules;
  kv: { get(keys: string[]): Promise<Record<string, unknown>>; set(values: Record<string, unknown>): void };
  ping(serverUrl: string, settings: unknown): Promise<boolean>;
  getCapabilities(serverUrl: string, settings: unknown): Promise<{ doc: Caps | null; offline: boolean }>;
  cachedCapabilities(serverUrl: string): Promise<{ doc?: Caps | null } | null>;
  saved(): string;   // what a status line says once saved ('Saved.', in the page's language)
};

export type State = {
  loaded: boolean;
  settings: Settings;
  fields: Fields;
  caps: Caps | null;
  capsOffline: boolean;      // the capabilities are a kept copy the server didn't just confirm
  badge: Badge;
  benchmark: boolean;        // offered: a local server that answered
  drawn: number;             // counts what 1.3 drew again whole (a load, new capabilities, a preset, a reset)
};

const CONNECTION_FIELDS = new Set<keyof Fields>(['serverUrl', 'serverToken']);

export function createTranslationStore(deps: Deps) {
  const { applyControl, benchmarkOffered, gatherTranslateSettings, readTranslateSettings, resetTranslateSettings, SERVER_URL_ERROR, serverUrlInvalid,
    hasConfiguredServer, serverUrlFromSettings } = deps.rules;
  const initial = readTranslateSettings(undefined);
  let state: State = { loaded: false, settings: initial.settings, fields: initial.fields, caps: null, capsOffline: false, badge: 'checking', benchmark: false, drawn: 0 };
  let capsServer = '';
  let live = false;
  let run = 0;   // each start() a run of its own: what an earlier run asked for lands nowhere
  const listeners = new Set<() => void>();

  const publish = (next: Partial<State>) => { state = { ...state, ...next }; for (const listener of [...listeners]) listener(); };
  const gather = (): Settings => gatherTranslateSettings(state.settings, state.fields);
  const alive = (mine: number) => live && mine === run;

  // `auto`: a check nobody asked for (the page showing). Not before a server is configured.
  async function checkStatus(settings: unknown, { auto = false } = {}, mine = run) {
    const translateSettings = settings || (await deps.kv.get(['translateSettings'])).translateSettings;
    if (!alive(mine)) return;
    if (auto && !hasConfiguredServer(translateSettings)) { publish({ badge: 'offline' }); return; }
    publish({ badge: 'checking' });
    const serverUrl = serverUrlFromSettings(translateSettings);
    const online = await deps.ping(serverUrl, translateSettings);
    if (!alive(mine)) return;
    publish({ badge: online ? 'online' : 'offline', benchmark: benchmarkOffered(online, serverUrl) });
  }

  // The kept copy of what the server can run at once, then the server's answer.
  async function refreshCapabilities({ auto = false } = {}, mine = run) {
    const serverUrl = serverUrlFromSettings(gather());
    if (serverUrl !== capsServer) { capsServer = serverUrl; publish({ caps: null }); }
    const cached = await deps.cachedCapabilities(serverUrl);
    if (!alive(mine)) return;
    if (cached?.doc && !state.caps) publish({ caps: cached.doc, capsOffline: true });
    publish({ drawn: state.drawn + 1 });
    if (auto && !hasConfiguredServer(state.settings)) return;
    const { doc, offline } = await deps.getCapabilities(serverUrl, gather());
    if (!alive(mine) || serverUrl !== capsServer) return;   // the address changed meanwhile
    publish({ caps: doc, capsOffline: offline, drawn: state.drawn + 1 });
  }

  // Stores the whole settings object; only the server's address or token needs the connection
  // checked again.
  function save({ recheck = false } = {}): Saved {
    if (serverUrlInvalid(state.fields.serverUrl)) return { text: SERVER_URL_ERROR, tone: 'err' };
    const settings = gather();
    publish({ settings });
    deps.kv.set({ translateSettings: settings });
    if (recheck) { checkStatus(null).catch(() => {}); refreshCapabilities().catch(() => {}); }
    return { text: deps.saved(), tone: 'ok' };
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    get: () => state,

    start() {
      if (live) return;
      live = true;
      const mine = ++run;
      deps.kv.get(['translateSettings']).then(({ translateSettings: stored }) => {
        if (!alive(mine)) return;
        const { settings, migrated, fields } = readTranslateSettings(stored);
        publish({ settings, fields, loaded: true });
        if (migrated) deps.kv.set({ translateSettings: settings });   // one-time migration
        refreshCapabilities({ auto: true }, mine);
      }).catch(() => {});
      checkStatus(null, { auto: true }, mine).catch(() => {});
    },
    stop() { live = false; },

    setField<K extends keyof Fields>(key: K, value: Fields[K]) { publish({ fields: { ...state.fields, [key]: value } }); },
    // A field's change committed (a box left or Enter pressed, a choice made, a switch turned).
    commit(key: keyof Fields): Saved { return save({ recheck: CONNECTION_FIELDS.has(key) }); },
    // An edited control of the pipeline, the language or the advanced window.
    apply(control: Control, { redraw = false } = {}): Saved {
      const settings = applyControl(state.settings, state.caps, control) as Settings;
      publish({ settings, drawn: state.drawn + (redraw || control.preset !== undefined ? 1 : 0) });
      return save();
    },
    reset(): Saved {
      publish({ settings: resetTranslateSettings(gather()) as Settings, drawn: state.drawn + 1 });
      return save();
    },
    // Check: the status and the capabilities, with the fields as they are now.
    check() {
      checkStatus(gather()).catch(() => {});
      refreshCapabilities().catch(() => {});
    },
  };
}

export type TranslationStore = ReturnType<typeof createTranslationStore>;
