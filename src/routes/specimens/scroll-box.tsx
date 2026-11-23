// ScrollBox's specimen: a box of more lines than it holds, at a dialog body's width.
import { Line, Section, Shape, tag } from './specimen';

const LINES = Array.from({ length: 24 }, (_, i) => `Line ${i + 1}`);

export function ScrollBoxSpecimens() {
  return (
    <Section id="scroll-box" title="ScrollBox">
      <Shape id="scroll" name="Scrolling areas" used="Dialogs' bodies, lists, panels: a class (scroll-box), the bar the browser's (thin) or scrollbar.js's when Settings → Experimental draws them.">
        <Line label="scroll-box" states={['rest']} render={(state) => (
          <div className="scroll-box h-[160px] w-[394px] rounded-8 border border-solid border-border bg-background px-[11px] py-[9px] text-12" {...tag('scroll', 'box', state)}>
            {LINES.map((l) => <p key={l}>{l}</p>)}
          </div>)} />
      </Shape>
    </Section>
  );
}
