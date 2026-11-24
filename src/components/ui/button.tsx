// Button — every button of the app, text or icon, one component (design inventory §3, 22 shapes).
//
// What a button looks like is four choices:
//   variant  its family: the dialog buttons (outline, primary, danger), the pages' filled one
//            (solid: Settings' Export…, the overview's Read), Settings' (subtle, tint, danger-subtle),
//            a button on a surface (secondary), the quiet bordered ones of the pages (quiet), the
//            borderless ones (ghost), one over a picture (overlay), dashed, and a text link;
//   tone     the colour a tint, quiet or ghost button speaks in (neutral, primary, warning, danger,
//            success), with `rest` (muted until hovered, or in its tone, framed or filled already) and
//            `hover` (an outline in the tone, or filled with it);
//   size     its box: text sizes default 36 and sm 28 (Settings' and the dialogs'), compact 28 (the
//            pages' own small ones: the header's Import and Stop all, the import tracker's: no
//            padding above and below, one line) and md 34 (the overview's actions); icon sizes
//            icon-2xs 16 (a library card's source logo, no frame) · icon-xs 22 · icon-sm 26 · icon 28 ·
//            icon-md 30 (the chapter rows') · toolbar 38×34; and inline (a link);
//   coarse   the size a finger gets, where today's page gives one (36, 40 or 44).
// Pressed (aria-pressed) shows the on look, in `pressedTone` where it differs from the tone; open
// (aria-expanded) shows the hover look, as today's "Titles" and "⋯" buttons do.
//
// The keyboard ring is the document's one ring (styles/document.css): nothing here draws one.
// Today's 1px press of Settings' buttons is gone (§5.3 F02: it moved the text).
//
// §5.3 S04, S05, S11, S13 (Settings and the dialogs on shadcn's scale): a dialog's buttons and
// Settings' are one size, default: 36 on a 20px line, 12px (12.5 and 11 before; Settings' 1.35 line
// takes the dialogs', the commoner); "Add folder" takes it too (40 before). The small ones are 28
// (30 before; page properties' "Copy as JSON" joins them), 11px. An icon beside a label is 14 (13
// before), a dialog's corner button's 16 (15). The pages' sizes (compact, md, the icon sizes) are
// 1.3's.
import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';
import type { AnchorHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

// A tone is a set of colours the variants below read: the outline (--t), its text (--t-text: the
// neutral tone frames in the muted grey and writes in the text colour), the fill's text (--t-fill-fg)
// and the 8% tint of an on button (--t-tint). The pressed set (--p…) is the tone's unless
// pressedTone names another.
const TONES = {
  neutral: '[--t:var(--muted-foreground)] [--t-text:var(--foreground)] [--t-fill-fg:var(--foreground)] [--t-tint:var(--secondary)]',
  primary: '[--t:var(--primary)] [--t-text:var(--primary)] [--t-fill-fg:var(--primary-foreground)] [--t-tint:var(--primary-tint)]',
  warning: '[--t:var(--warning)] [--t-text:var(--warning)] [--t-fill-fg:var(--warning-foreground)] [--t-tint:var(--warning-tint)]',
  danger: '[--t:var(--destructive)] [--t-text:var(--destructive)] [--t-fill-fg:var(--destructive-foreground)] [--t-tint:var(--destructive-tint)]',
  success: '[--t:var(--success)] [--t-text:var(--success)] [--t-fill-fg:var(--background)] [--t-tint:var(--success-tint)]',
} as const;
const PRESSED = {
  neutral: '[--p:var(--muted-foreground)] [--p-text:var(--foreground)] [--p-tint:var(--secondary)]',
  primary: '[--p:var(--primary)] [--p-text:var(--primary)] [--p-tint:var(--primary-tint)]',
  warning: '[--p:var(--warning)] [--p-text:var(--warning)] [--p-tint:var(--warning-tint)]',
  danger: '[--p:var(--destructive)] [--p-text:var(--destructive)] [--p-tint:var(--destructive-tint)]',
  success: '[--p:var(--success)] [--p-text:var(--success)] [--p-tint:var(--success-tint)]',
} as const;
type Tone = keyof typeof TONES;

// The on look: the pressed tone's frame and text on its tint. (An icon that fills when on, the
// heart, is drawn filled by its caller.)
const PRESSED_LOOK = 'aria-pressed:border-(--p) aria-pressed:bg-(--p-tint) aria-pressed:text-(--p-text)';

const buttonVariants = cva(
  'inline-flex shrink-0 cursor-pointer items-center justify-center border border-solid text-center whitespace-nowrap no-underline select-none disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        // Dialogs and the toast (.btn): the muted frame under the pointer, filled or not.
        outline: 'border-input bg-transparent text-foreground hover:border-muted-foreground aria-expanded:border-muted-foreground',
        primary: 'border-primary bg-primary text-primary-foreground hover:border-muted-foreground hover:brightness-110',
        danger: 'border-destructive bg-destructive text-destructive-foreground hover:border-muted-foreground hover:brightness-110',
        // The pages' filled button (Settings' Export…, the overview's Read): it brightens, keeping
        // its own frame.
        solid: 'border-primary bg-primary text-primary-foreground hover:brightness-110',
        // Settings: Clear All, Import, Stop all (a tone's outline that fills on hover).
        tint: 'border-(--t) bg-transparent text-(--t-text) hover:border-(--t) hover:bg-(--t) hover:text-(--t-fill-fg)',
        // Settings: the quieter danger (Reset).
        'danger-subtle': 'border-input bg-transparent text-destructive hover:border-destructive hover:bg-[color-mix(in_srgb,var(--destructive)_14%,transparent)]',
        // Settings' small neutral buttons (Advanced settings…, About).
        subtle: 'border-input bg-transparent text-muted-foreground hover:border-border-hover hover:bg-secondary hover:text-foreground aria-expanded:border-border-hover aria-expanded:bg-secondary aria-expanded:text-foreground',
        // On a surface (the overview's actions).
        secondary: `border-border bg-card text-foreground hover:border-primary ${PRESSED_LOOK}`,
        // The pages' bordered buttons, muted until hovered (header, card, tracker, task rows).
        quiet: `border-border bg-transparent text-muted-foreground ${PRESSED_LOOK}`,
        // No frame: a dialog's corner X, the chapter rows' buttons, the search box's clear.
        // §5.3 F09 (owner): every borderless button hovers to the raised surface. Today's chapter
        // buttons hovered darker, with a frame: 'hover:border-border hover:bg-background'.
        ghost: 'border-transparent bg-transparent text-muted-foreground hover:bg-secondary hover:text-foreground aria-expanded:bg-secondary aria-expanded:text-foreground',
        // Over a picture: the card's heart.
        overlay: 'border-border bg-overlay-ground text-muted-foreground hover:border-primary hover:text-primary aria-pressed:text-primary',
        dashed: 'border-dashed border-input bg-transparent text-muted-foreground hover:border-primary hover:bg-surface-subtle hover:text-foreground',
        // §5.3 F07 (owner): a text link hovers to the brand colour, whatever it hovered to before.
        link: 'border-0 bg-transparent whitespace-normal text-inherit hover:text-primary',
      },
      tone: {
        neutral: TONES.neutral, primary: TONES.primary, warning: TONES.warning, danger: TONES.danger, success: TONES.success,
      },
      // How a quiet or ghost button shows its tone before it is hovered.
      rest: { muted: '', tone: 'text-(--t-text)', framed: 'border-(--t) text-(--t-text)', filled: 'border-(--t) bg-(--t) text-(--t-fill-fg)' },
      // How it hovers in its tone: its frame and text in the tone, or filled with it.
      hover: { outline: '', fill: '' },
      pressedTone: { neutral: PRESSED.neutral, primary: PRESSED.primary, warning: PRESSED.warning, danger: PRESSED.danger, success: PRESSED.success },
      size: {
        default: 'min-h-[36px] gap-[6px] rounded-6 px-[14px] py-[7px] text-12 leading-[20px] font-semibold whitespace-normal [overflow-wrap:anywhere] [&_svg:not([class*=size-])]:size-[14px]',
        md: 'gap-[7px] rounded-6 px-[14px] py-[8px] text-12 [&_svg:not([class*=size-])]:size-[14px]',
        sm: 'min-h-[28px] gap-[6px] rounded-6 px-[10px] py-[5px] text-11 leading-[1.35] font-semibold whitespace-normal [overflow-wrap:anywhere] [&_svg:not([class*=size-])]:size-[14px]',
        compact: 'h-[28px] gap-[6px] rounded-6 px-[10px] text-11 [&_svg:not([class*=size-])]:size-[13px]',
        // A library card's source logo: 16px, no frame (its face fills it).
        'icon-2xs': 'size-[16px] rounded-2 border-0 p-0',
        'icon-xs': 'size-[22px] rounded-4 p-0 [&_svg:not([class*=size-])]:size-[14px]',
        'icon-sm': 'size-[26px] rounded-pill p-0 [&_svg:not([class*=size-])]:size-[14px]',
        icon: 'size-[28px] rounded-6 p-0 [&_svg:not([class*=size-])]:size-[15px]',
        'icon-md': 'size-[30px] rounded-6 p-0 [&_svg:not([class*=size-])]:size-[15px]',
        toolbar: 'h-[34px] rounded-6 px-[11px] [&_svg:not([class*=size-])]:size-[14px]',
        inline: 'inline p-0 [font-size:inherit] [line-height:inherit]',
      },
      // A finger's size: the box grows to it under a coarse pointer (an icon button both ways, a
      // text one in height).
      coarse: { none: '', '36': '', '40': '', '44': '' },
    },
    compoundVariants: [
      // Quiet and ghost buttons hover in their tone: outline (frame and text), or fill. A quiet
      // neutral outline is the muted frame and the text colour.
      { variant: ['quiet', 'ghost'], hover: 'outline', class: 'hover:border-(--t) hover:text-(--t-text) aria-expanded:border-(--t) aria-expanded:text-(--t-text)' },
      { variant: ['quiet', 'ghost'], hover: 'fill', class: 'hover:border-(--t) hover:bg-(--t) hover:text-(--t-fill-fg)' },
      // A ghost button in the neutral tone shows no frame on hover (F09): its ground says it.
      { variant: 'ghost', tone: 'neutral', class: 'hover:border-transparent aria-expanded:border-transparent' },
      // The toolbar's quiet button sits on the surface, like the select beside it.
      { variant: 'quiet', size: 'toolbar', class: 'bg-card' },
      // Page properties' quiet small button keeps the normal weight.
      { variant: 'quiet', size: 'sm', class: 'font-normal' },
      // A text button in the page's header (Import, Stop all) is bold and a little wider.
      { variant: 'tint', size: 'compact', class: 'px-[12px] py-[6px] font-semibold' },
      // A dialog's corner button (and Settings' beside a row): its icon alone, 16.
      { variant: 'ghost', size: 'icon', class: '[&_svg:not([class*=size-])]:size-[16px]' },
      // "Add folder": as wide as its place, radius 8.
      { variant: 'dashed', class: 'flex w-full rounded-8' },
      // The overview's primary action is bold; its others are not.
      { variant: 'solid', size: 'md', class: 'font-semibold' },
      // Disabled: as each family was. Dialog buttons .6, Settings' .5 (not-allowed), the pages'
      // quiet ones .4, the borderless ones .3; Stop all greys out instead.
      { variant: ['outline', 'primary', 'danger'], class: 'disabled:cursor-default disabled:opacity-60' },
      { variant: ['quiet', 'overlay'], class: 'disabled:cursor-default disabled:opacity-40' },
      { variant: 'ghost', class: 'disabled:cursor-default disabled:opacity-30' },
      { variant: 'tint', size: 'compact', class: 'disabled:cursor-default disabled:border-border disabled:text-muted-dim disabled:opacity-100' },
      // Coarse sizes.
      { size: ['icon', 'icon-sm', 'icon-md', 'toolbar'], coarse: '36', class: 'pointer-coarse:size-[36px]' },
      { size: ['icon', 'icon-sm', 'icon-md', 'toolbar'], coarse: '40', class: 'pointer-coarse:size-[40px]' },
      { size: ['icon', 'icon-sm', 'icon-md', 'toolbar'], coarse: '44', class: 'pointer-coarse:size-[44px]' },
      { size: ['default', 'md', 'sm', 'compact'], coarse: '36', class: 'pointer-coarse:h-auto pointer-coarse:min-h-[36px]' },
      { size: ['default', 'md', 'sm', 'compact'], coarse: '40', class: 'pointer-coarse:h-auto pointer-coarse:min-h-[40px]' },
      { size: ['default', 'md', 'sm', 'compact'], coarse: '44', class: 'pointer-coarse:h-auto pointer-coarse:min-h-[44px]' },
    ],
    defaultVariants: { variant: 'outline', size: 'default', coarse: 'none' },
  },
);

// Colour changes ease as each family's did (the dialog buttons never did).
const MOTION: Partial<Record<Variant, string>> = {
  tint: 'transition-[color,background-color,border-color] duration-base',
  quiet: 'transition-[color,background-color,border-color] duration-base',
};
// Colours only: a primary's brightness on hover changes at once (a filter that eased would lift its label
// onto a layer of its own while it ran, as rule 11 warns of opacity and transform).
const MOTION_DEFAULT = 'transition-[color,background-color,border-color] duration-fast ease-standard';

type Variant = NonNullable<VariantProps<typeof buttonVariants>['variant']>;
type Size = NonNullable<VariantProps<typeof buttonVariants>['size']>;

export type ButtonProps = ButtonPrimitive.Props & {
  // A link drawn as a button (or as a text link): an <a>, so it stays a link to everything that reads
  // the page (role, Enter, a middle click).
  href?: string;
  target?: string;
  rel?: string;
  variant?: Variant;
  size?: Size;
  tone?: Tone;
  rest?: 'muted' | 'tone' | 'framed' | 'filled';
  hover?: 'outline' | 'fill';
  pressedTone?: Tone;
  coarse?: '36' | '40' | '44';
};

// The tone a family speaks in when none is named: the tint buttons are warnings or dangers by
// nature, the quiet and ghost ones neutral.
const TONED: Variant[] = ['tint', 'quiet', 'ghost'];

function Button({ className, variant = 'outline', size = 'default', tone, rest, hover, pressedTone, coarse, href, ...props }: ButtonProps) {
  const toned = TONED.includes(variant);
  const t = toned ? tone ?? (variant === 'tint' ? 'warning' : 'neutral') : undefined;
  const motion = ['outline', 'primary', 'danger'].includes(variant) ? '' : MOTION[variant] ?? MOTION_DEFAULT;
  const classes = cn(
    buttonVariants({
      variant, size, coarse: coarse ?? 'none',
      tone: t,
      rest: toned ? rest ?? 'muted' : undefined,
      hover: toned ? hover ?? 'outline' : undefined,
      pressedTone: pressedTone ?? (variant === 'secondary' || variant === 'quiet' ? t ?? 'primary' : undefined),
    }),
    motion,
    typeof className === 'string' ? className : undefined,
  );
  if (href !== undefined) {
    const { children, ...rest } = props as unknown as AnchorHTMLAttributes<HTMLAnchorElement>;
    return <a data-slot="button" data-variant={variant} data-size={size} href={href} className={classes} {...rest}>{children}</a>;
  }
  return <ButtonPrimitive data-slot="button" data-variant={variant} data-size={size} className={classes} {...props} />;
}

export { Button, buttonVariants };
