// Progress's and Meter's specimens, at today's widths and figures: a task row's job (40%, and one
// done), a folder's check with no figure yet, a dialog's operation (one step of three, and one with
// no figure yet), the benchmark chart's bar.
import { Meter, Progress } from '@/components/ui/progress';
import { Line, Section, Shape, tag } from './specimen';

export function ProgressSpecimens() {
  return (
    <Section id="progress" title="Progress and Meter">
      <Shape id="prog" name="Job bar" used="A library card's job, a chapter row's, a task row's, the import tracker's.">
        <Line label="job · thin" states={['rest', 'on']} render={(state) => (
          <div className="w-[782px] max-w-[calc(100vw-200px)]">
            <Progress value={state === 'on' ? 100 : 40} done={state === 'on'} aria-label="Downloading" {...tag('prog', 'job', state)} />
          </div>)} />
        <Line label="no figure yet" states={['rest']} render={(state) => (
          <div className="w-[782px] max-w-[calc(100vw-200px)]"><Progress value={null} aria-label="Downloading" {...tag('prog', 'job-unknown', state)} /></div>)} />
      </Shape>
      <Shape id="lf-bar" name="Folder job bar" used="Settings → Storage → library folders: a check or a rescan (the job bar, F22's motion).">
        <Line label="no figure yet" states={['rest']} render={(state) => (
          <div className="w-[180px]"><Progress value={null} aria-label="Checking" {...tag('lf-bar', 'job-unknown', state)} /></div>)} />
      </Shape>
      <Shape id="notice-bar" name="Dialog bar" used="Progress and operation windows: backups, one-time library updates, imports.">
        <Line label="accent · thick" states={['rest']} render={(state) => (
          <div className="w-[434px] max-w-[calc(100vw-200px)]"><Progress tone="accent" value={1} max={3} aria-label="Restoring" {...tag('notice-bar', 'accent', state)} /></div>)} />
        <Line label="no figure yet" states={['rest']} render={(state) => (
          <div className="w-[434px] max-w-[calc(100vw-200px)]"><Progress tone="accent" value={null} aria-label="Restoring" {...tag('notice-bar', 'accent-unknown', state)} /></div>)} />
      </Shape>
      <Shape id="meter" name="Benchmark chart meter" used="Settings → Translation → Benchmark: each configuration's seconds per page.">
        <Line label="meter" states={['rest']} render={(state) => (
          <div className="w-[300px]"><Meter value={6} max={10} aria-label="Model A seconds per page" {...tag('meter', 'meter', state)} /></div>)} />
      </Shape>
    </Section>
  );
}
