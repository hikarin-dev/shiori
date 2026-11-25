// overview.tsx — a gallery's or a series' overview, the landing before the reader, as the one page
// draws it (at /overview-next while 1.3's page answers /overview): the header's parts (the page menu,
// Settings), then which gallery the address names (?g=: a chapter's id shows its series), or 1.3's
// words where there is none.
import { useNavigate, useLocation } from 'react-router';
import { Settings } from 'lucide-react';
import { HeaderSlot } from '@/components/header-slot';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { PageMenu } from '@/components/ui/page-menu';
import { useT } from '@/lib/i18n';
import { goTo } from '@/lib/links';
import { useTitle } from '@/lib/title';

export default function Overview() {
  // 1.3's page's own title (overview.html).
  useTitle('Series');
  const t = useT();
  const navigate = useNavigate();
  const g = new URLSearchParams(useLocation().search).get('g');
  return (
    <>
      <HeaderSlot side="left"><span className="brand-sep">/</span><PageMenu page="overview" /></HeaderSlot>
      <HeaderSlot side="right">
        <Button id="settingsBtn" variant="quiet" tone="primary" size="icon" coarse="40" className="btn-settings" aria-label={t('nav.settings')} data-tip={t('nav.settings')}
          onClick={() => goTo(navigate, 'settings')}>
          <Settings className="size-[16px]" />
        </Button>
      </HeaderSlot>
      <div className="ov-wrap">
        <div id="ovContent">
          {g ? <EmptyState className="ov-loading">{t('ov.loading')}</EmptyState> : <EmptyState className="ov-empty">{t('ov.not_found')}</EmptyState>}
        </div>
      </div>
    </>
  );
}
