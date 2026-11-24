// system-settings.js — Settings → System's rules that are not drawing, which every page drawing the
// panel uses: the window's bridge to the desktop app (`shioriDesktop.shell`), the ports offered, what
// an add-on's row is called, what the update's line says for each of its states (and whether it is
// ready, or under way and followed), and the restart a change of the port or of the network asks for.
// Moved as they were from 1.3's Settings page.
import { t } from './i18n.js';
import { confirmDialog } from './notice.js';

export const shell = (action, ...args) => globalThis.shioriDesktop.shell(action, ...args);

// The port's choices: automatic (0), then each port the app may take.
export const portChoices = (state) => [0, ...state.ports].map(p => ({ value: p, label: p ? p : t('set.desk_port_auto') }));

export const addOnName = (ext) => (ext.name ? `${ext.name} ${ext.version || ''}` : ext.dir);

// The update's progress, followed while something is under way.
export const UPDATE_TEXT = {
  idle: () => t('set.desk_check_desc'), checking: () => t('set.desk_checking'), none: () => t('set.desk_up_to_date'),
  downloading: (u) => t('set.desk_downloading', { version: u.version, percent: u.percent ?? 0 }),
  ready: (u) => t('set.desk_ready', { version: u.version }), error: (u) => t('set.desk_update_error', { error: u.error }),
  unavailable: () => t('set.desk_update_unavailable'),
};
export const UPDATE_FOLLOW_MS = 700;
// What the update's line says; `ready`: Restart to update shows; `busy`: Check is off, and the state is
// asked for again UPDATE_FOLLOW_MS later.
export const updateView = (update) => {
  const u = update || { status: 'idle' };
  return { text: (UPDATE_TEXT[u.status] || UPDATE_TEXT.idle)(u), ready: u.status === 'ready', busy: u.status === 'checking' || u.status === 'downloading' };
};

export const restart = async (body) => {
  if (await confirmDialog({ title: t('set.desk_restart_title'), body, ok: t('set.desk_restart_ok'), cancel: t('set.desk_later') })) shell('restart');
};
