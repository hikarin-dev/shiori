// card-rules.ts — what a card's view (card-view.ts, which imports nothing of the app's so Node tests
// it as it is) is handed from the app's own modules: the pure rules it shares with the rest of the app,
// the number formats, and the languages' names. A page makes its env from these, its preferences, the
// language and the site's state.
import { pickSeriesTitle, pickTitle } from '@lib/titles.js';
import { chapterTally } from '@lib/series.js';
import { memberKind } from '@lib/gallery-model.js';
import { safeExternalUrl } from '@lib/sanitize.js';
import { LANG_TAG_NAME, langDisplayName } from '@lib/tag-editor.js';
import { formatBytes, formatCount, formatMegapixels } from '@lib/format.js';
import type { CardEnv, CardRules } from './card-view';

const CARD_RULES: CardRules = { pickTitle, pickSeriesTitle, chapterTally, memberKind, safeExternalUrl, LANG_TAG_NAME };

// The parts of an env that come from the app's modules as they are.
export const CARD_FORMATS: Pick<CardEnv, 'count' | 'bytes' | 'megapixels' | 'langName' | 'rules'> = {
  count: formatCount, bytes: formatBytes, megapixels: formatMegapixels, langName: langDisplayName, rules: CARD_RULES,
};
