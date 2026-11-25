// Button's specimens: every shape of the design inventory's "button (text)" and "button (icon)"
// kinds that is a Button, with today's labels, so each box can be held against today's.
import type { ReactNode } from 'react';
import { BookOpen, Download, Eye, Funnel, Heart, Languages, Menu, Pin, Plus, Settings, Share, Square, Trash2, Upload, X, ChevronDown, Unlink } from 'lucide-react';
import { Button, type ButtonProps } from '@/components/ui/button';
import { Line, Section, Shape, tag, type State } from './specimen';

type Variant = { v: string; label: string; props: ButtonProps; children: ReactNode; states?: readonly State[]; onProps?: Record<string, unknown> };
type ShapeSpec = { id: string; name: string; used: string; states: readonly State[]; variants: Variant[] };

const BASE: readonly State[] = ['rest', 'hover', 'active', 'focus', 'disabled'];
const WITH_ON: readonly State[] = ['rest', 'hover', 'active', 'focus', 'disabled', 'on'];
const PRESSED = { 'aria-pressed': true };
const OPEN = { 'aria-expanded': true };

const SHAPES: ShapeSpec[] = [
  { id: 'btn', name: 'Dialog button', used: 'Every notice dialog, the toast, the filter dialog, the tag editor, Settings\' dialog footers, the feedback and benchmark dialogs.', states: BASE, variants: [
    { v: 'outline', label: 'outline · default', props: { variant: 'outline' }, children: 'Cancel' },
    { v: 'primary', label: 'primary · default', props: { variant: 'primary' }, children: 'Export' },
    { v: 'danger', label: 'danger · default', props: { variant: 'danger' }, children: 'Delete' },
  ] },
  { id: 'btn-save', name: 'Settings primary', used: 'Settings → Storage (Export…, Import…, Check…, Convert now), the optional panel\'s download, the desktop panel.', states: BASE, variants: [
    { v: 'primary', label: 'solid · default', props: { variant: 'solid' }, children: 'Export…' },
  ] },
  { id: 'btn-clear-all', name: 'Settings danger', used: 'Settings → Storage → Danger Zone (Clear All, Factory Reset): the danger button (F61: filled, never an outline).', states: BASE, variants: [
    { v: 'danger', label: 'danger · default', props: { variant: 'danger' }, children: '✕ Clear All' },
  ] },
  { id: 'btn-clear-key', name: 'Settings danger, small things', used: 'Settings → Storage → Stats (Reset); the library location\'s "delete what is left" (small).', states: BASE, variants: [
    { v: 'danger', label: 'danger · default', props: { variant: 'danger' }, children: 'Reset' },
    { v: 'danger-sm', label: 'danger · sm', props: { variant: 'danger', size: 'sm' }, children: 'Delete' },
  ] },
  { id: 'btn-mini', name: 'Settings small', used: 'Settings: Advanced settings…, library folders\' attention lines, the desktop panel, library location, benchmark controls.', states: BASE, variants: [
    { v: 'subtle', label: 'subtle · sm', props: { variant: 'subtle', size: 'sm' }, children: <><Settings />Advanced settings…</> },
  ] },
  { id: 'btn-about', name: 'Settings header "About"', used: 'Settings\' header: an outline button (the owner\'s, after F60\'s frameless one).', states: ['rest', 'hover', 'active', 'focus'], variants: [
    { v: 'subtle', label: 'subtle · sm', props: { variant: 'subtle', size: 'sm' }, children: 'About' },
  ] },
  { id: 'ov-btn', name: 'Overview action', used: 'Overview hero: Read (primary), Favourite, Edit (on while editing), Archive, Move, Source.', states: WITH_ON, variants: [
    { v: 'primary', label: 'solid · md', props: { variant: 'solid', size: 'md' }, children: <><BookOpen />Read from start</>, states: BASE },
    { v: 'secondary', label: 'secondary · md', props: { variant: 'secondary', size: 'md', pressedTone: 'warning' }, children: <><Settings />Edit</> },
    { v: 'secondary-fav', label: 'secondary · md (favourite)', props: { variant: 'secondary', size: 'md', pressedTone: 'primary' }, children: <><Heart />Favorited</>, onProps: { ...PRESSED, children: <><Heart className="fill-current" />Favorited</> } },
  ] },
  { id: 'btn-upload', name: 'Header Import', used: 'Library header (Import): icon only under 1400px. F60: filled in its yellow at rest.', states: BASE, variants: [
    { v: 'tint-warning', label: 'tint warning, filled · compact', props: { variant: 'tint', tone: 'warning', rest: 'filled', size: 'compact', coarse: '40' }, children: <><Upload />Import</> },
    { v: 'tint-warning-icon', label: 'tint warning, filled · icon', props: { variant: 'tint', tone: 'warning', rest: 'filled', size: 'icon', coarse: '40', 'aria-label': 'Import' }, children: <Upload /> },
  ] },
  { id: 'btn-stop-all', name: 'Tasks header Stop all', used: 'Tasks header.', states: BASE, variants: [
    { v: 'danger', label: 'danger · compact', props: { variant: 'danger', size: 'compact', coarse: '40' }, children: <><Square />Stop all</> },
    { v: 'danger-icon', label: 'danger · icon', props: { variant: 'danger', size: 'icon', coarse: '40', 'aria-label': 'Stop all' }, children: <Square className="size-[13px]" />, states: ['rest', 'hover', 'focus', 'disabled'] },
  ] },
  { id: 'ib-btn', name: 'Import tracker button', used: 'The import batch panel (Library, Overview, Tasks): Titles (opens), Stop, Dismiss, More.', states: WITH_ON, variants: [
    { v: 'quiet', label: 'quiet · compact', props: { variant: 'quiet', size: 'compact', coarse: '44' }, children: 'Titles', onProps: OPEN },
    { v: 'quiet-danger-icon', label: 'quiet danger · icon', props: { variant: 'quiet', tone: 'danger', size: 'icon', coarse: '44', 'aria-label': 'Stop' }, children: <Square className="size-[14px]" />, states: BASE },
  ] },
  { id: 'pp-btn', name: 'Page properties "Copy as JSON"', used: 'Reader → page properties header.', states: BASE, variants: [
    { v: 'quiet', label: 'quiet · sm', props: { variant: 'quiet', size: 'sm' }, children: 'Copy as JSON' },
  ] },
  { id: 'lf-add', name: 'Dashed "Add folder"', used: 'Settings → Storage → library folders.', states: ['rest', 'hover', 'active', 'focus'], variants: [
    { v: 'dashed', label: 'dashed · default', props: { variant: 'dashed', className: 'w-[320px]' }, children: <><Plus />Add folder…</> },
  ] },
  { id: 'link', name: 'Text link', used: 'The reader\'s empty screen, task titles, chapter ids, overview titles (F07: one hover).', states: ['rest', 'hover', 'focus'], variants: [
    { v: 'link', label: 'link · inline', props: { variant: 'link', size: 'inline', href: '#link' }, children: 'Back to the library' },
  ] },
  { id: 'icon-btn', name: 'Dialog corner icon button', used: 'The toast\'s close, About (GitHub, close), the advanced settings\' close, reader settings, page properties, library folders (rescan, more).', states: WITH_ON, variants: [
    { v: 'ghost', label: 'ghost · icon', props: { variant: 'ghost', size: 'icon', 'aria-label': 'Close' }, children: <X />, onProps: OPEN },
  ] },
  { id: 'header-icon', name: 'Header square buttons', used: 'Library header (menu, safe mode, settings, pin); Overview and Tasks header (settings). F60: no frame, the raised ground under the pointer.', states: WITH_ON, variants: [
    { v: 'ghost-menu', label: 'ghost · icon (menu)', props: { variant: 'ghost', size: 'icon', coarse: '40', 'aria-label': 'Menu' }, children: <Menu className="size-[16px]" />, states: BASE },
    { v: 'ghost-settings', label: 'ghost · icon (settings)', props: { variant: 'ghost', size: 'icon', coarse: '40', 'aria-label': 'Settings' }, children: <Settings className="size-[16px]" />, states: BASE },
    { v: 'ghost-safe', label: 'ghost · icon (safe: on in the colour of success)', props: { variant: 'ghost', pressedTone: 'success', size: 'icon', coarse: '40', 'aria-label': 'Safe mode' }, children: <Eye />, onProps: PRESSED },
    { v: 'ghost-pin', label: 'ghost · icon (pin)', props: { variant: 'ghost', size: 'icon', coarse: '40', 'aria-label': 'Pin' }, children: <Pin className="size-[14px]" />, states: BASE },
  ] },
  { id: 'card-btn', name: 'Card quick actions', used: 'A library card: download, translate, export, delete.', states: ['rest', 'hover', 'active', 'focus', 'disabled', 'on'], variants: [
    { v: 'quiet-warning-fill', label: 'quiet warning, fill', props: { variant: 'quiet', tone: 'warning', rest: 'tone', hover: 'fill', size: 'icon', coarse: '36', 'aria-label': 'Download' }, children: <Download className="size-[14px]" />, onProps: { tone: 'success', rest: 'framed' } },
    { v: 'quiet', label: 'quiet (translate: translated, in the colour of success)', props: { variant: 'quiet', size: 'icon', coarse: '36', 'aria-label': 'Translate' }, children: <Languages className="size-[14px]" />, onProps: { tone: 'success', rest: 'tone' } },
    { v: 'quiet-warning', label: 'quiet warning', props: { variant: 'quiet', tone: 'warning', size: 'icon', coarse: '36', 'aria-label': 'Export' }, children: <Share className="size-[14px]" />, states: BASE },
    { v: 'quiet-danger-fill', label: 'quiet danger, fill', props: { variant: 'quiet', tone: 'danger', rest: 'tone', hover: 'fill', size: 'icon', coarse: '36', 'aria-label': 'Delete' }, children: <Trash2 className="size-[14px]" />, states: BASE },
  ] },
  { id: 'ch-ibtn', name: 'Chapter row actions', used: 'Overview chapter rows: download, translate, detach, delete, open (F09: the ghost\'s hover; 30px, as in 1.3).', states: BASE, variants: [
    { v: 'ghost', label: 'ghost · icon-md', props: { variant: 'ghost', size: 'icon-md', coarse: '40', 'aria-label': 'Open' }, children: <ChevronDown /> },
    { v: 'ghost-warning-fill', label: 'ghost warning, fill', props: { variant: 'ghost', tone: 'warning', rest: 'tone', hover: 'fill', size: 'icon-md', coarse: '40', 'aria-label': 'Download' }, children: <Download /> },
    { v: 'ghost-primary', label: 'ghost primary', props: { variant: 'ghost', tone: 'primary', size: 'icon-md', coarse: '40', 'aria-label': 'Detach' }, children: <Unlink /> },
  ] },
  { id: 'tk-stop', name: 'Task row Stop', used: 'Tasks rows; the import tracker\'s Stop.', states: BASE, variants: [
    { v: 'quiet-danger', label: 'quiet danger · icon', props: { variant: 'quiet', tone: 'danger', size: 'icon', coarse: '44', 'aria-label': 'Stop' }, children: <Square className="size-[14px]" /> },
  ] },
  { id: 'filter-btn', name: 'Library filter toggle', used: 'Library toolbar, beside sort (on while a filter is set).', states: WITH_ON, variants: [
    { v: 'quiet-toolbar', label: 'quiet · toolbar', props: { variant: 'quiet', size: 'toolbar', 'aria-label': 'Filter' }, children: <Funnel />, onProps: PRESSED },
  ] },
  { id: 'card-fav', name: 'Card favourite heart', used: 'A library card\'s cover corner.', states: WITH_ON, variants: [
    { v: 'overlay', label: 'overlay · icon-sm', props: { variant: 'overlay', size: 'icon-sm', coarse: '36', 'aria-label': 'Favourite' }, children: <Heart />, onProps: { ...PRESSED, children: <Heart className="fill-current" /> } },
  ] },
  { id: 'search-clear', name: 'Search clear X', used: 'Library search box (F09: gains the ghost\'s hover ground).', states: BASE, variants: [
    { v: 'ghost', label: 'ghost · icon-xs', props: { variant: 'ghost', size: 'icon-xs', 'aria-label': 'Clear' }, children: <X /> },
  ] },
];

function specimen(shape: ShapeSpec, variant: Variant, state: State) {
  const { children, ...rest } = variant.props as ButtonProps & { children?: ReactNode };
  // "on" is pressed unless the variant says what else it is (open, done).
  const on = state === 'on' ? variant.onProps ?? PRESSED : {};
  const content = (on as { children?: ReactNode }).children ?? variant.children ?? children;
  const props = { ...rest, ...on, children: content } as ButtonProps;
  return <Button {...props} disabled={state === 'disabled' || undefined} {...tag(shape.id, variant.v, state)} />;
}

export function ButtonSpecimens() {
  return (
    <Section id="button" title="Button">
      {SHAPES.map((shape) => (
        <Shape key={shape.id} id={shape.id} name={shape.name} used={shape.used}>
          {shape.variants.map((variant) => (
            <Line key={variant.v} label={variant.label} states={variant.states ?? shape.states} render={(state) => specimen(shape, variant, state)} />
          ))}
        </Shape>
      ))}
    </Section>
  );
}
