// End-to-end encryption primitives (plan §2 / §10). Pure WebCrypto: the same
// code runs in the browser and under `node --test` (Node >= 20) — no DOM, no
// IndexedDB, no Buffer; the only import is the translations. Error messages
// are read from them at the moment they are thrown (never at module load)
// because the UI shows them verbatim in toasts.
//
// Key hierarchy
//   password ─PBKDF2-SHA256(NFC, salt16, 600k)─▶ MK (discarded right away)
//     MK ─HKDF "bt/v1/<role>/auth"─▶ authKey (b64u 43, bcrypted server-side)
//     MK ─HKDF "bt/v1/<role>/kek"──▶ KEK (AES-KW-256, wraps the FDK)
//   FDK = 32 random bytes (AES-GCM-256, one per family, encrypts every row)
//     FDK ─HKDF "bt/v1/recovery"───▶ recoveryAuthKey (bcrypted server-side)
//     b64u(FDK) = the 43-char recovery code shown to the user
//
// Envelope: b64u(0x01 || iv12 || AES-GCM(fdk, iv, aad, padded JSON)).
//   entry   AAD "bt1|<familyId>|<eid>", plaintext padded to 256 / 512 bytes
//   profile AAD "bt1|profile|<username>", plaintext padded to 128 / 256 bytes
// Padding is trailing 0x20 so JSON.parse ignores it; the fixed buckets keep
// the blob length from revealing the entry type.

import { t } from './i18n/index.js';

export const KDF_ITER = 600000;
export const KDF_MIN_ITER = 600000;
// Same ceiling as the server validator: a hostile /auth/params answer must
// not be able to pin the phone for hours.
export const KDF_MAX_ITER = 5000000;
export const ENVELOPE_V = 1;

const SALT_BYTES = 16;
const FDK_BYTES = 32;
const WRAPPED_BYTES = 40; // RFC 3394: 32-byte key + 8-byte integrity block
const IV_BYTES = 12;
const TAG_BITS = 128;
const ENTRY_BUCKETS = [256, 512];
const PROFILE_BUCKETS = [128, 256];
const ROLES = ['user', 'family'];
const HKDF_PREFIX = 'bt/v1/';

const EID_RE = /^[0-9a-f]{32}$/;

// ---------------------------------------------------------------------------
// Runtime helpers

function subtle() {
  const s = globalThis.crypto && globalThis.crypto.subtle;
  if (!s) throw new Error(t('errors.crypto.noSubtle'));
  return s;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function utf8(str) {
  return textEncoder.encode(str);
}

function isBytes(value, length) {
  return value instanceof Uint8Array && (length === undefined || value.length === length);
}

function withCause(error, cause) {
  if (cause !== undefined) error.cause = cause;
  return error;
}

// ---------------------------------------------------------------------------
// Encodings

/** base64url without padding (RFC 4648 §5). */
export function b64u(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error(t('errors.crypto.base64'));
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Strict inverse of b64u: alphabet, length and canonical trailing bits are enforced. */
export function unb64u(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str) || str.length % 4 === 1) {
    throw new Error(t('errors.crypto.base64'));
  }
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4);
  let bin;
  try {
    bin = atob(b64);
  } catch (e) {
    throw withCause(new Error(t('errors.crypto.base64')), e);
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  // Reject non-canonical encodings (stray bits in the last char) so one
  // byte string has exactly one accepted spelling.
  if (b64u(out) !== str) throw new Error(t('errors.crypto.base64'));
  return out;
}

export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

/** Entry id: 32 lowercase hex chars (16 random bytes), generated client-side. */
export function randomEid() {
  let hex = '';
  for (const b of randomBytes(16)) hex += b.toString(16).padStart(2, '0');
  return hex;
}

// ---------------------------------------------------------------------------
// Password → authKey + KEK

/**
 * Derive the two independent values behind a password. `role` is 'user' or
 * 'family'; the HKDF info strings keep the auth value from ever yielding the
 * KEK. Refuses server-supplied parameters below the floor (600000
 * iterations, 16-byte salt) so a tampered /auth/params answer cannot weaken
 * the derivation.
 */
export async function deriveKeys(password, saltBytes, iter, role) {
  if (typeof password !== 'string' || password === '') throw new Error(t('errors.crypto.kdf'));
  if (!isBytes(saltBytes, SALT_BYTES)) throw new Error(t('errors.crypto.kdf'));
  if (!Number.isSafeInteger(iter) || iter < KDF_MIN_ITER || iter > KDF_MAX_ITER) {
    throw new Error(t('errors.crypto.kdf'));
  }
  if (!ROLES.includes(role)) throw new Error(t('errors.crypto.kdf'));
  const s = subtle();

  const pwKey = await s.importKey('raw', utf8(password.normalize('NFC')), { name: 'PBKDF2' }, false, [
    'deriveBits',
  ]);
  const mk = new Uint8Array(
    await s.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: iter }, pwKey, 256)
  );
  try {
    const hk = await s.importKey('raw', mk, { name: 'HKDF' }, false, ['deriveBits', 'deriveKey']);
    const authBits = await s.deriveBits(hkdfParams(HKDF_PREFIX + role + '/auth'), hk, 256);
    const kek = await s.deriveKey(
      hkdfParams(HKDF_PREFIX + role + '/kek'),
      hk,
      { name: 'AES-KW', length: 256 },
      false,
      ['wrapKey', 'unwrapKey']
    );
    return { authKey: b64u(new Uint8Array(authBits)), kek };
  } finally {
    mk.fill(0); // MK is never kept; importKey copied what it needs
  }
}

function hkdfParams(info) {
  return { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(info) };
}

/**
 * A family credential nobody can type: the {authKey, kek} shape of
 * deriveKeys(…, 'family') from random bytes instead of a password. A
 * joining phone sends its wrapping (plus a random salt at KDF_ITER, which
 * the server insists on though nothing ever derives from it) as
 * `rotateFamily` with the join, so the family password that let it in
 * stops working the moment the join commits. Members never need the family
 * password again — their own password unlocks every device — and the next
 * person is let in by a member setting a fresh one under «Mehr › Konto».
 */
export async function randomFamilyKeys() {
  const kek = await subtle().importKey('raw', randomBytes(32), { name: 'AES-KW', length: 256 }, false, [
    'wrapKey',
    'unwrapKey',
  ]);
  return { authKey: b64u(randomBytes(32)), kek, salt: randomBytes(SALT_BYTES) };
}

// ---------------------------------------------------------------------------
// Family Data Key

export async function generateFdkRaw() {
  return randomBytes(FDK_BYTES);
}

/** AES-KW wrap of the raw FDK under a KEK from deriveKeys → b64u (54 chars). */
export async function wrapFdk(fdkRaw, kek) {
  if (!isBytes(fdkRaw, FDK_BYTES)) throw new Error(t('errors.crypto.keyData'));
  const s = subtle();
  const key = await s.importKey('raw', fdkRaw, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const wrapped = await s.wrapKey('raw', key, kek, 'AES-KW');
  return b64u(new Uint8Array(wrapped));
}

/**
 * Inverse of wrapFdk → raw FDK bytes. A wrong KEK (= wrong password) fails
 * the RFC 3394 integrity check and rejects with a WebCrypto OperationError —
 * the caller maps that to "falsches Passwort" without a round-trip.
 */
export async function unwrapFdk(wrapped, kek) {
  let bytes;
  try {
    bytes = unb64u(wrapped);
  } catch (e) {
    throw withCause(new Error(t('errors.crypto.keyData')), e);
  }
  if (bytes.length !== WRAPPED_BYTES) throw new Error(t('errors.crypto.keyData'));
  const s = subtle();
  const key = await s.unwrapKey('raw', bytes, kek, 'AES-KW', { name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  return new Uint8Array(await s.exportKey('raw', key));
}

/** The daily AES-GCM key. Non-extractable by default (what goes into IndexedDB). */
export async function importFdk(fdkRaw, extractable = false) {
  if (!isBytes(fdkRaw, FDK_BYTES)) throw new Error(t('errors.crypto.keyData'));
  return subtle().importKey('raw', fdkRaw, { name: 'AES-GCM', length: 256 }, extractable, [
    'encrypt',
    'decrypt',
  ]);
}

// ---------------------------------------------------------------------------
// Recovery code

/** HKDF(FDK, "bt/v1/recovery") → b64u; the server stores only its bcrypt. */
export async function recoveryAuthKey(fdkRaw) {
  if (!isBytes(fdkRaw, FDK_BYTES)) throw new Error(t('errors.crypto.keyData'));
  const s = subtle();
  const ikm = await s.importKey('raw', fdkRaw, { name: 'HKDF' }, false, ['deriveBits']);
  const bits = await s.deriveBits(hkdfParams(HKDF_PREFIX + 'recovery'), ikm, 256);
  return b64u(new Uint8Array(bits));
}

/** The raw FDK as a 43-char code (the UI shows it in groups separated by spaces). */
export function recoveryCode(fdkRaw) {
  if (!isBytes(fdkRaw, FDK_BYTES)) throw new Error(t('errors.crypto.keyData'));
  return b64u(fdkRaw);
}

/**
 * Parse a typed recovery code back into the raw FDK. Whitespace is ignored.
 * '-' is itself a base64url character, so dashes are dropped only when they
 * are clearly group separators (the whitespace-free input is longer than a
 * code and dropping them leaves exactly one code); a real dash in the code
 * is never touched. Case-sensitive. Throws unless the result is 32 bytes.
 */
export function rawFromRecoveryCode(code) {
  if (typeof code !== 'string') throw new Error(t('errors.crypto.recoveryCode'));
  let compact = code.replace(/\s+/g, '');
  const CODE_LEN = 43;
  if (compact.length > CODE_LEN && compact.replace(/-/g, '').length === CODE_LEN) {
    compact = compact.replace(/-/g, '');
  }
  if (compact.length !== CODE_LEN) throw new Error(t('errors.crypto.recoveryCode'));
  let raw;
  try {
    raw = unb64u(compact);
  } catch (e) {
    throw withCause(new Error(t('errors.crypto.recoveryCode')), e);
  }
  if (raw.length !== FDK_BYTES) throw new Error(t('errors.crypto.recoveryCode'));
  return raw;
}

// ---------------------------------------------------------------------------
// Envelope

/**
 * Pad with trailing spaces to the smallest bucket that fits (256 / 512 bytes
 * for entries; profiles pass [128, 256]). Throws when nothing fits — the
 * caller's validation keeps real data far below that.
 */
export function padTo(bytes, buckets = ENTRY_BUCKETS) {
  if (!(bytes instanceof Uint8Array)) throw new Error(t('errors.validate.invalidRecord'));
  const size = buckets.find((b) => bytes.length <= b);
  if (size === undefined) throw new Error(t('errors.crypto.tooBig'));
  const out = new Uint8Array(size);
  out.fill(0x20);
  out.set(bytes);
  return out;
}

function entryAad(familyId, eid) {
  const fid = String(familyId);
  if (!/^\d+$/.test(fid)) throw new Error(t('errors.crypto.familyId'));
  if (typeof eid !== 'string' || !EID_RE.test(eid)) throw new Error(t('errors.crypto.eid'));
  return utf8('bt1|' + fid + '|' + eid);
}

function profileAad(username) {
  // The server canonicalises usernames to lowercase ASCII; do the same here
  // so a profile sealed at registration opens after a later login.
  const name = typeof username === 'string' ? username.trim().toLowerCase() : '';
  if (name === '') throw new Error(t('errors.crypto.username'));
  return utf8('bt1|profile|' + name);
}

async function seal(fdk, aad, plaintextBytes, buckets) {
  const padded = padTo(plaintextBytes, buckets);
  const iv = randomBytes(IV_BYTES);
  const ct = new Uint8Array(
    await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: TAG_BITS }, fdk, padded)
  );
  const out = new Uint8Array(1 + IV_BYTES + ct.length);
  out[0] = ENVELOPE_V;
  out.set(iv, 1);
  out.set(ct, 1 + IV_BYTES);
  return b64u(out);
}

async function open(fdk, aad, blob) {
  const bytes = unb64u(blob);
  if (bytes.length < 1 + IV_BYTES + TAG_BITS / 8) throw new Error(t('errors.validate.invalidRecord'));
  if (bytes[0] !== ENVELOPE_V) throw new Error(t('errors.crypto.version'));
  let padded;
  try {
    padded = await subtle().decrypt(
      { name: 'AES-GCM', iv: bytes.subarray(1, 1 + IV_BYTES), additionalData: aad, tagLength: TAG_BITS },
      fdk,
      bytes.subarray(1 + IV_BYTES)
    );
  } catch (e) {
    throw withCause(new Error(t('errors.crypto.decrypt')), e);
  }
  let obj;
  try {
    obj = JSON.parse(textDecoder.decode(padded).trimEnd());
  } catch (e) {
    throw withCause(new Error(t('errors.validate.invalidRecord')), e);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(t('errors.validate.invalidRecord'));
  if (obj.v !== ENVELOPE_V) throw new Error(t('errors.crypto.version'));
  return obj;
}

/**
 * Seal one entry: {v:1, eid, rev, type, startedAt, endedAt, details,
 * loggedBy} (that key order) → padded → AES-GCM under AAD "bt1|<familyId>|<eid>"
 * → b64u(0x01 || iv || ciphertext). Fresh IV every call.
 */
export async function encryptEntry(fdk, familyId, plain) {
  if (!plain || typeof plain !== 'object') throw new Error(t('errors.validate.invalidRecord'));
  const aad = entryAad(familyId, plain.eid);
  const body = {
    v: ENVELOPE_V,
    eid: plain.eid,
    rev: plain.rev,
    type: plain.type,
    startedAt: plain.startedAt,
    endedAt: plain.endedAt === undefined ? null : plain.endedAt,
    details: plain.details === undefined ? {} : plain.details,
    loggedBy: plain.loggedBy,
  };
  return seal(fdk, aad, utf8(JSON.stringify(body)), ENTRY_BUCKETS);
}

/**
 * Open one entry blob. Throws on an unknown envelope version, a failed
 * AES-GCM check (wrong key, other family, other eid, tampering), malformed
 * JSON, or a plaintext whose eid differs from the row's (swap detection).
 */
export async function decryptEntry(fdk, familyId, eid, blob) {
  const plain = await open(fdk, entryAad(familyId, eid), blob);
  if (plain.eid !== eid) throw new Error(t('errors.crypto.eidMismatch'));
  return plain;
}

/** Profile blob {v:1, displayName}, AAD "bt1|profile|<username>", 128/256 buckets. */
export async function encryptProfile(fdk, username, { displayName }) {
  if (typeof displayName !== 'string') throw new Error(t('errors.validate.invalidRecord'));
  const aad = profileAad(username);
  return seal(fdk, aad, utf8(JSON.stringify({ v: ENVELOPE_V, displayName })), PROFILE_BUCKETS);
}

export async function decryptProfile(fdk, username, blob) {
  const plain = await open(fdk, profileAad(username), blob);
  if (typeof plain.displayName !== 'string') throw new Error(t('errors.validate.invalidRecord'));
  return { displayName: plain.displayName };
}
