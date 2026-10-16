// Physical buttons («Taster»): a microcontroller with real buttons — next
// to the changing table, say — that logs an entry without anyone picking up
// a phone (arduino/ in the repository holds the sketch). The pure half:
// the device code, what a press carries and the entry it becomes. No DOM,
// no network; store.js does the talking, device-sheet.js the showing.
//
// How it fits the encryption: the server never sees what a press means. A
// member's phone registers the device (POST /api/devices → an id and a
// TOKEN the server keeps as a hash) and makes a KEY the server never gets;
// both go into one entry of type `device` (validate.js DEVICE_TYPE), so the
// family's other phones have them too, and — joined — into the one CODE the
// sketch wants. The device seals every press with the key (crypto.js
// sealPress) and posts it with the token; the family's sync pages carry
// the sealed presses until a phone opens them, writes the entries through
// the normal path (loggedBy = the device's name) and deletes the presses.
//
// A press (the device's plaintext, inside the sealed blob):
//   {v: 3, at: '2026-10-16T12:34:56Z', type: 'diaper', details: {kind: 'pee'}}
// `at` is the device's own clock (synced from the app host's Date header,
// never a third party); a press older than PRESS_MAX_AGE_DAYS or in the
// future is refused — a device with a broken clock must not write 1970.

import { t } from './i18n/index.js';
import { EVENT_TYPES, canonDatetime, assertNotFuture, isoFromMs, DEVICE_NAME_MAX } from './validate.js';
import { DEVICE_V } from './crypto.js';

export { DEVICE_NAME_MAX };

/** A press older than this is a device that slept with a wrong clock, not a diaper. */
export const PRESS_MAX_AGE_DAYS = 7;

const TOKEN_RE = /^[0-9a-f]{32}$/;
const KEY_RE = /^[0-9a-f]{64}$/;

/** The code the sketch wants: the token (32 hex) followed by the key (64 hex). */
export function deviceCode(details) {
  if (!details || typeof details.token !== 'string' || !TOKEN_RE.test(details.token)) throw new Error(t('errors.validate.deviceToken'));
  if (typeof details.key !== 'string' || !KEY_RE.test(details.key)) throw new Error(t('errors.validate.deviceKey'));
  return details.token + details.key;
}

/** The inverse (what the sketch does with the code): {token, key}. Whitespace is ignored. */
export function parseDeviceCode(code) {
  const compact = typeof code === 'string' ? code.replace(/\s+/g, '').toLowerCase() : '';
  if (!/^[0-9a-f]{96}$/.test(compact)) throw new Error(t('errors.validate.deviceCode'));
  return { token: compact.slice(0, 32), key: compact.slice(32) };
}

/** The code in groups of eight for the eye (what the sheet shows; the sketch ignores spaces). */
export function groupedCode(code) {
  return String(code).replace(/(.{8})(?=.)/g, '$1 ');
}

/** A name as the entry stores it (trimmed, at most DEVICE_NAME_MAX characters), or the default. */
export function cleanDeviceName(name) {
  const trimmed = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  const out = trimmed === '' ? t('devices.defaultName') : trimmed;
  return [...out].slice(0, DEVICE_NAME_MAX).join('');
}

/**
 * The entry draft a press becomes ({type, startedAt, details} for
 * store.entries.create), or a throw with the reason: the envelope version,
 * an event type, a canonical instant not in the future and not older than
 * PRESS_MAX_AGE_DAYS. The details are validated by the create itself.
 */
export function pressToDraft(plain, nowIso) {
  const now = nowIso ?? isoFromMs(Date.now());
  if (!plain || typeof plain !== 'object' || plain.v !== DEVICE_V) throw new Error(t('errors.devices.pressVersion'));
  if (typeof plain.type !== 'string' || !EVENT_TYPES.includes(plain.type)) throw new Error(t('errors.devices.pressType'));
  let at;
  try {
    at = canonDatetime(plain.at, 'at');
    assertNotFuture(at, now);
  } catch {
    throw new Error(t('errors.devices.pressTime'));
  }
  if (Date.parse(now) - Date.parse(at) > PRESS_MAX_AGE_DAYS * 86400000) throw new Error(t('errors.devices.pressTime'));
  const details = plain.details && typeof plain.details === 'object' && !Array.isArray(plain.details) ? plain.details : {};
  return { type: plain.type, startedAt: at, details };
}

/** The press the «Testdruck» button sends: a wet diaper, now — exactly what the first button of the sketch sends. */
export function testPress(nowIso) {
  return { v: DEVICE_V, at: nowIso ?? isoFromMs(Date.now()), type: 'diaper', details: { kind: 'pee' } };
}
