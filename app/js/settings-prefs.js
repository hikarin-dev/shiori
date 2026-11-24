// settings-prefs.js — the preferences Settings' own controls show and save, each kept under its key in
// platform.kv: what a control shows given what is stored (`read`), and what is stored for what it
// shows (`write`). The stored values are what the pages that use them read (the library, the reader),
// so they never change: some are stored inverted or as words, and a value that is not one a control
// offers reads as its default.
//
//   read(value, stored)  the control's value: a switch's on/off, a choice's value; `value` is what is
//                        stored under the key (undefined when nothing is), `stored` every key read
//                        with it (the key and its `also`)
//   write(value)         what is stored under the key for the control's value
//   also                 older keys read with it, for a value saved before the key was named so

const shownUnlessOff = (value) => value !== false;   // a detail shown by default, until turned off
const oneOf = (values, fallback) => (value) => (values.includes(value) ? value : fallback);
const same = (value) => value;

const quickActions = oneOf(['hover', 'always', 'hidden'], 'hover');
const exportFormat = oneOf(['ask', 'zip', 'cbz'], 'ask');

export const SETTINGS_PREFS = Object.freeze({
  // Library
  libShowNavStats: { read: shownUnlessOff, write: Boolean },
  libMergeSeries: { read: shownUnlessOff, write: Boolean },
  libQuickActionsMode: { read: quickActions, write: quickActions },
  libHideAppLangFlag: { read: shownUnlessOff, write: Boolean },
  libShowCategoryTag: { read: shownUnlessOff, write: Boolean },
  // ZIP, CBZ, or asked at each export (the default); either holds the translations unless turned off.
  libExportFormat: { read: exportFormat, write: exportFormat },
  libExportTranslations: {
    also: ['libExportCbzTranslations'],
    read: (value, stored) => (value ?? stored.libExportCbzTranslations) !== false,
    write: Boolean,
  },
  // Experimental: the drawn scrollbars, off unless turned on (scrollbar.js reads the same).
  customScrollbar: { read: (value) => value === true, write: Boolean },
  // Reader. The chapter overview is stored as whether it is skipped.
  readerSkipOverview: { read: (value) => !value, write: (shown) => !shown },
  readerStripMode: { read: (value) => value !== 'chapter', write: (series) => (series ? 'series' : 'chapter') },
  readerChapterDivider: { read: shownUnlessOff, write: Boolean },
  readerTranslateDisplay: { read: (value) => (value === 'text' ? 'text' : 'image'), write: same },
  // Study mode
  readerStudyOriginal: { read: (value) => (value === 'text' ? 'text' : 'image'), write: same },
  readerStudySrcFont: { read: (value) => (value === 'kiwi' ? 'kiwi' : 'yasashisa'), write: same },
  readerFurigana: { read: (value) => value === 'on', write: (on) => (on ? 'on' : 'off') },
  readerStudyDisplay: { read: (value) => (value === 'text' ? 'text' : 'hardcoded_images'), write: same },
});

// The keys a preference is read from: its own, then any older ones.
export const prefKeys = (key) => [key, ...(SETTINGS_PREFS[key].also || [])];

// The value the control for `key` shows, from `stored` (platform.kv.get's answer for prefKeys(key)).
export const readPref = (key, stored) => SETTINGS_PREFS[key].read(stored[key], stored);

// What platform.kv.set is given when the control for `key` takes `value`.
export const writePref = (key, value) => ({ [key]: SETTINGS_PREFS[key].write(value) });
