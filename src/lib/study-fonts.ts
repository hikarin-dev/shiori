// study-fonts.ts — the faces study mode draws with (the comic lettering the translation renderer
// typesets in, and the two source-text faces), from the app's own files (app/fonts/): a copy installed
// on the computer wins. Added
// to the page once; nothing is downloaded until something draws in one, or load() asks for it.
import { siteRoot } from '../entry';

const FACES: [family: string, source: string][] = [
  ['CC Victory Speech', `local('CC Victory Speech'), url('${siteRoot}app/fonts/ccvictoryspeech.ttf') format('truetype')`],
  ['Yasashisa Antique', `local('07やさしさアンチック'), local('YasashisaAntique'), url('${siteRoot}app/fonts/YasashisaAntique.otf') format('opentype')`],
  ['Kiwi Maru', `local('Kiwi Maru'), url('${siteRoot}app/fonts/KiwiMaru-Regular.ttf') format('truetype')`],
];

let added = false;
export function addStudyFonts() {
  if (added || typeof FontFace === 'undefined') return;
  added = true;
  for (const [family, source] of FACES) document.fonts.add(new FontFace(family, source, { display: 'swap' }));
}
