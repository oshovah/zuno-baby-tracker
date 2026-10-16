// Tests for src/devices.js and the press envelope of src/crypto.js: the
// device code, what a press may carry, the entry it becomes — and that the
// bytes a device produces with plain AES-256-GCM (node:crypto standing in
// for the sketch's mbedtls) are exactly what the phone opens.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes as nodeRandom } from 'node:crypto';

import {
  DEVICE_NAME_MAX,
  PRESS_MAX_AGE_DAYS,
  deviceCode,
  parseDeviceCode,
  groupedCode,
  cleanDeviceName,
  pressToDraft,
  testPress,
} from '../devices.js';
import { DEVICE_V, DEVICE_BUCKETS, sealPress, openPress, pressEid, randomDeviceKey, unb64u } from '../crypto.js';
import { validDetails, validateCreate, DEVICE_TYPE } from '../validate.js';

const NOW = '2026-10-16T12:00:00Z';
const TOKEN = '0123456789abcdef0123456789abcdef';
const KEY = 'a'.repeat(64);
const PRESS = { v: DEVICE_V, at: '2026-10-16T11:58:30Z', type: 'diaper', details: { kind: 'poop' } };

test('deviceCode / parseDeviceCode: the token then the key, 96 hex; whitespace and case are forgiven on the way back', () => {
  const code = deviceCode({ token: TOKEN, key: KEY });
  assert.equal(code, TOKEN + KEY);
  assert.deepEqual(parseDeviceCode(code), { token: TOKEN, key: KEY });
  assert.deepEqual(parseDeviceCode(groupedCode(code)), { token: TOKEN, key: KEY }, 'the grouped form parses too');
  assert.deepEqual(parseDeviceCode(code.toUpperCase()), { token: TOKEN, key: KEY });
  assert.equal(groupedCode(code).split(' ').length, 12, 'twelve groups of eight');
  assert.throws(() => parseDeviceCode(code.slice(1)), /96 Hex-Zeichen/);
  assert.throws(() => parseDeviceCode(code + 'g'), /96 Hex-Zeichen/);
  assert.throws(() => deviceCode({ token: 'x', key: KEY }), /Knopf-Code/);
  assert.throws(() => deviceCode({ token: TOKEN, key: KEY.slice(1) }), /Knopf-Schlüssel/);
});

test('cleanDeviceName: trimmed, collapsed, capped; empty = the default', () => {
  assert.equal(cleanDeviceName('  Wickeltisch   oben '), 'Wickeltisch oben');
  assert.equal(cleanDeviceName(''), 'Knopf');
  assert.equal(cleanDeviceName(null), 'Knopf');
  assert.equal([...cleanDeviceName('x'.repeat(100))].length, DEVICE_NAME_MAX);
  assert.equal([...cleanDeviceName('🔘'.repeat(100))].length, DEVICE_NAME_MAX, 'code points, not UTF-16 units');
});

test('validDetails(device): id, name, token, key — the shape the entry stores', () => {
  const d = validDetails(DEVICE_TYPE, { id: 3, name: ' Wickeltisch ', token: TOKEN, key: KEY, extra: 1 });
  assert.deepEqual(d, { id: 3, name: 'Wickeltisch', token: TOKEN, key: KEY });
  assert.throws(() => validDetails(DEVICE_TYPE, { id: 0, name: 'x', token: TOKEN, key: KEY }), /details\.id/);
  assert.throws(() => validDetails(DEVICE_TYPE, { id: '3', name: 'x', token: TOKEN, key: KEY }), /details\.id/);
  assert.throws(() => validDetails(DEVICE_TYPE, { id: 3, name: '  ', token: TOKEN, key: KEY }), /details\.name/);
  assert.throws(() => validDetails(DEVICE_TYPE, { id: 3, name: 'x'.repeat(41), token: TOKEN, key: KEY }), /details\.name/);
  assert.throws(() => validDetails(DEVICE_TYPE, { id: 3, name: 'x', token: TOKEN.toUpperCase(), key: KEY }), /details\.token/);
  assert.throws(() => validDetails(DEVICE_TYPE, { id: 3, name: 'x', token: TOKEN, key: KEY + '0' }), /details\.key/);
  const v = validateCreate({ type: DEVICE_TYPE, details: { id: 3, name: 'x', token: TOKEN, key: KEY } }, NOW);
  assert.equal(v.type, DEVICE_TYPE);
  assert.equal(v.endedAt, null);
});

test('pressToDraft: the envelope version, an event type, a recent instant; the details pass through to the create', () => {
  assert.deepEqual(pressToDraft(PRESS, NOW), { type: 'diaper', startedAt: '2026-10-16T11:58:30Z', details: { kind: 'poop' } });
  assert.deepEqual(pressToDraft({ ...PRESS, at: '2026-10-16T13:58:30+02:00' }, NOW).startedAt, '2026-10-16T11:58:30Z', 'canonicalised');
  assert.deepEqual(pressToDraft({ ...PRESS, details: null }, NOW).details, {}, 'the create validates the details');
  assert.throws(() => pressToDraft({ ...PRESS, v: 1 }, NOW), /Unbekanntes Format/);
  assert.throws(() => pressToDraft({ ...PRESS, type: 'settings' }, NOW), /unbekannten Eintragstyp/);
  assert.throws(() => pressToDraft({ ...PRESS, type: 'device' }, NOW), /unbekannten Eintragstyp/);
  assert.throws(() => pressToDraft({ ...PRESS, at: '2026-10-16T12:20:00Z' }, NOW), /Uhr des Knopfs/, 'the future');
  assert.throws(() => pressToDraft({ ...PRESS, at: '1970-01-01T00:00:10Z' }, NOW), /Uhr des Knopfs/, 'a clock never set');
  assert.throws(() => pressToDraft({ ...PRESS, at: 'gestern' }, NOW), /Uhr des Knopfs/);
  const edge = new Date(Date.parse(NOW) - PRESS_MAX_AGE_DAYS * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  assert.equal(pressToDraft({ ...PRESS, at: edge }, NOW).startedAt, edge, 'exactly the horizon still counts');
  assert.throws(() => pressToDraft(null, NOW), /Unbekanntes Format/);
  // The test press is a wet diaper, now.
  assert.deepEqual(testPress(NOW), { v: DEVICE_V, at: NOW, type: 'diaper', details: { kind: 'pee' } });
  assert.deepEqual(pressToDraft(testPress(NOW), NOW), { type: 'diaper', startedAt: NOW, details: { kind: 'pee' } });
});

test('sealPress / openPress: the wire format is the documented one — version 0x03, iv, AES-256-GCM over the 128-byte bucket', async () => {
  assert.equal(DEVICE_V, 3);
  assert.deepEqual(DEVICE_BUCKETS, [128, 256]);
  const key = randomDeviceKey();
  assert.match(key, /^[0-9a-f]{64}$/);
  const blob = await sealPress(key, PRESS);
  const bytes = unb64u(blob);
  assert.equal(bytes[0], 3);
  assert.equal(bytes.length, 1 + 12 + 128 + 16, 'the 128-byte bucket');
  const blob2 = await sealPress(key, { ...PRESS, details: { kind: 'pee' } });
  assert.equal(unb64u(blob2).length, bytes.length, 'a Pipi and a Gaggi have the same length on the wire');
  assert.notEqual(blob, blob2);
  assert.deepEqual(await openPress(key, blob), PRESS);
  assert.deepEqual(await openPress(new Uint8Array(Buffer.from(key, 'hex')), blob), PRESS, 'the key as bytes too');

  // Independent check with node:crypto (what the sketch's mbedtls does).
  const d = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), bytes.subarray(1, 13));
  d.setAAD(Buffer.from('bt1|device'));
  d.setAuthTag(Buffer.from(bytes.subarray(bytes.length - 16)));
  const plain = Buffer.concat([d.update(bytes.subarray(13, bytes.length - 16)), d.final()]).toString('utf8');
  assert.equal(plain.length, 128, 'padded with spaces to the bucket');
  assert.deepEqual(JSON.parse(plain.trimEnd()), PRESS);

  // A wrong key, a tampered byte, another envelope version: all refused.
  await assert.rejects(openPress(randomDeviceKey(), blob), /Entschlüsselung fehlgeschlagen/);
  const flipped = Uint8Array.from(bytes);
  flipped[20] ^= 1;
  await assert.rejects(openPress(key, Buffer.from(flipped).toString('base64url')), /Entschlüsselung fehlgeschlagen/);
  const v1 = Uint8Array.from(bytes);
  v1[0] = 1;
  await assert.rejects(openPress(key, Buffer.from(v1).toString('base64url')), /Unbekanntes Datenformat/);
  await assert.rejects(openPress('zz'.repeat(32), blob), /Ungültige Schlüsseldaten/);
  await assert.rejects(sealPress(key, { ...PRESS, details: { note: 'x'.repeat(300) } }), /zu gross|too big|Datensatz/i, 'nothing fits past 256 bytes');
});

test('a press sealed the way the sketch does it (node:crypto, by hand) opens on the phone', async () => {
  const keyHex = randomDeviceKey();
  // The sketch: the JSON, padded with spaces to 128 bytes, a random 12-byte
  // iv, AES-256-GCM with AAD "bt1|device", then 0x03 ‖ iv ‖ ciphertext ‖ tag.
  const json = JSON.stringify({ v: 3, at: '2026-10-16T11:59:00Z', type: 'diaper', details: { kind: 'pee' } });
  const padded = Buffer.alloc(128, 0x20);
  padded.write(json, 'utf8');
  const iv = nodeRandom(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  c.setAAD(Buffer.from('bt1|device'));
  const ct = Buffer.concat([c.update(padded), c.final()]);
  const blob = Buffer.concat([Buffer.from([3]), iv, ct, c.getAuthTag()]).toString('base64url');
  assert.deepEqual(await openPress(keyHex, blob), { v: 3, at: '2026-10-16T11:59:00Z', type: 'diaper', details: { kind: 'pee' } });
  assert.deepEqual(pressToDraft(await openPress(keyHex, blob), NOW), { type: 'diaper', startedAt: '2026-10-16T11:59:00Z', details: { kind: 'pee' } });
});

test('pressEid: deterministic per (device, press), 32 hex, the first half of SHA-256("bt/v1/press|<device>|<press>")', async () => {
  const eid = await pressEid(7, 42);
  assert.match(eid, /^[0-9a-f]{32}$/);
  assert.equal(eid, await pressEid(7, 42));
  assert.equal(eid, createHash('sha256').update('bt/v1/press|7|42').digest('hex').slice(0, 32));
  assert.notEqual(eid, await pressEid(7, 43));
  assert.notEqual(eid, await pressEid(8, 42));
  await assert.rejects(pressEid(0, 1));
  await assert.rejects(pressEid(1, '1'));
});
