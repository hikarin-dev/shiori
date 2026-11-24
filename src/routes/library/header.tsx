// The library's parts of the common header (app/library.html's): after the brand, the page menu, the
// search and the pin; at the right the menu button, the three totals (galleries, images, stored, each
// with its tip), Import, Safe Mode and Settings. Drawn on 1.3's sizes (library.css): wider than 1400px
// the totals sit in the bar and Import shows its word; at 1400px or less the totals fold behind the
// menu button and Import is its icon alone, 28 square. The totals and the menu button go when
// Settings turns the totals off.
//
// The menu button's list, the pin, Import and Safe Mode are drawn in their place and do nothing yet
// (they come with the page's later steps).
import { Eye, Menu, Pin, Settings, Upload } from 'lucide-react';
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

type Props = {
  t: Translate;
  query: string;
  onQueryChange: (query: string, how: 'typed' | 'cleared' | 'set') => void;
  totals: Totals | undefined;
  showTotals: boolean;
};

export function LibraryHeader({ t, query, onQueryChange, totals, showTotals }: Props) {
  const navigate = useNavigate();
  const avg = totals && totals.stats.totalImages > 0 ? Math.round(totals.stats.totalSize / totals.stats.totalImages) : 0;
  return (
    <>
      <HeaderSlot side="left">
        <span className="brand-sep">/</span>
        <PageMenu page="library" />
        <SearchField placeholder={t('lib.search_ph')} clearLabel={t('lib.clear_search')} query={query} onQueryChange={onQueryChange} />
        <Button id="pinBtn" variant="quiet" tone="warning" size="icon" coarse="40" className="btn-pin" aria-label={t('nav.unpin')} data-tip={t('nav.unpin')}>
          <Pin className="size-[14px]" />
        </Button>
      </HeaderSlot>
      <HeaderSlot side="right">
        {showTotals && (
          <Button id="burgerBtn" variant="quiet" size="icon" coarse="40" className={cn('burger-btn', NARROW_ONLY)} aria-label={t('nav.menu')} data-tip={t('nav.menu')}>
            <Menu className="size-[16px]" />
          </Button>
        )}
        {showTotals && (
          <div id="collapsibleGroup" className={cn('collapsible-group flex shrink-0 items-center gap-[8px]', WIDE_ONLY)}>
            <Stat value={totals ? formatCount(totals.topLevel) : '—'} valueId="hTotalGalleries" label={t('stat.galleries')} className="hstat" />
            <Stat id="hImagesStat" value={totals ? formatCount(totals.stats.totalImages) : '—'} valueId="hTotalImages" label={t('stat.images')} className="hstat"
              data-tip={totals ? tierTally(t, totals.stats) : ''} />
            <Stat id="hSizeStat" value={totals ? formatBytes(totals.stats.totalSize) : '—'} valueId="hTotalSize" label={t('stat.stored')} className="hstat"
              data-tip={totals ? sizeSplit(t, totals.stats.totalSize, totals.stats.totalOrig) : ''}
              data-tip-shift={avg > 0 ? t('lib.avg_per_image', { size: formatBytes(avg) }) : ''} />
          </div>
        )}
        {/* Import keeps its place at every width: its word wider than 1400px, its icon alone at 1400px or
            less (28 square on the plain frame, 15px icon; 40 under a finger). */}
        <Button id="uploadCbzBtn" variant="tint" tone="warning" size="compact" coarse="40" aria-label={t('nav.import')} data-tip={t('nav.import')}
          className={cn('btn-upload gap-[5px]',
            '[@media(max-width:1400px)]:w-[28px] [@media(max-width:1400px)]:gap-0 [@media(max-width:1400px)]:border-border [@media(max-width:1400px)]:hover:border-border [@media(max-width:1400px)]:px-0',
            '[@media(pointer:coarse)_and_(max-width:1400px)]:size-[40px]')}>
          <Upload className="btn-upload-icon size-[13px] [@media(max-width:1400px)]:size-[15px]" />
          <span className={cn('btn-upload-label', WIDE_ONLY)}>{t('nav.import')}</span>
        </Button>
        <Button id="safeBtn" variant="quiet" tone="warning" pressedTone="success" size="icon" coarse="40" className="btn-safe" aria-label={t('nav.safe_on')} data-tip={t('nav.safe_on')}>
          <Eye />
        </Button>
        <Button id="settingsBtn" variant="quiet" tone="primary" size="icon" coarse="40" className="btn-settings" aria-label={t('nav.settings')} data-tip={t('nav.settings')}
          onClick={() => goTo(navigate, 'settings')}>
          <Settings className="size-[16px]" />
        </Button>
      </HeaderSlot>
    </>
  );
}
