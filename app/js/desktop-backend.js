// desktop-backend.js — the library kept by the desktop app, reached over its local connection. It
// offers the operations db.js offers, under the same names, so api.js can use either one. This
// page's own desktop library is the one library-location.js names: the desktop app's window says
// so itself; a site that chose the desktop library keeps its address and token; a page the desktop
// app serves at its own address is handed a site's token. Without any, this module stays inactive
// and opens nothing.
//
// Every call is one message over one WebSocket (desktop-wire.js), sent in the order made. What the
// library announces arrives on the same connection and is handed to this window's own listeners
// (platform.feed, platform.control), as db.js's announcements are, and so does what its windows on
// other origins relay (cover refreshes, job status). If the desktop app goes away,
// calls reject with a BackendError `unavailable` and the connection is tried again; a site's
// desktop app found on another of its ports is followed there.
//
// createClient(config) opens another desktop library for one purpose (moving a library into it);
// its announcements aren't this window's.

import * as platform from './platform.js';
import { encode, decode } from './desktop-wire.js';
import { BackendError } from './backend-error.js';
import { translatedImage } from './page-image.js';
import { imageToBlob } from './image-util.js';
import { activeDesktop, findDesktop, savedLocation, setLocation } from './library-location.js';

// The operations forwarded as they are (db.js's names).
const OPS = ['galleriesPage', 'galleriesCount', 'galleryIdsSorted', 'getGallery', 'getGalleriesByIds', 'getStats', 'tagCounts',
  'metaGetAllMap', 'resolveGalleryId', 'galleryCreate', 'mutateGallery', 'rebuildGalleryEntry', 'deleteGallery',
  'metaGet', 'metaGetAll', 'metaPut', 'seriesResolve', 'seriesChapters', 'seriesCommand', 'refreshSeriesAggregate',
  'pageList', 'pageHas', 'pageGet', 'getGalleryImageRecords', 'pagePut', 'deleteStaleGalleryImages',
  'putTranslatedPage', 'putTranslatedImage', 'putPageStudy', 'setPagesOwn', 'clearGalleryTranslations',
  'listGalleryStudyRecords', 'putPageData', 'coverGet', 'coverThumbnailGet', 'coverPreviewGet', 'coverThumbnailPut', 'coverPut',
  'sourceIconGet', 'sourceIconsAll', 'sourceIconPut', 'transferIds', 'transferRead', 'transferWrite',
  'changeRevision', 'changesSince', 'integritySnapshot', 'clearAll'];

// A connection to the desktop library `config` names ({ url, token }; `own` for a page the desktop
// app serves itself, its window or a page at its address, whose address never changes). `announce`: hand what it announces to this window.
export function createClient(config, { announce = false } = {}) {
  let socket = null, opening = null, connected = false, retry = null, sent = Promise.resolve(), seq = 0, closed = false;
  const pending = new Map();
  const reconnects = new Set();
  const unavailable = new Set();

  const connect = (url) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/api/ws?k=${encodeURIComponent(config.token)}`);
    ws.binaryType = 'arraybuffer';
    let open = false;
    ws.onopen = () => { open = true; resolve(ws); };
    ws.onmessage = (ev) => receive(ev.data);
    ws.onclose = () => {
      if (!open) { reject(new BackendError('unavailable', 'the desktop app is not running')); return; }
      if (socket === ws) socket = null;
      for (const p of pending.values()) p.reject(new BackendError('unavailable', 'the desktop app closed the connection'));
      pending.clear();
      for (const cb of [...unavailable]) { try { cb(); } catch {} }
      // Keep listening for what the library announces: come back as soon as the app does.
      if (!closed && !retry) {
        retry = setTimeout(() => { retry = null; open_().catch(() => {}); }, 2000);
        retry.unref?.();   // (in Node, where tests run, waiting to reconnect keeps nothing alive)
      }
    };
    ws.onerror = () => {};
  });

  function open_() {
    if (socket?.readyState === 1) return Promise.resolve(socket);
    if (opening) return opening;
    opening = (async () => {
      try {
        let ws;
        try { ws = await connect(config.url); } catch (e) {
          // A site's desktop app may have started on another of its ports: follow it there.
          if (config.own) throw e;
          const url = await findDesktop({ preferred: config.url });
          if (!url || url === config.url) throw e;
          ws = await connect(url);
          config.url = url;
          const saved = savedLocation();
          if (saved?.token === config.token) setLocation({ ...saved, url });
        }
        socket = ws;
        const again = connected;
        connected = true;
        if (again) for (const cb of [...reconnects]) { try { cb(); } catch {} }
        return ws;
      } finally { opening = null; }
    })();
    return opening;
  }

  function receive(data) {
    let msg;
    try { msg = decode(data); } catch { return; }
    if (msg?.push) {
      if (!announce) return;
      if (msg.push === 'feed') platform.feed.receive(msg.msg);
      else if (msg.push === 'control') platform.control.receive(msg.msg);
      else if (msg.push === 'jobs') platform.jobs.receive(msg.msg);
      return;
    }
    const p = pending.get(msg?.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new BackendError(msg.error?.code || 'aborted', msg.error?.message || 'the desktop library refused'));
  }

  async function call(op, ...args) {
    const ws = await open_();
    const id = ++seq;
    const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    // Frames go out in the order calls were made, though encoding one with images takes a moment.
    const frame = encode({ id, op, args });
    sent = sent.then(() => frame).then((bytes) => {
      if (!pending.has(id)) return;
      if (ws.readyState !== 1) throw new BackendError('unavailable', 'the desktop app closed the connection');
      ws.send(bytes);
    }).catch((e) => {
      const p = pending.get(id);
      if (p) { pending.delete(id); p.reject(e instanceof BackendError ? e : new BackendError('invalid', String(e?.message || e))); }
    });
    return result;
  }

  const client = Object.fromEntries(OPS.map(op => [op, (...args) => call(op, ...args)]));
  return Object.assign(client, {
    // Ends a run of silent writes; like db.js's, it returns at once.
    publishFeed(galleryId) { call('publishFeed', galleryId).catch(() => {}); },
    // Hands a message to this library's windows on other origins (platform.relayTo).
    relay(channel, msg) { call('relay', channel, msg).catch(() => {}); },
    // A page's image. A translated page kept as its study layers is composed here, where it can be
    // drawn; anything else comes as stored.
    async getPageBlob(galleryId, pageNum, variant) {
      if (variant !== 'translated') return call('getPageBlob', galleryId, pageNum, variant);
      const rec = await client.pageGet(galleryId, pageNum);
      if (!rec) return null;
      const translated = await translatedImage(rec);
      return imageToBlob(translated ?? rec.blob ?? rec.dataUrl);
    },
    // Called whenever the connection comes back after a break (api.events.watch catches up then),
    // and whenever it is lost.
    onReconnect(cb) { reconnects.add(cb); return () => reconnects.delete(cb); },
    onUnavailable(cb) { unavailable.add(cb); return () => unavailable.delete(cb); },
    // Whether the desktop library can be reached now (opening the connection if need be).
    reachable: () => open_().then(() => true, () => false),
    close() { closed = true; clearTimeout(retry); socket?.close(); },
  });
}

// ── This page's desktop library ──
const config = activeDesktop();
export const active = !!config;
const own = active ? createClient(config, { announce: true }) : null;
if (own) platform.relayTo((channel, msg) => own.relay(channel, msg));
const ownCall = (name) => (...args) => {
  if (!own) return Promise.reject(new BackendError('unavailable', 'this page has no desktop library'));
  return own[name](...args);
};

// ── Gallery ids are minted here, as in db.js (a timestamp, monotonic in this window) ──
let _lastGeneratedGalleryId = 0;
export function nextGalleryId() {
  _lastGeneratedGalleryId = Math.max(Date.now(), _lastGeneratedGalleryId + 1);
  return String(_lastGeneratedGalleryId);
}

export const galleriesPage = ownCall('galleriesPage');
export const galleriesCount = ownCall('galleriesCount');
export const galleryIdsSorted = ownCall('galleryIdsSorted');
export const getGallery = ownCall('getGallery');
export const getGalleriesByIds = ownCall('getGalleriesByIds');
export const getStats = ownCall('getStats');
export const tagCounts = ownCall('tagCounts');
export const metaGetAllMap = ownCall('metaGetAllMap');
export const resolveGalleryId = ownCall('resolveGalleryId');
export const galleryCreate = ownCall('galleryCreate');
export const mutateGallery = ownCall('mutateGallery');
export const rebuildGalleryEntry = ownCall('rebuildGalleryEntry');
export const deleteGallery = ownCall('deleteGallery');
export const metaGet = ownCall('metaGet');
export const metaGetAll = ownCall('metaGetAll');
export const metaPut = ownCall('metaPut');
export const seriesResolve = ownCall('seriesResolve');
export const seriesChapters = ownCall('seriesChapters');
export const seriesCommand = ownCall('seriesCommand');
export const refreshSeriesAggregate = ownCall('refreshSeriesAggregate');
export const pageList = ownCall('pageList');
export const pageHas = ownCall('pageHas');
export const pageGet = ownCall('pageGet');
export const getGalleryImageRecords = ownCall('getGalleryImageRecords');
export const pagePut = ownCall('pagePut');
export const deleteStaleGalleryImages = ownCall('deleteStaleGalleryImages');
export const putTranslatedPage = ownCall('putTranslatedPage');
export const putTranslatedImage = ownCall('putTranslatedImage');
export const putPageStudy = ownCall('putPageStudy');
export const setPagesOwn = ownCall('setPagesOwn');
export const clearGalleryTranslations = ownCall('clearGalleryTranslations');
export const listGalleryStudyRecords = ownCall('listGalleryStudyRecords');
export const putPageData = ownCall('putPageData');
export const coverGet = ownCall('coverGet');
export const coverThumbnailGet = ownCall('coverThumbnailGet');
export const coverPreviewGet = ownCall('coverPreviewGet');
export const coverThumbnailPut = ownCall('coverThumbnailPut');
export const coverPut = ownCall('coverPut');
export const sourceIconGet = ownCall('sourceIconGet');
export const sourceIconsAll = ownCall('sourceIconsAll');
export const sourceIconPut = ownCall('sourceIconPut');
export const transferIds = ownCall('transferIds');
export const transferRead = ownCall('transferRead');
export const transferWrite = ownCall('transferWrite');
export const changeRevision = ownCall('changeRevision');
export const changesSince = ownCall('changesSince');
export const integritySnapshot = ownCall('integritySnapshot');
export const clearAll = ownCall('clearAll');
export const getPageBlob = ownCall('getPageBlob');
export function publishFeed(galleryId) { own?.publishFeed(galleryId); }
export function onReconnect(cb) { return own ? own.onReconnect(cb) : () => {}; }
export function onUnavailable(cb) { return own ? own.onUnavailable(cb) : () => {}; }
export const reachable = () => (own ? own.reachable() : Promise.resolve(false));
