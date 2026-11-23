// Pagination's specimens: one page button in each state, and the whole control at two places.
import { useState } from 'react';
import { PageButton, Pagination } from '@/components/ui/pagination';
import { Line, Section, Shape, tag } from './specimen';

export function PaginationSpecimens() {
  const [page, setPage] = useState(10);
  return (
    <Section id="pagination" title="Pagination">
      <Shape id="page-btn" name="Pagination" used="The library, under the grid (and the gap between page numbers).">
        <Line label="page" states={['rest', 'hover', 'active', 'focus', 'disabled']} render={(state) => <PageButton disabled={state === 'disabled'} {...tag('page-btn', 'page', state)}>2</PageButton>} />
        <Line label="current page" states={['on']} render={(state) => <PageButton current {...tag('page-btn', 'current', state)}>1</PageButton>} />
        <Line label="arrow" states={['rest', 'disabled']} render={(state) => <PageButton disabled={state === 'disabled'} {...tag('page-btn', 'arrow', state)}>←</PageButton>} />
        <div className="flex flex-col items-start gap-[12px]" data-pagination-demo>
          <Pagination page={2} count={2} onPage={() => {}} />
          <Pagination page={page} count={20} onPage={setPage} />
        </div>
      </Shape>
    </Section>
  );
}
