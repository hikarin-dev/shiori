// reader-feedback.js — a report on how one bubble was typeset (F over a bubble in study or translate
// view): the page as it showed, the bubble and its neighbours, what needs improvement and a note, sent to
// the translation server or exported as a zip. The evidence, its zip and its request are feedback.js's;
// this keeps each bubble's draft for the reader's session (closed and opened again, it is as it was
// left) and what sending or exporting one does. The one page draws it: the reader's route registers a
// host here (setFeedbackHost, src/routes/reader/feedback-store.ts) before it starts the reader, and the
// host shows a draft and redraws it as it changes (src/routes/reader/feedback.tsx).
import * as api from './api.js';
import { kv } from './platform.js';
import { t } from './i18n.js';
import { ISSUES, captureFeedback, feedbackZip, feedbackDestination, feedbackRequest, sha256 } from './feedback.js';

let _host = null;
export function setFeedbackHost(host) {
  _host = host;
  return () => { if (_host === host) _host = null; };
}
const _drawer = () => {
  if (!_host) throw new Error('reader-feedback.js: no feedback host has registered (setFeedbackHost)');
  return _host;
};

const drafts = new Map();   // page url | job | bubble | surface → its draft, for the reader's session
export const feedbackOpen = () => !!_host?.isOpen();
// The reader's stop: every draft, shown or kept, goes with what it holds.
export function closeFeedback() {
  _host?.close();
  for (const draft of drafts.values()) draft.release();
  drafts.clear();
}

const rect = r => ({ x: r.x, y: r.y, w: r.width, h: r.height });

function displayEvidence(wrap, context) {
  const bounds = wrap.getBoundingClientRect();
  return {
    ...context, pageRect: rect(bounds), pageClientWidth: wrap.clientWidth,
    pixelRatio: window.devicePixelRatio, viewport: { w: innerWidth, h: innerHeight, scale: window.visualViewport?.scale || 1 },
    cssToPageScale: bounds.width / (context.pageWidth || bounds.width),
    regions: [...wrap.querySelectorAll('.bubble-box')].map(el => ({ index: Number(el.dataset.feedbackIndex),
      surface: el.dataset.feedbackSurface, translationVisible: el.dataset.feedbackVisible === 'true' && el.dataset.feedbackSurface === 'translation',
      rect: rect(el.getBoundingClientRect()) })),
    text: [...wrap.querySelectorAll('.study-text')].filter(el => el.style.display !== 'none').map(el => {
      const st = getComputedStyle(el), body = el.querySelector('.study-text-content');
      return { index: Number(el.dataset.feedbackIndex), translation: !el.classList.contains('src'),
        text: body?.textContent || '', rect: rect(el.getBoundingClientRect()), contentRect: body ? rect(body.getBoundingClientRect()) : null,
        style: { ...Object.fromEntries(['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'textAlign', 'textTransform',
          'whiteSpace', 'wordBreak', 'textWrap', 'writingMode', 'color'].map(k => [k, st[k]])),
          outline: `${st.getPropertyValue('--outline-w')} ${st.getPropertyValue('--outline-c')}`.trim() } };
    }),
  };
}

// The page as it showed when F was pressed, frozen: a copy of its wrap without ids or the bubbles' own
// controls. Once the evidence is captured its pictures are the capture's own, so the reader letting go
// of its pictures cannot empty it.
function _frozenPage(wrap) {
  const preview = wrap.cloneNode(true);
  preview.className = 'page-wrap';
  preview.removeAttribute('style');
  preview.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
  preview.querySelectorAll('.bubble-nav, .bubble-box').forEach(el => el.remove());
  preview.setAttribute('aria-hidden', 'true');
  return preview;
}

const MISSING = (field) => field === 'original' ? 'missing_original' : field === 'selected_ocr' ? 'surface_ocr'
  : field === 'translated' || field === 'selected_translation' ? 'missing_translation'
  : field === 'study_background' ? 'missing_background' : field === 'original_region_ids' ? 'missing_ids' : 'missing_pipeline';

function _draft({ key, page, study, index, wrap, context, surface }) {
  const display = displayEvidence(wrap, context);
  const urls = [];
  let capture = null, destination = null, receipt = null, submitted = '';
  const draft = {
    key, index, surface,
    page: _frozenPage(wrap), pageWidth: context.pageWidth || wrap.clientWidth,
    aspect: display.pageRect.w && display.pageRect.h ? `${display.pageRect.w} / ${display.pageRect.h}` : undefined,   // its shape as it showed
    // Each bubble's box on the page as a share of it (the one reported, its neighbours).
    regions: study.bubbles.map((b) => {
      const r = surface === 'translation' ? (b.tbox || b.rbox || b.region || b.box) : b.box;
      return r ? { x: r.x, y: r.y, w: r.w, h: r.h } : null;
    }),
    related: study.bubbles.map((b, i) => (i === index ? null : { index: i, text: `${i + 1}. ${(surface === 'translation' ? b.tr || b.src || '' : b.src || '').slice(0, 100)}` })).filter(Boolean),
    issues: ISSUES, chosen: new Set(), note: '', ticked: new Set(),
    destination: false, fidelity: null, missing: [], status: '', busy: false,
    canSave: () => !draft.busy && !!capture && !!destination && draft.chosen.size > 0,
    canExport: () => !draft.busy && !!capture && draft.chosen.size > 0,
    // A change to the form: what was sent is no longer what it says.
    edit(change) { change(); receipt = null; draft.status = ''; _changed(); },
    setIssue(value, on) { draft.edit(() => { on ? draft.chosen.add(value) : draft.chosen.delete(value); }); },
    setNote(text) { draft.edit(() => { draft.note = text; }); },
    setRelated(i, on) { draft.edit(() => { on ? draft.ticked.add(i) : draft.ticked.delete(i); }); },
    async send() {
      if (!draft.canSave()) return;
      _manifest(); draft.busy = true; draft.status = t('feedback.saving'); _changed();
      try {
        const result = await feedbackRequest(destination, '/feedback/save', { archive: await feedbackZip(capture) });
        if (result.report_id !== capture.manifest.report_id || !/^[a-f0-9]{64}$/.test(result.archive_sha256)
            || result.storage !== 'translation-server') throw new Error(t('feedback.bad_ack'));
        receipt = result;
        draft.status = t('feedback.saved');
      } catch (err) { draft.status = t('feedback.failed', { error: err.message }); }
      finally { draft.busy = false; _changed(); }
    },
    async export() {
      if (!draft.canExport()) return;
      _manifest(); draft.busy = true; _changed();
      try {
        if (receipt) {
          const blob = await feedbackRequest(destination, '/feedback/export', {
            report_id: receipt.report_id, archive_sha256: receipt.archive_sha256,
          }, true);
          if (await sha256(blob) !== receipt.archive_sha256) throw new Error(t('feedback.bad_ack'));
          _download(blob); draft.status = t('feedback.exported');
        } else {
          _download(await feedbackZip(capture));
          draft.status = t('feedback.exported_cached');
        }
      } catch {
        // Offline export keeps the note and all locally cached evidence; fidelity states the gap.
        _download(await feedbackZip(capture)); draft.status = t('feedback.exported_cached');
      } finally { draft.busy = false; _changed(); }
    },
    release() {
      window.removeEventListener('pagehide', draft.release);
      observer.disconnect();
      urls.splice(0).forEach(u => URL.revokeObjectURL(u));
    },
  };
  function _manifest() {
    const values = { issues: ISSUES.filter(v => draft.chosen.has(v)), note: draft.note,
      related: [...draft.ticked].sort((a, b) => a - b).map(i => capture.manifest.page.bubbles[i].id) };
    const signature = JSON.stringify(values);
    if (submitted && submitted !== signature) capture.manifest.report_id = crypto.randomUUID().replaceAll('-', '');
    submitted = signature;
    Object.assign(capture.manifest, { issues: values.issues, note: values.note });
    capture.manifest.selection.related = values.related;
  }
  function _download(blob) {
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = `feedback-${capture.manifest.report_id}.zip`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  function _changed() { if (drafts.get(key) === draft) _host?.changed(draft); }
  // The frozen page's bubble layers keep to its own width, whatever the reader's zoom was (the reader's
  // own measure, --pgscale), wherever it is drawn.
  const observer = new ResizeObserver(() => draft.page.querySelectorAll('.bubble-layer').forEach(layer =>
    layer.style.setProperty('--pgscale', String(draft.page.clientWidth / (draft.pageWidth || 1)))));
  observer.observe(draft.page);
  window.addEventListener('pagehide', draft.release, { once: true });
  (async () => {
    try {
      capture = await captureFeedback(await api.pages.get(page.gid, page.pageNum), study, display, index);
      const settings = (await kv.get('translateSettings')).translateSettings || {};
      destination = feedbackDestination(settings);
      if (drafts.get(key) !== draft) return;   // gone meanwhile (closeFeedback)
      draft.destination = true;
      draft.fidelity = capture.manifest.missing.length ? 'incomplete' : 'complete';
      draft.missing = [...new Set(capture.manifest.missing.map(MISSING))];
      // The frozen page's pictures, the capture's own.
      const blobs = [capture.manifest.page.original, capture.manifest.page.study_background];
      for (const img of draft.page.querySelectorAll('img')) {
        const owner = img.dataset.feedbackIndex;
        const ref = owner !== undefined ? capture.manifest.page.bubbles[Number(owner)]?.text
          : img.classList.contains('study-layer-img') ? blobs[1] : blobs[0];
        if (ref) { img.src = URL.createObjectURL(capture.assets.get(ref.path)); urls.push(img.src); }
      }
    } catch (err) {
      if (drafts.get(key) !== draft) return;
      draft.status = t(err.message.startsWith('feedback.') ? err.message : 'feedback.missing_page');
    }
    _changed();
  })();
  return draft;
}

export function openFeedback({ pageUrl, page, study, index, wrap, context }) {
  const surface = context.surface || 'translation';
  const key = `${pageUrl}|${study.job || 'legacy'}|${index}|${surface}`;
  let draft = drafts.get(key);
  if (!draft) {
    draft = _draft({ key, page, study, index, wrap, context, surface });
    drafts.set(key, draft);
  }
  _drawer().show(draft);
}
