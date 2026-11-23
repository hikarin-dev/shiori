// The one focused look of a box you type or choose in (Input, InputGroup, Textarea, Select's box).
// §5.3 F13 (owner): the ring colour, a 1px border and a 1px shadow round it, as Settings' fields had
// it; the library's, the overview's and the dialogs' boxes took the brand colour's border instead
// ('focus-visible:border-primary'), and the feedback note the browser's own ring. One line to change.
export const FOCUS_BOX = 'outline-none focus-visible:border-ring focus-visible:shadow-[0_0_0_1px_var(--ring)]';
