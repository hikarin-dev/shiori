// DragHandle's specimens: at a chapter row's left edge, at rest, under the pointer, and while its row
// is dragged.
import { DragHandle } from '@/components/ui/drag-handle';
import { Card } from '@/components/ui/card';
import { useT } from '@/lib/i18n';
import { Line, Section, Shape, tag } from './specimen';

export function DragHandleSpecimens() {
  const t = useT();
  return (
    <Section id="drag-handle" title="DragHandle">
      <Shape id="ch-grip" name="Row drag grip" used="The overview's chapter rows: drags a row to another place in the list.">
        <Line label="grip" states={['rest', 'hover', 'on']} render={(state) => (
          <Card variant="row" hover data-dragging={state === 'on' ? '' : undefined} className="relative flex h-[64.9px] w-[320px] items-center pl-[40px] text-13">
            <DragHandle data-tip={t('ov.drag_reorder')} {...tag('ch-grip', 'grip', state)} />
            1
          </Card>)} />
      </Shape>
    </Section>
  );
}
