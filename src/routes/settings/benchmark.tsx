// Settings → Translation → Benchmark: comparing translation models on the library's own galleries,
// for whoever runs the translation server on this machine (shown only for a local server that
// answers). Load the server's models and the galleries, pick models, galleries and the plan's numbers,
// run it (one job at a time; its progress said as it goes; Stop cancels the job under way), and read
// the report, also compared with an earlier one. Its words are English only, as 1.3's; what they say
// and every figure is app/js/benchmark-view.js's, the run is
// app/js/benchmark.js's.
//
// Drawn as 1.3's: the card's body 20px in; the models a grid of framed lists 220px or
// wider, the galleries a framed list 420 high at most, grouped by tier under sticky heads, a row's
// cover drawn small as it comes into view; the plan's fields a grid 200px or wider. §5.3: its fields
// and select 36 (S06, 34 before), its buttons Settings' small ones (S04), its ticks the app's
// checkbox (F11), the tier filter the menu's checklist (F30), a gallery row's tint 8% (F10). The
// report is a dialog (1.3: a native <dialog>), 1120 wide at most and the window less 16px a side
// (F39), padded 20 (S16), its title 15px (F28) and the corner X (F29); its bars Meter (F38), its
// runs' details the boxed Collapsible (S18: their summary 11px).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { useBlocker } from 'react-router';
import * as api from '@lib/api.js';
import * as notice from '@lib/notice.js';
import { benchmarkCapabilities, benchmarkGalleries, benchmarkSettings, lastBenchmarkReport, runBenchmark as run_ } from '@lib/benchmark.js';
import {
  MODES, NUMBERS, PLAN_FILE_NAME, RECOMMENDED_PAGES, REPORT_TITLE, benchmarkPlan, benchmarkServerSettings, defaultStartInterval, estimateText,
  finishedText, galleryGroups, galleryHidden, galleryMeta, isBenchmarkReport, modelGroups, planFields, reportFileName, reportView, selectedText,
  tierCounts, tierFilterText, tierRange,
} from '@lib/benchmark-view.js';
import { formatCount } from '@lib/format.js';
import { TIERS } from '@lib/page-size.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible } from '@/components/ui/collapsible';
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Menu, MenuCheckboxItem, MenuContent, MenuTrigger } from '@/components/ui/menu';
import { Meter } from '@/components/ui/progress';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { Section } from './parts';

type Report = { schema: string; startedAt: string; status: string; error?: string; runs: unknown[] } & Record<string, unknown>;
type Gallery = { id: string; title: string; pages: number; bytes: number; page?: { tier?: string; w: number; h: number; mp: number } | null };
type Model = { id: string; label: string; checked: boolean; disabled: boolean; reason: string | null };
type Group = { stage: string; legend: string; models: Model[] };
type Table = { headers: string[]; rows: (string | number)[][] };

// (Every description in the card stands 12px over what follows, as 1.3's had it.)
const DESC = 'field-desc mb-[12px] min-w-0 text-11.5 leading-[1.6] text-muted-foreground [overflow-wrap:anywhere]';
// (benchmark.js and benchmark-view.js are typed by what they do with what they are given: their
// callbacks and tables as the page hands and reads them.)
const runBenchmark = run_ as unknown as (plan: unknown, options: { signal: AbortSignal; onProgress: (p: { message: string }) => void; onReport: (r: Report) => void }) => Promise<Report>;
const PLAN_NUMBERS = NUMBERS as unknown as [string, string, number, number, number][];
const confirmNotice = notice.confirmDialog as unknown as (options: { title: string; body: string; ok: string; danger?: boolean }) => Promise<boolean>;

const download = (value: unknown, name: string) => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const jsonFile = async (): Promise<unknown> => new Promise((resolve) => {
  const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json';
  input.onchange = async () => { try { resolve(JSON.parse(await input.files![0].text())); } catch { resolve(null); } };
  input.oncancel = () => resolve(null); input.click();
});

// Covers drawn small as their rows come into view, three at a time, from a thumbnail the library
// already stored; nothing is written. Stopped with the list.
const COVER_W = 36, COVER_H = 50;
function useCovers(list: HTMLElement | null, galleries: Gallery[]) {
  useEffect(() => {
    if (!list) return;
    let live = true, active = 0;
    const queue: HTMLCanvasElement[] = [];
    const draw = async (canvas: HTMLCanvasElement) => {
      const blob = await api.covers.preview(canvas.dataset.id).catch(() => null);
      if (!blob || !live) return;
      const w = Math.round(COVER_W * (devicePixelRatio || 1)), h = Math.round(COVER_H * (devicePixelRatio || 1));
      let bitmap: ImageBitmap;
      try { bitmap = await createImageBitmap(blob, { resizeWidth: w * 2, resizeQuality: 'medium' }); } catch { return; }
      if (!live) { bitmap.close(); return; }
      canvas.width = w; canvas.height = h;
      const s = Math.max(w / bitmap.width, h / bitmap.height);
      canvas.getContext('2d')!.drawImage(bitmap, (w - bitmap.width * s) / 2, 0, bitmap.width * s, bitmap.height * s);
      bitmap.close();
    };
    const pump = () => {
      while (live && active < 3 && queue.length) { active++; draw(queue.shift()!).finally(() => { active--; pump(); }); }
    };
    const observer = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { observer.unobserve(e.target); queue.push(e.target as HTMLCanvasElement); }
      pump();
    }, { root: list, rootMargin: '200px 0px' });
    for (const canvas of list.querySelectorAll<HTMLCanvasElement>('canvas.bench-cover')) observer.observe(canvas);
    return () => { live = false; observer.disconnect(); queue.length = 0; };
  }, [list, galleries]);
}

export function BenchmarkSection({ offered }: { offered: boolean }) {
  const [server, setServer] = useState('');
  const [status, setStatus] = useState('Load models and galleries to configure a benchmark.');
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [groups, setGroups] = useState<Group[]>([]);
  const [galleries, setGalleries] = useState<Gallery[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [tiers, setTiers] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState('sweep');
  const [numbers, setNumbers] = useState<Record<string, string>>(() => Object.fromEntries(PLAN_NUMBERS.map(([key, , value]) => [key, String(value)])));
  const [running, setRunning] = useState(false);
  const [latest, setLatest] = useState<Report | null>(null);
  const [shown, setShown] = useState<{ report: Report; comparison: Report | null } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const [list, setList] = useState<HTMLDivElement | null>(null);
  useCovers(list, galleries);

  useEffect(() => {
    let live = true;
    lastBenchmarkReport().then((r: Report | null) => { if (live && r) setLatest(r); }).catch(() => {});
    // Leaving the page ends a run under way, as closing 1.3's page did.
    return () => { live = false; controller.current?.abort(); };
  }, []);

  // While a run is under way, leaving asks first: the window or tab (the browser's own question, as
  // 1.3), or another page of the app.
  useEffect(() => {
    if (!running) return;
    const unload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [running]);
  const blocker = useBlocker(running);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    confirmNotice({ title: 'Stop the benchmark?', body: 'Leaving this page stops the benchmark and cancels the job under way.', ok: 'Leave', danger: true })
      .then((leave) => (leave ? blocker.proceed() : blocker.reset()));
  }, [blocker]);

  const plan = () => benchmarkPlan({ serverUrl: server, mode, numbers,
    models: Object.fromEntries(groups.map((g) => [g.stage, g.models.filter((m) => m.checked).map((m) => m.id)])),
    galleryIds: galleries.filter((g) => picked.has(g.id)).map((g) => g.id) });

  async function load() {
    setLoading(true); setStatus('Loading…');
    try {
      const settings = benchmarkServerSettings(await benchmarkSettings(), server);
      const [caps, found] = await Promise.all([benchmarkCapabilities(settings), benchmarkGalleries()]);
      setGroups(modelGroups(caps) as Group[]);
      setGalleries(found as Gallery[]);
      setPicked(new Set());
      setNumbers((n) => ({ ...n, minStartIntervalSeconds: String(defaultStartInterval(settings.serverUrl)) }));
      setLoaded(true); setStatus(`${formatCount(found.length)} galleries.`);
    } catch (error) { setStatus((error as Error).message); } finally { setLoading(false); }
  }

  async function run() {
    const abort = controller.current = new AbortController();
    setRunning(true);
    let wake: WakeLockSentinel | undefined;
    try {
      try { wake = await navigator.wakeLock?.request('screen'); } catch {}
      const report = await runBenchmark(plan(), { signal: abort.signal,
        onProgress: (p: { message: string }) => { if (controller.current === abort) setStatus(p.message); },
        onReport: (r: Report) => { if (controller.current === abort) setLatest(r); } }) as Report;
      if (controller.current !== abort) return;
      setLatest(report);
      setStatus(finishedText(report)); setShown({ report, comparison: null });
    } catch (e) { if (controller.current === abort) setStatus((e as Error).message); }
    finally { await wake?.release(); if (controller.current === abort) { controller.current = null; setRunning(false); } }
  }

  async function importPlan() {
    const given = await jsonFile() as Record<string, unknown> | null; if (!given) return;
    const fields = planFields(given, Object.fromEntries(groups.map((g) => [g.stage, g.models])));
    setServer(fields.serverUrl); setMode(fields.mode);
    setNumbers((n) => ({ ...n, ...Object.fromEntries(Object.entries(fields.numbers).map(([k, v]) => [k, String(v)])) }));
    setGroups((all) => all.map((g) => ({ ...g, models: (fields.models[g.stage] as Model[] | undefined) ?? g.models })));
    setPicked(new Set(galleries.filter((g) => fields.galleryIds.includes(g.id)).map((g) => g.id)));
  }

  const current = loaded ? plan() : null;
  const visible = useMemo(() => galleries.filter((g) => !galleryHidden(g, tiers, query)), [galleries, tiers, query]);
  const counts = useMemo(() => tierCounts(galleries), [galleries]);
  const tick = (stage: string, id: string, on: boolean) => setGroups((all) => all.map((g) => (g.stage !== stage ? g : { ...g, models: g.models.map((m) => (m.id === id ? { ...m, checked: on } : m)) })));

  return (
    <Section id="translationBenchmark" title="Benchmark" hidden={!offered} className="scroll-mt-[70px]">
      <div className="flex min-w-0 flex-col p-[20px]">
        <p className={DESC}>Compare translation models on your stored galleries. Each job runs alone after a warm-up and cooldown. Results include timing, page resolution and server metrics. Generated pages leave your saved translations unchanged.</p>
        <label className="benchmark-server my-[16px] block text-12">Benchmark server (blank uses saved Translation server)
          <Input variant="inset" type="url" placeholder="Use saved server" className="mt-[6px] block" value={server} disabled={running} onChange={(e) => setServer(e.currentTarget.value)} />
        </label>
        <Button id="benchmarkLoad" variant="subtle" size="sm" disabled={loading || running} onClick={load}>Load models and galleries</Button>
        <fieldset className="benchmark-controls my-[18px] min-w-0 border-0 p-0" hidden={!loaded} disabled={running}>
          <div className="benchmark-models grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-[12px]">
            {groups.map((group) => (
              <fieldset key={group.stage} data-stage={group.stage} className="max-h-[260px] min-w-0 overflow-auto rounded-8 border border-solid border-border px-[10px] py-[8px]">
                <legend>{group.legend}</legend>
                {group.models.map((model) => (
                  <label key={model.id} className="block py-[5px] text-12 leading-[1.5]">
                    <Checkbox data-model={model.id} className="mr-[7px] align-[-2px]" checked={model.checked} disabled={model.disabled || running} onCheckedChange={(on) => tick(group.stage, model.id, on)} />
                    {model.label}
                    {model.reason && <small>{model.reason}</small>}
                  </label>
                ))}
              </fieldset>
            ))}
          </div>
          <div className="bench-gallery-head mt-[20px] flex items-baseline gap-[10px]">
            <h3>Galleries</h3>
            <span className="bench-selected text-12 text-muted-foreground">{selectedText(picked.size)}</span>
          </div>
          <p className={DESC}>{`${RECOMMENDED_PAGES}+ pages per gallery is recommended for steady timings; galleries with fewer show their page count in red.`}</p>
          <div className="bench-gallery-filters mt-[12px] mb-[8px] flex gap-[8px]">
            <Input variant="inset" type="search" placeholder="Filter galleries" aria-label="Filter benchmark galleries" className="flex-1" value={query} onChange={(e) => setQuery(e.currentTarget.value)} />
            <Menu>
              <MenuTrigger render={<button type="button" className="bench-tier-toggle group inline-flex min-h-[36px] min-w-[130px] cursor-pointer items-center justify-between gap-[10px] rounded-6 border border-solid border-border bg-background px-[11px] text-12 hover:border-input" />}>
                <span>{tierFilterText(tiers)}</span>
                <ChevronDown aria-hidden strokeWidth={2} className="size-[11px] text-muted-dim transition-[rotate] duration-open group-aria-expanded:rotate-180" />
              </MenuTrigger>
              <MenuContent variant="checklist" align="end" sideOffset={4}>
                {TIERS.map((tier: { id: string; name: string }, i: number) => (
                  <MenuCheckboxItem key={tier.id} checked={tiers.has(tier.id)} onCheckedChange={(on) => setTiers((all) => { const next = new Set(all); if (on) next.add(tier.id); else next.delete(tier.id); return next; })}>
                    <Badge variant="inverse">{tier.id}</Badge><span>{tier.name}</span><small className="text-11 text-muted-foreground">{tierRange(i)}</small>
                    <span className="bench-tier-count ml-auto pl-[8px] text-muted-foreground tabular-nums">{formatCount(counts[i])}</span>
                  </MenuCheckboxItem>
                ))}
              </MenuContent>
            </Menu>
          </div>
          <div ref={setList} className="benchmark-galleries mb-[12px] max-h-[420px] overflow-auto rounded-8 border border-solid border-border">
            {galleryGroups(galleries).map(({ tier, galleries: inTier }: { tier: { id: string | null; name: string; range: string }; galleries: Gallery[] }) => {
              const showing = inTier.filter((g) => visible.includes(g));
              return [
                <div key={`t-${tier.id}`} className="bench-group sticky top-0 z-[1] flex items-center gap-[8px] border-0 border-b border-solid border-border bg-secondary px-[12px] py-[7px] text-12 font-semibold" hidden={!showing.length}>
                  {tier.id && <Badge variant="inverse">{tier.id}</Badge>}<span>{tier.name}</span><small className="text-11 font-normal text-muted-foreground">{tier.range}</small>
                  <span className="bench-tier-count ml-auto pl-[8px] font-normal text-muted-foreground tabular-nums">{formatCount(showing.length)}</span>
                </div>,
                ...inTier.map((g) => <GalleryRow key={g.id} g={g} hidden={!visible.includes(g)} checked={picked.has(g.id)} disabled={running}
                  onChange={(on) => setPicked((all) => { const next = new Set(all); if (on) next.add(g.id); else next.delete(g.id); return next; })} />),
              ];
            })}
          </div>
          <div className="benchmark-fields my-[18px] grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-[12px]">
            <label className="text-12">Comparison mode
              <Select variant="inset" className="mt-[6px]" data-value={mode} value={mode} onValueChange={setMode} disabled={running} options={MODES.map(([value, label]: string[]) => ({ value, label }))} />
            </label>
            {PLAN_NUMBERS.map(([key, label, , min, max]) => (
              <label key={key} className="text-12">{label}
                <Input variant="inset" type="number" data-number={key} min={min} max={max} step={1} className="mt-[6px] block" value={numbers[key]} disabled={running}
                  onChange={(e) => { const value = e.currentTarget.value; setNumbers((n) => ({ ...n, [key]: value })); }} />
              </label>
            ))}
          </div>
          <p className={cn(DESC, 'benchmark-estimate')}>{current ? estimateText(current) : ''}</p>
          <p className={DESC}>Keep this tab visible and the device awake. Switching tabs stops the benchmark to prevent background timer throttling from distorting results. Avoid other GPU work. Remote defaults allow about 12 starts/hour; adjust pacing to your server policy. A rate-limit response stops the experiment and is recorded in the report.</p>
          <div className="benchmark-actions my-[12px] flex flex-wrap gap-[8px]">
            <Button id="benchmarkRun" variant="subtle" size="sm" disabled={running} onClick={run}>Run benchmark</Button>
            <Button variant="subtle" size="sm" disabled={running} onClick={() => download(plan(), PLAN_FILE_NAME)}>Export plan</Button>
            <Button variant="subtle" size="sm" disabled={running} onClick={importPlan}>Import plan…</Button>
          </div>
        </fieldset>
        <p id="benchmarkStatus" role="status" className="benchmark-status my-[14px] text-12 [overflow-wrap:anywhere]">{status}</p>
        <div className="benchmark-actions my-[12px] flex flex-wrap gap-[8px]">
          <Button id="benchmarkStop" variant="subtle" size="sm" disabled={!running} onClick={() => { controller.current?.abort(); setStatus('Stopping and cancelling the current job…'); }}>Stop</Button>
          <Button id="benchmarkLast" variant="subtle" size="sm" disabled={!latest} onClick={async () => {
            const report = (await lastBenchmarkReport() as Report | null) || latest;
            if (report) { setLatest(report); setShown({ report, comparison: null }); }
          }}>View last report</Button>
          <Button variant="subtle" size="sm" onClick={async () => { const r = await jsonFile(); if (isBenchmarkReport(r)) setShown({ report: r as Report, comparison: null }); }}>Open report JSON…</Button>
        </div>
      </div>
      <BenchmarkReport shown={shown} onClose={() => setShown(null)} onCompare={(report, comparison) => setShown({ report, comparison })} />
    </Section>
  );
}

function GalleryRow({ g, hidden, checked, disabled, onChange }: { g: Gallery; hidden: boolean; checked: boolean; disabled: boolean; onChange: (on: boolean) => void }) {
  const said = galleryMeta(g);
  const parts: ReactNode[] = [...said.size, <span key="pages" className={cn('bench-pages', said.pages.low && 'low font-semibold text-destructive')} data-tip={said.pages.tip ?? undefined}>{said.pages.text}</span>, said.perPage];
  return (
    <label className={cn('bench-gallery flex cursor-pointer items-center gap-[10px] border-0 border-b border-solid border-border px-[12px] py-[6px] hover:bg-secondary',
      checked && 'bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)]')} hidden={hidden} data-id={g.id}>
      <Checkbox checked={checked} disabled={disabled} onCheckedChange={onChange} />
      <canvas className="bench-cover h-[50px] w-[36px] flex-none rounded-3 bg-surface-subtle" width={0} height={0} data-id={g.id} />
      <span className="flex min-w-0 flex-col gap-[2px]">
        <span className="bench-gallery-title truncate text-13">{g.title}</span>
        <span className="bench-gallery-meta text-11 text-muted-foreground tabular-nums">{parts.flatMap((part, i) => (i ? [' · ', part] : [part]))}</span>
      </span>
    </label>
  );
}

function ReportTable({ table }: { table: Table }) {
  return (
    <div className="benchmark-table-wrap my-[14px] overflow-x-auto">
      <table className="w-full border-collapse text-12 tabular-nums">
        <thead><tr>{table.headers.map((h, i) => <th key={i} className="border-0 border-b border-solid border-border p-[9px] text-left">{h}</th>)}</tr></thead>
        <tbody>{table.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j} className="border-0 border-b border-solid border-border p-[9px] text-left">{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

const P = 'text-12 leading-[1.6] [margin-block:1em]';
const H3 = 'mt-[26px] mb-[1em] text-15 font-bold';
const PRE = 'max-h-[360px] overflow-auto text-11 whitespace-pre-wrap [overflow-wrap:anywhere]';

// The report: a dialog of its own (focus held, Escape, focus back to what opened it).
function BenchmarkReport({ shown, onClose, onCompare }: { shown: { report: Report; comparison: Report | null } | null; onClose: () => void; onCompare: (report: Report, comparison: Report) => void }) {
  const view = useMemo(() => (shown ? reportView(shown.report, shown.comparison as never) : null), [shown]);
  return (
    <Dialog open={!!shown} onOpenChange={(open) => { if (!open) onClose(); }}>
      {shown && view && (
        <DialogContent id="benchmarkReport" size="4xl" className="benchmark-dialog">
          <DialogHeader>
            <DialogTitle id="benchmarkReportTitle">{REPORT_TITLE}</DialogTitle>
            <DialogClose />
          </DialogHeader>
          <p className={P}>{view.line}</p>
          <div className="benchmark-actions my-[12px] flex flex-wrap gap-[8px]">
            <Button onClick={() => download(shown.report, reportFileName(shown.report))}>Export JSON</Button>
            <Button onClick={async () => { const other = await jsonFile(); if (isBenchmarkReport(other)) onCompare(shown.report, other as Report); }}>Compare JSON…</Button>
          </div>
          {view.error && <p className={cn(P, 'benchmark-error text-[#ed9b81]')}>{view.error}</p>}
          <p className={P}>{view.note}</p>
          <div className="benchmark-chart my-[20px] grid gap-[12px]">
            {view.chart.map((bar: { label: string; name: string; value: number; max: number; figure: string }, i: number) => (
              <div key={i} className="benchmark-chart-row grid grid-cols-[minmax(120px,2fr)_minmax(100px,3fr)_100px] items-center gap-[12px] text-11 max-[600px]:grid-cols-1 max-[600px]:gap-[3px]">
                <span>{bar.label}</span>
                <Meter min={0} max={bar.max} value={bar.value} aria-label={bar.name} />
                <strong>{bar.figure}</strong>
              </div>
            ))}
          </div>
          <ReportTable table={view.summary} />
          {view.comparison && (
            <>
              <h3 className={H3}>{view.comparison.title}</h3>
              <p className={cn(P, view.comparison.differs && 'benchmark-error text-[#ed9b81]')}>{view.comparison.note}</p>
              <ReportTable table={view.comparison.table} />
            </>
          )}
          <h3 className={H3}>{view.corpusTitle}</h3>
          <ReportTable table={view.corpus} />
          <h3 className={H3}>{view.stagesTitle}</h3>
          <ReportTable table={view.stages} />
          <h3 className={H3}>{view.runsTitle}</h3>
          {view.runs.map((r: { summary: string; metrics: Table; loads: Table | null; waits: Table | null; waitsNote: string; arrivalsNote: string; arrivals: Table; framesNote: string; raw: string }, i: number) => (
            <Collapsible key={i} variant="box" title={r.summary} className="my-[10px]">
              <ReportTable table={r.metrics} />
              {r.loads && <ReportTable table={r.loads} />}
              {r.waits && <><ReportTable table={r.waits} /><p className={P}>{r.waitsNote}</p></>}
              <p className={P}>{r.arrivalsNote}</p>
              <ReportTable table={r.arrivals} />
              <p className={P}>{r.framesNote}</p>
              <pre className={PRE}>{r.raw}</pre>
            </Collapsible>
          ))}
          <Collapsible variant="box" title={view.environment.summary} className="my-[10px]">
            <pre className={PRE}>{view.environment.raw}</pre>
          </Collapsible>
        </DialogContent>
      )}
    </Dialog>
  );
}
