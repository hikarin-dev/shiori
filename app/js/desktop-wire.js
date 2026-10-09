// desktop-wire.js — how a library held by the desktop app travels between it and a window: each
// message is one binary frame, a JSON header followed by the bytes of every Blob it carries. Values
// are what the library interface carries (plain data, Maps, Blobs); `undefined` survives too, since
// some operations tell an absent argument from a null one.

const TAG = '\u0000';   // marks an encoded value; no JSON a library holds uses this key

function _pack(value, blobs) {
  if (value === undefined) return { [TAG]: 'u' };
  // What a library can't hold is refused, as structured cloning refuses it.
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new DOMException(`a ${typeof value} can't be stored`, 'DataCloneError');
  }
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Blob) { blobs.push(value); return { [TAG]: 'b', i: blobs.length - 1 }; }
  if (value instanceof Map) return { [TAG]: 'm', e: [...value].map(([k, v]) => [_pack(k, blobs), _pack(v, blobs)]) };
  if (Array.isArray(value)) return value.map(v => _pack(v, blobs));
  if (ArrayBuffer.isView(value)) {
    blobs.push(new Blob([value]));
    return { [TAG]: 'a', i: blobs.length - 1 };
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = _pack(v, blobs);
  return out;
}

function _unpack(value, blobs) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => _unpack(v, blobs));
  const tag = value[TAG];
  if (tag === 'u') return undefined;
  if (tag === 'b') return blobs[value.i];
  if (tag === 'a') return blobs[value.i];
  if (tag === 'm') return new Map(value.e.map(([k, v]) => [_unpack(k, blobs), _unpack(v, blobs)]));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = _unpack(v, blobs);
  return out;
}

// One frame for `message` (an object; its Blobs travel as bytes after the header).
export async function encode(message) {
  const blobs = [];
  const body = _pack(message, blobs);
  const head = new TextEncoder().encode(JSON.stringify({ body, blobs: blobs.map(b => [b.size, b.type || '']) }));
  const total = 4 + head.length + blobs.reduce((n, b) => n + b.size, 0);
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, head.length, true);
  out.set(head, 4);
  let at = 4 + head.length;
  for (const b of blobs) {
    out.set(new Uint8Array(await b.arrayBuffer()), at);
    at += b.size;
  }
  return out;
}

// The message a frame holds; `bytes` is an ArrayBuffer or a Uint8Array. A frame whose bytes don't
// add up to what its header declares is refused, never read as shorter pictures.
export function decode(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.byteLength < 4) throw new Error('a frame too short');
  const headLength = new DataView(view.buffer, view.byteOffset, view.byteLength).getUint32(0, true);
  if (4 + headLength > view.byteLength) throw new Error('a frame shorter than its header');
  const { body, blobs: sizes } = JSON.parse(new TextDecoder().decode(view.subarray(4, 4 + headLength)));
  if (!Array.isArray(sizes) || sizes.some(s => !Array.isArray(s) || !Number.isSafeInteger(s[0]) || s[0] < 0)) throw new Error('a frame with a bad header');
  let at = 4 + headLength;
  if (at + sizes.reduce((n, [size]) => n + size, 0) !== view.byteLength) throw new Error('a frame whose pictures don\'t add up');
  const blobs = sizes.map(([size, type]) => {
    const blob = new Blob([view.subarray(at, at + size)], typeof type === 'string' && type ? { type } : {});
    at += size;
    return blob;
  });
  return _unpack(body, blobs);
}
