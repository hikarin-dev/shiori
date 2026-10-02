// desktop-backend.js — the library kept by the desktop app, reached over its local connection. It
// offers the operations db.js offers, under the same names, so api.js can use either one. The
// desktop app's window says where its library is (`globalThis.shioriDesktop`: { url, token });
// without that this module stays inactive and opens nothing.
//
// Every call is one message over one WebSocket (desktop-wire.js), sent in the order made. What the
// library announces arrives on the same connection and is handed to this window's own listeners
// (platform.feed, platform.control), as db.js's announcements are. If the desktop app goes away,
// calls reject with a BackendError `unavailable` and the connection is tried again.

import * as platform from './platform.js';
import { encode, decode } from './desktop-wire.js';
import { BackendError } from './backend-error.js';
import { translatedImage } from './page-image.js';
import { imageToBlob } from './image-util.js';

const config = globalThis.shioriDesktop || null;
export const active = !!(config?.url && config?.token);

let _socket = null, _opening = null, _connected = false, _retry = null, _sent = Promise.resolve();
let _seq = 0;
const _pending = new Map();
const _reconnects = new Set();

function _open() {
  if (_socket?.readyState === 1) return Promise.resolve(_socket);
  if (_opening) return _opening;
  _opening = new Promise((resolve, reject) => {
    const ws = new WebSocket(`${config.url.replace(/^http/, 'ws')}/api/ws?k=${encodeURIComponent(config.token)}`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      _socket = ws;
      _opening = null;
      const again = _connected;
      _connected = true;
      resolve(ws);
      if (again) for (const cb of [..._reconnects]) { try { cb(); } catch {} }
    };
    ws.onmessage = (ev) => _receive(ev.data);
    ws.onclose = () => {
      if (_socket === ws) _socket = null;
      if (_opening) { _opening = null; reject(new BackendError('unavailable', 'the desktop app is not running')); }
      for (const p of _pending.values()) p.reject(new BackendError('unavailable', 'the desktop app closed the connection'));
      _pending.clear();
      // Keep listening for what the library announces: come back as soon as the app does.
      if (_connected && !_retry) {
        _retry = setTimeout(() => { _retry = null; _open().catch(() => {}); }, 2000);
        _retry.unref?.();   // (in Node, where tests run, waiting to reconnect keeps nothing alive)
      }
    };
    ws.onerror = () => {};
  });
  return _opening;
}

function _receive(data) {
  let msg;
  try { msg = decode(data); } catch { return; }
  if (msg?.push === 'feed') { platform.feed.receive(msg.msg); return; }
  if (msg?.push === 'control') { platform.control.receive(msg.msg); return; }
  const p = _pending.get(msg?.id);
  if (!p) return;
  _pending.delete(msg.id);
  if (msg.ok) p.resolve(msg.result);
  else p.reject(new BackendError(msg.error?.code || 'aborted', msg.error?.message || 'the desktop library refused'));
}

async function _call(op, ...args) {
  const ws = await _open();
  const id = ++_seq;
  const result = new Promise((resolve, reject) => _pending.set(id, { resolve, reject }));
  // Frames go out in the order calls were made, though encoding one with images takes a moment.
  const frame = encode({ id, op, args });
  _sent = _sent.then(() => frame).then((bytes) => {
    if (!_pending.has(id)) return;
    if (ws.readyState !== 1) throw new BackendError('unavailable', 'the desktop app closed the connection');
    ws.send(bytes);
  }).catch((e) => {
    const p = _pending.get(id);
    if (p) { _pending.delete(id); p.reject(e instanceof BackendError ? e : new BackendError('invalid', String(e?.message || e))); }
  });
  return result;
}

// Called whenever the connection comes back after a break, so a window can catch up on what it
// missed (api.events.watch does).
export function onReconnect(cb) { _reconnects.add(cb); return () => _reconnects.delete(cb); }

// ── Gallery ids are minted here, as in db.js (a timestamp, monotonic in this window) ──
let _lastGeneratedGalleryId = 0;
export function nextGalleryId() {
  _lastGeneratedGalleryId = Math.max(Date.now(), _lastGeneratedGalleryId + 1);
  return String(_lastGeneratedGalleryId);
}

const call = (op) => (...args) => _call(op, ...args);

export const galleriesPage = call('galleriesPage');
export const galleriesCount = call('galleriesCount');
export const galleryIdsSorted = call('galleryIdsSorted');
export const getGallery = call('getGallery');
export const getGalleriesByIds = call('getGalleriesByIds');
export const getStats = call('getStats');
export const tagCounts = call('tagCounts');
export const metaGetAllMap = call('metaGetAllMap');
export const resolveGalleryId = call('resolveGalleryId');
export const galleryCreate = call('galleryCreate');
export const mutateGallery = call('mutateGallery');
export const rebuildGalleryEntry = call('rebuildGalleryEntry');
export const deleteGallery = call('deleteGallery');
export const metaGet = call('metaGet');
export const metaGetAll = call('metaGetAll');
export const metaPut = call('metaPut');
export const seriesResolve = call('seriesResolve');
export const seriesChapters = call('seriesChapters');
export const seriesCommand = call('seriesCommand');
export const refreshSeriesAggregate = call('refreshSeriesAggregate');
export const pageList = call('pageList');
export const pageHas = call('pageHas');
export const pageGet = call('pageGet');
export const getGalleryImageRecords = call('getGalleryImageRecords');
export const pagePut = call('pagePut');
export const deleteStaleGalleryImages = call('deleteStaleGalleryImages');
export const putTranslatedPage = call('putTranslatedPage');
export const putTranslatedImage = call('putTranslatedImage');
export const putPageStudy = call('putPageStudy');
export const setPagesOwn = call('setPagesOwn');
export const clearGalleryTranslations = call('clearGalleryTranslations');
export const listGalleryStudyRecords = call('listGalleryStudyRecords');
export const putPageData = call('putPageData');
export const coverGet = call('coverGet');
export const coverThumbnailGet = call('coverThumbnailGet');
export const coverPreviewGet = call('coverPreviewGet');
export const coverThumbnailPut = call('coverThumbnailPut');
export const coverPut = call('coverPut');
export const sourceIconGet = call('sourceIconGet');
export const sourceIconsAll = call('sourceIconsAll');
export const sourceIconPut = call('sourceIconPut');
export const transferIds = call('transferIds');
export const transferRead = call('transferRead');
export const transferWrite = call('transferWrite');
export const changeRevision = call('changeRevision');
export const changesSince = call('changesSince');
export const integritySnapshot = call('integritySnapshot');
export const clearAll = call('clearAll');

// Ends a run of silent writes; like db.js's, it returns at once.
export function publishFeed(galleryId) { _call('publishFeed', galleryId).catch(() => {}); }

// A page's image. A translated page kept as its study layers is composed here, where it can be
// drawn; anything else comes as stored.
export async function getPageBlob(galleryId, pageNum, variant) {
  if (variant !== 'translated') return _call('getPageBlob', galleryId, pageNum, variant);
  const rec = await pageGet(galleryId, pageNum);
  if (!rec) return null;
  const translated = await translatedImage(rec);
  return imageToBlob(translated ?? rec.blob ?? rec.dataUrl);
}
