// Select's specimens: each of today's boxes with its own options, in each state, at today's widths.
// Open one with a pointer to see the drawn list (on a touch screen, the system's picker opens).
import { Select, type SelectOption } from '@/components/ui/select';
import { Line, Section, Shape, tag, type State } from './specimen';

const LANGS: SelectOption[] = ['English', '日本語', 'Deutsch', 'Français', '简体中文', '繁體中文', '한국어', 'Español', 'Português (BR)', 'Русский', 'Tiếng Việt', 'Bahasa Indonesia']
  .map((label, i) => ({ value: ['en', 'ja', 'de', 'fr', 'zh', 'zh-tw', 'ko', 'es', 'pt', 'ru', 'vi', 'id'][i], label }));
const SORT: SelectOption[] = [['id', 'Most Recent'], ['updated', 'Last Updated'], ['size', 'Largest'], ['count', 'Most Pages'], ['uploadDate', 'Published Date']].map(([value, label]) => ({ value, label }));
const TYPES: SelectOption[] = [['tag', 'Tag'], ['artist', 'Artist'], ['group', 'Group'], ['parody', 'Parody'], ['character', 'Character'], ['category', 'Category']].map(([value, label]) => ({ value, label }));
const PAGES: SelectOption[] = [['library', 'Library'], ['settings', 'Settings'], ['tasks', 'Tasks']].map(([value, label]) => ({ value, label }));
const FONTS: SelectOption[] = [['yasashisa', 'やさしさアンチック'], ['kiwi', 'Kiwi Maru']].map(([value, label]) => ({ value, label }));
const QUICK: SelectOption[] = [['hover', 'On hover'], ['always', 'Always'], ['never', 'Never']].map(([value, label]) => ({ value, label }));

const STATES: readonly State[] = ['rest', 'hover', 'focus', 'disabled'];

export function SelectSpecimens() {
  return (
    <Section id="select" title="Select">
      <Shape id="select-field" name="Settings select" used="Settings: language, quick actions, export format, study font and data, target language; advanced options; the toggle dialog's choice.">
        <Line label="field · default" states={STATES} render={(state) => <div className="w-[260px]"><Select options={LANGS} defaultValue="en" aria-label="Language" disabled={state === 'disabled'} {...tag('select-field', 'field', state)} /></div>} />
        <Line label="a short list" states={['rest']} render={() => <div className="w-[260px]"><Select options={QUICK} defaultValue="hover" aria-label="Quick actions" data-select-demo="short" /></div>} />
        <Line label="the system's picker" states={['rest']} render={(state) => <div className="w-[260px]"><Select native options={LANGS} defaultValue="en" aria-label="Language" {...tag('select-field', 'native', state)} /></div>} />
      </Shape>
      <Shape id="sort-select" name="Library sort" used="The library's toolbar: held at its widest option's width.">
        <Line label="toolbar · toolbar" states={STATES} render={(state) => <Select variant="toolbar" options={SORT} defaultValue="id" aria-label="Sort" disabled={state === 'disabled'} {...tag('sort-select', 'toolbar', state)} />} />
      </Shape>
      <Shape id="modal-select" name="Tag editor type" used="The tag editor (Library, Overview); the benchmark's fields and the pipeline steps take its size (F14).">
        <Line label="inset · default" states={STATES} render={(state) => <div className="w-[298px]"><Select variant="inset" options={TYPES} defaultValue="tag" aria-label="Type" disabled={state === 'disabled'} {...tag('modal-select', 'inset', state)} /></div>} />
      </Shape>
      <Shape id="rs-select" name="Reader settings select" used="Reader settings → Display → Study: the original text's font (F14: the strong frame; S09: 36px, 12px).">
        <Line label="field · default" states={STATES} render={(state) => <div className="w-[211px]"><Select options={FONTS} defaultValue="yasashisa" aria-label="Font" disabled={state === 'disabled'} {...tag('rs-select', 'field', state)} /></div>} />
      </Shape>
      <Shape id="page-nav" name="Header page menu" used="Every page's header: the page's name, a menu of the app's pages.">
        <Line label="ghost · xs" states={STATES} render={(state) => <Select variant="ghost" options={PAGES} defaultValue="library" aria-label="Page" disabled={state === 'disabled'} {...tag('page-nav', 'ghost', state)} />} />
      </Shape>
    </Section>
  );
}
