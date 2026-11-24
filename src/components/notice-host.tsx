// NoticeHost — draws what notice.js is asked for (src/lib/notice-store.ts holds the requests and
// their answers): its confirm, alert, prompt, choice and toggle dialogs, ask()'s choices, a progress
// and an operation window, each a Dialog on the notice layer, and its toast. In the app's frame, on
// every page the one page draws.
//
// Each answers as notice.js's own did: OK or a choice gives the answer; Cancel, Escape or a press on
// the backdrop gives the cancel's (null for a prompt, a choice or a toggle; false for a confirm;
// nothing for an alert); Enter in the prompt's box is OK. ask() and the progress windows have no way
// out but their own buttons. While a toggle's confirm question is open over it, it takes nothing.
// Focus starts on the prompt's box (its text chosen), Cancel for a danger, OK otherwise, an ask's
// first choice, the Stop button; it goes back to what had it when the notice came.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { OptionCard, OptionCardRadio } from './ui/option-card';
import { RadioGroup } from './ui/radio-group';
import { Checkbox } from './ui/checkbox';
import { Switch } from './ui/switch';
import { Select } from './ui/select';
import { Progress } from './ui/progress';
import { Toast, ToastRegion } from './ui/toast';
import { dismissed, finish, getRequests, getToast, getVersion, subscribe, update, type AskRequest, type DialogRequest, type ProgressRequest } from '@/lib/notice-store';
import { cn } from '@/lib/utils';

// The notices' own type: 12.5px on a 1.55 line, as notice.css had it.
const BOX = 'text-12.5 leading-[1.55]';
const SAYS = 'mt-0 mb-[12px] text-12.5 leading-[1.55] whitespace-pre-line text-muted-foreground';

const TONE_ICON = { danger: TriangleAlert, error: CircleAlert, success: CircleCheck, info: Info } as const;
const TONE_COLOUR = { danger: 'text-destructive', error: 'text-destructive', success: 'text-success', info: 'text-muted-foreground' } as const;

function ToneIcon({ tone }: { tone: keyof typeof TONE_ICON }) {
  const Icon = TONE_ICON[tone];
  return (
    <span aria-hidden data-slot="notice-icon" className={cn('flex size-[34px] shrink-0 items-center justify-center rounded-circle bg-[color-mix(in_srgb,currentColor_14%,transparent)]', TONE_COLOUR[tone])}>
      <Icon strokeWidth={2} className="size-[18px]" />
    </span>
  );
}

// What it applies to: a line or two, with the gallery's cover at the left when it has one (swapped
// in once loaded, so a slow or missing cover never shows a broken picture).
function Detail({ detail, cover }: { detail: DialogRequest['ask']['detail']; cover: DialogRequest['ask']['cover'] }) {
  const lines = (Array.isArray(detail) ? detail : [detail]).filter(Boolean) as string[];
  const [picture, setPicture] = useState<{ url: string; landscape: boolean } | null>(null);
  useEffect(() => {
    if (cover == null) return;
    let live = true;
    Promise.resolve(cover).then((url) => {
      if (!url || !live) return;
      const img = new Image();
      img.onload = () => { if (live) setPicture({ url, landscape: img.naturalWidth >= img.naturalHeight }); };
      img.src = url;
    }, () => {});
    return () => { live = false; };
  }, [cover]);
  if (!lines.length) return null;
  const withCover = cover != null;
  return (
    <Card variant="detail" cover={withCover} data-slot="notice-detail">
      {withCover && (
        <span data-slot="notice-thumb" className={cn('flex w-[38px] shrink-0 items-center justify-center overflow-hidden rounded-5 border border-solid text-16 [aspect-ratio:1/1.41421356]',
          picture?.landscape ? 'border-transparent bg-transparent' : 'border-border bg-card')}>
          {picture
            ? <img alt="" src={picture.url} className={cn('block w-full object-cover', picture.landscape ? 'h-auto rounded-4 border border-solid border-border' : 'h-full')} />
            : <span className="opacity-50">📄</span>}
        </span>
      )}
      <span className={cn('min-w-0', withCover && 'flex-1 text-13 leading-[1.35]')}>
        <span className={cn(withCover && 'line-clamp-2')}>{lines[0]}</span>
        {lines[1] && <span className={cn('mt-[2px] block text-11 text-muted-foreground', withCover && 'line-clamp-2')}>{lines[1]}</span>}
      </span>
    </Card>
  );
}

function NoticeDialog({ request }: { request: DialogRequest }) {
  const { title, body, detail, cover, tone, input, form, toggle, ok, cancel } = request.ask;
  const [value, setValue] = useState(input?.value ?? '');
  const [picked, setPicked] = useState(form?.value);
  const [checks, setChecks] = useState(() => Object.fromEntries((form?.checks ?? []).map((c) => [c.name, !!c.checked])));
  const [toggled, setToggled] = useState(false);
  const [option, setOption] = useState(toggle?.value);
  const paused = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  const no = useRef<HTMLButtonElement>(null);
  const yes = useRef<HTMLButtonElement>(null);

  const answer = (a: unknown) => { finish(request); request.resolve(a); };
  const accept = () => answer(input ? value.trim() : form ? { value: picked, checks } : toggle ? { toggle: toggled, option } : true);
  const dismiss = () => answer(dismissed(request.ask));
  // A toggle's confirm question, asked when it is turned on or its choice changes while on.
  const confirmed = async (o: string | undefined) => { paused.current = true; try { return (await toggle?.confirm?.(o)) !== false; } finally { paused.current = false; } };

  const turn = async (on: boolean) => setToggled(on && await confirmed(option));

  const iconTone = tone && tone in TONE_ICON ? tone as keyof typeof TONE_ICON : null;
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !paused.current) dismiss(); }}>
      <DialogContent
        layer="notice"
        size="sm"
        className={BOX}
        role={tone === 'danger' || tone === 'error' ? 'alertdialog' : 'dialog'}
        data-notice="dialog"
        initialFocus={() => { if (field.current) { field.current.select(); return field.current; } return (tone === 'danger' && no.current) ? no.current : yes.current; }}
        finalFocus={false}
      >
        <DialogHeader>
          {iconTone && <ToneIcon tone={iconTone} />}
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {body && <DialogDescription className={SAYS}>{toggle?.bodyOn && toggled ? toggle.bodyOn : body}</DialogDescription>}
        <Detail detail={detail} cover={cover} />
        {input && (
          <Input ref={field} variant="inset" value={value} placeholder={input.placeholder} spellCheck={false} aria-label={title}
            onChange={(e) => setValue(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); accept(); } }} />
        )}
        {form && (
          <>
            <RadioGroup value={picked} onValueChange={(v) => setPicked(v as string)} aria-label={title} className={cn('gap-[8px]', detail && 'mt-[12px]')}>
              {form.choices.map((c) => <OptionCardRadio key={c.value} value={c.value} title={c.label} detail={c.detail} />)}
            </RadioGroup>
            {form.checks.length > 0 && (
              <div className="mt-[14px] flex flex-col gap-[8px]">
                {form.checks.map((c) => (
                  <label key={c.name} hidden={c.for != null && c.for !== picked} className="flex cursor-pointer items-center gap-[8px] text-13">
                    <Checkbox checked={checks[c.name]} onCheckedChange={(on) => setChecks((all) => ({ ...all, [c.name]: on }))} />
                    <span>{c.label}</span>
                  </label>
                ))}
              </div>
            )}
          </>
        )}
        {toggle && (
          <div className="mt-[16px] flex flex-wrap items-center gap-x-[10px] gap-y-[8px] text-13">
            <Switch aria-label={toggle.label} checked={toggled} onCheckedChange={(on) => void turn(on)} />
            <span className="cursor-pointer" onClick={() => void turn(!toggled)}>{toggle.label}</span>
            {toggle.options?.length ? (
              <span className="min-w-0 flex-[1_1_160px]">
                <Select variant="inset" options={toggle.options} value={option} disabled={!toggled} aria-label={toggle.label}
                  onValueChange={async (v) => { const before = option; setOption(v); if (toggled && !(await confirmed(v))) setOption(before); }} />
              </span>
            ) : null}
          </div>
        )}
        <DialogFooter>
          {cancel && <Button ref={no} onClick={dismiss}>{cancel}</Button>}
          <Button ref={yes} variant={tone === 'danger' ? 'danger' : 'primary'} onClick={accept}>{ok}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AskDialog({ request }: { request: AskRequest }) {
  const first = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent layer="notice" size="sm" className={BOX} data-notice="ask" initialFocus={first} finalFocus={false}>
        <DialogHeader><DialogTitle>{request.title}</DialogTitle></DialogHeader>
        {request.body && <DialogDescription className={SAYS}>{request.body}</DialogDescription>}
        <div className="mt-[14px] flex flex-col gap-[8px]">
          {request.choices.map((c, i) => (
            <OptionCard key={c.value} ref={i === 0 ? first : undefined} title={c.label} detail={c.detail}
              onClick={() => { finish(request); request.resolve(c.value); }} />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProgressDialog({ request }: { request: ProgressRequest }) {
  const operation = request.kind === 'operation';
  const pct = request.total ? Math.min(100, (request.done / request.total) * 100) : null;
  const lines = request.lines.filter(Boolean);
  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent
        ref={(el: HTMLDivElement | null) => { request.popup = el; }}
        layer="notice" size={operation ? 'md' : 'sm'}
        className={cn(BOX, request.aside && 'invisible')}
        // Set aside while a notice on top asks something: the page stays covered, without a second
        // dimming (its backdrop clear, its box hidden).
        backdropClassName={request.aside ? 'bg-transparent' : undefined}
        data-notice={request.kind}
        data-aside={request.aside ? '' : undefined}
        finalFocus={false}
      >
        <DialogHeader><DialogTitle>{request.title}</DialogTitle></DialogHeader>
        {request.body && <DialogDescription className={SAYS}>{request.body}</DialogDescription>}
        <Progress tone="accent" value={pct == null ? null : operation ? Math.round(pct) : pct} aria-label={request.title} className="mt-[14px] mb-[8px]" />
        {lines.map((line, i) => <div key={i} data-slot="notice-line" className={cn('text-11.5 text-muted-foreground tabular-nums', i > 0 && 'mt-[2px]')}>{line}</div>)}
        {request.stopLabel && (
          <DialogFooter>
            <Button data-notice-stop disabled={request.stopped} onClick={() => { request.stopped = true; update(); request.onStop?.(); }}>{request.stopLabel}</Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function NoticeHost() {
  useSyncExternalStore(subscribe, getVersion);
  const requests = getRequests(), toast = getToast();
  const drawn: ReactNode[] = requests.map((r) => r.kind === 'dialog' ? <NoticeDialog key={r.id} request={r} />
    : r.kind === 'ask' ? <AskDialog key={r.id} request={r} /> : <ProgressDialog key={r.id} request={r} />);
  return (
    <>
      {drawn}
      <ToastRegion data-notice-toast>
        {toast && <Toast key={toast.id} text={toast.text} action={toast.action} busy={toast.busy ?? undefined} closeLabel={toast.closeLabel} onAction={toast.onAction} onClose={toast.close} />}
      </ToastRegion>
    </>
  );
}
