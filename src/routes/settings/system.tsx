// Settings → System, in the desktop app's window only: closing to the tray; the connection (the local
// server's address, its port, other devices on the network and the addresses they open, the sites
// allowed); the add-ons its windows run; updates (where one stands, Check, Restart to update, developer
// mode); the app's version and data folder. Every setting is the desktop app's own, read and changed
// through the window's bridge (app/js/system-settings.js): the same calls
// with the same arguments in the same order as 1.3's page made them, the same question after a change of
// the port or the network, an update followed every 700 ms while one is under way.
//
// Drawn as 1.3's: each a section of rows; a list (the addresses, the
// sites, the add-ons) a block of rows of its own, not ruled apart; the update's state as its row's name.
// §5.3 S01/S04/S11/S20: the port's box 36 (38), the small buttons 28 (30) at 11px, Restart to update 36
// on a 20px line at 12px.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { addOnName, portChoices, restart, shell, updateView, UPDATE_FOLLOW_MS } from '@lib/system-settings.js';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { SettingRow } from '@/components/ui/setting-row';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Section } from './parts';

type Update = { status: string; version?: string; percent?: number; error?: string };
type AddOn = { name?: string; version?: string; dir: string; error?: string };
type State = {
  closeToTray: boolean; url: string; port: number; ports: number[]; lan: boolean; lanUrls?: string[] | null;
  sites: string[]; extensions: AddOn[]; version: string; dataDir: string; devUpdates: boolean; devFeed: string; update?: Update;
};
type Ask = (action: string, ...args: unknown[]) => Promise<unknown>;
const ask = shell as Ask;
// A state the panel can draw. 1.3 drew it from a module of its own, whose failure left the rest of the
// page as it was (its panel with no values in it): one it can't draw is not taken, so nothing else of
// the page goes with it.
const whole = (s: unknown): s is State => {
  const v = s as State | null;
  return !!v && Array.isArray(v.ports) && Array.isArray(v.sites) && Array.isArray(v.extensions);
};

// A row of a list: not ruled off from the one before it (1.3's lists were blocks of their own).
const LISTED = '[[data-kind=action]+&]:border-t-0';
const CODE = '[overflow-wrap:anywhere]';
// The phone form (SettingRow's: the panel 480px wide or less): a row's buttons take its whole width.
const PHONE_FILL = '@max-[480.02px]/settings-panel:grow';

export function SystemPanel() {
  const t = useT();
  const [state, setState] = useState<State | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    (ask('state') as Promise<State>).then((s) => { if (live.current && whole(s)) setState(s); });
    return () => { live.current = false; };
  }, []);

  // The update's progress, followed while something is under way: asked for again 700 ms after a
  // drawing finds it so, once at a time.
  const following = useRef<ReturnType<typeof setTimeout> | null>(null);
  const update = updateView(state?.update) as { text: string; ready: boolean; busy: boolean };
  useEffect(() => {
    if (!state || !update.busy || following.current) return;
    following.current = setTimeout(async () => {
      following.current = null;
      const next = await ask('updateState') as Update;
      if (live.current) setState((s) => s && { ...s, update: next });
    }, UPDATE_FOLLOW_MS);
  });
  useEffect(() => () => { if (following.current) clearTimeout(following.current); }, []);

  if (!state) return null;
  // Each change: what the bridge says the state is after it.
  const set = async (key: string, value: unknown) => { const next = await ask('set', key, value); if (live.current && whole(next)) setState(next); };
  const replaced = async (action: string, ...args: unknown[]) => { const next = await ask(action, ...args); if (live.current && whole(next)) setState(next); };
  // Both look for an update at once: followed from the start.
  const followCheck = () => setState((s) => s && { ...s, update: { status: 'checking' } });
  // (Shown as chosen at once, as 1.3's own controls were, before the bridge answers.)
  const shown = (patch: Partial<State>) => setState((s) => s && { ...s, ...patch });

  const row = (name: ReactNode, desc: ReactNode, control?: ReactNode, listed = false, key?: string) => (
    <SettingRow key={key} kind="action" className={listed ? LISTED : undefined} label={name} description={desc} control={control} />
  );

  return (
    <>
      <Section title={t('set.desk_window')}>
        <SettingRow kind="switch" label={t('set.desk_tray')} description={t('set.desk_tray_desc')}
          control={<Switch id="deskTray" checked={state.closeToTray}
            onCheckedChange={(on) => { shown({ closeToTray: on }); set('closeToTray', on); }} />} />
      </Section>

      <Section title={t('set.desk_connection')}>
        {row(t('set.desk_server'), <code id="deskServerUrl" className={CODE}>{state.url}</code>)}
        <SettingRow label={t('set.desk_port')} description={<span id="deskPortDesc">{t('set.desk_port_desc', { port: state.ports[0] })}</span>}
          control={<Select id="deskPort" data-value={String(state.port)} value={String(state.port)}
            options={portChoices(state).map(({ value, label }: { value: number; label: number | string }) => ({ value: String(value), label: String(label) }))}
            onValueChange={async (v) => { shown({ port: Number(v) }); await set('port', Number(v)); restart(t('set.desk_restart_port')); }} />} />
        <SettingRow kind="switch" label={t('set.desk_lan')} description={t('set.desk_lan_desc')}
          control={<Switch id="deskLan" checked={state.lan}
            onCheckedChange={async (on) => { shown({ lan: on }); await set('lan', on); restart(t('set.desk_restart_lan')); }} />} />
        {/* While it is open: the addresses another device opens (none while this computer is on no network). */}
        <div id="deskLanUrls">
          {state.lanUrls && (state.lanUrls.length
            ? row(t('set.desk_lan_at'), state.lanUrls.map((u, i) => <span key={u}>{i > 0 && <br />}<code className={CODE}>{u}</code></span>))
            : row(null, t('set.desk_lan_none')))}
        </div>
        {row(t('set.desk_sites'), t('set.desk_sites_desc'))}
        <div id="deskSites">
          {state.sites.length
            ? state.sites.map((site) => row(<code className={CODE}>{site}</code>, null,
              <Button variant="subtle" size="sm" data-forget={site} onClick={() => replaced('forgetSite', site)}>{t('set.desk_disconnect')}</Button>, true, site))
            : row(null, t('set.desk_sites_none'))}
        </div>
      </Section>

      <Section title={t('set.desk_ext')}>
        {row(null, t('set.desk_ext_desc'), <Button id="deskAddExtension" variant="subtle" size="sm" onClick={() => replaced('addExtension')}>{t('set.desk_ext_add')}</Button>)}
        <div id="deskExtensions">
          {state.extensions.length
            ? state.extensions.map((ext) => row(addOnName(ext),
              ext.error ? t('set.desk_ext_failed', { error: ext.error }) : <code className={CODE}>{ext.dir}</code>,
              <Button variant="subtle" size="sm" data-remove-extension={ext.dir} onClick={() => replaced('removeExtension', ext.dir)}>{t('set.desk_ext_remove')}</Button>, true, ext.dir))
            : row(null, t('set.desk_ext_none'))}
        </div>
      </Section>

      <Section title={t('set.desk_updates')}>
        {row(<span id="deskUpdateStatus">{update.text}</span>, null, (
          // (Its buttons give room as 1.3's did, their words wrapping, so a narrow panel holds both; on
          // the phone form Check alone has the row's width, as every row's one button there.)
          <span className="desk-actions inline-flex min-w-0 gap-[8px]">
            <Button id="deskInstallUpdate" variant="solid" className={cn('shrink', PHONE_FILL)} hidden={!update.ready} onClick={() => ask('installUpdate')}>{t('set.desk_restart_update')}</Button>
            <Button id="deskCheckUpdates" variant="subtle" size="sm" className={cn('shrink', PHONE_FILL)} disabled={update.busy}
              onClick={async () => { const next = await ask('checkUpdates'); if (!live.current) return; if (whole(next)) setState(next); followCheck(); }}>{t('set.desk_check')}</Button>
          </span>
        ))}
        <SettingRow kind="switch" label={t('set.desk_dev')} description={<span id="deskDevDesc">{t('set.desk_dev_desc', { address: state.devFeed })}</span>}
          control={<Switch id="deskDev" checked={state.devUpdates}
            onCheckedChange={async (on) => { shown({ devUpdates: on }); await set('devUpdates', on); if (live.current) followCheck(); }} />} />
      </Section>

      <Section title={t('set.desk_about')}>
        {row(<span id="deskVersion">{t('set.desk_version', { version: state.version })}</span>,
          <><span>{t('set.desk_data_desc')}</span> <code id="deskDataPath" className={CODE}>{state.dataDir}</code></>,
          <Button id="deskOpenData" variant="subtle" size="sm" onClick={() => ask('openDataFolder')}>{t('set.desk_open')}</Button>)}
      </Section>
    </>
  );
}
