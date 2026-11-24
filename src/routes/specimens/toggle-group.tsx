// ToggleGroup's specimens: segmented (text and icons), cards (default, stack, small) and pills, as
// wide as today's places for them, each item in its states.
import { useState } from 'react';
import { Columns2, File, Image, MoveHorizontal, MoveVertical, ScrollText, Type } from 'lucide-react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Line, Section, Shape, tag, type State } from './specimen';

const ITEM_STATES: readonly State[] = ['rest', 'hover', 'active', 'focus', 'disabled'];

export function ToggleGroupSpecimens() {
  const [seg, setSeg] = useState('image');
  return (
    <Section id="toggle-group" title="ToggleGroup">
      <Shape id="choice-toggle" name="Segmented (text)" used="Settings → Reader: translation display; Settings → Storage: library location (F12: one highlight, sliding).">
        <Line label="group" states={['rest']} render={(state) => (
          <ToggleGroup className="w-[260px]" value={seg} onValueChange={setSeg} {...tag('choice-toggle', 'segmented', state)} data-seg-demo>
            <ToggleGroupItem value="image">Image</ToggleGroupItem>
            <ToggleGroupItem value="text">Text</ToggleGroupItem>
          </ToggleGroup>)} />
        <Line label="an item" states={ITEM_STATES} render={(state) => (
          <ToggleGroup className="w-[260px]" defaultValue="image" disabled={state === 'disabled'}>
            <ToggleGroupItem value="image">Image</ToggleGroupItem>
            <ToggleGroupItem value="text" {...tag('choice-toggle', 'item', state)}>Text</ToggleGroupItem>
          </ToggleGroup>)} />
        <Line label="three" states={['rest']} render={() => (
          <ToggleGroup className="w-[360px]" defaultValue="b">
            <ToggleGroupItem value="a">Original</ToggleGroupItem>
            <ToggleGroupItem value="b">Translated</ToggleGroupItem>
            <ToggleGroupItem value="c">Both</ToggleGroupItem>
          </ToggleGroup>)} />
      </Shape>
      <Shape id="icon-choice" name="Segmented (icons)" used="Settings → Reader → Study mode: original and translation, as image or text.">
        <Line label="an item" states={ITEM_STATES} render={(state) => (
          <ToggleGroup className="w-[366px]" defaultValue="image" disabled={state === 'disabled'} {...(state === 'rest' ? tag('icon-choice', 'segmented', state) : {})}>
            <ToggleGroupItem value="image"><Image /><span>Image</span></ToggleGroupItem>
            <ToggleGroupItem value="text" {...tag('icon-choice', 'item', state)}><Type /><span>Text</span></ToggleGroupItem>
          </ToggleGroup>)} />
      </Shape>
      <Shape id="rs-choices" name="Cards" used="Reader settings: reader mode, image fit (stacked), navigation and page direction, navigation bar, translation display (small).">
        <Line label="stack" states={ITEM_STATES} render={(state) => (
          <ToggleGroup variant="cards" size="stack" className="w-[442px]" defaultValue="single" disabled={state === 'disabled'}>
            <ToggleGroupItem value="single"><File /><span>Single page</span></ToggleGroupItem>
            <ToggleGroupItem value="double" {...tag('rs-choices', 'stack', state)}><Columns2 /><span>Double page</span></ToggleGroupItem>
            <ToggleGroupItem value="strip"><ScrollText /><span>Scroll strip</span></ToggleGroupItem>
          </ToggleGroup>)} />
        <Line label="stack, chosen" states={['on']} render={(state) => (
          <ToggleGroup variant="cards" size="stack" className="w-[442px]" defaultValue="single">
            <ToggleGroupItem value="single" {...tag('rs-choices', 'stack', state)}><File /><span>Single page</span></ToggleGroupItem>
            <ToggleGroupItem value="double"><Columns2 /><span>Double page</span></ToggleGroupItem>
            <ToggleGroupItem value="strip"><ScrollText /><span>Scroll strip</span></ToggleGroupItem>
          </ToggleGroup>)} />
        <Line label="default" states={['rest', 'hover', 'on']} render={(state) => (
          <ToggleGroup variant="cards" className="w-[442px]" defaultValue={state === 'on' ? 'ltr' : 'rtl'}>
            <ToggleGroupItem value="ltr" {...tag('rs-choices', 'default', state)}><MoveHorizontal /><span>Left to right</span></ToggleGroupItem>
            <ToggleGroupItem value="rtl"><MoveVertical /><span>Right to left</span></ToggleGroupItem>
          </ToggleGroup>)} />
        <Line label="small" states={['rest', 'hover', 'on']} render={(state) => (
          <ToggleGroup variant="cards" size="sm" defaultValue={state === 'on' ? 'image' : 'text'}>
            <ToggleGroupItem value="image" {...tag('rs-choices', 'sm', state)}>Image</ToggleGroupItem>
            <ToggleGroupItem value="text">Text</ToggleGroupItem>
          </ToggleGroup>)} />
      </Shape>
      <Shape id="ib-filter" name="Pills" used="The import tracker's titles list: its filters (all, done, failed…).">
        <Line label="pill" states={['rest', 'hover', 'focus', 'on']} render={(state) => (
          <ToggleGroup variant="pill" defaultValue={state === 'on' ? 'all' : 'done'}>
            <ToggleGroupItem value="all" {...tag('ib-filter', 'pill', state)}>All 12</ToggleGroupItem>
            <ToggleGroupItem value="done">Done 4</ToggleGroupItem>
            <ToggleGroupItem value="failed">Failed 1</ToggleGroupItem>
          </ToggleGroup>)} />
      </Shape>
    </Section>
  );
}
