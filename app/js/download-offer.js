// download-offer.js — the app's own download offer in Settings' optional panel: which package it
// offers and how it opens, by browser. Moved as it was from settings.js. Firefox (and browsers built on
// it) gets its own package, installed a different way; every other browser the one for Chrome. Firefox
// only lets a page start an add-on install in its own tab — from a new tab it refuses outright.
export const IS_FIREFOX = /\bFirefox\//.test(navigator.userAgent);
export const OFFER_URL = `https://github.com/hikarin-dev/shiori/releases/latest/download/${IS_FIREFOX ? 'extension-firefox.xpi' : 'extension.zip'}`;
