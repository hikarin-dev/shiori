// The components page: the colour tokens and each shared component, as the new UI draws them.
import { Button } from '@/components/ui/button';
import { useTitle } from '@/lib/title';

const TOKENS = [
  'background', 'foreground', 'card', 'card-foreground', 'popover', 'popover-foreground',
  'primary', 'primary-foreground', 'secondary', 'secondary-foreground', 'muted', 'muted-foreground',
  'accent', 'accent-foreground', 'destructive', 'border', 'input', 'ring',
  'surface-subtle', 'muted-dim', 'accent2', 'success', 'debug', 'backdrop',
  'scrollbar-track', 'scrollbar-thumb', 'scrollbar-thumb-active', 'scrollbar-inner-thumb',
];

const BUTTONS = ['default', 'outline', 'secondary', 'ghost', 'destructive', 'link'] as const;

export default function Components() {
  useTitle('Components');
  return (
    <main className="flex flex-col gap-8 p-5">
      <h1 className="text-base font-semibold">Components</h1>

      <section className="flex flex-col gap-3">
        <h2 className="font-semibold text-muted-foreground">Colours</h2>
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
          {TOKENS.map((token) => (
            <li key={token} className="flex items-center gap-2" data-token={token}>
              <span className="size-8 shrink-0 rounded-md border" style={{ background: `var(--${token})` }} />
              <code>--{token}</code>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-semibold text-muted-foreground">Button</h2>
        <div className="flex flex-wrap items-center gap-3">
          {BUTTONS.map((variant) => <Button key={variant} variant={variant}>{variant}</Button>)}
        </div>
      </section>
    </main>
  );
}
