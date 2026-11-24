// What Settings' panels are made of (src/routes/settings.tsx): the page's preferences, a section,
// and a section's status line.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import * as platform from '@lib/platform.js';
import { SETTINGS_PREFS } from '@lib/settings-prefs.js';
import { Card, CardHeader } from '@/components/ui/card';
import { StatusText } from '@/components/ui/alert';
import { CardTitle } from '@/components/ui/text';
import { createPrefs, type Pref } from '@/lib/prefs';
import { cn } from '@/lib/utils';

// The page's preferences: every key read before the page is first drawn (this module is part of the
// route's chunk, which the router waits for), so a control shows its saved value from the first paint.
// The page starts the store while it shows (other tabs' changes followed) and stops it when left.
export const prefs = createPrefs(platform.kv, SETTINGS_PREFS as unknown as Record<string, Pref>);
await prefs.load();

export type PrefKey = keyof typeof SETTINGS_PREFS;

// What the control for `key` shows, and how it is changed (stored as the table writes it).
export function usePref<T extends boolean | string>(key: PrefKey): [T, (value: T) => void] {
  const value = useSyncExternalStore(prefs.subscribe, () => prefs.get(key)) as T;
  return [value, useCallback((next: T) => prefs.set(key, next), [key])];
}

export type Status = { text: string; tone: 'ok' | 'err'; shown: boolean };
export const STATUS_MS = 2500;   // a status line shows this long, as 1.3's showStatus

// A section's status line: show(text) shows it for 2.5 s, or `ms` (again from the start if shown
// already); no text hides it at once.
export function useStatus(ms = STATUS_MS): [Status, (text: string, tone?: 'ok' | 'err') => void] {
  const [status, setStatus] = useState<Status>({ text: '', tone: 'ok', shown: false });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = useCallback((text: string, tone: 'ok' | 'err' = 'ok') => {
    setStatus({ text, tone, shown: !!text });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus((s) => ({ ...s, shown: false })), ms);
  }, [ms]);
  return [status, show];
}

// The status line at a section's foot (StatusText, place section), by the id 1.3 gave it.
export const SectionStatus = ({ id, status }: { id: string; status: Status }) => (
  <StatusText id={id} place="section" tone={status.tone} shown={status.shown}>{status.text}</StatusText>
);

// A Settings section: a card with its title in a ruled header, then its rows; 24px under it. `aside`:
// what else its header holds (a status pill), at the header's end.
export function Section({ title, id, hidden, className, aside, children }: { title: ReactNode; id?: string; hidden?: boolean; className?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <Card id={id} hidden={hidden} className={cn('section mb-[24px]', className)}>
      <CardHeader><CardTitle>{title}</CardTitle>{aside}</CardHeader>
      {children}
    </Card>
  );
}
