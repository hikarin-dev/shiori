// The library's filter (app/library.html's #filterModal): rating and category, each option any → show
// only → hide as it is pressed (TriStateToggle), applied and kept as it is pressed; Clear and Close;
// Escape or a press beside it closes it, and focus goes back to the toolbar's button. A dialog of the
// app's (Dialog, xl 620: §5.3 F26–F28, S10, S16), its contents 1.3's: the hint, the legend, the two
// sections (four options a row, two at 560px or less).
import { TAG_VALUES } from '@lib/tag-editor.js';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Eyebrow } from '@/components/ui/text';
import { TriStateMark, TriStateToggle } from '@/components/ui/tri-state-toggle';
import type { Translate } from '@/lib/i18n';
import { FILTER_TYPES, type FilterType, type LibFilter } from '@/lib/library-search';

const VALUES = TAG_VALUES as unknown as Record<FilterType, string[]>;
const SECTION: Record<FilterType, { id: string; label: string }> = {
  rating: { id: 'filterRating', label: 'filter.rating' },
  category: { id: 'filterCategory', label: 'filter.category' },
};

type Props = {
  t: Translate;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filter: LibFilter;
  onStep: (type: FilterType, value: string) => void;
  onClear: () => void;
};

export function FilterDialog({ t, open, onOpenChange, filter, onStep, onClear }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent id="filterModal" size="xl" className="filter-box show" aria-labelledby="filterTitle">
        <DialogHeader><DialogTitle id="filterTitle">{t('filter.title')}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-[14px]">
          <p className="filter-hint text-11 leading-[1.5] text-muted-foreground">{t('filter.hint')}</p>
          <div className="filter-legend flex gap-[16px] text-11 text-muted-foreground" aria-hidden>
            <span className="inline-flex items-center gap-[6px]"><TriStateMark state="include" />{t('filter.include')}</span>
            <span className="inline-flex items-center gap-[6px]"><TriStateMark state="exclude" />{t('filter.exclude')}</span>
          </div>
          {FILTER_TYPES.map((type) => (
            <div key={type} className="filter-section flex flex-col gap-[8px] border-0 border-t border-solid border-border pt-[12px]">
              <Eyebrow className="mt-[4px]">{t(SECTION[type].label)}</Eyebrow>
              <div id={SECTION[type].id} className="filter-options grid grid-cols-4 gap-[6px] [@media(max-width:560px)]:grid-cols-2">
                {VALUES[type].map((value) => (
                  <TriStateToggle key={value} className="fopt" data-type={type} data-value={value} label={value}
                    value={filter[type][value] ?? 'off'} onValueChange={() => onStep(type, value)} />
                ))}
              </div>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button id="filterClear" onClick={onClear}>{t('filter.clear')}</Button>
          <Button id="filterClose" variant="primary" onClick={() => onOpenChange(false)}>{t('common.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
