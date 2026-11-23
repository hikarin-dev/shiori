// Pagination — the library's page buttons under its grid: ← 1 … 8 9 [10] 11 12 … 20 →.
// Its own small buttons (32×28, radius 5, on the surface), not Button's: §3 keeps their look.
import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { formatCount } from '@lib/format.js';
import { cn } from '@/lib/utils';

// The page numbers shown, null for a gap. A five-page window rides with the current page, plus the
// first and last page: 1 … 8 9 [10] 11 12 … 20. Near an edge the window reaches six pages from it
// instead: 1 2 3 [4] 5 6 … 20. (library.js _pageNumbers, as it is.)
export function pageNumbers(current: number, total: number): (number | null)[] {
  let lo = current - 2, hi = current + 2;
  if (lo <= 3) { lo = 1; hi = Math.max(hi, 6); }
  if (hi >= total - 2) { hi = total; lo = Math.min(lo, total - 5); }
  lo = Math.max(1, lo);
  hi = Math.min(total, hi);
  const out: (number | null)[] = [];
  if (lo > 1) out.push(1, null);
  for (let p = lo; p <= hi; p++) out.push(p);
  if (hi < total) out.push(null, total);
  return out;
}

type PageButtonProps = ButtonPrimitive.Props & { current?: boolean };

// One page's button (or an arrow). The current page is filled and keeps its look under the pointer.
export function PageButton({ current, className, ...props }: PageButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="page-button"
      aria-current={current ? 'page' : undefined}
      className={cn(
        'min-w-[32px] cursor-pointer rounded-5 border border-solid border-border bg-card px-[11px] py-[6px] text-center text-11 text-muted-foreground',
        'transition-[color,background-color,border-color] duration-fast ease-standard',
        'hover:not-aria-[current=page]:border-primary hover:not-aria-[current=page]:text-primary',
        'aria-[current=page]:border-primary aria-[current=page]:bg-primary aria-[current=page]:text-primary-foreground',
        'disabled:cursor-default disabled:opacity-30',
        typeof className === 'string' ? className : undefined,
      )}
      {...props}
    />
  );
}

export function Pagination({ page, count, onPage, className }: { page: number; count: number; onPage: (page: number) => void; className?: string }) {
  if (count <= 1) return null;
  return (
    <nav data-slot="pagination" className={cn('flex items-center justify-center', className)}>
      <ul className="flex list-none items-center gap-[5px]">
        <li><PageButton disabled={page === 1} onClick={() => onPage(page - 1)}>←</PageButton></li>
        {pageNumbers(page, count).map((n, i) => (n === null
          ? <li key={`gap${i}`} aria-hidden className="px-[3px] text-11 text-muted-foreground select-none">…</li>
          : <li key={n}><PageButton current={n === page} onClick={() => onPage(n)}>{formatCount(n)}</PageButton></li>))}
        <li><PageButton disabled={page === count} onClick={() => onPage(page + 1)}>→</PageButton></li>
      </ul>
    </nav>
  );
}
