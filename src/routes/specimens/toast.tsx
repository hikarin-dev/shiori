// Toast's specimens: the update toast and the reader's status pill drawn in place, still; then each
// working, at the bottom of the window: the toast until it is acted on or closed, the status pill for
// its 3.5s (busy: until the next line).
import { useState } from 'react';
import { StatusPill, StatusToast, Toast, ToastRegion } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { useT } from '@/lib/i18n';
import { Line, Section, Shape, tag } from './specimen';

export function ToastSpecimens() {
  const t = useT();
  const [toast, setToast] = useState<'off' | 'on' | 'busy'>('off');
  const [status, setStatus] = useState({ seq: 0, text: '', busy: false, error: false });
  const say = (text: string, busy = false, error = false) => setStatus((s) => ({ seq: s.seq + 1, text, busy, error }));
  const noop = () => {};
  return (
    <Section id="toast" title="Toast">
      <Shape id="notice-toast" name="Toast" used="notice.js's showToast: the update toast, a library folder's news; one at a time, 22px over the window's bottom.">
        <Line label="action" states={['rest']} render={(state) => (
          <Toast text={t('update.available')} action={t('update.now')} onAction={noop} closeLabel={t('update.later')} onClose={noop} {...tag('notice-toast', 'action', state)} />)} />
        <Line label="busy" states={['rest']} render={(state) => (
          <Toast text={t('update.available')} action={t('update.now')} busy={t('update.updating')} onAction={noop} closeLabel={t('update.later')} onClose={noop} {...tag('notice-toast', 'busy', state)} />)} />
      </Shape>
      <Shape id="page-status" name="Status pill" used="The reader: a page's translation (busy with a spinner, an error framed in the brand colour); 28px over the bottom.">
        <Line label="status" states={['rest']} render={(state) => <StatusPill {...tag('page-status', 'status', state)}>{t('page.translating', { n: 4 })}</StatusPill>} />
        <Line label="busy" states={['rest']} render={(state) => <StatusPill busy {...tag('page-status', 'busy', state)}>{t('page.translating', { n: 4 })}</StatusPill>} />
        <Line label="error" states={['rest']} render={(state) => <StatusPill error {...tag('page-status', 'error', state)}>{t('page.failed', { n: 4, error: t('page.not_started') })}</StatusPill>} />
      </Shape>
      <Shape id="toast-open" name="Working toasts" used="At the bottom of the window, as each shows on its page.">
        <div className="flex flex-wrap gap-[8px]">
          <Button data-specimen-open="toast" onClick={() => setToast('on')}>{t('update.now')}</Button>
          <Button data-specimen-open="status" onClick={() => say(t('page.translating', { n: 4 }))}>{t('page.translate')}</Button>
          <Button data-specimen-open="status-busy" onClick={() => say(t('page.translating', { n: 4 }), true)}>{t('page.busy')}</Button>
          <Button data-specimen-open="status-error" onClick={() => say(t('page.failed', { n: 4, error: t('page.not_started') }), false, true)}>{t('page.failed', { n: 4, error: t('page.not_started') })}</Button>
        </div>
      </Shape>
      <ToastRegion data-specimen-region="toast">
        {toast !== 'off' && (
          <Toast text={t('update.available')} action={t('update.now')} busy={toast === 'busy' ? t('update.updating') : undefined}
            onAction={() => setToast('busy')} closeLabel={t('update.later')} onClose={() => setToast('off')} />
        )}
      </ToastRegion>
      <StatusToast {...status} />
    </Section>
  );
}
