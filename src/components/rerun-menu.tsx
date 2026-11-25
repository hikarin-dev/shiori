// "Re-run from…" (1.3's app/js/rerun-menu.js) on the design system's Menu: under a translated card's
// translate button that was right-clicked, 6px below it (above it where the window has no room), each
// step with what choosing it would do (how many pages have what it needs, or why it can't be used),
// the steps that can't be used drawn off. A step chosen closes it and asks the card's question; Escape,
// a press outside, a scroll or a resize close it, focus going back to the button.
import * as api from '@lib/api.js';
import { RERUN_POINTS, rerunAvailability } from '@lib/page-data.js';
import { rerunLabel, rerunStatus } from '@lib/rerun-menu.js';
import { Menu, MenuContent, MenuGroup, MenuItem, MenuTitle } from '@/components/ui/menu';
import type { Translate } from '@/lib/i18n';

export type RerunAsk = { id: string; anchor: HTMLElement; steps: { point: string; label: string; enabled: boolean; text: string }[] };

// What the menu offers for the gallery `id`: each step and whether its pages have what it needs.
export async function rerunSteps(id: string, anchor: HTMLElement): Promise<RerunAsk> {
  const records = ((await api.pages.all(id)) as { blob?: unknown; dataUrl?: unknown }[]).filter((r) => r.blob ?? r.dataUrl);
  const availability = rerunAvailability(records as never) as Record<string, { pages: number; ready: number }>;
  return {
    id, anchor,
    steps: Object.keys(RERUN_POINTS).map((point) => ({ point, label: rerunLabel(point) as string, ...(rerunStatus(availability[point]) as { enabled: boolean; text: string }) })),
  };
}

export function RerunMenu({ t, ask, onPick, onClose }: { t: Translate; ask: RerunAsk | null; onPick: (id: string, point: string, label: string) => void; onClose: () => void }) {
  return (
    <Menu open={!!ask} onOpenChange={(open) => { if (!open) onClose(); }}>
      {ask && (
        <MenuContent anchor={ask.anchor} sideOffset={6} className="rerun-menu" finalFocus={() => ask.anchor}>
          <MenuGroup>
            <MenuTitle>{t('rerun.title')}</MenuTitle>
            {ask.steps.map((step) => (
              <MenuItem key={step.point} disabled={!step.enabled} detail={step.text} data-point={step.point} onClick={() => onPick(ask.id, step.point, step.label)}>
                {step.label}
              </MenuItem>
            ))}
          </MenuGroup>
        </MenuContent>
      )}
    </Menu>
  );
}
