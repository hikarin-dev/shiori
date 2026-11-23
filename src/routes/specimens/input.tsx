// Input's, InputGroup's and Textarea's specimens, at today's widths and with today's text.
import { RefreshCw } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Textarea } from '@/components/ui/textarea';
import { Line, Section, Shape, tag, type State } from './specimen';

const STATES: readonly State[] = ['rest', 'hover', 'focus', 'disabled'];

export function InputSpecimens() {
  return (
    <Section id="input" title="Input, InputGroup and Textarea">
      <Shape id="field-input" name="Settings text field" used="Settings: the translation server's access token, advanced options, the desktop panel, library folders.">
        <Line label="field · lg" states={STATES} render={(state) => <div className="w-[260px]"><Input placeholder="Optional" aria-label="Access token" disabled={state === 'disabled'} {...tag('field-input', 'field', state)} /></div>} />
        <Line label="with text" states={['rest']} render={() => <div className="w-[260px]"><Input defaultValue="http://127.0.0.1:5003" aria-label="Server" data-input-demo /></div>} />
      </Shape>
      <Shape id="reveal-btn" name="A field with a joined button" used="Settings → Translation: the server's address and Check connection.">
        <Line label="group" states={['rest', 'hover', 'focus']} render={(state) => (
          <InputGroup className="w-[260px]">
            <InputGroupInput placeholder="http://127.0.0.1:5003" aria-label="Server" {...tag('field-input', 'group', state)} />
            <InputGroupButton aria-label="Check connection" {...tag('reveal-btn', 'button', state)}><RefreshCw /></InputGroupButton>
          </InputGroup>)} />
        <Line label="busy" states={['rest']} render={() => (
          <InputGroup className="w-[260px]">
            <InputGroupInput defaultValue="http://127.0.0.1:5003" aria-label="Server" />
            <InputGroupButton aria-label="Check connection" aria-busy="true"><RefreshCw /></InputGroupButton>
          </InputGroup>)} />
      </Shape>
      <Shape id="modal-input" name="Tag editor value" used="The tag editor (F13: the one focused look).">
        <Line label="inset · default" states={STATES} render={(state) => <div className="w-[298px]"><Input variant="inset" placeholder="Value" aria-label="Value" disabled={state === 'disabled'} {...tag('modal-input', 'inset', state)} /></div>} />
      </Shape>
      <Shape id="add-search" name="Add-chapter search" used="The overview's add-chapter bar.">
        <Line label="inset · xl" states={STATES} render={(state) => <div className="w-[480px]"><Input variant="inset" size="xl" defaultValue="shelf" aria-label="Search" disabled={state === 'disabled'} {...tag('add-search', 'inset-xl', state)} /></div>} />
      </Shape>
      <Shape id="notice-input" name="Prompt dialog field" used="The prompt dialog: a link, a new name (F15: radius 6, 40px).">
        <Line label="dialog · xl" states={STATES} render={(state) => <div className="w-[394px]"><Input variant="dialog" defaultValue="Harbor Lights, chapter 2" aria-label="Name" disabled={state === 'disabled'} {...tag('notice-input', 'dialog', state)} /></div>} />
      </Shape>
      <Shape id="tcfg-textarea" name="Advanced options, several lines" used="Settings → Translation → Advanced settings: a server's multi-line options.">
        <Line label="field" states={STATES} render={(state) => <div className="w-[340px]"><Textarea aria-label="Options" disabled={state === 'disabled'} {...tag('tcfg-textarea', 'field', state)} /></div>} />
      </Shape>
      <Shape id="feedback-textarea" name="Feedback note" used="The reader's feedback dialog (F13: gains the focused look).">
        <Line label="inset" states={STATES} render={(state) => <div className="w-[447px]"><Textarea variant="inset" rows={5} aria-label="Note" disabled={state === 'disabled'} {...tag('feedback-textarea', 'inset', state)} /></div>} />
      </Shape>
    </Section>
  );
}
