// PageMenu — the header's page name, "/ Library ▾": a quiet menu of the app's pages, the one showing
// chosen. Choosing another goes there, by a change of route (src/lib/links.ts, goTo).
// A gallery's overview is offered where the address names a gallery, the reader only in the reader,
// as app/js/page-nav.js does in the reader's own top bar.
//
// Drawn closed as 1.3's .page-nav to the pixel: Select's ghost look at xs (26px, 6px in, 13px, as
// wide as the page's name), 5px into the "/"'s gap (styles/frame.css: the header's forms place it). With a pointer its list is the app's; under a
// coarse pointer the system's picker (T15). It shows the page it stands for whatever was chosen
// (the address decides), so a page left by the back/forward cache comes back showing its own name.
import { useLocation, useNavigate } from 'react-router';
import { Select } from './select';
import { goTo } from '@/lib/links';
import { useT } from '@/lib/i18n';

export type Page = 'library' | 'overview' | 'reader' | 'settings' | 'tasks';

// Each page, its name, and its address from the site's root given the address showing.
const PAGES: { id: Page; label: string; path: (query: URLSearchParams, search: string) => string }[] = [
  { id: 'library', label: 'nav.library', path: () => '' },
  { id: 'overview', label: 'nav.overview', path: (query) => `overview?g=${encodeURIComponent(query.get('g') ?? '')}` },
  { id: 'reader', label: 'nav.reader', path: (_, search) => `reader${search}` },
  { id: 'settings', label: 'nav.settings', path: () => 'settings' },
  { id: 'tasks', label: 'tasks.title', path: () => 'tasks' },
];

type Props = { page: Page; id?: string } & { [data: `data-${string}`]: string | undefined };

function PageMenu({ page, id = 'pageNav', ...data }: Props) {
  const t = useT();
  const navigate = useNavigate();
  const { search } = useLocation();
  const query = new URLSearchParams(search);
  const offered = PAGES.filter((p) => p.id === page || (p.id === 'overview' ? !!query.get('g') : p.id !== 'reader'));
  return (
    <Select
      variant="ghost"
      id={id}
      data-page={page}
      className="brand-page page-nav"
      aria-label={t('nav.go_to')}
      options={offered.map((p) => ({ value: p.id, label: t(p.label) }))}
      value={page}
      onValueChange={(value) => {
        const next = PAGES.find((p) => p.id === value);
        if (next && next.id !== page) goTo(navigate, next.path(query, search));
      }}
      {...data}
    />
  );
}

export { PageMenu };
