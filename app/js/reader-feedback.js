import { dbGet } from './db.js';
import { kv } from './platform.js';
import { t } from './i18n.js';
import { ISSUES, captureFeedback, feedbackZip, feedbackDestination, feedbackRequest, sha256 } from './feedback.js';

const drafts = new Map();
export const feedbackOpen = () => !!document.querySelector('.feedback-dialog[open]');
const node = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
};
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
        style: Object.fromEntries(['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'textAlign', 'textTransform',
          'whiteSpace', 'wordBreak', 'textWrap', 'writingMode', 'color', 'webkitTextStroke'].map(k => [k, st[k]])) };
    }),
  };
}

export function openFeedback({ pageUrl, study, index, wrap, context }) {
  const surface = context.surface || 'translation';
  const key = `${pageUrl}|${study.job || 'legacy'}|${index}|${surface}`;
  if (drafts.has(key)) { drafts.get(key).showModal(); return; }
  const display = displayEvidence(wrap, context);
  const dialog = node('dialog', 'feedback-dialog');
  const titleId = 'feedback-' + crypto.randomUUID();
  dialog.setAttribute('aria-labelledby', titleId);
  const header = node('div', 'feedback-header');
  const title = node('h2', '', t('feedback.title')); title.id = titleId;
  const close = node('button', 'btn', t('common.close')); close.type = 'button';
  header.append(title, close);
  const content = node('div', 'feedback-content');
  const previewColumn = node('div', 'feedback-preview-column');
  const preview = wrap.cloneNode(true);
  preview.className = 'page-wrap feedback-preview';
  preview.removeAttribute('style');
  preview.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
  preview.querySelectorAll('.bubble-nav, .bubble-box').forEach(el => el.remove());
  preview.setAttribute('aria-hidden', 'true');
  previewColumn.append(node('p', 'feedback-caption', t('feedback.preview')), preview);
  const form = node('form', 'feedback-form');
  const destinationText = node('p', 'feedback-destination', t('feedback.loading'));
  const subjectText = node('p', 'feedback-subject', t('feedback.subject', { subject: t('feedback.surface_' + surface) }));
  const fidelity = node('p', 'feedback-fidelity');
  const issues = node('fieldset'); issues.append(node('legend', '', t('feedback.issues')));
  for (const value of ISSUES) {
    const label = node('label', 'feedback-check'), input = node('input');
    input.type = 'checkbox'; input.name = 'issue'; input.value = value;
    label.append(input, document.createTextNode(t(`feedback.${value}`))); issues.append(label);
  }
  const noteLabel = node('label', 'feedback-note', t('feedback.note'));
  const note = node('textarea'); note.name = 'note'; note.rows = 5; note.maxLength = 10000;
  noteLabel.append(note);
  const related = node('fieldset', 'feedback-related'); related.append(node('legend', '', t('feedback.related')));
  const highlights = [];
  study.bubbles.forEach((b, i) => {
    const r = surface === 'translation' ? (b.tbox || b.rbox || b.region || b.box) : b.box;
    if (r) {
      const mark = node('div', 'feedback-region');
      Object.assign(mark.style, { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });
      mark.classList.toggle('selected', i === index);
      mark.textContent = String(i + 1); preview.append(mark); highlights[i] = mark;
    }
    if (i === index) return;
    const label = node('label', 'feedback-check'), input = node('input');
    input.type = 'checkbox'; input.name = 'related'; input.value = String(i);
    input.addEventListener('change', () => highlights[i]?.classList.toggle('selected', input.checked));
    label.append(input, document.createTextNode(`${i + 1}. ${(surface === 'translation' ? b.tr || b.src || '' : b.src || '').slice(0, 100)}`)); related.append(label);
  });
  const status = node('p', 'feedback-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const actions = node('div', 'feedback-actions');
  const save = node('button', 'btn primary', t('feedback.save')); save.type = 'submit'; save.disabled = true;
  const exp = node('button', 'btn', t('feedback.export')); exp.type = 'button'; exp.disabled = true;
  actions.append(save, exp);
  form.append(destinationText, subjectText, fidelity, issues, noteLabel, related, status, actions);
  content.append(previewColumn, form); dialog.append(header, content); document.body.append(dialog);
  drafts.set(key, dialog);
  dialog.showModal();
  close.onclick = () => dialog.close();
  // The ::backdrop belongs to no scroller, so a wheel or swipe over it would scroll the pages
  // behind; scrolls over the dialog itself stay in it (overscroll-behavior: contain).
  const holdPage = (e) => {
    const p = e.touches ? e.touches[0] : e;
    const r = dialog.getBoundingClientRect();
    if (p.clientX < r.left || p.clientX > r.right || p.clientY < r.top || p.clientY > r.bottom) e.preventDefault();
  };
  dialog.addEventListener('wheel', holdPage, { passive: false });
  dialog.addEventListener('touchmove', holdPage, { passive: false });
  // Keep the frozen preview scaled to its own width, independent of the live reader's zoom.
  const observer = new ResizeObserver(() => preview.querySelectorAll('.bubble-layer').forEach(layer =>
    layer.style.setProperty('--pgscale', String(preview.clientWidth / (context.pageWidth || wrap.clientWidth)))));
  observer.observe(preview);
  let capture, destination, receipt, busy = false, submitted = '';
  const chosen = () => [...issues.querySelectorAll('input:checked')].map(el => el.value);
  const updateButtons = () => {
    save.disabled = busy || !capture || !destination || !chosen().length;
    exp.disabled = busy || !capture || !chosen().length;
    issues.disabled = related.disabled = note.disabled = busy;
  };
  form.addEventListener('input', () => { receipt = null; status.textContent = ''; updateButtons(); });
  function updateManifest() {
    const values = { issues: chosen(), note: note.value, related: [...related.querySelectorAll('input:checked')].map(el => capture.manifest.page.bubbles[Number(el.value)].id) };
    const signature = JSON.stringify(values);
    if (submitted && submitted !== signature) capture.manifest.report_id = crypto.randomUUID().replaceAll('-', '');
    submitted = signature;
    Object.assign(capture.manifest, { issues: values.issues, note: values.note });
    capture.manifest.selection.related = values.related;
  }
  function download(blob) {
    const url = URL.createObjectURL(blob), a = node('a');
    a.href = url; a.download = `feedback-${capture.manifest.report_id}.zip`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  form.addEventListener('submit', async e => {
    e.preventDefault(); if (save.disabled) return;
    updateManifest(); busy = true; updateButtons(); status.textContent = t('feedback.saving');
    try {
      const result = await feedbackRequest(destination, '/feedback/save', { archive: await feedbackZip(capture) });
      if (result.report_id !== capture.manifest.report_id || !/^[a-f0-9]{64}$/.test(result.archive_sha256)
          || result.storage !== 'translation-server') throw new Error(t('feedback.bad_ack'));
      receipt = result;
      status.textContent = t('feedback.saved');
    } catch (err) { status.textContent = t('feedback.failed', { error: err.message }); }
    finally { busy = false; updateButtons(); }
  });
  exp.addEventListener('click', async () => {
    if (exp.disabled) return;
    updateManifest(); busy = true; updateButtons();
    try {
      if (receipt) {
        const blob = await feedbackRequest(destination, '/feedback/export', {
          report_id: receipt.report_id, archive_sha256: receipt.archive_sha256,
        }, true);
        if (await sha256(blob) !== receipt.archive_sha256) throw new Error(t('feedback.bad_ack'));
        download(blob); status.textContent = t('feedback.exported');
      } else {
        download(await feedbackZip(capture));
        status.textContent = t('feedback.exported_cached');
      }
    } catch {
      // Offline export keeps the note and all locally cached evidence; fidelity states the gap.
      download(await feedbackZip(capture)); status.textContent = t('feedback.exported_cached');
    } finally { busy = false; updateButtons(); }
  });
  (async () => {
    try {
      capture = await captureFeedback(await dbGet(pageUrl), study, display, index);
      const settings = (await kv.get('translateSettings')).translateSettings || {};
      destination = feedbackDestination(settings);
      destinationText.textContent = t('feedback.destination');
      fidelity.textContent = capture.manifest.missing.length ? t('feedback.incomplete') : t('feedback.complete');
      if (capture.manifest.missing.length) {
        const labels = new Set(capture.manifest.missing.map(field =>
          field === 'original' ? 'missing_original' : field === 'selected_ocr' ? 'surface_ocr' : field === 'translated' || field === 'selected_translation' ? 'missing_translation'
            : field === 'study_background' ? 'missing_background' : field === 'original_region_ids' ? 'missing_ids' : 'missing_pipeline'));
        const list = node('ul');
        for (const label of labels) list.append(node('li', '', t('feedback.' + label)));
        fidelity.append(list);
      }
      // Give the preview independent URLs, so reader cache eviction cannot remove its images.
      const urls = [];
      const blobs = [capture.manifest.page.original, capture.manifest.page.study_background];
      for (const img of preview.querySelectorAll('img')) {
        const owner = img.dataset.feedbackIndex;
        const ref = owner !== undefined ? capture.manifest.page.bubbles[Number(owner)]?.text
          : img.classList.contains('study-layer-img') ? blobs[1] : blobs[0];
        if (ref) { img.src = URL.createObjectURL(capture.assets.get(ref.path)); urls.push(img.src); }
      }
      // Retain closed drafts for this reader session. Release when the tab leaves.
      window.addEventListener('pagehide', () => { urls.forEach(u => URL.revokeObjectURL(u)); observer.disconnect(); }, { once: true });
    } catch (err) { status.textContent = t(err.message.startsWith('feedback.') ? err.message : 'feedback.missing_page'); }
    updateButtons();
  })();
}
