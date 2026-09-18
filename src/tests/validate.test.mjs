// Port of the create/update validation cases from api/tests/api.test.php —
// same fixtures, same NOW (2026-09-01T10:00:00Z), and the exact German texts
// of api/lib/entries.php v2 (the UI toasts them verbatim).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TYPES,
  TIMER_TYPES,
  FEED_TYPES,
  TYPE_LABELS,
  FUTURE_GRACE_SECONDS,
  isTimerType,
  timerRunningMessage,
  canonDatetime,
  validLocalDate,
  assertNotFuture,
  validDetails,
  validateCreate,
  validateUpdate,
  validatePlain,
  validateLegacyPlain,
  EVENT_TYPES,
  SETTINGS_TYPE,
  REMINDER_TYPE,
  WHO_VALUES,
  isEventType,
} from '../validate.js';

const NOW = '2026-09-01T10:00:00Z';

/** Assert fn throws an Error with exactly this message (and status). */
function throwsMsg(fn, message, status = 400) {
  let caught = null;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof Error, `expected an Error for "${message}"`);
  assert.equal(caught.message, message);
  assert.equal(caught.status, status);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('type tables match entries.php, plus the family settings document, tasks and reminders', () => {
  assert.deepEqual(EVENT_TYPES, ['breastfeed', 'bottle', 'diaper', 'sleep', 'weight', 'temperature', 'medication', 'task']);
  assert.equal(SETTINGS_TYPE, 'settings');
  assert.equal(REMINDER_TYPE, 'reminder');
  assert.deepEqual(TYPES, [...EVENT_TYPES, 'settings', 'reminder']);
  assert.deepEqual(TIMER_TYPES, ['breastfeed', 'sleep']);
  assert.deepEqual(FEED_TYPES, ['breastfeed', 'bottle']);
  assert.deepEqual(TYPE_LABELS, {
    breastfeed: 'Stillen',
    bottle: 'Schoppen',
    diaper: 'Windel',
    sleep: 'Schlaf',
    weight: 'Gewicht',
    temperature: 'Temperatur',
    medication: 'Medikament',
    task: 'Erledigt',
    settings: 'Einstellungen',
    reminder: 'Erinnerung',
  });
  assert.deepEqual(WHO_VALUES, ['baby', 'mama', 'papa']);
  assert.equal(isEventType('settings'), false);
  assert.equal(isEventType('reminder'), false);
  assert.equal(isEventType('task'), true);
  assert.equal(isEventType('bottle'), true);
  assert.equal(FUTURE_GRACE_SECONDS, 600);
  assert.equal(isTimerType('sleep'), true);
  assert.equal(isTimerType('breastfeed'), true);
  assert.equal(isTimerType('bottle'), false);
  assert.equal(isTimerType('nap'), false);
  assert.equal(timerRunningMessage('sleep'), 'Es läuft bereits ein Schlaf-Timer');
  assert.equal(timerRunningMessage('breastfeed'), 'Es läuft bereits ein Stillen-Timer');
});

// ---------------------------------------------------------------------------
// canonDatetime (bt_canon_datetime)
// ---------------------------------------------------------------------------

test('canonDatetime canonicalizes offsets, optional seconds and fractions to UTC', () => {
  assert.equal(canonDatetime('2026-09-01T10:30:00+02:00', 'x'), '2026-09-01T08:30:00Z');
  assert.equal(canonDatetime('2026-09-01T10:30:00+0200', 'x'), '2026-09-01T08:30:00Z');
  assert.equal(canonDatetime('2026-09-01T10:30+02:00', 'x'), '2026-09-01T08:30:00Z');
  assert.equal(canonDatetime('2026-09-01T10:30:00.999+02:00', 'x'), '2026-09-01T08:30:00Z');
  assert.equal(canonDatetime('2026-09-01T10:30:00.5Z', 'x'), '2026-09-01T10:30:00Z');
  assert.equal(canonDatetime('2026-09-01T00:30:00-05:30', 'x'), '2026-09-01T06:00:00Z');
  assert.equal(canonDatetime('2026-12-31T23:30:00-01:00', 'x'), '2027-01-01T00:30:00Z');
  assert.equal(canonDatetime(NOW, 'x'), NOW);
});

test('canonDatetime rolls over like PHP and rejects what PHP rejects', () => {
  // PHP's DateTimeImmutable rolls Feb 31, hour 24 and second 60 forward ...
  assert.equal(canonDatetime('2026-02-31T10:00:00Z', 'x'), '2026-03-03T10:00:00Z');
  assert.equal(canonDatetime('2026-09-01T24:00:00Z', 'x'), '2026-09-02T00:00:00Z');
  assert.equal(canonDatetime('2026-09-01T23:59:60Z', 'x'), '2026-09-02T00:00:00Z');
  assert.equal(canonDatetime('0000-01-01T00:00:00Z', 'x'), '0000-01-01T00:00:00Z');
  // ... and refuses month 13, day 32, hour 25, minute 60.
  for (const bad of ['2026-13-01T10:00:00Z', '2026-09-32T10:00:00Z', '2026-09-01T25:00:00Z', '2026-09-01T23:60:00Z']) {
    throwsMsg(() => canonDatetime(bad, 'startedAt'), '"startedAt" ist kein gültiger Zeitpunkt');
  }
});

test('canonDatetime rejects non-ISO input and missing zones', () => {
  const msg = '"startedAt" muss ein ISO-8601-Zeitpunkt mit Zeitzone sein';
  for (const bad of ['01.09.2026 10:00', '2026-09-01T10:00:00', '2026-09-01', '', null, undefined, 42, {}, NOW + '\n']) {
    throwsMsg(() => canonDatetime(bad, 'startedAt'), msg);
  }
  throwsMsg(() => canonDatetime('nope', 'endedAt'), '"endedAt" muss ein ISO-8601-Zeitpunkt mit Zeitzone sein');
});

// ---------------------------------------------------------------------------
// validLocalDate (bt_valid_local_date)
// ---------------------------------------------------------------------------

test('validLocalDate accepts real calendar dates only', () => {
  assert.equal(validLocalDate('2026-09-01', 'from'), '2026-09-01');
  assert.equal(validLocalDate('2024-02-29', 'from'), '2024-02-29');
  throwsMsg(() => validLocalDate('2026-13-45', 'from'), '"from" ist kein gültiges Datum');
  throwsMsg(() => validLocalDate('2026-02-31', 'from'), '"from" ist kein gültiges Datum');
  throwsMsg(() => validLocalDate('2026-02-29', 'to'), '"to" ist kein gültiges Datum');
  throwsMsg(() => validLocalDate('0000-01-01', 'from'), '"from" ist kein gültiges Datum');
  throwsMsg(() => validLocalDate('2026-9-1', 'from'), '"from" muss ein Datum im Format JJJJ-MM-TT sein');
  throwsMsg(() => validLocalDate(null, 'to'), '"to" muss ein Datum im Format JJJJ-MM-TT sein');
});

// ---------------------------------------------------------------------------
// assertNotFuture (bt_assert_not_future)
// ---------------------------------------------------------------------------

test('assertNotFuture allows 600 s of skew and no more', () => {
  assertNotFuture('2026-09-01T10:10:00Z', NOW);
  assertNotFuture('2026-09-01T10:05:00Z', NOW);
  assertNotFuture('2026-08-01T10:00:00Z', NOW);
  throwsMsg(() => assertNotFuture('2026-09-01T10:10:01Z', NOW), 'Der Zeitpunkt liegt in der Zukunft');
  throwsMsg(() => assertNotFuture('2026-09-02T10:00:00Z', NOW), 'Der Zeitpunkt liegt in der Zukunft');
});

// ---------------------------------------------------------------------------
// validDetails (bt_valid_details)
// ---------------------------------------------------------------------------

test('validDetails canonicalizes every type', () => {
  assert.deepEqual(validDetails('breastfeed', { side: 'L', extra: 1 }), { side: 'L' });
  // The pause mark of the live hero: kept when true, dropped otherwise.
  assert.deepEqual(validDetails('breastfeed', { side: 'L', paused: true }), { side: 'L', paused: true });
  assert.deepEqual(validDetails('breastfeed', { side: 'R', paused: false }), { side: 'R' });
  assert.deepEqual(validDetails('breastfeed', { side: 'R', paused: 'ja' }), { side: 'R' });
  assert.deepEqual(validDetails('breastfeed', { side: 'R', paused: 1 }), { side: 'R' });
  assert.deepEqual(validDetails('bottle', { amount_ml: 90 }), { amount_ml: 90 });
  assert.deepEqual(validDetails('bottle', { amount_ml: 90, colostrum_ml: 0 }), { amount_ml: 90 });
  assert.deepEqual(validDetails('bottle', { amount_ml: 60, colostrum_ml: 5 }), { amount_ml: 60, colostrum_ml: 5 });
  assert.deepEqual(validDetails('bottle', { colostrum_ml: 8 }), { amount_ml: 0, colostrum_ml: 8 });
  assert.deepEqual(validDetails('diaper', { kind: 'both' }), { kind: 'both' });
  assert.deepEqual(validDetails('sleep', null), {});
  assert.deepEqual(validDetails('sleep', undefined), {});
  assert.deepEqual(validDetails('sleep', { foo: 1 }), {});
  assert.deepEqual(validDetails('weight', { grams: 3450 }), { grams: 3450 });
  assert.deepEqual(validDetails('temperature', { celsius: 37 }), { celsius: 37 });
  assert.deepEqual(validDetails('temperature', { celsius: 36.64 }), { celsius: 36.6 });
  assert.deepEqual(validDetails('temperature', { celsius: 36.65 }), { celsius: 36.7 }); // PHP round(): the typed decimal wins
  assert.deepEqual(validDetails('temperature', { celsius: 38.15 }), { celsius: 38.2 });
  assert.deepEqual(validDetails('temperature', { celsius: 39.95 }), { celsius: 40 });
  assert.deepEqual(validDetails('temperature', { celsius: 44.96 }), { celsius: 45 });
  assert.deepEqual(validDetails('medication', { name: '  Vitamin D \n' }), { name: 'Vitamin D' });
  assert.deepEqual(validDetails('medication', { name: 'ä'.repeat(100) }), { name: 'ä'.repeat(100) });
});

test('validDetails rejects bad input with the old 400 texts', () => {
  throwsMsg(() => validDetails('sleep', 'x'), '"details" muss ein Objekt sein');
  throwsMsg(() => validDetails('sleep', 5), '"details" muss ein Objekt sein');
  throwsMsg(() => validDetails('breastfeed', {}), '"details.side" muss "L" oder "R" sein');
  throwsMsg(() => validDetails('breastfeed', { side: 'l' }), '"details.side" muss "L" oder "R" sein');
  throwsMsg(() => validDetails('bottle', {}), 'Bitte eine Menge angeben – Muttermilch oder Milch (Formula)');
  throwsMsg(() => validDetails('bottle', { amount_ml: 0 }), 'Bitte eine Menge angeben – Muttermilch oder Milch (Formula)');
  throwsMsg(() => validDetails('bottle', { amount_ml: '90' }), '"details.amount_ml" muss eine Menge in ml sein (0–1000)');
  throwsMsg(() => validDetails('bottle', { amount_ml: 90.5 }), '"details.amount_ml" muss eine Menge in ml sein (0–1000)');
  throwsMsg(() => validDetails('bottle', { amount_ml: 1001 }), '"details.amount_ml" muss eine Menge in ml sein (0–1000)');
  throwsMsg(() => validDetails('bottle', { amount_ml: -1 }), '"details.amount_ml" muss eine Menge in ml sein (0–1000)');
  throwsMsg(
    () => validDetails('bottle', { amount_ml: 60, colostrum_ml: 1500 }),
    '"details.colostrum_ml" muss eine Menge in ml sein (0–1000)'
  );
  throwsMsg(() => validDetails('diaper', { kind: 'wet' }), '"details.kind" muss "pee", "poop" oder "both" sein');
  throwsMsg(() => validDetails('diaper', {}), '"details.kind" muss "pee", "poop" oder "both" sein');
  throwsMsg(() => validDetails('weight', { grams: 299 }), '"details.grams" muss ein Gewicht in Gramm sein (300–30000)');
  throwsMsg(() => validDetails('weight', { grams: 30001 }), '"details.grams" muss ein Gewicht in Gramm sein (300–30000)');
  throwsMsg(() => validDetails('weight', { grams: 3000.5 }), '"details.grams" muss ein Gewicht in Gramm sein (300–30000)');
  throwsMsg(() => validDetails('weight', {}), '"details.grams" muss ein Gewicht in Gramm sein (300–30000)');
  throwsMsg(() => validDetails('temperature', { celsius: 55 }), '"details.celsius" muss eine Temperatur in °C sein (30–45)');
  throwsMsg(() => validDetails('temperature', { celsius: 29.9 }), '"details.celsius" muss eine Temperatur in °C sein (30–45)');
  throwsMsg(() => validDetails('temperature', { celsius: '37' }), '"details.celsius" muss eine Temperatur in °C sein (30–45)');
  throwsMsg(() => validDetails('temperature', { celsius: NaN }), '"details.celsius" muss eine Temperatur in °C sein (30–45)');
  throwsMsg(() => validDetails('temperature', {}), '"details.celsius" muss eine Temperatur in °C sein (30–45)');
  throwsMsg(() => validDetails('medication', { name: '   ' }), '"details.name" muss ein Name sein (max. 100 Zeichen)');
  throwsMsg(() => validDetails('medication', { name: 'x'.repeat(101) }), '"details.name" muss ein Name sein (max. 100 Zeichen)');
  throwsMsg(() => validDetails('medication', { name: 7 }), '"details.name" muss ein Name sein (max. 100 Zeichen)');
  throwsMsg(() => validDetails('medication', {}), '"details.name" muss ein Name sein (max. 100 Zeichen)');
  throwsMsg(() => validDetails('nap', {}), 'Unbekannter Typ');
});

// ---------------------------------------------------------------------------
// validateCreate (bt_create_entry field rules)
// ---------------------------------------------------------------------------

test('the pause mark lives only on a closed side with a duration', () => {
  // A quick-logged side (Ende == Start) and an open timer cannot be paused.
  const quick = validateCreate({ type: 'breastfeed', startedAt: '2026-09-01T09:40:00Z', endedAt: '2026-09-01T09:40:00Z', details: { side: 'L', paused: true } }, NOW);
  assert.deepEqual(quick.details, { side: 'L' });
  const open = validateCreate({ type: 'breastfeed', startedAt: '2026-09-01T09:40:00Z', details: { side: 'L', paused: true } }, NOW);
  assert.deepEqual(open.details, { side: 'L' });
  const closed = validateCreate({ type: 'breastfeed', startedAt: '2026-09-01T09:40:00Z', endedAt: '2026-09-01T09:48:00Z', details: { side: 'L', paused: true } }, NOW);
  assert.deepEqual(closed.details, { side: 'L', paused: true });
  // The hero's «Pause»: the end and the mark in one patch.
  const running = { type: 'breastfeed', startedAt: '2026-09-01T09:40:00Z', endedAt: null, details: { side: 'L' } };
  const paused = validateUpdate(running, { endedAt: '2026-09-01T09:48:00Z', ifOpen: true, details: { side: 'L', paused: true } }, NOW);
  assert.deepEqual(paused, { type: 'breastfeed', startedAt: '2026-09-01T09:40:00Z', endedAt: '2026-09-01T09:48:00Z', details: { side: 'L', paused: true } });
  // Reopening the paused side (Ende cleared in the form) drops the mark even
  // though the patch carries the old details; so does a plain end-only patch
  // that makes the row duration-less again.
  const pausedRow = { ...paused };
  assert.deepEqual(validateUpdate(pausedRow, { endedAt: null, details: { side: 'L', paused: true } }, NOW).details, { side: 'L' });
  assert.deepEqual(validateUpdate(pausedRow, { endedAt: null }, NOW).details, { side: 'L' });
  assert.deepEqual(validateUpdate(pausedRow, { endedAt: '2026-09-01T09:40:00Z' }, NOW).details, { side: 'L' });
  // «Stillen beenden» on the paused hero: the mark goes, the row stays closed.
  assert.deepEqual(validateUpdate(pausedRow, { details: { side: 'L' } }, NOW).details, { side: 'L' });
  // A patch that only moves the start keeps the mark.
  assert.deepEqual(validateUpdate(pausedRow, { startedAt: '2026-09-01T09:38:00Z' }, NOW).details, { side: 'L', paused: true });
  // A synced row from the other phone with the mark is a valid plaintext.
  assert.equal(
    validatePlain({ eid: 'b'.repeat(32), rev: 2, type: 'breastfeed', startedAt: '2026-09-01T09:40:00Z', endedAt: '2026-09-01T09:48:00Z', details: { side: 'R', paused: true }, loggedBy: 'Mama' }).details.paused,
    true
  );
});

test('create bottle entry returns the canonical shape', () => {
  const e = validateCreate({ type: 'bottle', startedAt: '2026-09-01T08:30:00Z', details: { amount_ml: 90 } }, NOW);
  assert.deepEqual(e, { type: 'bottle', startedAt: '2026-09-01T08:30:00Z', endedAt: null, details: { amount_ml: 90 } });
  assert.deepEqual(Object.keys(e), ['type', 'startedAt', 'endedAt', 'details']);
});

test('startedAt defaults to now; offsets are canonicalized to UTC', () => {
  const e = validateCreate({ type: 'diaper', details: { kind: 'pee' } }, NOW);
  assert.equal(e.startedAt, NOW);
  assert.equal(e.endedAt, null);
  const e2 = validateCreate(
    { type: 'diaper', startedAt: '2026-09-01T10:30:00+02:00', details: { kind: 'poop' } }, // = 08:30 UTC
    NOW
  );
  assert.equal(e2.startedAt, '2026-09-01T08:30:00Z');
  // null startedAt is "not given", like a missing key.
  assert.equal(validateCreate({ type: 'diaper', startedAt: null, details: { kind: 'pee' } }, NOW).startedAt, NOW);
});

test('create rejects bad input with 400', () => {
  throwsMsg(() => validateCreate({ type: 'nap' }, NOW), '"type" muss einer der bekannten Eintragstypen sein');
  throwsMsg(() => validateCreate({}, NOW), '"type" muss einer der bekannten Eintragstypen sein');
  throwsMsg(() => validateCreate(null, NOW), '"type" muss einer der bekannten Eintragstypen sein');
  throwsMsg(
    () => validateCreate({ type: 'diaper', details: { kind: 'wet' } }, NOW),
    '"details.kind" muss "pee", "poop" oder "both" sein'
  );
  throwsMsg(() => validateCreate({ type: 'bottle' }, NOW), 'Bitte eine Menge angeben – Muttermilch oder Milch (Formula)');
  throwsMsg(
    () => validateCreate({ type: 'bottle', endedAt: NOW, details: { amount_ml: 90 } }, NOW),
    'Dieser Eintragstyp hat kein Ende – nur Stillen und Schlaf'
  );
  throwsMsg(
    () => validateCreate({ type: 'diaper', startedAt: '01.09.2026 10:00', details: { kind: 'pee' } }, NOW),
    '"startedAt" muss ein ISO-8601-Zeitpunkt mit Zeitzone sein'
  );
  throwsMsg(
    () => validateCreate({ type: 'temperature', details: { celsius: 55 } }, NOW),
    '"details.celsius" muss eine Temperatur in °C sein (30–45)'
  );
});

test('bottle: colostrum tracked separately, at least one amount required', () => {
  const e = validateCreate({ type: 'bottle', details: { amount_ml: 60, colostrum_ml: 5 } }, NOW);
  assert.equal(e.details.amount_ml, 60);
  assert.equal(e.details.colostrum_ml, 5);
  const c = validateCreate({ type: 'bottle', details: { colostrum_ml: 8 } }, NOW);
  assert.equal(c.details.amount_ml, 0);
  assert.equal(c.details.colostrum_ml, 8);
  const m = validateCreate({ type: 'bottle', details: { amount_ml: 90 } }, NOW);
  assert.deepEqual(m.details, { amount_ml: 90 });
  throwsMsg(
    () => validateCreate({ type: 'bottle', details: { amount_ml: 0 } }, NOW),
    'Bitte eine Menge angeben – Muttermilch oder Milch (Formula)'
  );
  throwsMsg(
    () => validateCreate({ type: 'bottle', details: { amount_ml: 60, colostrum_ml: 1500 } }, NOW),
    '"details.colostrum_ml" muss eine Menge in ml sein (0–1000)'
  );
});

test('endedAt before startedAt is rejected', () => {
  throwsMsg(
    () => validateCreate({ type: 'sleep', startedAt: '2026-09-01T09:00:00Z', endedAt: '2026-09-01T08:00:00Z' }, NOW),
    'Das Ende liegt vor dem Start'
  );
  // Equal start and end is fine (the retro "Nachtragen" chips rely on it).
  const e = validateCreate({ type: 'sleep', startedAt: '2026-09-01T09:00:00Z', endedAt: '2026-09-01T09:00:00Z' }, NOW);
  assert.equal(e.endedAt, '2026-09-01T09:00:00Z');
});

test('timer types: open without endedAt, closed with it', () => {
  const open = validateCreate({ type: 'breastfeed', startedAt: '2026-09-01T09:40:00Z', details: { side: 'L' } }, NOW);
  assert.deepEqual(open, { type: 'breastfeed', startedAt: '2026-09-01T09:40:00Z', endedAt: null, details: { side: 'L' } });
  const closed = validateCreate(
    { type: 'breastfeed', startedAt: '2026-09-01T06:00:00Z', endedAt: '2026-09-01T06:20:00+00:00', details: { side: 'R' } },
    NOW
  );
  assert.equal(closed.endedAt, '2026-09-01T06:20:00Z');
  const sleep = validateCreate({ type: 'sleep', startedAt: '2026-09-01T08:00:00Z' }, NOW);
  assert.deepEqual(sleep, { type: 'sleep', startedAt: '2026-09-01T08:00:00Z', endedAt: null, details: {} });
});

test('future timestamps are rejected beyond the skew grace', () => {
  throwsMsg(
    () => validateCreate({ type: 'diaper', startedAt: '2026-09-02T10:00:00Z', details: { kind: 'pee' } }, NOW),
    'Der Zeitpunkt liegt in der Zukunft'
  );
  throwsMsg(
    () => validateCreate({ type: 'sleep', startedAt: '2026-09-01T09:00:00Z', endedAt: '2026-09-01T11:00:00Z' }, NOW),
    'Der Zeitpunkt liegt in der Zukunft'
  );
  const existing = { type: 'diaper', startedAt: NOW, endedAt: null, details: { kind: 'pee' } };
  throwsMsg(() => validateUpdate(existing, { startedAt: '2026-09-01T12:00:00Z' }, NOW), 'Der Zeitpunkt liegt in der Zukunft');
  // A few minutes ahead is clock skew and must pass.
  const ok = validateCreate({ type: 'diaper', startedAt: '2026-09-01T10:05:00Z', details: { kind: 'poop' } }, NOW);
  assert.equal(ok.startedAt, '2026-09-01T10:05:00Z');
});

test('a client-sent loggedBy is ignored, not rejected', () => {
  const e = validateCreate({ type: 'diaper', details: { kind: 'pee' }, loggedBy: 'Hacker' }, NOW);
  assert.deepEqual(Object.keys(e), ['type', 'startedAt', 'endedAt', 'details']);
});

// ---------------------------------------------------------------------------
// validateUpdate (bt_update_entry merge rules)
// ---------------------------------------------------------------------------

const bottle = {
  eid: 'a'.repeat(32),
  seq: 1,
  rev: 1,
  type: 'bottle',
  startedAt: '2026-09-01T08:00:00Z',
  endedAt: null,
  details: { amount_ml: 90 },
  loggedBy: 'Papa',
};

test('update changes fields, keeps the rest, forbids type changes', () => {
  const u = validateUpdate(bottle, { startedAt: '2026-09-01T08:05:00Z', details: { amount_ml: 120 } }, NOW);
  assert.deepEqual(u, { type: 'bottle', startedAt: '2026-09-01T08:05:00Z', endedAt: null, details: { amount_ml: 120 } });
  // Untouched fields survive exactly; the merge never re-authors.
  const only = validateUpdate(bottle, { details: { amount_ml: 100 } }, NOW);
  assert.equal(only.startedAt, bottle.startedAt);
  assert.equal('loggedBy' in only, false);
  const nothing = validateUpdate(bottle, {}, NOW);
  assert.deepEqual(nothing, { type: 'bottle', startedAt: bottle.startedAt, endedAt: null, details: { amount_ml: 90 } });
  throwsMsg(() => validateUpdate(bottle, { type: 'diaper' }, NOW), 'Der Typ eines Eintrags kann nicht geändert werden');
  // The same type is allowed (an old client echoes it back).
  assert.equal(validateUpdate(bottle, { type: 'bottle' }, NOW).type, 'bottle');
  // loggedBy in the patch is ignored.
  assert.equal('loggedBy' in validateUpdate(bottle, { loggedBy: 'Hacker', details: { amount_ml: 10 } }, NOW), false);
});

test('update validates the changed fields with the old texts', () => {
  throwsMsg(() => validateUpdate(bottle, { startedAt: null }, NOW), '"startedAt" darf nicht leer sein');
  throwsMsg(() => validateUpdate(bottle, { startedAt: 'gestern' }, NOW), '"startedAt" muss ein ISO-8601-Zeitpunkt mit Zeitzone sein');
  throwsMsg(() => validateUpdate(bottle, { endedAt: NOW }, NOW), 'Dieser Eintragstyp hat kein Ende – nur Stillen und Schlaf');
  throwsMsg(() => validateUpdate(bottle, { details: { amount_ml: 0 } }, NOW), 'Bitte eine Menge angeben – Muttermilch oder Milch (Formula)');
  throwsMsg(() => validateUpdate(bottle, { details: null }, NOW), 'Bitte eine Menge angeben – Muttermilch oder Milch (Formula)');
});

test('update closes and reopens timers; the end may not precede the start', () => {
  const open = { ...bottle, type: 'sleep', startedAt: '2026-09-01T08:00:00Z', endedAt: null, details: {} };
  const closed = validateUpdate(open, { endedAt: '2026-09-01T09:00:00Z' }, NOW);
  assert.deepEqual(closed, { type: 'sleep', startedAt: '2026-09-01T08:00:00Z', endedAt: '2026-09-01T09:00:00Z', details: {} });
  const reopened = validateUpdate({ ...open, endedAt: '2026-09-01T09:00:00Z' }, { endedAt: null }, NOW);
  assert.equal(reopened.endedAt, null);
  throwsMsg(() => validateUpdate(open, { endedAt: '2026-09-01T07:59:59Z' }, NOW), 'Das Ende liegt vor dem Start');
  // Moving the start past an existing end is caught too.
  throwsMsg(
    () => validateUpdate({ ...open, endedAt: '2026-09-01T09:00:00Z' }, { startedAt: '2026-09-01T09:30:00Z' }, NOW),
    'Das Ende liegt vor dem Start'
  );
  // Offsets are canonicalized on update as well.
  assert.equal(validateUpdate(open, { endedAt: '2026-09-01T11:00:00+02:00' }, NOW).endedAt, '2026-09-01T09:00:00Z');
});

test('ifOpen guards the stop path: closing an already-closed timer 409s', () => {
  const open = { ...bottle, type: 'sleep', startedAt: '2026-09-01T08:00:00Z', endedAt: null, details: {} };
  const closed = validateUpdate(open, { endedAt: '2026-09-01T09:00:00Z', ifOpen: true }, NOW);
  assert.equal(closed.endedAt, '2026-09-01T09:00:00Z');
  throwsMsg(
    () => validateUpdate({ ...open, endedAt: '2026-09-01T09:00:00Z' }, { endedAt: '2026-09-01T09:30:00Z', ifOpen: true }, NOW),
    'Der Timer wurde bereits beendet',
    409
  );
  // The edit form (no flag) can still adjust the closed entry.
  const edited = validateUpdate({ ...open, endedAt: '2026-09-01T09:00:00Z' }, { endedAt: '2026-09-01T09:15:00Z' }, NOW);
  assert.equal(edited.endedAt, '2026-09-01T09:15:00Z');
});

// ---------------------------------------------------------------------------
// validatePlain (decrypted rows from other devices)
// ---------------------------------------------------------------------------

const plain = {
  v: 1,
  eid: '0123456789abcdef0123456789abcdef',
  rev: 3,
  type: 'breastfeed',
  startedAt: '2026-09-01T08:00:00Z',
  endedAt: '2026-09-01T08:25:00Z',
  details: { side: 'R' },
  loggedBy: 'Mama',
};

test('validatePlain accepts a well-formed decrypted entry and returns it', () => {
  assert.equal(validatePlain(plain), plain);
  const open = { ...plain, endedAt: null };
  assert.equal(validatePlain(open), open);
  validatePlain({ ...plain, loggedBy: null });
  validatePlain({ ...plain, type: 'sleep', details: {} });
  validatePlain({ ...plain, type: 'bottle', endedAt: null, details: { amount_ml: 90 } });
  validatePlain({ ...plain, rev: 1 });
});

test('validatePlain rejects every malformed shape with "Ungültiger Datensatz"', () => {
  const MSG = 'Ungültiger Datensatz';
  const bad = [
    null,
    'x',
    [],
    { ...plain, type: 'nap' },
    { ...plain, type: undefined },
    { ...plain, startedAt: '2026-09-01T10:00:00+02:00' }, // not canonical UTC
    { ...plain, startedAt: '2026-09-01T10:00:00.000Z' },
    { ...plain, startedAt: '2026-13-01T10:00:00Z' },
    { ...plain, startedAt: 1756713600 },
    { ...plain, endedAt: undefined },
    { ...plain, endedAt: 'later' },
    { ...plain, details: { side: 'X' } },
    { ...plain, details: null },
    { ...plain, details: 'R' },
    { ...plain, loggedBy: 7 },
    { ...plain, loggedBy: undefined },
    { ...plain, rev: 0 },
    { ...plain, rev: -1 },
    { ...plain, rev: 1.5 },
    { ...plain, rev: '3' },
    { ...plain, rev: undefined },
    { ...plain, eid: 'ABCDEF0123456789ABCDEF0123456789' }, // uppercase
    { ...plain, eid: '0123456789abcdef0123456789abcde' }, // 31 chars
    { ...plain, eid: 42 },
    { ...plain, eid: undefined },
  ];
  for (const obj of bad) {
    throwsMsg(() => validatePlain(obj), MSG);
  }
});

test('validateLegacyPlain checks the five legacy fields without rev/eid', () => {
  const legacy = { type: 'bottle', startedAt: '2026-08-30T08:00:00Z', endedAt: null, details: { amount_ml: 90 }, loggedBy: 'Mama' };
  assert.equal(validateLegacyPlain(legacy), legacy);
  validateLegacyPlain({ ...legacy, loggedBy: null });
  throwsMsg(() => validateLegacyPlain({ ...legacy, details: {} }), 'Ungültiger Datensatz');
  throwsMsg(() => validateLegacyPlain({ ...legacy, startedAt: 'x' }), 'Ungültiger Datensatz');
  throwsMsg(() => validateLegacyPlain(null), 'Ungültiger Datensatz');
});

// ---------------------------------------------------------------------------
// The family settings document (type `settings`)
// ---------------------------------------------------------------------------

test('settings details: every field optional, validated when present, unknown keys kept', () => {
  assert.deepEqual(validDetails('settings', {}), {});
  assert.deepEqual(validDetails('settings', null), {});
  assert.deepEqual(validDetails('settings', { feedFromStart: true }), { feedFromStart: true });
  assert.deepEqual(validDetails('settings', { recommendedMl: null }), { recommendedMl: null });
  assert.deepEqual(validDetails('settings', { recommendedMl: 70, bottlePresets: [50, 80, 110] }), {
    recommendedMl: 70,
    bottlePresets: [50, 80, 110],
  });
  // A newer shell's key survives an older shell's validation untouched.
  assert.deepEqual(validDetails('settings', { feedFromStart: false, nightMode: 'dim' }), { feedFromStart: false, nightMode: 'dim' });
  // The drinking target: the birth date as a calendar day, the meals a day; null clears.
  assert.deepEqual(validDetails('settings', { birthDate: '2026-09-08', mealsPerDay: 7 }), { birthDate: '2026-09-08', mealsPerDay: 7 });
  // The formula row's own three chips, validated like the Muttermilch ones and copied too.
  const f = [10, 20, 30];
  const fo = validDetails('settings', { formulaPresets: f });
  f[0] = 1;
  assert.deepEqual(fo, { formulaPresets: [10, 20, 30] });
  assert.deepEqual(validDetails('settings', { birthDate: null, mealsPerDay: null }), { birthDate: null, mealsPerDay: null });
  assert.deepEqual(validDetails('settings', { breastfeeding: false, nursingMl: 50 }), { breastfeeding: false, nursingMl: 50 });
  assert.deepEqual(validDetails('settings', { breastfeeding: true, nursingMl: null }), { breastfeeding: true, nursingMl: null });
  assert.deepEqual(validDetails('settings', { birthDate: '2024-02-29', mealsPerDay: 1 }), { birthDate: '2024-02-29', mealsPerDay: 1 });
  // The presets are copied, not shared.
  const p = [60, 90, 120];
  const out = validDetails('settings', { bottlePresets: p });
  p[0] = 1;
  assert.deepEqual(out.bottlePresets, [60, 90, 120]);
  for (const [bad, msg] of [
    [{ feedFromStart: 'ja' }, '"details.feedFromStart" muss true oder false sein'],
    [{ feedFromStart: 1 }, '"details.feedFromStart" muss true oder false sein'],
    [{ recommendedMl: 0 }, '"details.recommendedMl" muss eine Menge in ml sein (1–1000) oder leer'],
    [{ recommendedMl: 1001 }, '"details.recommendedMl" muss eine Menge in ml sein (1–1000) oder leer'],
    [{ recommendedMl: '70' }, '"details.recommendedMl" muss eine Menge in ml sein (1–1000) oder leer'],
    [{ bottlePresets: [60, 90] }, '"details.bottlePresets" müssen drei Mengen in ml sein (1–1000)'],
    [{ bottlePresets: [60, 90, 120, 150] }, '"details.bottlePresets" müssen drei Mengen in ml sein (1–1000)'],
    [{ bottlePresets: [0, 90, 120] }, '"details.bottlePresets" müssen drei Mengen in ml sein (1–1000)'],
    [{ bottlePresets: 'x' }, '"details.bottlePresets" müssen drei Mengen in ml sein (1–1000)'],
    [{ formulaPresets: [10, 20] }, '"details.formulaPresets" müssen drei Mengen in ml sein (1–1000)'],
    [{ formulaPresets: [0, 20, 30] }, '"details.formulaPresets" müssen drei Mengen in ml sein (1–1000)'],
    [{ formulaPresets: [10, 20, 1001] }, '"details.formulaPresets" müssen drei Mengen in ml sein (1–1000)'],
    [{ birthDate: '08.09.2026' }, '"details.birthDate" muss ein Datum im Format JJJJ-MM-TT sein oder leer'],
    [{ birthDate: 20260908 }, '"details.birthDate" muss ein Datum im Format JJJJ-MM-TT sein oder leer'],
    [{ birthDate: '2026-02-30' }, '"details.birthDate" ist kein gültiges Datum'],
    [{ birthDate: '2026-13-01' }, '"details.birthDate" ist kein gültiges Datum'],
    [{ mealsPerDay: 0 }, '"details.mealsPerDay" muss eine Anzahl Mahlzeiten sein (1–12) oder leer'],
    [{ mealsPerDay: 13 }, '"details.mealsPerDay" muss eine Anzahl Mahlzeiten sein (1–12) oder leer'],
    [{ mealsPerDay: 6.5 }, '"details.mealsPerDay" muss eine Anzahl Mahlzeiten sein (1–12) oder leer'],
    [{ mealsPerDay: '6' }, '"details.mealsPerDay" muss eine Anzahl Mahlzeiten sein (1–12) oder leer'],
    [{ breastfeeding: 'ja' }, '"details.breastfeeding" muss true oder false sein'],
    [{ breastfeeding: 0 }, '"details.breastfeeding" muss true oder false sein'],
    [{ nursingMl: 0 }, '"details.nursingMl" muss eine Menge in ml sein (1–1000) oder leer'],
    [{ nursingMl: 1001 }, '"details.nursingMl" muss eine Menge in ml sein (1–1000) oder leer'],
    [{ nursingMl: 2.5 }, '"details.nursingMl" muss eine Menge in ml sein (1–1000) oder leer'],
    [{ nursingMl: '50' }, '"details.nursingMl" muss eine Menge in ml sein (1–1000) oder leer'],
  ]) {
    throwsMsg(() => validDetails('settings', bad), msg);
  }
});

test('settings entries are no timers and can be created, updated and validated as plaintext', () => {
  const v = validateCreate({ type: 'settings', details: { feedFromStart: true } }, NOW);
  assert.deepEqual(v, { type: 'settings', startedAt: NOW, endedAt: null, details: { feedFromStart: true } });
  throwsMsg(
    () => validateCreate({ type: 'settings', endedAt: NOW, details: {} }, NOW),
    'Dieser Eintragstyp hat kein Ende – nur Stillen und Schlaf'
  );
  const existing = { type: 'settings', startedAt: '2026-09-01T08:00:00Z', endedAt: null, details: { feedFromStart: true, recommendedMl: 70 } };
  const u = validateUpdate(existing, { startedAt: NOW, details: { ...existing.details, recommendedMl: null } }, NOW);
  assert.deepEqual(u, { type: 'settings', startedAt: NOW, endedAt: null, details: { feedFromStart: true, recommendedMl: null } });
  assert.deepEqual(
    validatePlain({ eid: 'a'.repeat(32), rev: 2, type: 'settings', startedAt: NOW, endedAt: null, details: { bottlePresets: [60, 90, 120] }, loggedBy: 'Mama' }).type,
    'settings'
  );
  assert.throws(
    () => validatePlain({ eid: 'a'.repeat(32), rev: 2, type: 'settings', startedAt: NOW, endedAt: null, details: { bottlePresets: [60] }, loggedBy: 'Mama' }),
    /Ungültiger Datensatz/
  );
});

// ---------------------------------------------------------------------------
// Reminders + tasks
// ---------------------------------------------------------------------------

const EID = 'a'.repeat(32);

test('reminder details: title, who (baby by default), optional note, sorted unique times', () => {
  assert.deepEqual(validDetails('reminder', { title: ' Vitamin D ', times: ['18:00', '08:00', '08:00'] }), {
    title: 'Vitamin D',
    who: 'baby',
    times: ['08:00', '18:00'],
  });
  assert.deepEqual(validDetails('reminder', { title: 'Ibuprofen 600', who: 'mama', note: ' 1 Tablette ', times: ['20:30'] }), {
    title: 'Ibuprofen 600',
    who: 'mama',
    note: '1 Tablette',
    times: ['20:30'],
  });
  // A blank note is dropped, an unknown key too.
  assert.deepEqual(validDetails('reminder', { title: 'X', note: '  ', times: ['00:00'], colour: 'red' }), { title: 'X', who: 'baby', times: ['00:00'] });
  // Every N days from a first day; 1 (daily) is not stored.
  assert.deepEqual(validDetails('reminder', { title: 'Baden', times: ['18:00'], everyDays: 2, startDate: '2026-09-01' }), {
    title: 'Baden',
    who: 'baby',
    times: ['18:00'],
    everyDays: 2,
    startDate: '2026-09-01',
  });
  assert.deepEqual(validDetails('reminder', { title: 'X', times: ['08:00'], everyDays: 1, startDate: null }), { title: 'X', who: 'baby', times: ['08:00'] });
  for (const [bad, msg] of [
    [{ title: 'X', times: ['08:00'], everyDays: 0 }, '"details.everyDays" muss eine Anzahl Tage sein (1–365)'],
    [{ title: 'X', times: ['08:00'], everyDays: 366 }, '"details.everyDays" muss eine Anzahl Tage sein (1–365)'],
    [{ title: 'X', times: ['08:00'], everyDays: '2' }, '"details.everyDays" muss eine Anzahl Tage sein (1–365)'],
    [{ title: 'X', times: ['08:00'], everyDays: 2, startDate: '1.9.2026' }, '"details.startDate" muss ein Datum im Format JJJJ-MM-TT sein'],
    [{ title: 'X', times: ['08:00'], everyDays: 2, startDate: '2026-02-30' }, '"details.startDate" ist kein gültiges Datum'],
  ]) {
    throwsMsg(() => validDetails('reminder', bad), msg);
  }
  throwsMsg(() => validDetails('reminder', { times: ['08:00'] }), '"details.title" muss ein Text sein (max. 100 Zeichen)');
  throwsMsg(() => validDetails('reminder', { title: '   ', times: ['08:00'] }), '"details.title" muss ein Text sein (max. 100 Zeichen)');
  throwsMsg(() => validDetails('reminder', { title: 'x'.repeat(101), times: ['08:00'] }), '"details.title" muss ein Text sein (max. 100 Zeichen)');
  throwsMsg(() => validDetails('reminder', { title: 'X', who: 'oma', times: ['08:00'] }), '"details.who" muss "baby", "mama" oder "papa" sein');
  throwsMsg(() => validDetails('reminder', { title: 'X', note: 'n'.repeat(101), times: ['08:00'] }), '"details.note" muss ein Text sein (max. 100 Zeichen)');
  for (const times of [undefined, [], ['8:00'], ['24:00'], ['08:60'], ['08:00:00'], [800], '08:00']) {
    throwsMsg(() => validDetails('reminder', { title: 'X', times }), '"details.times" müssen Uhrzeiten sein (HH:MM, mindestens eine)');
  }
  const many = Array.from({ length: 13 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
  throwsMsg(() => validDetails('reminder', { title: 'X', times: many }), '"details.times" dürfen höchstens 12 Uhrzeiten sein');
  assert.equal(validDetails('reminder', { title: 'X', times: many.slice(0, 12) }).times.length, 12);
});

test('task details: title + who, optional reminder reference (eid + canonical due)', () => {
  assert.deepEqual(validDetails('task', { title: 'Nabel pflegen' }), { title: 'Nabel pflegen', who: 'baby' });
  assert.deepEqual(validDetails('task', { title: 'Vitamin D', who: 'baby', reminderEid: EID, due: '2026-09-01T08:00:00+02:00' }), {
    title: 'Vitamin D',
    who: 'baby',
    reminderEid: EID,
    due: '2026-09-01T06:00:00Z',
  });
  // Explicit nulls mean "none".
  assert.deepEqual(validDetails('task', { title: 'X', who: 'papa', reminderEid: null, due: null }), { title: 'X', who: 'papa' });
  throwsMsg(() => validDetails('task', {}), '"details.title" muss ein Text sein (max. 100 Zeichen)');
  throwsMsg(() => validDetails('task', { title: 'X', reminderEid: 'abc' }), '"details.reminderEid" muss eine Eintrags-ID sein');
  throwsMsg(() => validDetails('task', { title: 'X', due: '2026-09-01 08:00' }), '"details.due" muss ein ISO-8601-Zeitpunkt mit Zeitzone sein');
  throwsMsg(() => validDetails('task', { title: 'X', who: 'baby ' }), '"details.who" muss "baby", "mama" oder "papa" sein');
});

test('reminders and tasks are no timers; both round-trip through create, update and validatePlain', () => {
  const r = validateCreate({ type: 'reminder', details: { title: 'Vitamin D', times: ['08:00'] } }, NOW);
  assert.deepEqual(r, { type: 'reminder', startedAt: NOW, endedAt: null, details: { title: 'Vitamin D', who: 'baby', times: ['08:00'] } });
  throwsMsg(
    () => validateCreate({ type: 'reminder', endedAt: NOW, details: { title: 'X', times: ['08:00'] } }, NOW),
    'Dieser Eintragstyp hat kein Ende – nur Stillen und Schlaf'
  );
  const t = validateCreate({ type: 'task', details: { title: 'Vitamin D', reminderEid: EID, due: NOW } }, NOW);
  assert.deepEqual(t, { type: 'task', startedAt: NOW, endedAt: null, details: { title: 'Vitamin D', who: 'baby', reminderEid: EID, due: NOW } });
  // An edit re-validates the whole details object (a reference must be carried over by the caller).
  const edited = validateUpdate({ ...t, eid: EID }, { details: { title: 'Vitamin D', who: 'mama' } }, NOW);
  assert.deepEqual(edited.details, { title: 'Vitamin D', who: 'mama' });
  for (const type of ['reminder', 'task']) {
    const plain = { eid: EID, rev: 1, type, startedAt: NOW, endedAt: null, details: type === 'reminder' ? { title: 'X', who: 'baby', times: ['08:00'] } : { title: 'X', who: 'baby' }, loggedBy: null };
    assert.equal(validatePlain(plain), plain);
    assert.throws(() => validatePlain({ ...plain, details: { title: '' } }), /Ungültiger Datensatz/);
  }
});
