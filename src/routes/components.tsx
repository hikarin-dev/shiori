// The components page: the design tokens and each shared component, as the new UI draws them. The
// tokens are read from the stylesheet itself (styles/tokens.css), so every one shows, by its name;
// each component shows every shape, variant and state it has (specimens/, the parity check's subjects).
import { useState } from 'react';
import { ButtonSpecimens } from './specimens/button';
import { PaginationSpecimens } from './specimens/pagination';
import { SwitchSpecimens } from './specimens/switch';
import { CheckboxSpecimens } from './specimens/checkbox';
import { TriStateSpecimens } from './specimens/tri-state-toggle';
import { ToggleGroupSpecimens } from './specimens/toggle-group';
import { TabsSpecimens } from './specimens/tabs';
import { SelectSpecimens } from './specimens/select';
import { InputSpecimens } from './specimens/input';
import { SliderSpecimens } from './specimens/slider';
import { NumberFieldSpecimens } from './specimens/number-field';
import { SeparatorSpecimens } from './specimens/separator';
import { KbdSpecimens } from './specimens/kbd';
import { SpinnerSpecimens } from './specimens/spinner';
import { ProgressSpecimens } from './specimens/progress';
import { TagSpecimens } from './specimens/tag';
import { BadgeSpecimens } from './specimens/badge';
import { StatSpecimens } from './specimens/stat';
import { TextSpecimens } from './specimens/text';
import { CardSpecimens } from './specimens/card';
import { SettingRowSpecimens } from './specimens/setting-row';
import { OptionCardSpecimens } from './specimens/option-card';
import { useT } from '@/lib/i18n';
import { useTitle } from '@/lib/title';

// The page's style rules for :root, in its stylesheets' order.
function rootRules(): CSSStyleRule[] {
  const found: CSSStyleRule[] = [];
  const walk = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule && /(^|,)\s*:root\b/.test(rule.selectorText)) found.push(rule);
      if ('cssRules' in rule) walk((rule as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    try { walk(sheet.cssRules); } catch { /* another origin's sheet */ }
  }
  return found;
}

const GROUPS = [
  { id: 'text', title: 'Type sizes', prefix: '--text-' },
  { id: 'radius', title: 'Radii', prefix: '--radius-' },
  { id: 'shadow', title: 'Shadows', prefix: '--shadow-' },
  { id: 'layer', title: 'Layers', prefix: '--z-index-' },
  { id: 'duration', title: 'Durations', prefix: '--transition-duration-' },
  { id: 'ease', title: 'Easings', prefix: '--ease-' },
] as const;

// The colours are the custom properties of the :root rule that sets --background (tokens.css), less
// the two scrollbar.js writes there; the rest are found by their namespace.
function tokens() {
  const rules = rootRules();
  const all = new Map<string, string>();
  for (const rule of rules) for (const name of rule.style) if (name.startsWith('--')) all.set(name, rule.style.getPropertyValue(name).trim());
  const names = [...all.keys()];
  const number = (name: string) => parseFloat(all.get(name) ?? '') || 0;
  const palette = rules.find((rule) => rule.style.getPropertyValue('--background'));
  return {
    colours: palette ? [...palette.style].filter((name) => name.startsWith('--') && !name.startsWith('--page-scrollbar-')) : [],
    groups: GROUPS.map((g) => {
      const list = names.filter((name) => name.startsWith(g.prefix));
      if (g.id === 'text' || g.id === 'layer') list.sort((a, b) => number(a) - number(b));
      return { ...g, list };
    }),
    value: (name: string) => all.get(name) ?? '',
  };
}

// A token as CSS refers to it: a name such as --text-10.5 is written escaped.
const ref = (name: string) => `var(--${CSS.escape(name.slice(2))})`;

// The app's pages by name, in the language chosen (useT follows a change of it).
const PAGE_NAMES = ['nav.library', 'nav.overview', 'nav.reader', 'nav.settings', 'tasks.title'];

export default function Components() {
  useTitle('Components');
  const t = useT();
  const [{ colours, groups, value }] = useState(tokens);
  return (
    <main className="flex flex-col gap-[32px] overflow-x-clip p-[20px]">
      <h1 className="text-16 font-semibold">Components</h1>

      <section className="flex flex-col gap-[12px]">
        <h2 className="text-13 font-semibold text-muted-foreground">Colours</h2>
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-[12px]">
          {colours.map((token) => (
            <li key={token} className="flex items-center gap-[8px]" data-token={token}>
              <span className="size-[32px] shrink-0 rounded-6 border border-border" style={{ background: ref(token) }} />
              <span className="flex min-w-0 flex-col">
                <code>{token}</code>
                <span className="truncate text-11 text-muted-foreground">{value(token)}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      {groups.map((group) => (
        <section key={group.id} className="flex flex-col gap-[12px]">
          <h2 className="text-13 font-semibold text-muted-foreground">{group.title}</h2>
          <ul className="flex flex-wrap items-end gap-[16px]">
            {group.list.map((token) => (
              <li key={token} className="flex flex-col gap-[6px]" data-token={token}>
                {group.id === 'text' && <span style={{ fontSize: ref(token) }}>Shiori</span>}
                {group.id === 'radius' && <span className="block size-[48px] border border-input bg-secondary" style={{ borderRadius: ref(token) }} />}
                {group.id === 'shadow' && <span className="m-[12px] block size-[64px] rounded-8 bg-card" style={{ boxShadow: ref(token) }} />}
                <code>{token}</code>
                <span className="text-11 text-muted-foreground">{value(token)}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <section className="flex flex-col gap-[12px]">
        <h2 className="text-13 font-semibold text-muted-foreground">Text</h2>
        <ul className="flex flex-wrap gap-[16px]" id="pageNames">
          {PAGE_NAMES.map((key) => <li key={key} data-key={key}>{t(key)}</li>)}
        </ul>
      </section>

      <ButtonSpecimens />
      <PaginationSpecimens />
      <SwitchSpecimens />
      <CheckboxSpecimens />
      <TriStateSpecimens />
      <ToggleGroupSpecimens />
      <TabsSpecimens />
      <SelectSpecimens />
      <InputSpecimens />
      <SliderSpecimens />
      <NumberFieldSpecimens />
      <SeparatorSpecimens />
      <KbdSpecimens />
      <SpinnerSpecimens />
      <ProgressSpecimens />
      <TagSpecimens />
      <BadgeSpecimens />
      <StatSpecimens />
      <TextSpecimens />
      <CardSpecimens />
      <SettingRowSpecimens />
      <OptionCardSpecimens />
    </main>
  );
}
