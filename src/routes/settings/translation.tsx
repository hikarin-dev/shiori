// Settings → Translation: the server (its address and token, its status, Check), the config (the
// pipeline's models step by step, the target language, Study data, snapshots, and the advanced window
// with every option the server offers), and the benchmark for a local server that answers. Everything
// saves as it changes, said for 2.5 s in the status line of the section (or window) the change came
// from. What is stored is 1.3's to the byte (app/js/translate-settings.js);
// the panel's flow is src/lib/translation-store.ts.
//
// Drawn as 1.3's: the status pill at the server header's end; the pipeline a row of
// equal steps joined by chevrons (one under the other in a panel of 480px or less), each step's name
// a small heading over its model's box, its tip the stage's options; the advanced window 760 wide, its
// options two to a row (one at 520px of window or less), "Pipeline details" folding away all but the
// translator's, the clearing presets and the grouped options. §5.3 S01/S06: every box 36 (Settings'
// 38, the step boxes ≈33); S13: the buttons' icons 14 and 16; F11: the window's ticks the app's
// checkbox; F18: the headings the Eyebrow's, the fold's glyph a chevron; F38: the (i) shows the
// keyboard ring, the status lines fade by colour.
import { useEffect, useId, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ChevronRight, RefreshCw, SlidersHorizontal } from 'lucide-react';
import * as platform from '@lib/platform.js';
import * as rules from '@lib/translate-settings.js';
import { DEFAULT_PRICES, capsNote, optionLabel, presetChoices, stepLabel, stepTip, targetLanguageParam, unavailableChoice } from '@lib/translate-settings.js';
import { hasConfiguredServer, pingServer, serverUrlFromSettings } from '@lib/translate.js';
import { cachedCapabilities, getCapabilities } from '@lib/capabilities.js';
import { GROUP_HEADING_KEYS, settingsModel } from '@lib/translate-config.js';
import * as notice from '@lib/notice.js';
import { Alert, StatusText } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible } from '@/components/ui/collapsible';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { InfoTip } from '@/components/ui/info-tip';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Select, type SelectOption } from '@/components/ui/select';
import { SettingRow } from '@/components/ui/setting-row';
import { Switch } from '@/components/ui/switch';
import { Eyebrow } from '@/components/ui/text';
import { Textarea } from '@/components/ui/textarea';
import { useT, type Translate } from '@/lib/i18n';
import { createTranslationStore, type Control, type Fields, type Saved, type TranslationStore } from '@/lib/translation-store';
import { cn } from '@/lib/utils';
import { BenchmarkSection } from './benchmark';
import { Section, SectionStatus, useStatus } from './parts';

type Choice = { value: unknown; label: string; short?: string | null; version?: string; available?: boolean; missing?: boolean };
type Param = { key: string; type: string; value: unknown; label?: string; labelKey?: string | null; choices?: Choice[]; primary?: boolean; group?: string;
  multiline?: boolean; placeholder?: string; min?: number; max?: number; step?: number; integer?: boolean };
type Stage = { id: string; label: string; headingKey: string | null; implParam: string; implLabelKey: string | null; stepKey: string | null; value: unknown; choices: Choice[]; params: Param[] };
type Model = { offline: boolean; stages: Stage[]; presets: { id: string; label: string }[]; preset?: string; batching: { translator: string; label: string; value: number }[]; problems: { value: unknown }[] };

// App-owned presentation: which implementation choices span the whole window, and each pipeline step's
// icon (a stage the app doesn't know gets the scan icon). As 1.3's.
const WIDE_STAGES = new Set(['translate', 'ocr']);
const SCAN_ICON = 'M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2';
const STEP_ICONS: Record<string, string> = {
  detect: SCAN_ICON,
  ocr: `${SCAN_ICON}M7 8h8M7 12h10M7 16h6`,
  translate: 'M5 8l6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6',
  inpaint: 'M7 21l-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21M22 21H7M5 11l9 9',
  render: 'M4 7V4h16v3M9 20h6M12 4v16',
};

const json = (value: unknown) => JSON.stringify(value);

// A choice list as a select's options: each value as its JSON (numbers stay numbers), the label saying
// when it can't be run or isn't offered, its tip the full name (a step) or the version.
function choiceOptions(choices: Choice[], t: Translate, { step = false } = {}): SelectOption[] {
  return choices.map((choice) => {
    const unavailable = unavailableChoice(choice);
    return {
      value: json(choice.value),
      label: step ? stepLabel(choice) : optionLabel(choice, unavailable, t),
      title: step ? optionLabel(choice, unavailable, t) : choice.version ? t('tm.version', { version: choice.version }) : undefined,
      disabled: unavailable,
    };
  });
}

// A box committed as 1.3's were: on the browser's own change (the box left, Enter, a step of a
// number's arrows), not as each key is typed.
function onCommit(commit: (el: HTMLInputElement | HTMLTextAreaElement) => void) {
  let current: HTMLInputElement | HTMLTextAreaElement | null = null;
  const changed = (e: Event) => commit(e.currentTarget as HTMLInputElement);
  return (el: HTMLInputElement | HTMLTextAreaElement | null) => {
    current?.removeEventListener('change', changed);
    current = el;
    el?.addEventListener('change', changed);
  };
}

// notice.js's confirmation (drawn by the notice host, over this window).
const confirmNotice = notice.confirmDialog as unknown as (options: { title: string; body: string; ok: string }) => Promise<boolean>;

type Show = (text: string, tone?: 'ok' | 'err') => void;
// A save's outcome said in a status line.
const say = (show: Show) => (saved: Saved) => { if (saved) show(saved.text, saved.tone); };

function useStore(): [TranslationStore, ReturnType<TranslationStore['get']>] {
  const t = useT();
  const [store] = useState(() => createTranslationStore({
    rules: { ...rules, hasConfiguredServer, serverUrlFromSettings },
    kv: platform.kv,
    ping: pingServer,
    getCapabilities: getCapabilities as never,
    cachedCapabilities: cachedCapabilities as never,
    saved: () => t('common.saved'),
  }));
  useEffect(() => { store.start(); return () => store.stop(); }, [store]);
  return [store, useSyncExternalStore(store.subscribe, store.get)];
}

export function TranslationPanel() {
  const t = useT();
  const [store, state] = useStore();
  const [server, showServer] = useStatus();
  const [config, showConfig] = useStatus();
  const [modal, showModal] = useStatus();
  const [open, setOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);   // kept while the page shows, as 1.3's
  const model = useMemo(() => settingsModel(state.caps, state.settings) as unknown as Model, [state.caps, state.settings]);
  const { fields } = state;
  const set = <K extends keyof Fields>(key: K, show: Show) => (value: Fields[K]) => { store.setField(key, value); say(show)(store.commit(key)); };
  const busy = state.badge === 'checking';
  const target = model.offline ? null : targetLanguageParam(model) as unknown as Param | null;
  // The server's address and token are saved, and the connection checked again, once committed.
  const commitAddress = useMemo(() => onCommit(() => say(showServer)(store.commit('serverUrl'))), [store, showServer]);
  const commitToken = useMemo(() => onCommit(() => say(showServer)(store.commit('serverToken'))), [store, showServer]);

  return (
    <>
      <Section title={t('set.tr_server')} aside={(
        <Badge id="translateStatusBadge" variant="status" tone={state.badge === 'online' ? 'success' : 'warning'} role="status" data-state={state.badge}
          className={cn('key-status-badge ml-auto -my-[3px]', state.badge === 'online' ? 'set' : 'unset')}>
          {t(state.badge === 'checking' ? 'set.tr_checking' : state.badge === 'online' ? 'set.tr_online' : 'set.tr_offline')}
        </Badge>
      )}>
        <SettingRow label={t('set.tr_server_url')} description={t('set.tr_server_desc')} control={(
          <InputGroup>
            <InputGroupInput id="translateServerInput" type="text" placeholder="http://127.0.0.1:5003" autoComplete="off" spellCheck={false} aria-label={t('set.tr_server_url')}
              value={fields.serverUrl} onChange={(e) => store.setField('serverUrl', e.currentTarget.value)} ref={commitAddress} />
            <InputGroupButton id="checkTranslateBtn" data-tip={t('set.tr_check')} aria-label={t('set.tr_check')} aria-busy={busy} onClick={() => store.check()}>
              <RefreshCw aria-hidden strokeWidth={2} />
            </InputGroupButton>
          </InputGroup>
        )} />
        <SettingRow label={t('set.tr_token')} description={t('set.tr_token_desc')} control={(
          <Input id="translateTokenInput" type="password" autoComplete="off" spellCheck={false}
            value={fields.serverToken} onChange={(e) => store.setField('serverToken', e.currentTarget.value)} ref={commitToken} />
        )} />
        <SectionStatus id="translateServerStatus" status={server} />
      </Section>

      <Section title={t('set.translation')}>
        <Pipeline model={model} onChoose={(control) => say(showConfig)(store.apply(control, { redraw: true }))} />
        {target && (
          <SettingRow id="translateLanguageField" label={target.labelKey ? t(target.labelKey) : target.label} description={t('set.tr_lang_desc')} control={(
            <Select id="translateLanguage" data-param={target.key} data-value={json(target.value)} options={choiceOptions(target.choices ?? [], t)} value={json(target.value)}
              onValueChange={(value) => say(showConfig)(store.apply({ param: target.key, type: 'select', value }, { redraw: true }))} />
          )} />
        )}
        <SettingRow label={t('set.study_gen')} description={t('set.study_gen_desc')} control={(
          <Select id="studyModeGeneration" data-value={fields.studyModeGeneration} value={fields.studyModeGeneration} onValueChange={set('studyModeGeneration', showConfig)}
            options={[{ value: 'disabled', label: t('set.study_gen_off') }, { value: 'text_only', label: t('set.study_gen_text') }, { value: 'text_and_image', label: t('set.study_gen_full') }]} />
        )} />
        <SettingRow kind="switch" label={<>{t('set.snapshots')}<InfoTip tip={t('set.snapshots_info')} /></>} description={t('set.snapshots_desc')}
          control={<Switch id="translateSaveSnapshots" aria-label={t('set.snapshots')} checked={fields.saveSnapshots} onCheckedChange={set('saveSnapshots', showConfig)} />} />
        <SettingRow kind="switch" sub label={t('set.snapshots_revert')} description={t('set.snapshots_revert_desc')}
          control={<Switch id="translateKeepSnapshots" checked={fields.keepSnapshotsOnRevert} onCheckedChange={set('keepSnapshotsOnRevert', showConfig)} />} />
        <div className={cn('translate-advanced flex justify-end border-0 border-t border-solid border-border px-[20px] py-[10px]', '@max-[480.02px]/settings-panel:px-[15px]')}>
          <Button id="openTranslateModalBtn" variant="subtle" size="sm" aria-haspopup="dialog" onClick={() => setOpen(true)}>
            <SlidersHorizontal aria-hidden strokeWidth={2} /><span>{t('set.tr_modal_btn')}</span>
          </Button>
        </div>
        <SectionStatus id="translateStatus" status={config} />
      </Section>

      <BenchmarkSection offered={state.benchmark} />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent id="translateBox" size="2xl" layout="sectioned" initialFocus={() => document.getElementById('translateClose')}>
          <DialogHeader>
            <DialogTitle id="translateTitle">{t('tm.title')}</DialogTitle>
            <DialogClose id="translateClose" />
          </DialogHeader>
          <DialogBody>
            {/* Why the options are missing, stale or partly unavailable (said by the server's answer). */}
            {(() => {
              const note = model.offline ? t('tm.caps_offline') : capsNote(model, state.capsOffline, t);
              return <Alert id="translateCapsNote" role="status" hidden={!note} className="translate-caps-note mb-[12px]">{note}</Alert>;
            })()}
            <Options key={state.drawn} model={model} settings={state.settings} advancedOpen={advancedOpen} onAdvancedOpen={setAdvancedOpen}
              apply={(control) => say(showModal)(store.apply(control))} />
          </DialogBody>
          <DialogFooter>
            <Button id="resetTranslateBtn" disabled={model.offline} onClick={async () => {
              if (!(await confirmNotice({ title: t('dlg.trreset_title'), body: t('dlg.trreset_body'), ok: t('common.reset') }))) return;
              say(showModal)(store.reset());
            }}>{t('tm.reset_defaults')}</Button>
            <StatusText id="translateModalStatus" className="modal-status flex-auto max-[520.02px]:order-3 max-[520.02px]:basis-full max-[520.02px]:text-left"
              tone={modal.tone} shown={modal.shown}>{modal.text}</StatusText>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// The pipeline, one step per stage of the server's, joined by chevrons: each step's name over its
// model's box (a mirror of the advanced window's choice), its tip the full name and the stage's other
// options. With nothing known of the server, a line saying to connect to one.
function Pipeline({ model, onChoose }: { model: Model; onChoose: (control: Control) => void }) {
  const t = useT();
  const ids = useId();
  const stages = model.stages;
  return (
    <div id="translateSummary" className={cn('translate-summary grid items-end gap-x-[4px] gap-y-[8px] border-0 border-b border-solid border-border px-[20px] py-[17px] tabular-nums',
      '@max-[480.02px]/settings-panel:p-[15px] @max-[480.02px]/settings-panel:grid-cols-[minmax(0,1fr)]!')}
      style={{ gridTemplateColumns: model.offline ? undefined : `minmax(0, 1fr)${' auto minmax(0, 1fr)'.repeat(Math.max(0, stages.length - 1))}` }}>
      {model.offline
        ? <div className="translate-summary-offline col-span-full text-11 leading-[1.5] text-muted-foreground">{t('tm.caps_offline')}</div>
        : stages.flatMap((stage, i) => {
          const name = `${ids}-${stage.id}`;
          const step = (
            <div key={stage.id} className="translate-step grid min-w-0 gap-y-[6px]" data-tip={stepTip(stage, t)}>
              <span className="translate-step-head flex min-w-0 items-center gap-[6px] pl-[1px]">
                <svg className="translate-step-icon size-[14px] shrink-0 fill-none stroke-current stroke-[1.8] text-muted-foreground [stroke-linecap:round] [stroke-linejoin:round]" viewBox="0 0 24 24" aria-hidden="true">
                  <path d={STEP_ICONS[stage.id] || SCAN_ICON} />
                </svg>
                {/* (This face's capitals sit just above their line's middle: 1px down lines them up with the icon.) */}
                <Eyebrow as="span" id={name} tone="dim" className="translate-step-name mt-[1px] min-w-0 truncate leading-none">{stage.stepKey ? t(stage.stepKey) : stage.label}</Eyebrow>
              </span>
              <Select id={`step-${stage.id}`} data-param={stage.implParam} data-value={json(stage.value)} aria-labelledby={name} className="translate-step-select"
                options={choiceOptions(stage.choices, t, { step: true })} value={json(stage.value)}
                onValueChange={(value) => onChoose({ param: stage.implParam, type: 'select', value })} />
            </div>
          );
          if (!i) return [step];
          // Centred on the model's box (36 tall: 11px up from its foot).
          return [<ChevronRight key={`${stage.id}-sep`} aria-hidden strokeWidth={2}
            className="translate-step-sep mb-[11px] size-[14px] shrink-0 text-muted-dim @max-[480.02px]/settings-panel:m-0 @max-[480.02px]/settings-panel:justify-self-center @max-[480.02px]/settings-panel:rotate-90" />, step];
        })}
    </div>
  );
}

// ── The advanced window's options ─────────────────────────────────────────────────────────────

const FIELD = 'tcfg-field flex min-w-0 flex-col gap-[5px]';
const WIDE = 'tcfg-wide col-span-full';
const LABEL = 'min-w-0 text-10.5 leading-[1.45] text-muted-foreground [overflow-wrap:anywhere]';

function Heading({ children, first }: { children: ReactNode; first?: boolean }) {
  return (
    <Eyebrow as="h3" size="sm" tone="warning" className={cn('tcfg-h col-span-full min-w-0 border-0 border-b border-solid border-border pb-[6px] leading-[1.45] [overflow-wrap:anywhere]', !first && 'mt-[9px]')}>
      {children}
    </Eyebrow>
  );
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: (id: string) => ReactNode }) {
  const id = `tp-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <div className={cn(FIELD, wide && WIDE)}>
      <label className={LABEL} htmlFor={id} id={`${id}-label`}>{label}</label>
      {children(id)}
    </div>
  );
}

// A box of the window, committed on the browser's change.
function TextBox({ id, param, multiline, number, value, apply, ...rest }: {
  id: string; param?: string; multiline?: boolean; number?: { min?: number; max?: number; step?: number; integer?: boolean }; value: unknown;
  apply: (el: HTMLInputElement | HTMLTextAreaElement) => void; placeholder?: string; 'data-batch'?: string;
}) {
  const ref = useMemo(() => onCommit(apply), [apply]);
  if (multiline) return <Textarea id={id} data-param={param} rows={3} spellCheck={false} defaultValue={String(value ?? '')} ref={ref} className="tcfg-textarea" {...rest} />;
  return (
    <Input id={id} data-param={param} type={number ? 'number' : 'text'} spellCheck={number ? undefined : false}
      min={number?.min} max={number?.max} step={number?.step} data-integer={number ? (number.integer ? '1' : '') : undefined}
      defaultValue={String(value ?? '')} ref={ref} {...rest} />
  );
}

function ParamControl({ p, apply }: { p: Param; apply: (control: Control) => void }) {
  const t = useT();
  const label = p.labelKey ? t(p.labelKey) : p.label ?? p.key;
  const commit = useMemo(() => (el: HTMLInputElement | HTMLTextAreaElement) =>
    apply({ param: p.key, type: p.type === 'number' ? 'number' : 'text', value: el.value, integer: !!p.integer }), [apply, p.key, p.type, p.integer]);
  if (p.type === 'bool') {
    return (
      <div className={cn(FIELD, 'tcfg-check flex-row items-center', p.group && WIDE)}>
        <label className="flex items-start gap-[7px] text-11 text-foreground">
          <Checkbox data-param={p.key} className="mt-[2px]" checked={!!p.value} onCheckedChange={(checked) => apply({ param: p.key, type: 'checkbox', checked })} />
          <span>{label}</span>
        </label>
      </div>
    );
  }
  if (p.type === 'enum' || p.type === 'language') {
    return (
      <Field label={label} wide={!!(p.primary || p.group)}>
        {(id) => <Select id={id} data-param={p.key} data-value={json(p.value)} aria-labelledby={`${id}-label`} options={choiceOptions(p.choices ?? [], t)} value={json(p.value)}
          onValueChange={(value) => apply({ param: p.key, type: 'select', value })} />}
      </Field>
    );
  }
  return (
    <Field label={label} wide={!!(p.primary || p.group || p.multiline)}>
      {(id) => <TextBox id={id} param={p.key} multiline={p.multiline} value={p.value} placeholder={p.placeholder} apply={commit}
        number={p.type === 'number' ? { min: p.min ?? undefined, max: p.max ?? undefined, step: p.step ?? undefined, integer: p.integer } : undefined} />}
    </Field>
  );
}

function NumberBox({ label, id, value, step = 1, min, apply, batch }: { label: string; id: string; value: unknown; step?: number; min?: number; apply: (value: string) => void; batch?: string }) {
  const commit = useMemo(() => (el: HTMLInputElement | HTMLTextAreaElement) => apply(el.value), [apply]);
  return (
    <div className={FIELD}>
      <label className={LABEL} htmlFor={id}>{label}</label>
      <TextBox id={id} value={value} number={{ step, min }} apply={commit} data-batch={batch} />
    </div>
  );
}

// The window's options as 1.3 laid them out: the translator (its engine and primary options), the
// clearing presets, the grouped options under their headings, then "Pipeline details": every other
// stage's model and options, the translator's other options, the batch caps and the cost.
function Options({ model, settings, advancedOpen, onAdvancedOpen, apply }: {
  model: Model; settings: Record<string, unknown>; advancedOpen: boolean; onAdvancedOpen: (open: boolean) => void; apply: (control: Control) => void;
}) {
  const t = useT();
  if (model.offline) return <div id="tcfgGrid" className="tcfg-grid" />;
  const byId = new Map(model.stages.map((s) => [s.id, s]));
  const implField = (stage: Stage) => (
    <Field key={`impl-${stage.id}`} label={stage.implLabelKey ? t(stage.implLabelKey) : stage.label} wide={WIDE_STAGES.has(stage.id)}>
      {(id) => <Select id={id} data-param={stage.implParam} data-value={json(stage.value)} aria-labelledby={`${id}-label`} options={choiceOptions(stage.choices, t)} value={json(stage.value)}
        onValueChange={(value) => apply({ param: stage.implParam, type: 'select', value })} />}
    </Field>
  );
  const stageHeading = (stage: Stage, first = false) => <Heading key={`h-${stage.id}`} first={first}>{stage.headingKey ? t(stage.headingKey) : stage.label}</Heading>;
  const params = (list: Param[]) => list.map((p) => <ParamControl key={p.key} p={p} apply={apply} />);
  const translate = byId.get('translate');
  const groups = new Map<string, Param[]>();
  for (const stage of model.stages) for (const p of stage.params) if (p.group) {
    if (!groups.has(p.group)) groups.set(p.group, []);
    groups.get(p.group)!.push(p);
  }
  const grid = 'grid min-w-0 grid-cols-2 gap-x-[16px] gap-y-[13px] max-[520.02px]:grid-cols-1';
  const cost = { priceIn: settings.priceIn ?? DEFAULT_PRICES.priceIn, priceOut: settings.priceOut ?? DEFAULT_PRICES.priceOut };
  return (
    <div id="tcfgGrid" className={cn('tcfg-grid', grid)}>
      {translate && [stageHeading(translate, true), implField(translate), ...params(translate.params.filter((p) => p.primary && !p.group))]}
      {model.presets.length > 0 && (
        <Field label={t('tm.clearing')} wide>
          {(id) => <Select id={id} data-preset="1" data-value={json(model.preset)} aria-labelledby={`${id}-label`} options={presetChoices(model, t).map((c: { value: string; label: string }) => ({ value: json(c.value), label: c.label }))}
            value={json(model.preset)} onValueChange={(value) => apply({ preset: JSON.parse(value) })} />}
        </Field>
      )}
      {[...groups].map(([group, list], i) => [
        <Heading key={`g-${group}`} first={!i && !translate && model.presets.length === 0}>{(GROUP_HEADING_KEYS as Record<string, string>)[group] ? t((GROUP_HEADING_KEYS as Record<string, string>)[group]) : group}</Heading>,
        ...params(list),
      ])}
      <Collapsible variant="group" title={t('tm.advanced')} open={advancedOpen} onOpenChange={onAdvancedOpen} className="col-span-full mt-[9px] min-w-0"
        triggerProps={{ id: 'cfgAdvancedHeader' }} panelClassName={cn(grid, 'mt-[13px] [&[hidden]]:hidden')}>
        {model.stages.filter((stage) => stage.id !== 'translate').flatMap((stage) => [stageHeading(stage), implField(stage), ...params(stage.params.filter((p) => !p.group))])}
        {params((translate?.params ?? []).filter((p) => !p.primary && !p.group))}
        {model.batching.length > 0 && [
          <Heading key="h-batch">{t('tm.batch')}</Heading>,
          <div key="batch-note" className="tcfg-note col-span-full -mt-[2px] mb-[2px] min-w-0 text-10.5 leading-[1.55] text-muted-foreground [overflow-wrap:anywhere]">{t('tm.batch_note')}</div>,
          ...model.batching.map((b) => <NumberBox key={b.translator} label={b.label} id={`cfgCap-${b.translator}`} value={b.value} min={1} batch={b.translator}
            apply={(value) => apply({ batch: b.translator, value })} />),
        ]}
        <Heading key="h-cost">{t('tm.cost')}</Heading>
        <NumberBox label={t('tm.price_in')} id="cfgPriceIn" value={cost.priceIn} step={0.01} min={0} apply={(value) => apply({ price: 'in', value })} />
        <NumberBox label={t('tm.price_out')} id="cfgPriceOut" value={cost.priceOut} step={0.01} min={0} apply={(value) => apply({ price: 'out', value })} />
      </Collapsible>
    </div>
  );
}

