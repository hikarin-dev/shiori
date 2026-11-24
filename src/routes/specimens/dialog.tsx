// Dialog's specimens: each of the nine dialog shapes of the design inventory drawn in place, still
// (no backdrop, nothing trapped), at its width, with stand-in contents of its kind; then a working
// one: a sectioned dialog opened by a button, which opens a second one over it.
import { useState, type ReactNode } from 'react';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Eyebrow } from '@/components/ui/text';
import { OptionCard } from '@/components/ui/option-card';
import { Input } from '@/components/ui/input';
import { useT } from '@/lib/i18n';
import { Line, Section, Shape, tag } from './specimen';

type Size = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl';
const WIDTH: Record<Size, number> = { xs: 340, sm: 440, md: 480, lg: 520, xl: 620, '2xl': 760, '3xl': 960, '4xl': 1120 };

// A dialog drawn where it stands: the box alone, still.
function Still({ shape, variant, size, layout = 'simple', children }: { shape: string; variant: string; size: Size; layout?: 'simple' | 'sectioned'; children: ReactNode }) {
  return (
    <div className="max-w-[calc(100vw-200px)] min-w-0" style={{ width: WIDTH[size] }}>
      <DialogContent still size={size} layout={layout} {...tag(shape, variant, 'rest')}>{children}</DialogContent>
    </div>
  );
}

const BODY = 'text-12.5 leading-[1.55] text-muted-foreground whitespace-pre-line';

export function DialogSpecimens() {
  const t = useT();
  return (
    <Section id="dialog" title="Dialog">
      <Shape id="notice-dialog" name="Notice: confirm, alert, prompt, choice" used="notice.js's dialogs, from every page (sm 440; simple).">
        <Line label="simple · sm" states={['rest']} render={() => (
          <Still shape="notice-dialog" variant="simple" size="sm">
            <DialogHeader><DialogTitle>{t('dlg.del_gallery_title')}</DialogTitle></DialogHeader>
            <p className={BODY}>{t('dlg.del_gallery_body')}</p>
            <DialogFooter><Button>{t('common.cancel')}</Button><Button variant="danger">{t('dlg.delete')}</Button></DialogFooter>
          </Still>)} />
      </Shape>
      <Shape id="notice-ask" name="Notice: ask, progress, operation" used="ask()'s choices, a progress window (sm 440, F27: 460 → 440), an operation (md 480).">
        <Line label="simple · sm" states={['rest']} render={() => (
          <Still shape="notice-ask" variant="simple" size="sm">
            <DialogHeader><DialogTitle>{t('gate.title')}</DialogTitle></DialogHeader>
            <p className={BODY}>{t('gate.body')}</p>
            <div className="flex flex-col gap-[8px]"><OptionCard title={t('gate.open')} detail={t('gate.open_detail')} /><OptionCard title={t('gate.browser')} detail={t('gate.browser_detail')} /></div>
          </Still>)} />
        <Line label="simple · md" states={['rest']} render={() => (
          <Still shape="notice-ask" variant="operation" size="md">
            <DialogHeader><DialogTitle>{t('set.bk_title')}</DialogTitle></DialogHeader>
            <DialogFooter><Button>{t('common.cancel')}</Button></DialogFooter>
          </Still>)} />
      </Shape>
      <Shape id="modal-box" name="Page dialog" used="The tag editor and removing a chapter (xs 340), the library filter (xl 620).">
        <Line label="simple · xs" states={['rest']} render={() => (
          <Still shape="modal-box" variant="simple" size="xs">
            <DialogHeader><DialogTitle>{t('addtag.title')}</DialogTitle></DialogHeader>
            <div className="flex flex-col gap-[8px]">
              <Eyebrow as="label">{t('addtag.value')}</Eyebrow>
              <Input variant="inset" placeholder={t('addtag.value_ph')} />
            </div>
            <DialogFooter><Button>{t('common.cancel')}</Button><Button variant="primary">{t('common.add')}</Button></DialogFooter>
          </Still>)} />
        <Line label="simple · xl" states={['rest']} render={() => (
          <Still shape="modal-box" variant="filter" size="xl">
            <DialogHeader><DialogTitle>{t('filter.title')}</DialogTitle></DialogHeader>
            <p className="text-11 leading-[1.5] text-muted-foreground">{t('filter.hint')}</p>
            <DialogFooter><Button>{t('filter.clear')}</Button><Button>{t('common.close')}</Button></DialogFooter>
          </Still>)} />
      </Shape>
      <Shape id="settings-dialog" name="Settings dialog" used="Settings: the backup choice (sm 440), About (lg 520), the advanced options (2xl 760); sectioned.">
        <Line label="sectioned · sm" states={['rest']} render={() => (
          <Still shape="settings-dialog" variant="sectioned" size="sm" layout="sectioned">
            <DialogHeader><div className="min-w-0"><DialogTitle>{t('set.bk_title')}</DialogTitle><DialogDescription>{t('set.bk_pick')}</DialogDescription></div></DialogHeader>
            <DialogBody className="flex flex-col gap-[9px]"><OptionCard title={t('set.bk_meta')} /><OptionCard title={t('set.bk_full')} /></DialogBody>
            <DialogFooter><Button>{t('common.cancel')}</Button></DialogFooter>
          </Still>)} />
        <Line label="sectioned · 2xl" states={['rest']} render={() => (
          <Still shape="settings-dialog" variant="close" size="2xl" layout="sectioned">
            <DialogHeader><DialogTitle>{t('tm.title')}</DialogTitle><DialogClose /></DialogHeader>
            <DialogBody><p className="text-11 leading-[1.5] text-muted-foreground">{t('set.bk_pick')}</p></DialogBody>
            <DialogFooter className="justify-start"><Button>{t('common.reset')}</Button></DialogFooter>
          </Still>)} />
      </Shape>
      <Shape id="reader-settings" name="Reader settings" used="The reader (md 480): a header with the tabs, the tab shown under it.">
        <Line label="sectioned · md" states={['rest']} render={() => (
          <Still shape="reader-settings" variant="sectioned" size="md" layout="sectioned">
            <DialogHeader><DialogTitle>{t('rd.reader_settings')}</DialogTitle><DialogClose /></DialogHeader>
            <DialogBody><Eyebrow as="h3" tone="dim">{t('rd.tab_reading')}</Eyebrow></DialogBody>
          </Still>)} />
      </Shape>
      <Shape id="keys" name="Keyboard shortcuts" used="The reader's ? (sm 440; F27: 420 → 440).">
        <Line label="simple · sm" states={['rest']} render={() => (
          <Still shape="keys" variant="simple" size="sm">
            <DialogHeader><DialogTitle>{t('kb.title')}</DialogTitle><DialogClose /></DialogHeader>
            <Eyebrow>{t('kb.navigation')}</Eyebrow>
            <div className="flex items-center justify-between gap-[8px] py-[5px] text-11"><span className="text-muted-foreground">{t('kb.next')}</span><Kbd>→</Kbd></div>
          </Still>)} />
      </Shape>
      <Shape id="pp-dialog" name="Page properties" used="The reader's I, or the page menu (2xl 760; F27: 780 → 760); sectioned.">
        <Line label="sectioned · 2xl" states={['rest']} render={() => (
          <Still shape="pp-dialog" variant="sectioned" size="2xl" layout="sectioned">
            <DialogHeader><div className="min-w-0"><DialogTitle>{t('page.properties')}</DialogTitle><DialogDescription>Harbor Lights</DialogDescription></div><DialogClose /></DialogHeader>
            <DialogBody><Eyebrow as="h3">{t('rd.tab_pages')}</Eyebrow></DialogBody>
          </Still>)} />
      </Shape>
      <Shape id="feedback" name="Page feedback" used="Study mode's F over a bubble (3xl 960; F29: the corner X for the text Close).">
        <Line label="simple · 3xl" states={['rest']} render={() => (
          <Still shape="feedback" variant="simple" size="3xl">
            <DialogHeader><DialogTitle>{t('feedback.title')}</DialogTitle><DialogClose /></DialogHeader>
            <p className="text-13 text-muted-foreground">{t('feedback.issues')}</p>
            <DialogFooter><Button>{t('feedback.export')}</Button><Button variant="primary">{t('feedback.save')}</Button></DialogFooter>
          </Still>)} />
      </Shape>
      <Shape id="benchmark" name="Benchmark report" used="Settings → Translation → Benchmark (4xl 1120; F28: 20 → 15px; F29: the corner X).">
        <Line label="simple · 4xl" states={['rest']} render={() => (
          <Still shape="benchmark" variant="simple" size="4xl">
            <DialogHeader><DialogTitle>Translation benchmark</DialogTitle><DialogClose /></DialogHeader>
            <p className="text-12 text-muted-foreground">…</p>
          </Still>)} />
      </Shape>
      <Shape id="dialog-open" name="Working dialog" used="Opened by its button: focus trapped and given back, Escape and the backdrop close it, the page and its scrollbar stay; a dialog over it.">
        <Line label="sectioned · 2xl" states={['rest']} render={() => <Working />} />
      </Shape>
    </Section>
  );
}

// The second dialog is not inside the first's tree, as a notice over a page's dialog is not: each has
// its own backdrop, the later one on top.
function Working() {
  const t = useT();
  const [inner, setInner] = useState(false);
  return (
    <>
      <Dialog>
        <DialogTrigger render={<Button data-specimen-open="dialog" />}>{t('tm.title')}</DialogTrigger>
        <DialogContent size="2xl" layout="sectioned" data-specimen-dialog="outer">
          <DialogHeader><DialogTitle>{t('tm.title')}</DialogTitle><DialogClose /></DialogHeader>
          <DialogBody><Input variant="field" aria-label={t('addtag.value')} placeholder={t('addtag.value_ph')} /></DialogBody>
          <DialogFooter className="justify-start">
            <Button data-specimen-open="inner" onClick={() => setInner(true)}>{t('common.reset')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={inner} onOpenChange={setInner}>
        <DialogContent size="sm" layer="notice" data-specimen-dialog="inner">
          <DialogHeader><DialogTitle>{t('dlg.trreset_title')}</DialogTitle></DialogHeader>
          <p className={BODY}>{t('dlg.trreset_body')}</p>
          <DialogFooter>
            <Button onClick={() => setInner(false)}>{t('common.cancel')}</Button>
            <Button variant="danger" onClick={() => setInner(false)}>{t('common.reset')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
