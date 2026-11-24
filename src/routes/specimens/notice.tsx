// The notice host's specimens: each of notice.js's functions, called for real (the page's NoticeHost
// draws them), with what it answered shown under the buttons. And a notice over a page's dialog.
import { useState } from 'react';
import * as noticeModule from '@lib/notice.js';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useT } from '@/lib/i18n';
import { Section, Shape, tag } from './specimen';

// A cover drawn here, so the delete confirmation shows one as the library's does.
function cover() {
  const c = document.createElement('canvas');
  c.width = 60; c.height = 85;
  const x = c.getContext('2d')!;
  x.fillStyle = '#3a6ea5'; x.fillRect(0, 0, 60, 85);
  return c.toDataURL();
}

// (Its options are optional in the JavaScript; TypeScript would read every one as required.)
type Call = (options: Record<string, unknown>) => any;
const notice = noticeModule as unknown as Record<'confirmDialog' | 'alertDialog' | 'promptDialog' | 'choiceDialog' | 'toggleDialog' | 'ask' | 'showProgress' | 'showOperation' | 'showToast', Call>;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function NoticeSpecimens() {
  const t = useT();
  const [said, setSaid] = useState('');
  const show = (answer: unknown) => setSaid(answer === undefined ? 'undefined' : JSON.stringify(answer));
  const calls: [string, () => Promise<unknown> | unknown][] = [
    ['confirm', () => notice.confirmDialog({ title: t('dlg.del_gallery_title'), body: t('dlg.del_gallery_body'), detail: ['Harbor Lights', t('dlg.detail_pages', { id: 1042, n: 24 })], cover: cover(), ok: t('dlg.delete'), danger: true })],
    ['alert', () => notice.alertDialog({ title: t('dlg.export_fail_title'), body: t('dlg.export_fail_body'), detail: 'QuotaExceededError', tone: 'error' })],
    ['prompt', () => notice.promptDialog({ title: t('dlg.src_title'), body: t('dlg.src_body'), placeholder: t('dlg.src_ph'), value: 'Harbor Lights' })],
    ['choice', () => notice.choiceDialog({ title: t('dlg.export_title'), detail: 'Harbor Lights',
      choices: [{ value: 'zip', label: t('set.lib_export_zip'), detail: t('dlg.export_zip_desc') }, { value: 'cbz', label: t('set.lib_export_cbz'), detail: t('dlg.export_cbz_desc') }],
      checks: [{ name: 'remember', label: t('dlg.export_remember') }] })],
    ['toggle', () => notice.toggleDialog({ title: t('dlg.trreset_title'), body: t('dlg.trreset_body'),
      toggle: { label: t('set.lib_export_zip'), options: [{ value: 'zip', label: 'ZIP' }, { value: 'cbz', label: 'CBZ' }], value: 'zip',
        confirm: () => notice.confirmDialog({ title: t('dlg.trreset_title'), body: t('dlg.trreset_body') }) } })],
    ['ask', () => notice.ask({ title: t('gate.title'), body: t('gate.body'),
      choices: [{ value: 'open', label: t('gate.open'), detail: t('gate.open_detail') }, { value: 'browser', label: t('gate.browser'), detail: t('gate.browser_detail') }] })],
    ['progress', async () => {
      let stopped = false;
      const p = notice.showProgress({ title: t('maint.title'), body: t('maint.body'), stopLabel: t('common.cancel'), onStop: () => { stopped = true; } });
      for (let done = 0; done <= 10 && !stopped; done++) { p.update(done, 10, t('maint.progress', { done, total: 10 })); await wait(300); }
      p.close();
      return stopped ? 'stopped' : 'done';
    }],
    ['operation', async () => {
      let stopped = false;
      const op = notice.showOperation({ title: t('set.bk_title'), stopLabel: t('common.cancel'), onStop: () => { stopped = true; op.stopping(); } });
      op.update({ lines: [t('set.bk_meta')] });
      await wait(600);
      for (let done = 0; done <= 10 && !stopped; done++) { op.update({ done, total: 10, lines: [t('set.bk_meta'), `${done} / 10`] }); await wait(300); }
      op.close();
      return stopped ? 'stopped' : 'done';
    }],
    ['toast', () => { notice.showToast({ text: t('update.available'), action: t('update.now'), closeLabel: t('update.later'), onAction: (toast: { busy: (label: string) => void }) => toast.busy(t('update.updating')) }); }],
  ];
  // Each as a capture of 1.3 shows it (the parity check opens these and measures what the host draws);
  // the progress windows close by themselves after 650ms.
  const held = (handle: { close(): void }) => { setTimeout(() => handle.close(), 650); };
  const asCaptured: [string, () => unknown][] = [
    ['confirm', () => notice.confirmDialog({ title: t('dlg.del_gallery_title'), body: t('dlg.del_gallery_body'), detail: ['Harbor Lights', t('dlg.detail_pages', { id: 1042, n: 24 })], cover: cover(), ok: t('dlg.delete'), danger: true })],
    ['prompt', () => notice.promptDialog({ title: t('dlg.src_edit_title'), body: t('dlg.src_body'), detail: 'Harbor Lights', cover: cover(), value: 'Harbor Lights 1042', placeholder: t('dlg.src_ph'), ok: t('common.save') })],
    ['choice', () => notice.choiceDialog({ title: t('dlg.export_title'), detail: ['Harbor Lights'],
      choices: [{ value: 'zip', label: t('set.lib_export_zip'), detail: t('dlg.export_zip_desc') }, { value: 'cbz', label: t('set.lib_export_cbz'), detail: t('dlg.export_cbz_desc') }],
      checks: [{ name: 'translations', label: t('set.lib_export_tr'), checked: false }, { name: 'remember', label: t('dlg.export_remember'), checked: false }], ok: t('dlg.export_ok') })],
    ['progress', () => { const p = notice.showProgress({ title: t('maint.title'), body: t('maint.body') }); p.update(14, 36, t('maint.progress', { done: 14, total: 36 })); held(p); }],
    ['operation', () => { const op = notice.showOperation({ title: t('bk.making_title'), body: t('bk.making_body'), stopLabel: t('common.cancel'), onStop() {} }); op.update({ done: 14, total: 42, lines: ['14 / 42', 'Panorama Sketchbook'] }); held(op); }],
  ];
  return (
    <Section id="notice" title="Notices (notice.js through the notice host)">
      <Shape id="notice-calls" name="Each function, called" used="Every page and the modules behind them: the same functions and promises; what draws them is the notice host.">
        <div className="flex flex-wrap gap-[8px]">
          {calls.map(([name, call]) => (
            <Button key={name} data-notice-call={name} onClick={async () => { setSaid('…'); show(await call()); }}>{name}</Button>
          ))}
        </div>
        <div className="flex flex-wrap gap-[8px]">
          {asCaptured.map(([name, call]) => (
            <Button key={name} size="sm" onClick={() => { void call(); }} {...tag('notice-host', name, 'rest')}>{name} (as captured)</Button>
          ))}
        </div>
        <output data-notice-answer className="text-11 text-muted-foreground">{said}</output>
      </Shape>
      <Shape id="notice-over-dialog" name="A notice over a page's dialog" used="Settings' advanced options: Reset asks first, over the dialog.">
        <div><Dialog>
          <DialogTrigger render={<Button data-notice-open="dialog" />}>{t('tm.title')}</DialogTrigger>
          <DialogContent size="2xl" layout="sectioned" data-notice-page-dialog="">
            <DialogHeader><DialogTitle>{t('tm.title')}</DialogTitle><DialogClose /></DialogHeader>
            <DialogBody><p className="text-11 text-muted-foreground">{t('set.bk_pick')}</p></DialogBody>
            <DialogFooter className="justify-start">
              <Button data-notice-call="over" onClick={async () => show(await notice.confirmDialog({ title: t('dlg.trreset_title'), body: t('dlg.trreset_body'), ok: t('common.reset'), danger: true }))}>{t('common.reset')}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog></div>
      </Shape>
    </Section>
  );
}
