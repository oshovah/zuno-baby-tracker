// The daily key on this device (plan §2 "materialisation helper"): the raw
// Family Data Key, obtained by unwrapping the server copy with a password,
// is imported as a NON-extractable AES-GCM CryptoKey and that object is put
// into IndexedDB meta 'fdk' as {key}. A browser whose structured clone
// refuses CryptoKeys (DataCloneError) gets the raw bytes as {raw} instead —
// same trust boundary as the plaintext localStorage snapshot, no worse.
//
// The daily key is never re-wrapped: every flow that needs the raw FDK
// (join, rotation, password change, recovery code) re-derives from the
// password typed at that moment and unwraps the server copy again.
//
// Everything rejects when IndexedDB is unusable (see db.js); callers decide.

import { getMeta, setMeta, deleteMeta } from './db.js';
import { importFdk } from './crypto.js';

const META_KEY = 'fdk';

function isCryptoKey(v) {
  if (!v || typeof v !== 'object') return false;
  if (typeof globalThis.CryptoKey === 'function' && v instanceof globalThis.CryptoKey) return true;
  // Some engines hand back a structured-clone twin that is not `instanceof`
  // the current realm's class — duck-type it.
  return v.type === 'secret' && v.algorithm && v.algorithm.name === 'AES-GCM';
}

/**
 * The stored daily key, or null when this device holds none. A {raw}
 * fallback record is imported on the fly (non-extractable) and the copy is
 * zeroed. Rejects when IndexedDB fails.
 */
export async function loadFdk() {
  const rec = await getMeta(META_KEY);
  if (!rec || typeof rec !== 'object') return null;
  if (isCryptoKey(rec.key)) return rec.key;
  if (rec.raw) {
    const src = rec.raw instanceof ArrayBuffer ? new Uint8Array(rec.raw) : rec.raw;
    if (!(src instanceof Uint8Array)) return null;
    const raw = new Uint8Array(src); // own copy, zeroed below
    try {
      return await importFdk(raw, false);
    } finally {
      raw.fill(0);
    }
  }
  return null;
}

/**
 * Materialise fdkRaw (32 bytes) as the device's daily key: import
 * non-extractable, put {key}; on DataCloneError put {raw} instead. The
 * caller's buffer is zeroed afterwards in every case — hold the returned
 * CryptoKey, not the bytes. Rejects (after zeroing) when IndexedDB refuses
 * the put for any other reason; the caller keeps its in-memory key
 * (store.unlockWith) and the next boot asks for the password again.
 */
export async function storeFdk(fdkRaw) {
  try {
    const key = await importFdk(fdkRaw, false);
    try {
      await setMeta(META_KEY, { key });
    } catch (e) {
      if (!e || e.name !== 'DataCloneError') throw e;
      await setMeta(META_KEY, { raw: fdkRaw.slice() });
    }
    return key;
  } finally {
    if (fdkRaw instanceof Uint8Array) fdkRaw.fill(0);
  }
}

/** Drop the stored key (logout / identity change). */
export function forgetFdk() {
  return deleteMeta(META_KEY);
}
