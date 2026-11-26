// The library's parts of the common header (1.3's, app/library.html): after the brand, the page menu, the
// search and the pin; at the right the menu button, the three totals (galleries, images, stored, each
// with its tip), Import, Safe Mode and Settings. Drawn on 1.3's sizes (library.css): wider than 1400px
// the totals sit in the bar and Import shows its word; at 1400px or less the totals fold behind the
// menu button, shown under the bar's right end while it is open, and Import is its icon alone, 28
// square. The totals and the menu button go when Settings turns the totals off.
//
// Import opens the page's file picker (onImport). The pin makes the header stay at the window's top or
// scroll away with the page (onPin), Safe Mode blurs and scrambles the cards (onSafe): both are the
// page's, which keeps them. The menu button opens and closes its list of totals (1.3's #collapsibleGroup
// and its class `open`); a press anywhere else closes it, as 1.3's did (not Escape: 1.3 had no key for
// it), and it is closed again whenever the page shows.
import { useEffect, useState, type SVGProps } from 'react';
import { Menu, Settings, Upload } from 'lucide-react';
import { useNavigate } from 'react-router';
import { TIERS, describePage } from '@lib/page-size.js';
import { formatBytes, formatCount } from '@lib/format.js';
import { getLang } from '@lib/i18n.js';
import { HeaderSlot } from '@/components/header-slot';
import { Button } from '@/components/ui/button';
import { PageMenu } from '@/components/ui/page-menu';
import { SearchField } from '@/components/ui/search-field';
import { Stat } from '@/components/ui/stat';
import type { Translate } from '@/lib/i18n';
import { goTo } from '@/lib/links';
import { cn } from '@/lib/utils';
import type { Totals } from './data';

// "Original pages X" over "Other data Y": a size not worked out again yet is all original.
export function sizeSplit(t: Translate, total: number | undefined, original: number | undefined) {
  const orig = original ?? total ?? 0;
  return t('lib.size_split', { orig: formatBytes(orig), rest: formatBytes(Math.max(0, (total || 0) - orig)) });
}

// The Images total's tip: its images tallied by resolution tier, every tier listed. A gallery's pages
// count in the tier of its typical (median) page; ones not sized yet are tallied apart. (1.3's
// _tierTally.)
type Tier = { id: string; max: number };
export function tierTally(t: Translate, stats: Totals['stats']) {
  const tiers = TIERS as unknown as Tier[];
  const byTier = new Map(tiers.map((tier) => [tier.id, 0]));
  let unsized = 0;
  for (const g of Object.values(stats.galleries)) {
    if (!g.count) continue;
    const tier = (describePage(g.medianPage as never) as { tier?: string } | null)?.tier;
    if (tier) byTier.set(tier, byTier.get(tier)! + g.count); else unsized += g.count;
  }
  const mp = (n: number) => n.toLocaleString(getLang(), { maximumFractionDigits: 1 });
  const range = (i: number) => (i === 0 ? `< ${mp(tiers[0].max)} MP`
    : tiers[i].max === Infinity ? `≥ ${mp(tiers[i - 1].max)} MP` : `${mp(tiers[i - 1].max)}–${mp(tiers[i].max)} MP`);
  const rows: [string, number][] = tiers.map((tier, i) => [`${tier.id}\v${range(i)}`, byTier.get(tier.id)!]);
  if (unsized) rows.push([t('lib.tier_unsized'), unsized]);
  const pct = (n: number) => {
    const p = stats.totalImages ? n / stats.totalImages * 100 : 0;
    return n && p < 1 ? '<1%' : `${Math.round(p)}%`;
  };
  // Percentages padded to one width with figure spaces (digit-wide, never collapsed), so the
  // right-aligned values keep their "·" in one column.
  const width = Math.max(...rows.map(([, n]) => pct(n).length));
  return [t('lib.images_by_tier'), ...rows.map(([label, n]) => `${label}\t${formatCount(n)} · ${pct(n).padStart(width, ' ')}`)].join('\n');
}

// 1.3's widths: the totals and Import's word in the bar above 1400px; the menu button at 1400px or
// less (written out whole: the stylesheet is made from the classes it finds).
const WIDE_ONLY = '[@media(max-width:1400px)]:hidden';
const NARROW_ONLY = 'hidden [@media(max-width:1400px)]:flex';
// The totals folded (1.3's .collapsible-group at 1400px or less): not shown until the menu button opens
// them, then one row of the same boxes under the bar's right end, as wide as they are, over the page;
// 12px in from the window's edge on a phone (600px or less), 2px higher.
const FOLDED = cn(
  '[@media(max-width:1400px)]:fixed [@media(max-width:1400px)]:top-[54px] [@media(max-width:1400px)]:right-[20px] [@media(max-width:1400px)]:z-[200]',
  '[@media(max-width:1400px)]:not-[.open]:hidden [@media(max-width:1400px)]:items-stretch',
  '[@media(max-width:1400px)]:w-max [@media(max-width:1400px)]:max-w-[calc(100vw-40px)]',
  '[@media(max-width:1400px)]:rounded-8 [@media(max-width:1400px)]:border [@media(max-width:1400px)]:border-solid [@media(max-width:1400px)]:border-border [@media(max-width:1400px)]:bg-card',
  '[@media(max-width:1400px)]:p-[12px] [@media(max-width:1400px)]:[box-shadow:0_6px_24px_rgba(0,0,0,0.5)]',
  '[@media(max-width:600px)]:top-[52px] [@media(max-width:600px)]:right-[12px] [@media(max-width:600px)]:max-w-[calc(100vw-24px)]',
);

// 1.3's own drawings (Lucide's of its time; the Lucide this app bundles draws them otherwise).
function Icon({ size, children, ...props }: SVGProps<SVGSVGElement> & { size: number }) {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{children}</svg>;
}
const PinIcon = () => <Icon size={14} className="size-[14px]"><line x1="12" y1="17" x2="12" y2="22" /><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" /></Icon>;
const UnpinIcon = () => <Icon size={14} className="size-[14px]"><line x1="2" y1="2" x2="22" y2="22" /><line x1="12" y1="17" x2="12" y2="22" /><path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h12" /><path d="M15 9.34V6h1a2 2 0 0 0 0-4H7.89" /></Icon>;
const EyeIcon = () => <Icon size={15}><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></Icon>;
const EyeOffIcon = () => <Icon size={15}><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></Icon>;

type Props = {
  t: Translate;
  query: string;
  onQueryChange: (query: string, how: 'typed' | 'cleared' | 'set') => void;
  totals: Totals | undefined;
  showTotals: boolean;
  onImport: () => void;
  pinned: boolean;
  onPin: () => void;
  safe: boolean;
  onSafe: () => void;
};

export function LibraryHeader({ t, query, onQueryChange, totals, showTotals, onImport, pinned, onPin, safe, onSafe }: Props) {
  const navigate = useNavigate();
  const avg = totals && totals.stats.totalImages > 0 ? Math.round(totals.stats.totalSize / totals.stats.totalImages) : 0;
  // The folded totals' list: closed by a press anywhere but on it and its button (1.3's listener on the
  // document's clicks).
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const at = e.target as Element | null;
      if (!at?.closest?.('#collapsibleGroup, #burgerBtn')) setOpen(false);
    };
    document.addEventListener('click', away);
    return () => document.removeEventListener('click', away);
  }, [open]);
  const pinTip = t(pinned ? 'nav.unpin' : 'nav.pin');
  const safeTip = t(safe ? 'nav.safe_off' : 'nav.safe_on');
  return (
    <>
      <HeaderSlot side="left">
        <span className="brand-sep">/</span>
        <PageMenu page="library" />
        <SearchField placeholder={t('lib.search_ph')} clearLabel={t('lib.clear_search')} query={query} onQueryChange={onQueryChange} />
        <Button id="pinBtn" variant="ghost" size="icon" coarse="40" className="btn-pin" aria-label={pinTip} data-tip={pinTip} onClick={onPin}>
          {pinned ? <PinIcon /> : <UnpinIcon />}
        </Button>
      </HeaderSlot>
      <HeaderSlot side="right">
        {showTotals && (
          <Button id="burgerBtn" variant="ghost" size="icon" coarse="40" className={cn('burger-btn', NARROW_ONLY)} aria-label={t('nav.menu')} data-tip={t('nav.menu')}
            onClick={() => setOpen((was) => !was)}>
            <Menu className="size-[16px]" />
          </Button>
        )}
        {showTotals && (
          <div id="collapsibleGroup" className={cn('collapsible-group flex shrink-0 items-center gap-[8px]', FOLDED, open && 'open')}>
            <Stat value={totals ? formatCount(totals.topLevel) : '—'} valueId="hTotalGalleries" label={t('stat.galleries')} className="hstat" />
            <Stat id="hImagesStat" value={totals ? formatCount(totals.stats.totalImages) : '—'} valueId="hTotalImages" label={t('stat.images')} className="hstat"
              data-tip={totals ? tierTally(t, totals.stats) : ''} />
            <Stat id="hSizeStat" value={totals ? formatBytes(totals.stats.totalSize) : '—'} valueId="hTotalSize" label={t('stat.stored')} className="hstat"
              data-tip={totals ? sizeSplit(t, totals.stats.totalSize, totals.stats.totalOrig) : ''}
              data-tip-shift={avg > 0 ? t('lib.avg_per_image', { size: formatBytes(avg) }) : ''} />
          </div>
        )}
        {/* Import keeps its place at every width: its word wider than 1400px, its icon alone at 1400px or
            less (28 square, 15px icon; 40 under a finger). Its frame stays the second accent there: 1.3's
            narrow rule asked for the plain frame, but its base rule came after it and won. */}
        <Button id="uploadCbzBtn" variant="tint" tone="warning" rest="filled" size="compact" coarse="40" aria-label={t('nav.import')} data-tip={t('nav.import')}
          className={cn('btn-upload gap-[5px]',
            '[@media(max-width:1400px)]:w-[28px] [@media(max-width:1400px)]:gap-0 [@media(max-width:1400px)]:px-0',
            '[@media(pointer:coarse)_and_(max-width:1400px)]:size-[40px]')} onClick={onImport}>
          <Upload className="btn-upload-icon size-[13px] [@media(max-width:1400px)]:size-[15px]" />
          <span className={cn('btn-upload-label', WIDE_ONLY)}>{t('nav.import')}</span>
        </Button>
        {/* Safe Mode: on, its eye in the colour of success on its tint (aria-pressed: kept under the
            pointer, rule 27); no frame, as the header's other buttons (§5.3 F60). */}
        <Button id="safeBtn" variant="ghost" pressedTone="success" size="icon" coarse="40" className={cn('btn-safe', safe && 'active')}
          aria-pressed={safe} aria-label={safeTip} data-tip={safeTip} onClick={onSafe}>
          {safe ? <EyeOffIcon /> : <EyeIcon />}
        </Button>
        <Button id="settingsBtn" variant="ghost" size="icon" coarse="40" className="btn-settings" aria-label={t('nav.settings')} data-tip={t('nav.settings')}
          onClick={() => goTo(navigate, 'settings')}>
          <Settings className="size-[16px]" />
        </Button>
      </HeaderSlot>
    </>
  );
}
