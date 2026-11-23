// Separator's specimens: the line inside a list and inside a menu, each in a frame of today's width
// and padding (the lists and menus themselves are drawn by their own components).
import { Separator } from '@/components/ui/separator';
import { Line, Section, Shape, tag } from './specimen';

const row = 'px-[8px] py-[6px] text-12 text-muted-foreground';

export function SeparatorSpecimens() {
  return (
    <Section id="separator" title="Separator">
      <Shape id="separator" name="Separators" used="Between the search suggestions' groups (a listbox: decorative); before a folder menu's Delete (a menu: a separator).">
        <Line label="in a list" states={['rest']} render={(state) => (
          // 670px less the 10px scrollbar the search list shows there.
          <div role="listbox" aria-label="Suggestions" className="w-[660px] max-w-full rounded-8 border border-solid border-input bg-popover p-[6px]">
            <div role="option" aria-selected="false" className={row}>Recent searches</div>
            <Separator decorative {...tag('separator', 'list', state)} />
            <div role="option" aria-selected="false" className={row}>Tags</div>
          </div>)} />
        <Line label="in a menu" states={['rest']} render={(state) => (
          <div role="menu" aria-label="Folder" className="w-[170px] rounded-8 border border-solid border-border bg-popover p-[5px]">
            <div role="menuitem" className="px-[9px] py-[7px] text-12">Rescan</div>
            <Separator {...tag('separator', 'menu', state)} />
            <div role="menuitem" className="px-[9px] py-[7px] text-12 text-destructive">Delete</div>
          </div>)} />
      </Shape>
    </Section>
  );
}
