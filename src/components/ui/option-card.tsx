// OptionCard — one answer of a few, as a framed card with a title and an optional line under it.
//
//   OptionCard        a button: choosing it is the answer (the ask dialog's choices: the desktop
//                     app's gates, moving a library, the storage upgrade; Settings' backup choice);
//   OptionCardRadio   a radio in a card, inside a RadioGroup (the export format): the whole card is
//                     the target, the arrow keys move the choice, the chosen card framed in the brand
//                     colour.
// Both: no ground, the strong frame, radius 8; the brand colour's frame under the pointer; the title
// 13px bold, the line under it 11.5px muted, on the dialogs' 1.55 line.
//
// §5.3 F17: one card. The cards' radius 9 → 8; the backup choices lose their ground and hover ground,
// frame in the brand colour (not the ring colour) and take a 13px bold title for their 11px semibold
// line. One size, as Settings' and the dialogs' are (the owner): 12px 14px for 11px 14px (ask),
// 10px 14px (the export format) and 12px 14px with a 52px minimum (backup).
import type { ComponentProps, ReactNode } from 'react';
import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { RadioGroupItem } from './radio-group';
import { cn } from '@/lib/utils';

const CARD = 'w-full min-w-0 cursor-pointer rounded-8 border border-solid border-input bg-transparent px-[14px] py-[12px] text-left leading-[1.55] text-foreground [overflow-wrap:anywhere] hover:border-primary';

function Text({ title, detail }: { title: ReactNode; detail?: ReactNode }) {
  return (
    <>
      <strong data-slot="option-title" className="block text-13 font-bold">{title}</strong>
      {detail != null && <span data-slot="option-detail" className="mt-[2px] block text-11.5 text-muted-foreground">{detail}</span>}
    </>
  );
}

type CardProps = Omit<ButtonPrimitive.Props, 'title' | 'children'> & { title: ReactNode; detail?: ReactNode };

function OptionCard({ title, detail, className, ...props }: CardProps) {
  return (
    <ButtonPrimitive data-slot="option-card" className={cn(CARD, 'block', typeof className === 'string' ? className : undefined)} {...props}>
      <Text title={title} detail={detail} />
    </ButtonPrimitive>
  );
}

type RadioProps = Omit<ComponentProps<'label'>, 'title' | 'children'> & { value: string; title: ReactNode; detail?: ReactNode; disabled?: boolean };

function OptionCardRadio({ value, title, detail, disabled, className, ...props }: RadioProps) {
  return (
    <label data-slot="option-card" className={cn(CARD, 'flex items-start gap-[10px] has-data-checked:border-primary', className)} {...props}>
      <RadioGroupItem value={value} disabled={disabled} className="mt-[2px]" />
      <span className="min-w-0"><Text title={title} detail={detail} /></span>
    </label>
  );
}

export { OptionCard, OptionCardRadio };
