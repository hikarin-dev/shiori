// The About dialog (Settings' header): the brand, the app's version and a link to its repository, then
// the changelog, which scrolls on its own. A sectioned dialog 520px wide (lg): focus held inside it
// and taken first by its close (1.3's), Escape or a press beside it closes it, and focus goes back to
// About. Its text on Settings' 1.5 line; the changelog drawn as 1.3's (./changelog.css).
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { readAbout, type About } from '@/lib/about';
import './changelog.css';

// The GitHub mark: a filled shape of its own (no Lucide drawing), 16px as the close beside it.
const GitHubMark = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="size-[16px] fill-current"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" /></svg>
);

// What it shows, read once as the page shows (so it opens drawn), kept for the page's life.
function useAbout() {
  const [about, setAbout] = useState<About | null>(null);
  useEffect(() => {
    let live = true;
    readAbout().then((read) => { if (live) setAbout(read); });
    return () => { live = false; };
  }, []);
  return about;
}

export function AboutDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const about = useAbout();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent id="aboutBox" size="lg" layout="sectioned" className="leading-[1.5]" initialFocus={() => document.getElementById('aboutClose')}>
        <DialogHeader>
          <div className="about-brand flex min-w-0 items-center gap-[8px]">
            <div className="brand-icon"><img alt="" src="icons/shiori-logo.svg" /></div>
            <DialogTitle id="aboutTitle" className="flex-none tracking-[-0.3px] text-primary">Shiori</DialogTitle>
            <Badge id="aboutVersion" size="sm">{about?.version ?? ''}</Badge>
          </div>
          <div className="flex shrink-0 items-center gap-[4px]">
            <Button id="aboutRepo" variant="ghost" size="icon" href="https://github.com/hikarin-dev/shiori/" target="_blank" rel="noopener noreferrer" data-tip="GitHub" aria-label="GitHub">
              <GitHubMark />
            </Button>
            <DialogClose id="aboutClose" />
          </div>
        </DialogHeader>
        <DialogBody id="aboutChangelog" className="changelog" dangerouslySetInnerHTML={{ __html: about?.changelog ?? '' }} />
      </DialogContent>
    </Dialog>
  );
}
