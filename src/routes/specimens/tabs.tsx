// Tabs' specimens: Settings' side navigation, reader settings' segmented tabs over panels of three
// heights (the box keeps the tallest's), and the overview's underlined pair.
import { Tabs, TabsList, TabsPanel, TabsPanels, TabsTab } from '@/components/ui/tabs';
import { Line, Section, Shape, tag, type State } from './specimen';

const STATES: readonly State[] = ['rest', 'hover', 'active', 'focus', 'on'];

export function TabsSpecimens() {
  return (
    <Section id="tabs" title="Tabs">
      <Shape id="nav-item" name="Settings side navigation" used="Settings: Library, Reader, Translation, the optional panel, Storage (and the desktop panel).">
        <Line label="nav" states={STATES} render={(state) => (
          <Tabs className="w-[176px]" defaultValue={state === 'on' ? 'reader' : 'library'}>
            <TabsList>
              <TabsTab value="library">Library</TabsTab>
              <TabsTab value="reader" {...tag('nav-item', 'nav', state)}>Reader</TabsTab>
              <TabsTab value="storage">Storage</TabsTab>
            </TabsList>
          </Tabs>)} />
      </Shape>
      <Shape id="rs-tabs" name="Reader settings tabs" used="Reader settings: Reading, Pages, Display (F12: the segmented track and its sliding highlight).">
        <Line label="a tab" states={STATES} render={(state) => (
          <Tabs variant="segmented" className="w-[442px]" defaultValue={state === 'on' ? 'pages' : 'reading'}>
            <TabsList {...(state === 'rest' ? tag('rs-tabs', 'list', state) : {})}>
              <TabsTab value="reading">Reading</TabsTab>
              <TabsTab value="pages" {...tag('rs-tabs', 'segmented', state)}>Pages</TabsTab>
              <TabsTab value="display">Display</TabsTab>
            </TabsList>
          </Tabs>)} />
        <Line label="with panels" states={['rest']} render={() => (
          <Tabs variant="segmented" className="flex w-[442px] flex-col gap-[10px] rounded-12 border border-input bg-card p-[12px]" defaultValue="reading" data-tabs-demo>
            <TabsList>
              <TabsTab value="reading">Reading</TabsTab>
              <TabsTab value="pages">Pages</TabsTab>
              <TabsTab value="display">Display</TabsTab>
            </TabsList>
            <TabsPanels>
              <TabsPanel value="reading"><p className="text-12">A short tab.</p></TabsPanel>
              <TabsPanel value="pages"><p className="text-12">A taller tab.<br />Its second line.<br />Its third line.<br />Its fourth line.</p></TabsPanel>
              <TabsPanel value="display"><p className="text-12">Two lines<br />here.</p><button type="button" className="text-12 underline">A control inside</button></TabsPanel>
            </TabsPanels>
          </Tabs>)} />
      </Shape>
      <Shape id="ov-view" name="Underlined pair" used="The overview's section heading of a series with volumes: Chapters / Volumes.">
        <Line label="underline" states={STATES} render={(state) => (
          <Tabs variant="underline" defaultValue={state === 'on' ? 'volumes' : 'chapters'}>
            <TabsList>
              <TabsTab value="chapters">Chapters</TabsTab>
              <TabsTab value="volumes" {...tag('ov-view', 'underline', state)}>Volumes</TabsTab>
            </TabsList>
          </Tabs>)} />
      </Shape>
    </Section>
  );
}
