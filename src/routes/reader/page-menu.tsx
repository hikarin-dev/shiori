// reader/page-menu.tsx — the reader's right-click menu for one page (1.3's app/js/reader-page-menu.js
// drew it by hand): the app's menu at the pointer (opened from code at the right-click's point, which the
// reader's own script takes), slid back inside the window, with what the
// engine asked for (./page-menu-store.ts): its title, then each item with its detail line, its key cap,
// disabled while it can't be used. The keyboard is the menu's (the arrows, which wrap, Home, End, typing,
// Enter, Escape); it closes on a choice, Escape, a press outside, a scroll, a resize (the Menu's own) or
// the window losing focus (here, as 1.3's did). Fetched on the first right-click.
import { useEffect, useSyncExternalStore } from 'react';
import { Menu, MenuContent, MenuGroup, MenuItem, MenuTitle } from '@/components/ui/menu';
import { closeMenu, getAsk, pick, subscribe } from './page-menu-store';

export default function PageMenu() {
  const ask = useSyncExternalStore(subscribe, getAsk);
  useEffect(() => {
    if (!ask) return;
    // A key the menu does not use reaches the reader (the side arrows, Space), which takes the focus off
    // the menu as it does after any press of the pointer. The menu stays open, and as 1.3's did it still
    // takes Escape (closing it, the reader hearing nothing) and the arrows, Home and End (back to its
    // first or last item).
    const onKey = (e: KeyboardEvent) => {
      const popup = document.querySelector<HTMLElement>('[data-reader-part="page-menu"]');
      if (!popup || popup.contains(document.activeElement)) return;   // its own keys: the Menu's
      const items = [...popup.querySelectorAll<HTMLElement>('[role="menuitem"]')];
      const to = e.key === 'ArrowDown' || e.key === 'Home' ? items[0] : e.key === 'ArrowUp' || e.key === 'End' ? items.at(-1) : null;
      if (e.key !== 'Escape' && !to) return;
      e.preventDefault();
      e.stopPropagation();
      if (to) to.focus(); else closeMenu();
    };
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', closeMenu);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', closeMenu);
    };
  }, [ask]);
  return (
    <Menu open={!!ask} onOpenChange={(open) => { if (!open) closeMenu(); }}>
      {ask && (
        <MenuContent key={ask.id} point={ask} className="min-w-[220px] [&_kbd]:bg-reader-background" data-reader-part="page-menu">
          <MenuGroup>
            <MenuTitle>{ask.title}</MenuTitle>
            {ask.items.map((item, i) => (
              <MenuItem key={i} disabled={item.disabled} detail={item.detail} shortcut={item.kbd} onClick={() => pick(item)}>{item.label}</MenuItem>
            ))}
          </MenuGroup>
        </MenuContent>
      )}
    </Menu>
  );
}
