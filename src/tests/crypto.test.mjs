// node --test src/tests/*.test.mjs  (Node >= 20; `npm test` runs it after the PHP suite)
//
// Tests for src/crypto.js: encodings, key derivation (determinism, NFC,
// domain separation, fixed vectors cross-checked against node:crypto),
// FDK wrap/unwrap, recovery code, padding buckets and the entry/profile
// envelope incl. AAD binding and tamper detection.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync, hkdfSync, createCipheriv } from 'node:crypto';

import {
  KDF_ITER,
  KDF_MIN_ITER,
  ENVELOPE_V,
  b64u,
  unb64u,
  randomBytes,
  randomEid,
  deriveKeys,
  randomFamilyKeys,
  generateFdkRaw,
  wrapFdk,
  unwrapFdk,
  importFdk,
  recoveryAuthKey,
  recoveryCode,
  rawFromRecoveryCode,
  encryptEntry,
  decryptEntry,
  encryptProfile,
  decryptProfile,
  padTo,
} from '../crypto.js';

const B64U_RE = /^[A-Za-z0-9_-]+$/;
const SALT = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
const SALT2 = new Uint8Array([16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
const FDK_FIXED = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
const EID = 'd3cc1fd7fbdf5f9427d18fc3a9d8430a';
const EID2 = '0123456789abcdef0123456789abcdef';
const FAMILY = 7;

// Blob length per plaintext bucket: b64u(1 + 12 + bucket + 16 bytes).
const blobChars = (bucket) => Math.ceil(((1 + 12 + bucket + 16) * 4) / 3);

// Realistic sample of every entry type (details as validated by entries.php).
const SAMPLES = {
  breastfeed: {
    type: 'breastfeed',
    startedAt: '2026-09-06T03:12:00Z',
    endedAt: '2026-09-06T03:31:00Z',
    details: { side: 'L' },
  },
  bottle: {
    type: 'bottle',
    startedAt: '2026-09-06T06:40:00Z',
    endedAt: null,
    details: { amount_ml: 60, colostrum_ml: 5 },
  },
  diaper: { type: 'diaper', startedAt: '2026-09-06T07:02:00Z', endedAt: null, details: { kind: 'both' } },
  sleep: { type: 'sleep', startedAt: '2026-09-06T07:30:00Z', endedAt: null, details: {} },
  weight: { type: 'weight', startedAt: '2026-09-06T09:00:00Z', endedAt: null, details: { grams: 3480 } },
  temperature: {
    type: 'temperature',
    startedAt: '2026-09-06T09:05:00Z',
    endedAt: null,
    details: { celsius: 37.2 },
  },
  medication: {
    type: 'medication',
    startedAt: '2026-09-06T09:10:00Z',
    endedAt: null,
    details: { name: 'Vitamin D Tropfen' },
  },
};

function entry(sample, eid = EID, rev = 1, loggedBy = 'Papa') {
  return { eid, rev, ...sample, loggedBy };
}

function nodeB64u(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let fdkKeyCache;
async function fixedFdkKey() {
  if (!fdkKeyCache) fdkKeyCache = await importFdk(FDK_FIXED);
  return fdkKeyCache;
}

// ---------------------------------------------------------------------------
// Constants and encodings

test('exported constants', () => {
  assert.equal(KDF_ITER, 600000);
  assert.equal(KDF_MIN_ITER, 600000);
  assert.equal(ENVELOPE_V, 1);
});

test('b64u: known vectors, round trip, strictness', () => {
  assert.equal(b64u(new Uint8Array([])), '');
  assert.equal(b64u(new Uint8Array([0xff, 0xfe])), '__4'); // '+' and '/' become '-' and '_', no '='
  assert.equal(b64u(new Uint8Array([0xfb, 0xff])), '-_8');
  assert.deepEqual(unb64u('__4'), new Uint8Array([0xff, 0xfe]));
  for (const n of [0, 1, 2, 3, 4, 31, 32, 40, 285]) {
    const bytes = randomBytes(n);
    const s = b64u(bytes);
    assert.match(s || 'A', B64U_RE);
    assert.equal(s.length, Math.ceil((n * 4) / 3));
    assert.deepEqual(unb64u(s), bytes);
  }
  for (const bad of ['__4=', '+/8', 'A', 'AAAAA', 'ab cd', '__5', 'AB', null, 42]) {
    assert.throws(() => unb64u(bad), /Ungültige Base64-Daten/, `expected throw for ${JSON.stringify(bad)}`);
  }
});

test('randomBytes / randomEid', () => {
  assert.equal(randomBytes(16).length, 16);
  assert.notDeepEqual(randomBytes(16), randomBytes(16));
  const eids = new Set();
  for (let i = 0; i < 50; i++) {
    const eid = randomEid();
    assert.match(eid, /^[0-9a-f]{32}$/);
    eids.add(eid);
  }
  assert.equal(eids.size, 50);
});

// ---------------------------------------------------------------------------
// Key derivation

test('deriveKeys: PBKDF2 600k timing (informational)', async (t) => {
  const t0 = performance.now();
  await deriveKeys('correct horse battery staple', SALT, KDF_ITER, 'user');
  const ms = performance.now() - t0;
  t.diagnostic(`PBKDF2-SHA256 ${KDF_ITER} iterations + HKDF: ${ms.toFixed(1)} ms`);
  console.log(`  PBKDF2-SHA256 ${KDF_ITER} iterations + HKDF: ${ms.toFixed(1)} ms`);
});

test('deriveKeys: deterministic, 43-char b64u authKey, AES-KW KEK', async () => {
  const a = await deriveKeys('Muttermilch!23', SALT, KDF_ITER, 'user');
  const b = await deriveKeys('Muttermilch!23', SALT, KDF_ITER, 'user');
  assert.equal(a.authKey, b.authKey);
  assert.equal(a.authKey.length, 43);
  assert.match(a.authKey, B64U_RE);
  assert.equal(unb64u(a.authKey).length, 32);
  assert.equal(a.kek.type, 'secret');
  assert.equal(a.kek.algorithm.name, 'AES-KW');
  assert.equal(a.kek.algorithm.length, 256);
  assert.equal(a.kek.extractable, false);
  assert.deepEqual([...a.kek.usages].sort(), ['unwrapKey', 'wrapKey']);
  // Same password → same KEK: a wrap under a and an unwrap under b agree.
  const fdk = await generateFdkRaw();
  assert.deepEqual(await unwrapFdk(await wrapFdk(fdk, a.kek), b.kek), fdk);
});

test('deriveKeys: NFC normalisation (composed vs decomposed é)', async () => {
  const composed = 'café au lait';
  const decomposed = 'café au lait';
  assert.notEqual(composed, decomposed);
  const a = await deriveKeys(composed, SALT, KDF_ITER, 'family');
  const b = await deriveKeys(decomposed, SALT, KDF_ITER, 'family');
  assert.equal(a.authKey, b.authKey);
});

test('deriveKeys: role, salt, password and iterations each change the result', async () => {
  const base = await deriveKeys('pw-secret-1', SALT, KDF_ITER, 'user');
  const role = await deriveKeys('pw-secret-1', SALT, KDF_ITER, 'family');
  const salt = await deriveKeys('pw-secret-1', SALT2, KDF_ITER, 'user');
  const pw = await deriveKeys('pw-secret-2', SALT, KDF_ITER, 'user');
  const iter = await deriveKeys('pw-secret-1', SALT, KDF_ITER + 1, 'user');
  const keys = [base.authKey, role.authKey, salt.authKey, pw.authKey, iter.authKey];
  assert.equal(new Set(keys).size, keys.length);
  // Domain separation: the family KEK cannot open a user-wrapped FDK.
  const fdk = await generateFdkRaw();
  const wrapped = await wrapFdk(fdk, base.kek);
  await assert.rejects(unwrapFdk(wrapped, role.kek));
});

test('deriveKeys: refuses weak or malformed parameters', async () => {
  const ERR = /Ungültige Schlüsselparameter/;
  await assert.rejects(deriveKeys('pw-secret-1', SALT, KDF_MIN_ITER - 1, 'user'), ERR);
  await assert.rejects(deriveKeys('pw-secret-1', SALT, 1000, 'user'), ERR);
  await assert.rejects(deriveKeys('pw-secret-1', SALT, '600000', 'user'), ERR);
  await assert.rejects(deriveKeys('pw-secret-1', SALT, 600000.5, 'user'), ERR);
  await assert.rejects(deriveKeys('pw-secret-1', SALT, 1e12, 'user'), ERR);
  await assert.rejects(deriveKeys('pw-secret-1', SALT, KDF_ITER, 'admin'), ERR);
  await assert.rejects(deriveKeys('pw-secret-1', new Uint8Array(8), KDF_ITER, 'user'), ERR);
  await assert.rejects(deriveKeys('pw-secret-1', 'salt', KDF_ITER, 'user'), ERR);
  await assert.rejects(deriveKeys('', SALT, KDF_ITER, 'user'), ERR);
  await assert.rejects(deriveKeys(null, SALT, KDF_ITER, 'user'), ERR);
  await assert.doesNotReject(deriveKeys('pw-secret-1', SALT, KDF_MIN_ITER, 'user'));
});

test('fixed vectors: match an independent node:crypto implementation', async () => {
  const password = 'correct horse';
  const { authKey, kek } = await deriveKeys(password, SALT, KDF_ITER, 'user');
  // Reference: PBKDF2-SHA256 → HKDF-SHA256 (empty salt) → base64url.
  const mk = pbkdf2Sync(Buffer.from(password.normalize('NFC'), 'utf8'), Buffer.from(SALT), KDF_ITER, 32, 'sha256');
  const refAuth = nodeB64u(hkdfSync('sha256', mk, Buffer.alloc(0), 'bt/v1/user/auth', 32));
  const refKek = Buffer.from(hkdfSync('sha256', mk, Buffer.alloc(0), 'bt/v1/user/kek', 32));
  assert.equal(authKey, refAuth);
  assert.equal(authKey, 'yfas63siFYU9u4DSBt-EEZ8p7adoexDgWmwY1bCQzI0');
  // AES-KW (RFC 3394, default IV A6..A6) of the fixed FDK under the reference KEK.
  const cipher = createCipheriv('id-aes256-wrap', refKek, Buffer.from('A6A6A6A6A6A6A6A6', 'hex'));
  const refWrapped = nodeB64u(Buffer.concat([cipher.update(Buffer.from(FDK_FIXED)), cipher.final()]));
  const wrapped = await wrapFdk(FDK_FIXED, kek);
  assert.equal(wrapped, refWrapped);
  assert.equal(wrapped, 'SG6pKTIpxkTKlHfotFkKaREC0eJoByrB2sEI4MjFLIM9og7ODB1f1g');
  // Recovery auth value: HKDF(FDK, "bt/v1/recovery").
  const refRecovery = nodeB64u(hkdfSync('sha256', Buffer.from(FDK_FIXED), Buffer.alloc(0), 'bt/v1/recovery', 32));
  assert.equal(await recoveryAuthKey(FDK_FIXED), refRecovery);
  assert.equal(await recoveryAuthKey(FDK_FIXED), 'YuJgRA7y0sgfzmy3vfI8dL4frbBp5EOXVTyYjFIikh8');
});

// ---------------------------------------------------------------------------
// FDK wrap / unwrap

test('wrapFdk / unwrapFdk: round trip, 54 chars, wrong password throws', async () => {
  const fdk = await generateFdkRaw();
  assert.ok(fdk instanceof Uint8Array);
  assert.equal(fdk.length, 32);
  const right = await deriveKeys('the family password', SALT, KDF_ITER, 'family');
  const wrong = await deriveKeys('the family passw0rd', SALT, KDF_ITER, 'family');
  const wrapped = await wrapFdk(fdk, right.kek);
  assert.equal(wrapped.length, 54);
  assert.match(wrapped, B64U_RE);
  assert.equal(unb64u(wrapped).length, 40);
  assert.equal(await wrapFdk(fdk, right.kek), wrapped); // AES-KW is deterministic
  const back = await unwrapFdk(wrapped, right.kek);
  assert.ok(back instanceof Uint8Array);
  assert.deepEqual(back, fdk);
  await assert.rejects(unwrapFdk(wrapped, wrong.kek), (e) => e.name === 'OperationError');
  // Corrupted key material is rejected before / by the integrity check.
  const bytes = unb64u(wrapped);
  bytes[20] ^= 0x01;
  await assert.rejects(unwrapFdk(b64u(bytes), right.kek), (e) => e.name === 'OperationError');
  await assert.rejects(unwrapFdk(wrapped.slice(0, 43), right.kek), /Ungültige Schlüsseldaten/);
  await assert.rejects(unwrapFdk('not base64!', right.kek), /Ungültige Schlüsseldaten/);
  await assert.rejects(wrapFdk(new Uint8Array(16), right.kek), /Ungültige Schlüsseldaten/);
});

test('randomFamilyKeys: the deriveKeys(family) shape from random bytes – wraps and unwraps the FDK, never repeats', async () => {
  const a = await randomFamilyKeys();
  const b = await randomFamilyKeys();
  assert.equal(a.authKey.length, 43);
  assert.match(a.authKey, B64U_RE);
  assert.equal(unb64u(a.authKey).length, 32);
  assert.equal(a.salt.length, 16);
  assert.notEqual(a.authKey, b.authKey);
  assert.notDeepEqual(Array.from(a.salt), Array.from(b.salt));
  assert.equal(a.kek.algorithm.name, 'AES-KW');
  assert.equal(a.kek.extractable, false);
  assert.deepEqual([...a.kek.usages].sort(), ['unwrapKey', 'wrapKey']);

  const wrapped = await wrapFdk(FDK_FIXED, a.kek);
  assert.equal(wrapped.length, 54);
  assert.deepEqual(Array.from(await unwrapFdk(wrapped, a.kek)), Array.from(FDK_FIXED));
  await assert.rejects(unwrapFdk(wrapped, b.kek), 'another random KEK does not unwrap it');
  const typed = await deriveKeys('irgendein passwort', a.salt, KDF_ITER, 'family');
  await assert.rejects(unwrapFdk(wrapped, typed.kek), 'no password derives to it');
});

test('importFdk: non-extractable AES-GCM by default, extractable on request', async () => {
  const fdk = await generateFdkRaw();
  const daily = await importFdk(fdk);
  assert.equal(daily.algorithm.name, 'AES-GCM');
  assert.equal(daily.algorithm.length, 256);
  assert.equal(daily.extractable, false);
  assert.deepEqual([...daily.usages].sort(), ['decrypt', 'encrypt']);
  const exportable = await importFdk(fdk, true);
  assert.equal(exportable.extractable, true);
  assert.deepEqual(new Uint8Array(await crypto.subtle.exportKey('raw', exportable)), fdk);
  await assert.rejects(importFdk(new Uint8Array(31)), /Ungültige Schlüsseldaten/);
  // A blob sealed under the unwrapped copy opens under the daily key.
  const blob = await encryptEntry(exportable, FAMILY, entry(SAMPLES.sleep));
  assert.equal((await decryptEntry(daily, FAMILY, EID, blob)).type, 'sleep');
});

// ---------------------------------------------------------------------------
// Recovery code

test('recovery: code round-trips, tolerates grouping, rejects junk', async () => {
  const fdk = await generateFdkRaw();
  const code = recoveryCode(fdk);
  assert.equal(code.length, 43);
  assert.match(code, B64U_RE);
  assert.deepEqual(rawFromRecoveryCode(code), fdk);
  // Grouped with spaces / newlines / tabs (how the UI shows it).
  const grouped = code.match(/.{1,5}/g).join(' ');
  assert.deepEqual(rawFromRecoveryCode(grouped), fdk);
  assert.deepEqual(rawFromRecoveryCode('  ' + code.match(/.{1,8}/g).join('\n\t') + ' \n'), fdk);
  // Dash-separated groups are accepted when the code itself has no dashes …
  const noDash = recoveryCode(FDK_FIXED);
  assert.ok(!noDash.includes('-'));
  assert.deepEqual(rawFromRecoveryCode(noDash.match(/.{1,5}/g).join('-')), FDK_FIXED);
  // … and a dash that IS part of the code survives (b64u alphabet).
  const withDash = new Uint8Array(32);
  withDash.fill(0xfb); // b64u of 0xfb 0xff … starts with '-'
  const dashCode = recoveryCode(withDash);
  assert.ok(dashCode.includes('-'));
  assert.deepEqual(rawFromRecoveryCode(dashCode), withDash);
  assert.deepEqual(rawFromRecoveryCode(dashCode.match(/.{1,6}/g).join(' ')), withDash);
  // Case-sensitive.
  assert.notDeepEqual(rawFromRecoveryCode(noDash.replace('B', 'b')), FDK_FIXED);
  const ERR = /Ungültiger Wiederherstellungscode/;
  assert.throws(() => rawFromRecoveryCode(code.slice(0, 42)), ERR);
  // (a dash-free code: with a '-' inside, 44 chars minus that dash would read as a grouped code)
  assert.throws(() => rawFromRecoveryCode(noDash + 'A'), ERR);
  assert.throws(() => rawFromRecoveryCode(code.slice(0, 42) + '+'), ERR);
  assert.throws(() => rawFromRecoveryCode(''), ERR);
  assert.throws(() => rawFromRecoveryCode(null), ERR);
  assert.throws(() => rawFromRecoveryCode('A'.repeat(44)), ERR);
  assert.throws(() => recoveryCode(new Uint8Array(16)), /Ungültige Schlüsseldaten/);
});

test('recoveryAuthKey: deterministic, 43 chars, differs from the code', async () => {
  const fdk = await generateFdkRaw();
  const a = await recoveryAuthKey(fdk);
  const b = await recoveryAuthKey(fdk);
  assert.equal(a, b);
  assert.equal(a.length, 43);
  assert.match(a, B64U_RE);
  assert.notEqual(a, recoveryCode(fdk));
  assert.notEqual(a, await recoveryAuthKey(await generateFdkRaw()));
  await assert.rejects(recoveryAuthKey(new Uint8Array(16)), /Ungültige Schlüsseldaten/);
});

// ---------------------------------------------------------------------------
// Padding

test('padTo: 256 / 512 buckets with trailing 0x20, throws above 512', () => {
  for (const n of [0, 1, 100, 255, 256]) {
    const out = padTo(new Uint8Array(n).fill(0x41));
    assert.equal(out.length, 256);
    assert.ok(out.subarray(0, n).every((b) => b === 0x41));
    assert.ok(out.subarray(n).every((b) => b === 0x20));
  }
  for (const n of [257, 400, 512]) {
    const out = padTo(new Uint8Array(n).fill(0x41));
    assert.equal(out.length, 512);
    assert.ok(out.subarray(n).every((b) => b === 0x20));
  }
  assert.throws(() => padTo(new Uint8Array(513)), /Daten sind zu gross/);
  assert.throws(() => padTo('abc'), /Ungültiger Datensatz/);
  // Profile buckets.
  assert.equal(padTo(new Uint8Array(128), [128, 256]).length, 128);
  assert.equal(padTo(new Uint8Array(129), [128, 256]).length, 256);
  assert.throws(() => padTo(new Uint8Array(257), [128, 256]), /Daten sind zu gross/);
});

// ---------------------------------------------------------------------------
// Entry envelope

test('encryptEntry: padding invariant – every type gives the same blob length', async () => {
  const key = await fixedFdkKey();
  const lengths = new Set();
  for (const [type, sample] of Object.entries(SAMPLES)) {
    const plain = entry(sample, EID, 12, 'Papa');
    const size = new TextEncoder().encode(JSON.stringify({ v: 1, ...plain })).length;
    assert.ok(size <= 256, `${type} sample must fit the 256 bucket (${size} bytes)`);
    const blob = await encryptEntry(key, FAMILY, plain);
    assert.match(blob, B64U_RE);
    lengths.add(blob.length);
    assert.deepEqual(await decryptEntry(key, FAMILY, EID, blob), { v: 1, ...plain });
  }
  assert.equal(lengths.size, 1);
  assert.equal([...lengths][0], blobChars(256)); // 380
});

test('encryptEntry: a 100-char medication name lands in the 512 bucket only when > 256 bytes', async () => {
  const key = await fixedFdkKey();
  const longName = 'Paracetamol Zäpfchen 125 mg nach Rücksprache mit der Kinderärztin bei Fieber über 38.5 Grad'.padEnd(100, ' geben');
  assert.equal([...longName].length, 100);
  const plain = entry({ ...SAMPLES.medication, details: { name: longName } }, EID, 3, 'Papa');
  const size = new TextEncoder().encode(JSON.stringify({ v: 1, ...plain })).length;
  assert.ok(size > 256 && size <= 512, `expected 257..512 plaintext bytes, got ${size}`);
  const blob = await encryptEntry(key, FAMILY, plain);
  assert.equal(blob.length, blobChars(512)); // 722
  assert.deepEqual((await decryptEntry(key, FAMILY, EID, blob)).details, { name: longName });
  // A medication whose JSON still fits 256 bytes stays in the small bucket.
  const shortPlain = entry({ ...SAMPLES.medication, details: { name: 'X'.repeat(80) } }, EID, 3, 'D');
  const shortSize = new TextEncoder().encode(JSON.stringify({ v: 1, ...shortPlain })).length;
  assert.ok(shortSize <= 256, `expected <= 256, got ${shortSize}`);
  assert.equal((await encryptEntry(key, FAMILY, shortPlain)).length, blobChars(256));
  // Beyond the 512 bucket the encryptor refuses instead of leaking a size.
  const huge = entry({ ...SAMPLES.medication, details: { name: 'ä'.repeat(300) } });
  await assert.rejects(encryptEntry(key, FAMILY, huge), /Daten sind zu gross/);
});

test('encryptEntry: fresh IV – two encryptions differ, both decrypt; key order fixed', async () => {
  const key = await fixedFdkKey();
  const plain = entry(SAMPLES.bottle, EID, 5, 'Anna');
  const a = await encryptEntry(key, FAMILY, plain);
  const b = await encryptEntry(key, FAMILY, plain);
  assert.notEqual(a, b);
  assert.equal(a.length, b.length);
  const ba = unb64u(a);
  const bb = unb64u(b);
  assert.equal(ba[0], 1);
  assert.equal(bb[0], 1);
  assert.notDeepEqual(ba.subarray(1, 13), bb.subarray(1, 13));
  const da = await decryptEntry(key, FAMILY, EID, a);
  assert.deepEqual(da, await decryptEntry(key, FAMILY, EID, b));
  assert.deepEqual(Object.keys(da), ['v', 'eid', 'rev', 'type', 'startedAt', 'endedAt', 'details', 'loggedBy']);
  assert.equal(da.endedAt, null);
  // Extra client-side fields (seq, createdAt …) never enter the envelope.
  const noisy = { ...plain, seq: 99, createdAt: '2026-09-06', error: 'x' };
  const dn = await decryptEntry(key, FAMILY, EID, await encryptEntry(key, FAMILY, noisy));
  assert.equal('seq' in dn, false);
  assert.equal('createdAt' in dn, false);
  // Input validation.
  await assert.rejects(encryptEntry(key, FAMILY, entry(SAMPLES.sleep, 'ABC')), /Ungültige Eintrags-ID/);
  await assert.rejects(encryptEntry(key, 'x', entry(SAMPLES.sleep)), /Ungültige Familien-ID/);
  await assert.rejects(encryptEntry(key, FAMILY, null), /Ungültiger Datensatz/);
});

test('decryptEntry: AAD binds family and eid; tampering and wrong key fail', async () => {
  const key = await fixedFdkKey();
  const blob = await encryptEntry(key, FAMILY, entry(SAMPLES.diaper));
  const DECRYPT = /Entschlüsselung fehlgeschlagen/;
  await assert.rejects(decryptEntry(key, FAMILY + 1, EID, blob), DECRYPT);
  await assert.rejects(decryptEntry(key, '8', EID, blob), DECRYPT);
  await assert.rejects(decryptEntry(key, FAMILY, EID2, blob), DECRYPT);
  await assert.rejects(decryptEntry(key, FAMILY, EID.toUpperCase(), blob), /Ungültige Eintrags-ID/);
  await assert.rejects(decryptEntry(await importFdk(await generateFdkRaw()), FAMILY, EID, blob), DECRYPT);
  // familyId as a numeric string is the same AAD as the number.
  assert.equal((await decryptEntry(key, String(FAMILY), EID, blob)).type, 'diaper');
  // Flip one byte in the IV, the ciphertext and the tag.
  for (const pos of [1, 13, 100, 284]) {
    const bytes = unb64u(blob);
    bytes[pos] ^= 0x80;
    await assert.rejects(decryptEntry(key, FAMILY, EID, b64u(bytes)), DECRYPT, `flipped byte ${pos}`);
  }
  // Truncated / malformed blobs.
  await assert.rejects(decryptEntry(key, FAMILY, EID, b64u(unb64u(blob).subarray(0, 28))), /Ungültiger Datensatz/);
  // 29 chars: length % 4 == 1 is never valid base64url (30 could decode canonically by chance).
  await assert.rejects(decryptEntry(key, FAMILY, EID, blob.slice(0, 29)), /Ungültige Base64-Daten/);
  await assert.rejects(decryptEntry(key, FAMILY, EID, blob.slice(0, -4)), DECRYPT);
  await assert.rejects(decryptEntry(key, FAMILY, EID, blob + '='), /Ungültige Base64-Daten/);
  await assert.rejects(decryptEntry(key, FAMILY, EID, ''), /Ungültiger Datensatz/);
});

test('decryptEntry: envelope version byte must be 1', async () => {
  const key = await fixedFdkKey();
  const bytes = unb64u(await encryptEntry(key, FAMILY, entry(SAMPLES.weight)));
  bytes[0] = 2;
  await assert.rejects(
    decryptEntry(key, FAMILY, EID, b64u(bytes)),
    /^Error: Unbekanntes Datenformat – bitte App aktualisieren$/
  );
  bytes[0] = 0;
  await assert.rejects(decryptEntry(key, FAMILY, EID, b64u(bytes)), /Unbekanntes Datenformat/);
});

// Craft envelopes by hand (same format, AAD chosen freely) to reach the
// checks that a well-formed AES-GCM result still has to pass.
async function craft(key, aad, plaintext, bucket = 256) {
  const padded = padTo(new TextEncoder().encode(plaintext), [bucket]);
  const iv = randomBytes(12);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) }, key, padded)
  );
  const out = new Uint8Array(1 + 12 + ct.length);
  out[0] = 1;
  out.set(iv, 1);
  out.set(ct, 13);
  return b64u(out);
}

test('decryptEntry: inner checks – eid swap, inner version, malformed JSON', async () => {
  const key = await fixedFdkKey();
  const aad = `bt1|${FAMILY}|${EID}`;
  const good = { v: 1, ...entry(SAMPLES.sleep) };
  assert.deepEqual(await decryptEntry(key, FAMILY, EID, await craft(key, aad, JSON.stringify(good))), good);
  const swapped = JSON.stringify({ ...good, eid: EID2 });
  await assert.rejects(decryptEntry(key, FAMILY, EID, await craft(key, aad, swapped)), /Datensatz passt nicht zum Eintrag/);
  const v2 = JSON.stringify({ ...good, v: 2 });
  await assert.rejects(decryptEntry(key, FAMILY, EID, await craft(key, aad, v2)), /Unbekanntes Datenformat/);
  for (const junk of ['{"v":1,', '[1,2]', '"str"', 'null', 'ÿþ']) {
    await assert.rejects(decryptEntry(key, FAMILY, EID, await craft(key, aad, junk)), /Ungültiger Datensatz/);
  }
  // Trailing whitespace padding is tolerated whatever the bucket size.
  assert.equal((await decryptEntry(key, FAMILY, EID, await craft(key, aad, JSON.stringify(good), 512))).type, 'sleep');
});

// ---------------------------------------------------------------------------
// Profile envelope

test('encryptProfile / decryptProfile: round trip, AAD by username, buckets', async () => {
  const key = await fixedFdkKey();
  const blob = await encryptProfile(key, 'papa', { displayName: 'Papa' });
  assert.match(blob, B64U_RE);
  assert.equal(blob.length, blobChars(128)); // 210
  assert.deepEqual(await decryptProfile(key, 'papa', blob), { displayName: 'Papa' });
  // Username canonicalisation matches the server (trim + lowercase).
  assert.deepEqual(await decryptProfile(key, ' Papa ', blob), { displayName: 'Papa' });
  await assert.rejects(decryptProfile(key, 'anna', blob), /Entschlüsselung fehlgeschlagen/);
  await assert.rejects(decryptProfile(key, '', blob), /Ungültiger Benutzername/);
  await assert.rejects(decryptEntry(key, FAMILY, EID, blob), /Entschlüsselung fehlgeschlagen/);
  // Two encryptions differ (IV) and both open.
  const again = await encryptProfile(key, 'papa', { displayName: 'Papa' });
  assert.notEqual(again, blob);
  assert.deepEqual(await decryptProfile(key, 'papa', again), { displayName: 'Papa' });
  // Longer names move to the 256 bucket; absurd ones are refused.
  const long = 'Mami ' + 'ä'.repeat(70);
  const longBlob = await encryptProfile(key, 'papa', { displayName: long });
  assert.equal(longBlob.length, blobChars(256));
  assert.deepEqual(await decryptProfile(key, 'papa', longBlob), { displayName: long });
  await assert.rejects(encryptProfile(key, 'papa', { displayName: 'x'.repeat(300) }), /Daten sind zu gross/);
  await assert.rejects(encryptProfile(key, 'papa', { displayName: 42 }), /Ungültiger Datensatz/);
  // Version byte and tamper checks apply here too.
  const bytes = unb64u(blob);
  bytes[0] = 2;
  await assert.rejects(decryptProfile(key, 'papa', b64u(bytes)), /Unbekanntes Datenformat/);
  const crafted = await craft(key, 'bt1|profile|papa', JSON.stringify({ v: 1, name: 'x' }), 128);
  await assert.rejects(decryptProfile(key, 'papa', crafted), /Ungültiger Datensatz/);
});
