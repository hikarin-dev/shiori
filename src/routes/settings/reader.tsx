// Settings → Reader: the reader's switches and how a translated page is drawn, then Study Mode: a
// preview of a bubble in the original and its translation, each drawn as the choices below it say
// (as an image, or as text in its font, with furigana), and those choices. Each saved as it changes,
// said so for 2.5 s in the study section's status line (1.3's one line for the panel).
//
// The preview is drawn as 1.3's (settings.css: a paper ground with a dot screen, the two bubbles with
// an arrow between, one under the other in a panel of 480px or less, the controls in one column at
// 560px or less). §5.3 A5: a bubble drawn as an image is drawn in the face it names, loaded first
// (1.3 drew it before any face had come, in each browser's own fallback). F24: the text options' radius
// 7 → 8. The text options are dimmed while the original shows as an image, at once (1.3 faded them,
// an opacity over text: rule 11).
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Image as ImageIcon, Type } from 'lucide-react';
import { cardVariants, Card } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { SettingRow } from '@/components/ui/setting-row';
import { Switch } from '@/components/ui/switch';
import { Eyebrow } from '@/components/ui/text';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useT } from '@/lib/i18n';
import { addStudyFonts } from '@/lib/study-fonts';
import { cn } from '@/lib/utils';
import { PrefSwitch } from './library';
import { Section, SectionStatus, usePref, useStatus } from './parts';


// The faces the bubbles drawn as images are drawn in.
const RASTER_FONT = { original: '700 15px "Yasashisa Antique", serif', translation: '400 14px "CC Victory Speech", "Comic Sans MS", sans-serif' };
const SAMPLE = { original: '頑張って！', translation: 'Good Luck!' };

function drawRaster(canvas: HTMLCanvasElement | null, which: 'original' | 'translation') {
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#111';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = RASTER_FONT[which];
  ctx.fillText(SAMPLE[which], canvas.width / 2, canvas.height / 2);
}

const BUBBLE_PATH = 'M120 10C182 10 225 34 225 65c0 19-18 36-47 47l23 15-13-23c-19 11-43 17-68 17-62 0-105-23-105-56S58 10 120 10Z';

function Bubble({ children }: { children: ReactNode }) {
  return (
    <div className={cn('study-preview-bubble relative grid aspect-[240/135] w-[min(100%,240px)] min-w-0 place-items-center px-[30px] pt-[20px] pb-[28px] text-center text-[#111]',
      '@max-[480.02px]/settings-panel:w-[min(100%,210px)] @max-[480.02px]/settings-panel:px-[22px] @max-[480.02px]/settings-panel:pt-[16px] @max-[480.02px]/settings-panel:pb-[24px]')}>
      <svg className="study-bubble-shape pointer-events-none absolute inset-0 size-full fill-[#fff] stroke-[#171719] stroke-2" viewBox="0 0 240 135" aria-hidden="true">
        <path d={BUBBLE_PATH} vectorEffect="non-scaling-stroke" />
      </svg>
      {children}
    </div>
  );
}

const SIDE = cn('study-preview-side flex min-h-[140px] min-w-0 items-center justify-center p-[6px]', '@max-[480.02px]/settings-panel:min-h-[110px] @max-[480.02px]/settings-panel:p-0');
const RASTER = 'study-raster-text pointer-events-none relative z-[1] block h-auto w-[min(100%,170px)] select-none [image-rendering:pixelated]';
const DOM_TEXT = 'study-dom-text relative z-[1] inline max-w-full cursor-text select-text';

function StudyPreview({ original, translation, font, furigana }: { original: string; translation: string; font: string; furigana: boolean }) {
  const originalCanvas = useRef<HTMLCanvasElement>(null);
  const translationCanvas = useRef<HTMLCanvasElement>(null);
  // Drawn once their faces have come (or failed to), and again when shown again as an image.
  useEffect(() => {
    let live = true;
    addStudyFonts();
    Promise.all([document.fonts.load(RASTER_FONT.original, SAMPLE.original), document.fonts.load(RASTER_FONT.translation, SAMPLE.translation)])
      .catch(() => {})
      .then(() => {
        if (!live) return;
        drawRaster(originalCanvas.current, 'original');
        drawRaster(translationCanvas.current, 'translation');
      });
    return () => { live = false; };
  }, [original, translation]);
  return (
    <div id="studyPreview" data-original={original} data-translation={translation} data-font={font} data-furigana={furigana ? 'on' : 'off'}
      className={cn('study-preview grid min-h-[184px] w-full min-w-0 grid-cols-[minmax(0,1fr)_36px_minmax(0,1fr)] items-center overflow-hidden rounded-8 border border-solid border-input p-[18px]',
        '@max-[480.02px]/settings-panel:min-h-0 @max-[480.02px]/settings-panel:grid-cols-[minmax(0,1fr)] @max-[480.02px]/settings-panel:gap-[2px] @max-[480.02px]/settings-panel:p-[11px]')}
      style={{ background: 'linear-gradient(rgba(249, 248, 244, .96), rgba(232, 229, 220, .96)), radial-gradient(circle, rgba(0, 0, 0, .16) 0 1px, transparent 1.2px) 0 0 / 8px 8px' }}>
      <div className={cn(SIDE, 'study-preview-original')}>
        <Bubble>
          {original === 'image'
            ? <canvas ref={originalCanvas} className={RASTER} data-raster="original" width="136" height="40" aria-hidden="true" />
            : (
              <span className={cn(DOM_TEXT, 'study-dom-original [&_rt]:text-[8px] [&_rt]:leading-none', !furigana && '[&_rt]:hidden')}
                style={{ font: `18px/1.5 ${font === 'kiwi' ? "'Kiwi Maru'" : "'Yasashisa Antique'"}, sans-serif` }}>
                <ruby>頑<rt>がん</rt></ruby><ruby>張<rt>ば</rt></ruby>って！
              </span>
            )}
        </Bubble>
      </div>
      <svg className={cn('study-preview-arrow w-[27px] justify-self-center fill-none stroke-[#71717a] stroke-[1.8] [stroke-linecap:round] [stroke-linejoin:round]', '@max-[480.02px]/settings-panel:w-[22px] @max-[480.02px]/settings-panel:rotate-90')} viewBox="0 0 40 24" aria-hidden="true">
        <path d="M3 12h30M25 4l8 8-8 8" />
      </svg>
      <div className={cn(SIDE, 'study-preview-translation')}>
        <Bubble>
          {translation === 'hardcoded_images'
            ? <canvas ref={translationCanvas} className={RASTER} data-raster="translation" width="136" height="40" aria-hidden="true" />
            : <span className={cn(DOM_TEXT, 'study-dom-translation')} style={{ font: "15px/1.15 'CC Victory Speech', 'Comic Sans MS', sans-serif" }}>Good Luck!</span>}
        </Bubble>
      </div>
    </div>
  );
}

// An image-or-text choice of the study controls, its two halves an icon and a name.
function ImageOrText({ id, value, image, onChange, labelledBy }: { id: string; value: string; image: string; onChange: (value: string) => void; labelledBy: string }) {
  const t = useT();
  return (
    <ToggleGroup id={id} data-value={value} aria-labelledby={labelledBy} value={value} onValueChange={onChange} className="icon-choice">
      <ToggleGroupItem value={image}><ImageIcon aria-hidden strokeWidth={1.8} /><span>{t('set.image')}</span></ToggleGroupItem>
      <ToggleGroupItem value="text"><Type aria-hidden strokeWidth={1.8} /><span>{t('set.text')}</span></ToggleGroupItem>
    </ToggleGroup>
  );
}

const FONTS = [{ value: 'yasashisa', label: 'やさしさアンチック' }, { value: 'kiwi', label: 'Kiwi Maru' }];

export function ReaderPanel() {
  const t = useT();
  const ids = useId();
  const [status, show] = useStatus();
  const saved = () => show(t('common.saved'));
  const [display, setDisplay] = usePref<string>('readerTranslateDisplay');
  const [original, setOriginal] = usePref<string>('readerStudyOriginal');
  const [translation, setTranslation] = usePref<string>('readerStudyDisplay');
  const [font, setFont] = usePref<string>('readerStudySrcFont');
  const [furigana, setFurigana] = usePref<boolean>('readerFurigana');
  const asText = original === 'text';
  const change = <T,>(set: (value: T) => void) => (value: T) => { set(value); saved(); };
  return (
    <>
      <Section title={t('set.nav_reader')}>
        <PrefSwitch pref="readerSkipOverview" label={t('set.skip_overview')} description={t('set.skip_overview_desc')} saved={saved} />
        <PrefSwitch pref="readerStripMode" label={t('set.strip_flow')} description={t('set.strip_flow_desc')} saved={saved} />
        <PrefSwitch pref="readerChapterDivider" label={t('set.ch_divider')} description={t('set.ch_divider_desc')} saved={saved} />
        <SettingRow label={t('set.tr_display')} description={t('set.tr_display_desc')} control={(
          <ToggleGroup id="readerTranslateDisplay" data-value={display} value={display} onValueChange={change(setDisplay)} className="choice-toggle">
            <ToggleGroupItem value="image">{t('set.image')}</ToggleGroupItem>
            <ToggleGroupItem value="text">{t('set.text')}</ToggleGroupItem>
          </ToggleGroup>
        )} />
      </Section>
      <Section title={t('set.study')}>
        <div className={cn('study-section-body flex w-full min-w-0 flex-col gap-[18px] p-[20px]', '@max-[480.02px]/settings-panel:p-[14px]')}>
          <StudyPreview original={original} translation={translation} font={font} furigana={furigana} />
          <div className={cn('study-control-grid grid min-w-0 grid-cols-2 gap-[14px]', '@max-[560.02px]/settings-panel:grid-cols-1')}>
            <Card variant="inset" className="study-control-group p-[14px]">
              <div id={`${ids}-original`} className="mb-[10px] text-11 font-bold text-foreground">{t('set.original')}</div>
              <ImageOrText id="readerStudyOriginal" value={original} image="image" onChange={change(setOriginal)} labelledBy={`${ids}-original`} />
              <fieldset id="studyTextOptions" disabled={!asText} aria-disabled={!asText}
                className={cn(cardVariants({ variant: 'inset' }), 'study-original-options mt-[13px] grid w-full gap-[13px] px-[12px] pt-[11px] pb-[12px]', !asText && 'opacity-[.42]')}>
                <Eyebrow as="legend" className="px-[5px]">{t('set.text_options')}</Eyebrow>
                <div className="grid min-w-0 gap-[6px] text-10 text-muted-foreground">
                  <span id={`${ids}-font`}>{t('set.font')}</span>
                  <Select id="readerStudySrcFont" data-value={font} aria-labelledby={`${ids}-font`} options={FONTS} value={font} onValueChange={change(setFont)} disabled={!asText} />
                </div>
                <div className="flex min-w-0 items-center justify-between gap-[14px] text-10 text-muted-foreground">
                  <span id={`${ids}-furigana`}>{t('set.study_furi')}</span>
                  {/* Dimmed with its options, not again on its own. */}
                  <Switch id="readerFurigana" aria-labelledby={`${ids}-furigana`} checked={furigana} onCheckedChange={change(setFurigana)} disabled={!asText} className="data-disabled:opacity-100" />
                </div>
              </fieldset>
            </Card>
            <Card variant="inset" className="study-control-group p-[14px]">
              <div id={`${ids}-translation`} className="mb-[10px] text-11 font-bold text-foreground">{t('set.translation_short')}</div>
              <ImageOrText id="readerStudyDisplay" value={translation} image="hardcoded_images" onChange={change(setTranslation)} labelledBy={`${ids}-translation`} />
            </Card>
          </div>
          <SectionStatus id="readerStatus" status={status} />
        </div>
      </Section>
    </>
  );
}
