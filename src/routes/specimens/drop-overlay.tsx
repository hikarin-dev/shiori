// DropOverlay's specimens: drawn still inside a box the shape of a window, and the real one over this
// window while the button is held down (it lets the pointer through, so the button's release still
// lands). Its words here are 1.3's, as its stylesheet wrote them; the page gives its own.
import { useState } from 'react';
import { DropOverlay } from '@/components/ui/drop-overlay';
import { Button } from '@/components/ui/button';
import { Line, Section, Shape, tag } from './specimen';

export function DropOverlaySpecimens() {
  const [held, setHeld] = useState(false);
  return (
    <Section id="drop-overlay" title="DropOverlay">
      <Shape id="drop-overlay" name="File drop overlay" used="Library (and the overview's add bar): over the window while files are dragged over it.">
        <Line label="still" states={['rest']} render={(state) => (
          <div className="relative h-[200px] w-[360px] bg-background">
            <DropOverlay still {...tag('drop-overlay', 'still', state)}>Drop to import</DropOverlay>
          </div>
        )} />
        <Line label="over the window" states={['on']} render={(state) => (
          <>
            <Button size="sm" variant="outline" data-drop-demo onPointerDown={() => setHeld(true)} onPointerUp={() => setHeld(false)} onPointerLeave={() => setHeld(false)}>Hold to show</Button>
            <DropOverlay shown={held} {...tag('drop-overlay', 'window', state)}>Drop to import</DropOverlay>
          </>
        )} />
      </Shape>
    </Section>
  );
}
