// Settings → Storage: where the library is kept (./folders.tsx, and in the desktop app's window the
// archiving card), the library's backup (Export… asks which, Import…, Check…), the library upgrades
// (the stored layout; category and rating, only while something answers the bridge), the total disk
// writes with its Reset, and the danger zone (Clear All, Factory Reset: each asked twice, never while a
// backup runs in any window). A library kept by the desktop app has no upgrades, and seen from a site no
// stats either.
//
// What each says, asks and does is app/js/storage-settings.js's; a backup is
// backup-ui.js's (its progress window and questions are notice.js's), called as 1.3's page called it.
//
// Drawn as 1.3's: each a section of rows with a button at the end (under the words, full
// width, in a panel of 480px or less); the total in its framed figure, its tip the split by kind; Reset
// in a row of its own with its status line before it. The backup choice a dialog of two cards. §5.3
// S01/S11/S20: the buttons 36 on a 20px line, 12px (11px, 1.35); F17/S17: the choices one option card
// (no ground, 13px bold title, 46px); S16, F26–F28: the dialog's frame; F02: no press.
import { useEffect, useRef, useState } from 'react';
import * as api from '@lib/api.js';
import * as platform from '@lib/platform.js';
import { attachNativeBackup, checkBackup, exportBackup, importBackups } from '@lib/backup-ui.js';
import {
  DESK_WRITES_EVERY, FACTORY_RELOAD_MS, browserWrites, classifyAll, classifyStatus, clearLibrary, convertLayout, desktopWrites, factoryReset,
  layoutStatus, resetWrites, storageSections,
} from '@lib/storage-settings.js';
import { StatusText } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { OptionCard } from '@/components/ui/option-card';
import { SettingRow } from '@/components/ui/setting-row';
import { Stat } from '@/components/ui/stat';
import { useT } from '@/lib/i18n';
import { ArchiveSection, FoldersSection } from './folders';
import { Section, SectionStatus, useStatus } from './parts';

const BACKUP_FILES = '.shi,.shioridb,.crdownload,.crswap,application/octet-stream,application/json';

// A backup the desktop app was making or restoring when its window was reloaded is followed again:
// asked for once a page load, as 1.3's page asked as it loaded. Asked again when the panel is drawn
// again, it would take a backup this window itself is making or restoring for one left behind.
let attached = false;

export function StoragePanel() {
  const [sections] = useState(() => storageSections() as { upgrades: boolean; stats: boolean });
  useEffect(() => { if (!attached) { attached = true; attachNativeBackup().catch(() => {}); } }, []);
  return (
    <>
      <FoldersSection />
      <ArchiveSection />
      <BackupSection />
      <UpgradesSection shown={sections.upgrades} />
      <StatsSection shown={sections.stats} />
      <DangerSection />
    </>
  );
}

// ── Library Backup ─────────────────────────────────────────────────────────────────────────────

function BackupSection() {
  const t = useT();
  const [choosing, setChoosing] = useState(false);
  const importFile = useRef<HTMLInputElement>(null);
  const checkFile = useRef<HTMLInputElement>(null);
  // The file picked (the box emptied, so the same file can be picked again).
  const picked = (run: (file: File) => unknown) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (file) run(file);
  };
  // Each runs behind its own progress window (backup-ui.js), which says how it went.
  const make = (kind: 'metadata' | 'full') => { setChoosing(false); exportBackup(kind); };
  return (
    <Section title={t('set.backup')}>
      <SettingRow kind="action" label={t('set.export_backup')} description={t('set.export_backup_desc')}
        control={<Button id="exportBackupBtn" variant="solid" aria-haspopup="dialog" onClick={() => setChoosing(true)}>{t('common.export')}</Button>} />
      <SettingRow kind="action" label={t('set.import_backup')} description={t('set.import_backup_desc')}
        control={<Button id="importBackupBtn" variant="solid" onClick={() => importFile.current?.click()}>{t('common.import')}</Button>} />
      <SettingRow kind="action" label={t('set.check_backup')} description={t('set.check_backup_desc')}
        control={<Button id="checkBackupBtn" variant="solid" onClick={() => checkFile.current?.click()}>{t('common.check')}</Button>} />
      {/* (After the rows: a row follows a row to be ruled off from it.) */}
      <input type="file" id="backupImportFile" accept={BACKUP_FILES} hidden ref={importFile} onChange={picked((file) => importBackups([file]))} />
      <input type="file" id="backupCheckFile" accept={BACKUP_FILES} hidden ref={checkFile} onChange={picked((file) => checkBackup(file))} />
      <Dialog open={choosing} onOpenChange={setChoosing}>
        <DialogContent id="backupBox" size="sm" layout="sectioned" initialFocus={() => document.getElementById('backupMetaBtn')}>
          <DialogHeader>
            <div className="min-w-0">
              <DialogTitle id="backupTitle">{t('set.bk_title')}</DialogTitle>
              <DialogDescription>{t('set.bk_pick')}</DialogDescription>
            </div>
          </DialogHeader>
          <DialogBody className="backup-options flex flex-col gap-[9px]">
            <OptionCard id="backupMetaBtn" className="backup-choice" title={t('set.bk_meta')} onClick={() => make('metadata')} />
            <OptionCard id="backupFullBtn" className="backup-choice" title={t('set.bk_full')} onClick={() => make('full')} />
          </DialogBody>
          <DialogFooter>
            <Button id="backupCancelBtn" onClick={() => setChoosing(false)}>{t('common.cancel')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

// ── Library upgrades ───────────────────────────────────────────────────────────────────────────

type Layout = { text: string; remaining: boolean };
type Classify = { text: string; pending: number } | null;

function UpgradesSection({ shown }: { shown: boolean }) {
  const t = useT();
  const [layout, setLayout] = useState<Layout | null>(null);
  const [classify, setClassify] = useState<Classify>(null);
  const [converting, setConverting] = useState(false);
  const [classifying, setClassifying] = useState(false);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  const readLayout = () => (layoutStatus() as Promise<Layout>).then((v) => { if (live.current) setLayout(v); }).catch(() => {});
  const readClassify = () => (classifyStatus() as Promise<Classify>).then((v) => { if (live.current) setClassify(v); }).catch(() => {});
  // Read as the panel is drawn, and again in another language (what each says is worded as it is read).
  useEffect(() => { live.current = true; readLayout(); readClassify(); }, [t]);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Section id="upgradesSection" title={t('set.layout')} hidden={!shown}>
      <SettingRow kind="action" label={t('set.layout_name')} description={<span id="layoutStatus">{layout?.text ?? '—'}</span>}
        control={(
          <Button id="convertNowBtn" variant="solid" disabled={!layout?.remaining || converting}
            onClick={async () => { setConverting(true); try { await convertLayout(); await readLayout(); } finally { setConverting(false); } }}>{t('storage.now')}</Button>
        )} />
      {classify && (
        <SettingRow kind="action" id="classifyRow" label={t('set.classify_name')} description={<span id="classifyStatus">{classify.text}</span>}
          control={(
            <Button id="classifyNowBtn" variant="solid" disabled={!classify.pending || classifying}
              onClick={async () => { setClassifying(true); try { await classifyAll(); await readClassify(); } finally { setClassifying(false); } }}>{t('set.classify_now')}</Button>
          )} />
      )}
    </Section>
  );
}

// ── Stats ──────────────────────────────────────────────────────────────────────────────────────

type Writes = { total?: number; by?: Record<string, number> } | null;

// The total: this browser's, followed as it changes; a library kept as files' own count instead,
// read every 3 s while the page is visible.
function useWrites(): [{ text: string; tip: string } | null, () => void] {
  const [own, setOwn] = useState<Writes | undefined>(undefined);
  const [desk, setDesk] = useState<{ text: string; tip: string } | null>(null);
  const readDesk = useRef(() => {});
  useEffect(() => {
    let live = true;
    if (api.capabilities.archive) {
      const read = readDesk.current = () => { (desktopWrites() as Promise<{ text: string; tip: string } | null>).then((v) => { if (live && v) setDesk(v); }, () => {}); };
      read();
      const every = setInterval(() => { if (!document.hidden) read(); }, DESK_WRITES_EVERY);
      return () => { live = false; readDesk.current = () => {}; clearInterval(every); };
    }
    platform.writes.get().then((w: Writes) => { if (live) setOwn(w); }, () => {});
    const off = platform.writes.subscribe((w: Writes) => setOwn(w));
    return () => { live = false; off(); };
  }, []);
  const read = () => readDesk.current();
  if (api.capabilities.archive) return [desk, read];
  return [own === undefined ? null : browserWrites(own) as { text: string; tip: string }, read];
}

function StatsSection({ shown }: { shown: boolean }) {
  const t = useT();
  const [writes, readAgain] = useWrites();
  const [status, show] = useStatus();
  return (
    <Section id="statsSection" title={t('set.stats')} hidden={!shown}>
      <SettingRow kind="action" label={t('set.total_writes')} description={t(api.capabilities.archive ? 'set.writes_desk_desc' : 'set.total_writes_desc')}
        control={(
          // (At 480px of panel or less the figure stays its own width, at the row's start.)
          <div className="flex justify-end @max-[480.02px]/settings-panel:justify-start">
            <Stat variant="inline" id="totalWritesCount" className="writes-count" value={writes?.text ?? '—'} data-tip={writes?.tip || undefined} />
          </div>
        )} />
      <SettingRow kind="footer" className="actions-row">
        <StatusText id="writesStatus" tone={status.tone} shown={status.shown}>{status.text}</StatusText>
        <Button id="resetWritesBtn" variant="danger-subtle" onClick={async () => {
          if (!(await resetWrites())) return;
          readAgain();   // (a library kept as files' count, at once; this browser's follows by itself)
          show(t('set.writes_reset_done'));
        }}>{t('common.reset')}</Button>
      </SettingRow>
    </Section>
  );
}

// ── Danger Zone ────────────────────────────────────────────────────────────────────────────────

function DangerSection() {
  const t = useT();
  const [status, show] = useStatus();
  return (
    <Section title={<span className="danger-title text-destructive">{t('set.danger')}</span>}>
      <SettingRow kind="action" label={t('set.clear_all')} description={t('set.clear_all_desc')}
        control={<Button id="clearAllBtn" variant="tint" tone="danger" onClick={async () => { if (await clearLibrary()) show(t('set.clear_done')); }}>{t('set.clear_all_btn')}</Button>} />
      <SettingRow kind="action" label={t('set.factory_reset')} description={t('set.factory_reset_desc')}
        control={(
          <Button id="factoryResetBtn" variant="tint" tone="danger" onClick={async () => {
            if (!(await factoryReset())) return;
            show(t('set.factory_done'));
            setTimeout(() => location.reload(), FACTORY_RELOAD_MS);   // the page again, with defaults
          }}>{t('set.factory_reset_btn')}</Button>
        )} />
      <SectionStatus id="clearAllStatus" status={status} />
    </Section>
  );
}
