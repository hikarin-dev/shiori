// runner-tag.js — what a job's `runner` (platform.js) tells a person: where the job runs, as a short
// tag, and in its tooltip what ending that would stop the job. The tasks page and the import tracker
// show it on every job.

import { t } from './i18n.js';
import { contextId, helperHost } from './platform.js';

const PAGE_KEY = { library: 'nav.library', overview: 'nav.overview', reader: 'nav.reader', settings: 'nav.settings', tasks: 'tasks.title' };
const _page = (runner) => (runner.page ? t(PAGE_KEY[runner.page] || '') || runner.page : '');

// { text, tip } for `runner`, or null when the job doesn't say (a record from before it did).
export function runnerTag(runner) {
  const kind = runner?.kind;
  if (!kind || kind === 'other') return null;
  const here = runner.id && runner.id === contextId;
  const page = _page(runner);
  switch (kind) {
    case 'tab': return { text: here ? t('run.this_tab') : t('run.tab', { page }), tip: t('run.tab_tip', { page }) };
    case 'desktop-window': return { text: here ? t('run.this_window') : t('run.window', { page }), tip: t('run.window_tip', { page }) };
    case 'desktop-background': return { text: t('run.app_background'), tip: t('run.app_background_tip') };
    case 'service-worker': return { text: t('run.service_worker'), tip: t('run.service_worker_tip') };
    case 'shared-worker': return { text: t('run.shared_worker'), tip: t('run.shared_worker_tip') };
    case 'worker': return { text: t('run.worker'), tip: t('run.worker_tip') };
    case 'helper': {
      const host = runner.host || helperHost;
      if (host === 'desktop') return { text: t('run.desktop_extension'), tip: t('run.desktop_extension_tip') };
      return { text: t('run.browser_extension', { browser: host }), tip: t('run.browser_extension_tip', { browser: host }) };
    }
    default: return { text: kind, tip: '' };
  }
}

// Fill a tag element (hidden when the job doesn't say), changing only what changed.
export function paintRunnerTag(el, runner) {
  const tag = runnerTag(runner);
  el.hidden = !tag;
  if (!tag) return;
  if (el.textContent !== tag.text) el.textContent = tag.text;
  if (el.dataset.tip !== tag.tip) el.dataset.tip = tag.tip;
  if (el.dataset.runner !== runner.kind) el.dataset.runner = runner.kind;
}
