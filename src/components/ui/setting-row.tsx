// SettingRow — the row Settings is made of: a setting's name and what it does on one side, its control
// on the other. Rows of one kind that follow each other are ruled apart.
//
//   kind  field   a box to type or choose in (a select, a text box, a segmented choice): the name
//                 and description in the first column, the control in a second of 190–260px,
//                 centred across both lines; a `status` (a status pill) goes under the control;
//         switch  as field, the switch at the row's end;
//         action  a button that does something now (Export…, Check…): the name and description, then
//                 the button at the row's end;
//         footer  the row of buttons under a section's rows, at its end (min 58px);
//   sub   a field that belongs with the one above it: set in by 40px (the narrow form's 15px padding
//         takes it, as 1.3's did), not ruled off from it.
// The name labels the control and the description describes it (aria-labelledby, aria-describedby).
// A field with no name keeps its control under its description on a phone (1.3 drew the select over
// the description there).
//
// The phone form follows the Settings panel's width, not the window's (container settings-panel,
// which the page names): at 560px or less a field's control goes under its words, full width (a
// switch stays at the end); at 480px or less the rows' padding is 15px (a footer's 10px 15px), and an
// action's button goes under its words, full width. (Tailwind's @max is "less than": 560.02 and
// 480.02 stand for "at most 560" and "at most 480", the next width a layout holds being + 1/64.)
import { cloneElement, isValidElement, useId, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

type Kind = 'field' | 'switch' | 'action' | 'footer';

type Props = Omit<ComponentProps<'div'>, 'children'> & {
  kind?: Kind;
  label?: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  status?: ReactNode;
  sub?: boolean;
  children?: ReactNode;
};

// A row after a row of its kind is ruled off from it (a sub field is not).
const RULE: Record<Exclude<Kind, 'footer'>, string> = {
  field: '[[data-kind=field]+&,[data-kind=switch]+&]:border-t',
  switch: '[[data-kind=field]+&,[data-kind=switch]+&]:border-t',
  action: '[[data-kind=action]+&]:border-t',
};

const NAME = 'min-w-0 text-12 leading-[1.45] font-semibold text-foreground [overflow-wrap:anywhere]';
const DESC = 'min-w-0 text-11.5 leading-[1.6] text-muted-foreground [overflow-wrap:anywhere]';

// The control, told which words name and describe it (unless it says otherwise).
function named(control: ReactNode, labelId: string | undefined, descId: string | undefined) {
  if (!isValidElement(control)) return control;
  const own = control.props as Record<string, unknown>;
  return cloneElement(control as ReactElement<Record<string, unknown>>, {
    'aria-labelledby': own['aria-labelledby'] ?? (own['aria-label'] ? undefined : labelId),
    'aria-describedby': own['aria-describedby'] ?? descId,
  });
}

function SettingRow({ kind = 'field', label, description, control, status, sub, className, children, ...props }: Props) {
  const id = useId();
  const labelId = label != null ? `${id}-name` : undefined;
  const descId = description != null ? `${id}-desc` : undefined;
  const base = 'w-full min-w-0 border-0 border-solid border-border';

  if (kind === 'footer') {
    return (
      <div data-slot="setting-row" data-kind="footer" className={cn(base,
        'flex min-h-[58px] items-center justify-end gap-[12px] border-t px-[20px] py-[11px] @max-[480.02px]/settings-panel:px-[15px] @max-[480.02px]/settings-panel:py-[10px]',
        className)} {...props}>{children}</div>
    );
  }

  if (kind === 'action') {
    return (
      <div data-slot="setting-row" data-kind="action" className={cn(base, RULE.action,
        'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-[24px] px-[20px] py-[17px]',
        '@max-[480.02px]/settings-panel:grid-cols-[minmax(0,1fr)] @max-[480.02px]/settings-panel:items-start @max-[480.02px]/settings-panel:gap-[12px] @max-[480.02px]/settings-panel:p-[15px]',
        className)} {...props}>
        <div className="flex min-w-0 flex-col gap-[3px]">
          {label != null && <div id={labelId} className={NAME}>{label}</div>}
          {description != null && <div id={descId} className={DESC}>{description}</div>}
        </div>
        <div data-slot="setting-control" className="flex min-w-0 justify-end @max-[480.02px]/settings-panel:[&>*]:w-full">{named(control, labelId, descId)}</div>
      </div>
    );
  }

  const isSwitch = kind === 'switch';
  return (
    <div data-slot="setting-row" data-kind={kind} className={cn(base, RULE[kind],
      'grid auto-rows-min grid-cols-[minmax(0,1fr)_minmax(190px,260px)] items-center gap-x-[28px] gap-y-[5px] px-[20px] py-[17px]',
      '@max-[480.02px]/settings-panel:p-[15px]',
      isSwitch
        ? '@max-[560.02px]/settings-panel:grid-cols-[minmax(0,1fr)_auto] @max-[560.02px]/settings-panel:gap-x-[14px]'
        : '@max-[560.02px]/settings-panel:grid-cols-[minmax(0,1fr)] @max-[560.02px]/settings-panel:gap-[6px]',
      sub && 'pl-[40px] [[data-kind=field]+&,[data-kind=switch]+&]:border-t-0 [[data-kind=field]+&,[data-kind=switch]+&]:pt-0',
      className)} {...props}>
      {label != null && <div id={labelId} className={cn(NAME, 'col-start-1 row-start-1')}>{label}</div>}
      {description != null && <div id={descId} className={cn(DESC, 'col-start-1 row-start-2')}>{description}</div>}
      <div data-slot="setting-control" className={cn('min-w-0',
        isSwitch ? 'col-start-2 row-span-2 row-start-1 justify-self-end'
          : cn('col-start-2 row-start-1 self-center', status == null && 'row-span-2',
            '@max-[560.02px]/settings-panel:col-start-1 @max-[560.02px]/settings-panel:row-span-1 @max-[560.02px]/settings-panel:row-start-3 @max-[560.02px]/settings-panel:mt-[5px] @max-[560.02px]/settings-panel:w-full'),
        label == null && description == null && !isSwitch && '@max-[560.02px]/settings-panel:row-start-1 @max-[560.02px]/settings-panel:mt-0')}>
        {named(control, labelId, descId)}
      </div>
      {status != null && !isSwitch && (
        <div data-slot="setting-status" className="col-start-2 row-start-2 justify-self-start @max-[560.02px]/settings-panel:col-start-1 @max-[560.02px]/settings-panel:row-start-4 @max-[560.02px]/settings-panel:mt-[2px]">{status}</div>
      )}
    </div>
  );
}

export { SettingRow };
