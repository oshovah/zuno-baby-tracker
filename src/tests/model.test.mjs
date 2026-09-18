// Port of the PHP state/list/timer tests (api/tests/api.test.php) onto the
// client model — same fixtures, same NOW (2026-09-01T10:00:00Z: Europe/Zurich
// is on CEST then, the local day is 2026-09-01 and the day window starts
// 2026-08-31T22:00:00Z), same expected numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sortNewest,
  liveEntries,
  deriveState,
  listRange,
  openTimer,
  duplicateOpenTimers,
  applyRow,
  groupMeals,
  MEAL_GAP_MIN,
  OPEN_TIMER_JOIN_MAX_MIN,
  familySettingsRow,
  effectiveFamilySettings,
  DEFAULT_FAMILY_SETTINGS,
  FAMILY_SETTING_KEYS,
} from '../model.js';
import { validateCreate, TYPES, EVENT_TYPES } from '../validate.js';

const NOW = '2026-09-01T10:00:00Z';

/** Deterministic 32-hex eids: 1 -> "000…001" (sorted like their numbers). */
const eidOf = (n) => n.toString(16).padStart(32, '0');

/**
 * A tiny stand-in for the old bt_create_entry: validates the input exactly
 * like the server did and appends a model entry with the next seq.
 */
function fixture() {
  const map = new Map();
  let n = 0;
  return {
    map,
    add(input, extra = {}) {
      const v = validateCreate(input, NOW);
      n += 1;
      const entry = {
        eid: eidOf(n),
        seq: n,
        rev: 1,
        ...v,
        loggedBy: input.loggedBy ?? 'Mama',
        createdAt: '2026-09-01',
        updatedAt: '2026-09-01',
        deletedAt: null,
        ...extra,
      };
      map.set(entry.eid, entry);
      return entry;
    },
    remove(e) {
      map.set(e.eid, { ...e, deletedAt: '2026-09-01' });
    },
  };
}

function throwsMsg(fn, message) {
  let caught = null;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof Error, `expected an Error for "${message}"`);
  assert.equal(caught.message, message);
}

// ---------------------------------------------------------------------------
// Ordering + liveEntries
// ---------------------------------------------------------------------------

test('sortNewest orders by startedAt DESC, then eid DESC', () => {
  const a = { eid: eidOf(1), startedAt: '2026-09-01T08:00:00Z' };
  const b = { eid: eidOf(2), startedAt: '2026-09-01T09:00:00Z' };
  const c = { eid: eidOf(3), startedAt: '2026-09-01T08:00:00Z' };
  assert.deepEqual([a, b, c].sort(sortNewest).map((e) => e.eid), [b.eid, c.eid, a.eid]);
  assert.equal(sortNewest(a, a), 0);
  assert.ok(sortNewest(a, b) > 0);
  assert.ok(sortNewest(b, a) < 0);
});

test('liveEntries drops tombstones and undecryptable rows, accepts Map/object/array', () => {
  const f = fixture();
  const keep = f.add({ type: 'diaper', startedAt: '2026-09-01T07:00:00Z', details: { kind: 'pee' } });
  const gone = f.add({ type: 'diaper', startedAt: '2026-09-01T08:00:00Z', details: { kind: 'pee' } });
  f.remove(gone);
  f.map.set(eidOf(99), { eid: eidOf(99), seq: 99, createdAt: '2026-09-01', updatedAt: '2026-09-01', deletedAt: null, error: 'x' });
  const later = f.add({ type: 'diaper', startedAt: '2026-09-01T09:00:00Z', details: { kind: 'both' } });
  assert.deepEqual(liveEntries(f.map).map((e) => e.eid), [later.eid, keep.eid]);
  assert.deepEqual(liveEntries(Object.fromEntries(f.map)).map((e) => e.eid), [later.eid, keep.eid]);
  assert.deepEqual(liveEntries([...f.map.values()]).map((e) => e.eid), [later.eid, keep.eid]);
  assert.deepEqual(liveEntries(new Map()), []);
  assert.deepEqual(liveEntries(undefined), []);
});

// ---------------------------------------------------------------------------
// State (bt_state)
// ---------------------------------------------------------------------------

test('state aggregates today counts, last feed, and sleep minutes', () => {
  const f = fixture();
  // Yesterday (local): must not count today.
  f.add({ type: 'bottle', startedAt: '2026-08-31T12:00:00Z', details: { amount_ml: 80 } });
  // Today: one bottle, one closed breastfeed, two diapers.
  f.add({ type: 'bottle', startedAt: '2026-09-01T05:00:00Z', details: { amount_ml: 100 } });
  const feed = f.add({
    type: 'breastfeed',
    startedAt: '2026-09-01T08:00:00Z',
    endedAt: '2026-09-01T08:25:00Z',
    details: { side: 'R' },
  });
  f.add({ type: 'diaper', startedAt: '2026-09-01T06:00:00Z', details: { kind: 'pee' } });
  f.add({ type: 'diaper', startedAt: '2026-09-01T08:30:00Z', details: { kind: 'both' } });
  // Sleep: 90 min closed, then an open one since 09:30 (= 30 min so far),
  // plus one crossing local midnight (22:00–23:00Z overlaps the day by 60 min).
  f.add({ type: 'sleep', startedAt: '2026-09-01T05:30:00Z', endedAt: '2026-09-01T07:00:00Z' });
  f.add({ type: 'sleep', startedAt: '2026-08-31T20:00:00Z', endedAt: '2026-08-31T23:00:00Z' });
  const openSleep = f.add({ type: 'sleep', startedAt: '2026-09-01T09:30:00Z' });

  const state = deriveState(f.map, NOW);
  assert.equal(state.serverNow, NOW);
  assert.equal(state.today.feeds, 2);
  assert.equal(state.today.diapers, 2);
  assert.deepEqual(state.today.diaperKinds, { pee: 1, poop: 0, both: 1 });
  assert.equal(state.today.sleepMinutes, 90 + 60 + 30);
  assert.equal(state.lastFeed.eid, feed.eid);
  assert.equal(state.openTimers.length, 1);
  assert.equal(state.openTimers[0].type, 'sleep');
  assert.equal(state.openTimers[0].eid, openSleep.eid);
  // lastByType.sleep is the last CLOSED sleep ("Wach seit"), not the open one.
  assert.equal(state.lastByType.sleep.startedAt, '2026-09-01T05:30:00Z');
  assert.equal(state.lastByType.breastfeed.eid, feed.eid);
  assert.equal(state.lastByType.bottle.startedAt, '2026-09-01T05:00:00Z');
  assert.equal(state.lastByType.diaper.startedAt, '2026-09-01T08:30:00Z');
  assert.equal(state.lastByType.weight, null);
  assert.equal(state.lastByType.temperature, null);
  assert.equal(state.lastByType.medication, null);
  assert.deepEqual(state.recentMedicationNames, []);
  // Exact /api/state shape.
  assert.deepEqual(Object.keys(state), ['serverNow', 'openTimers', 'lastByType', 'lastFeed', 'lastMeal', 'lastNursingMeal', 'familySettings', 'reminders', 'todos', 'today', 'recentMedicationNames']);
  assert.deepEqual(Object.keys(state.today), ['feeds', 'meals', 'diapers', 'diaperKinds', 'sleepMinutes']);
  // Two feeds hours apart: two meals; the last one is the 08:00 breastfeed.
  assert.equal(state.today.meals, 2);
  assert.equal(state.lastMeal.entries.length, 1);
  assert.equal(state.lastMeal.entries[0].eid, feed.eid);
  assert.deepEqual(Object.keys(state.lastByType), EVENT_TYPES);
  // The same result from the pre-sorted live array.
  assert.deepEqual(deriveState(liveEntries(f.map), NOW), state);
});

test('sleep minutes: open sleeps run until now, seconds are summed then divided', () => {
  const f = fixture();
  // 30 s + 45 s closed = 75 s -> 1 minute (intdiv), not 0 + 0.
  f.add({ type: 'sleep', startedAt: '2026-09-01T05:00:00Z', endedAt: '2026-09-01T05:00:30Z' });
  f.add({ type: 'sleep', startedAt: '2026-09-01T06:00:00Z', endedAt: '2026-09-01T06:00:45Z' });
  assert.equal(deriveState(f.map, NOW).today.sleepMinutes, 1);
  // An open sleep started yesterday evening counts from local midnight.
  const g = fixture();
  g.add({ type: 'sleep', startedAt: '2026-08-31T20:00:00Z' });
  assert.equal(deriveState(g.map, NOW).today.sleepMinutes, 12 * 60);
  // Now moving forward grows the open sleep.
  assert.equal(deriveState(g.map, '2026-09-01T10:30:00Z').today.sleepMinutes, 12 * 60 + 30);
  // A sleep entirely yesterday does not count; one ending exactly at the
  // window start neither.
  const h = fixture();
  h.add({ type: 'sleep', startedAt: '2026-08-31T10:00:00Z', endedAt: '2026-08-31T22:00:00Z' });
  assert.equal(deriveState(h.map, NOW).today.sleepMinutes, 0);
});

test('open timer: state lists it; lastByType keeps the last CLOSED one; lastFeed includes the open breastfeed', () => {
  const f = fixture();
  const open = f.add({ type: 'breastfeed', startedAt: '2026-09-01T09:40:00Z', details: { side: 'L' } });
  let state = deriveState(f.map, NOW);
  assert.equal(state.openTimers.length, 1);
  assert.equal(state.openTimers[0].eid, open.eid);
  assert.equal(state.lastByType.breastfeed, null, 'open timer is not the last closed one');
  assert.equal(state.lastFeed.eid, open.eid, 'lastFeed counts from the START of the open feed');

  // A closed breastfeed logged while the timer runs (Nachtragen).
  const retro = f.add({
    type: 'breastfeed',
    startedAt: '2026-09-01T06:00:00Z',
    endedAt: '2026-09-01T06:20:00Z',
    details: { side: 'R' },
  });
  state = deriveState(f.map, NOW);
  assert.equal(state.lastByType.breastfeed.eid, retro.eid);
  assert.equal(state.lastFeed.eid, open.eid);

  // Closing the timer makes it the last one.
  f.map.set(open.eid, { ...open, endedAt: NOW, seq: 3, rev: 2 });
  state = deriveState(f.map, NOW);
  assert.deepEqual(state.openTimers, []);
  assert.equal(state.lastByType.breastfeed.eid, open.eid);
});

test('openTimers are ordered by startedAt ASC', () => {
  const f = fixture();
  const sleep = f.add({ type: 'sleep', startedAt: '2026-09-01T09:00:00Z' });
  const feed = f.add({ type: 'breastfeed', startedAt: '2026-09-01T08:00:00Z', details: { side: 'L' } });
  assert.deepEqual(deriveState(f.map, NOW).openTimers.map((e) => e.eid), [feed.eid, sleep.eid]);
});

test('recent medication names are unique and newest first', () => {
  const f = fixture();
  for (const [name, hm] of [['Vitamin D', '05:00'], ['Bigaia', '06:00'], ['Vitamin D', '07:00']]) {
    f.add({ type: 'medication', startedAt: `2026-09-01T${hm}:00Z`, details: { name } });
  }
  assert.deepEqual(deriveState(f.map, NOW).recentMedicationNames, ['Vitamin D', 'Bigaia']);
});

test('recent medication names: newest 20 -> unique -> at most 5', () => {
  const f = fixture();
  // 25 entries, oldest first: names 1..25 at 00:01..00:25 (all today).
  for (let i = 1; i <= 25; i++) {
    f.add({ type: 'medication', startedAt: `2026-09-01T01:${String(i).padStart(2, '0')}:00Z`, details: { name: `M${i}` } });
  }
  assert.deepEqual(deriveState(f.map, NOW).recentMedicationNames, ['M25', 'M24', 'M23', 'M22', 'M21']);
  // Only the newest 20 are considered: with 20 identical newest names the
  // older distinct ones never show.
  const g = fixture();
  for (let i = 1; i <= 3; i++) {
    g.add({ type: 'medication', startedAt: `2026-09-01T00:0${i}:00Z`, details: { name: `Old${i}` } });
  }
  for (let i = 1; i <= 20; i++) {
    g.add({ type: 'medication', startedAt: `2026-09-01T02:${String(i).padStart(2, '0')}:00Z`, details: { name: 'Same' } });
  }
  assert.deepEqual(deriveState(g.map, NOW).recentMedicationNames, ['Same']);
});

test('empty model: nulls, zeros and empty lists', () => {
  const state = deriveState(new Map(), NOW);
  assert.deepEqual(state, {
    serverNow: NOW,
    openTimers: [],
    lastByType: {
      breastfeed: null,
      bottle: null,
      diaper: null,
      sleep: null,
      weight: null,
      temperature: null,
      medication: null,
      task: null,
    },
    lastFeed: null,
    lastMeal: null,
    lastNursingMeal: null,
    familySettings: null,
    reminders: [],
    todos: { today: [], tomorrow: [] },
    today: { feeds: 0, meals: 0, diapers: 0, diaperKinds: { pee: 0, poop: 0, both: 0 }, sleepMinutes: 0 },
    recentMedicationNames: [],
  });
});

test('soft delete hides the entry everywhere', () => {
  const f = fixture();
  const e = f.add({ type: 'diaper', details: { kind: 'both' } });
  f.remove(e);
  assert.deepEqual(listRange(f.map, '2026-09-01', '2026-09-01'), []);
  const state = deriveState(f.map, NOW);
  assert.equal(state.lastByType.diaper, null);
  assert.equal(state.today.diapers, 0);
  // The row itself survives (tombstone).
  assert.equal(f.map.size, 1);
});

test('today follows the Zurich day of nowIso, not UTC', () => {
  const f = fixture();
  f.add({ type: 'diaper', startedAt: '2026-08-31T23:30:00Z', details: { kind: 'pee' } }); // 01:30 local Sep 1
  f.add({ type: 'diaper', startedAt: '2026-08-31T21:30:00Z', details: { kind: 'pee' } }); // 23:30 local Aug 31
  assert.equal(deriveState(f.map, '2026-08-31T23:45:00Z').today.diapers, 1);
  assert.equal(deriveState(f.map, '2026-08-31T21:45:00Z').today.diapers, 1);
  assert.equal(deriveState(f.map, '2026-09-01T21:59:59Z').today.diapers, 1);
  assert.equal(deriveState(f.map, '2026-09-01T22:00:00Z').today.diapers, 0);
});

// ---------------------------------------------------------------------------
// Listing (bt_list_entries)
// ---------------------------------------------------------------------------

test('list filters by local-day range, newest first', () => {
  const f = fixture();
  // 2026-08-31 local day ends 2026-08-31T21:59:59Z (CEST).
  const old = f.add({ type: 'diaper', startedAt: '2026-08-31T12:00:00Z', details: { kind: 'pee' } });
  // 23:30Z on Aug 31 is already Sep 1 in Zurich (01:30 local).
  const night = f.add({ type: 'diaper', startedAt: '2026-08-31T23:30:00Z', details: { kind: 'poop' } });
  const morning = f.add({ type: 'diaper', startedAt: '2026-09-01T07:00:00Z', details: { kind: 'both' } });

  const sep1 = listRange(f.map, '2026-09-01', '2026-09-01');
  assert.deepEqual(sep1.map((e) => e.eid), [morning.eid, night.eid]);

  const both = listRange(f.map, '2026-08-31', '2026-09-01');
  assert.equal(both.length, 3);
  assert.equal(both[2].eid, old.eid);

  assert.deepEqual(listRange(f.map, '2026-08-30', '2026-08-30'), []);

  throwsMsg(() => listRange(f.map, '2026-09-02', '2026-09-01'), '"to" liegt vor "from"');
  // Nonsense calendar dates must fail cleanly.
  throwsMsg(() => listRange(f.map, '2026-13-45', '2026-09-01'), '"from" ist kein gültiges Datum');
  throwsMsg(() => listRange(f.map, '2026-02-31', '2026-09-01'), '"from" ist kein gültiges Datum');
  throwsMsg(() => listRange(f.map, '2026-09-01', '2026-02-31'), '"to" ist kein gültiges Datum');
  throwsMsg(() => listRange(f.map, 'heute', '2026-09-01'), '"from" muss ein Datum im Format JJJJ-MM-TT sein');
});

// ---------------------------------------------------------------------------
// Open timers (bt_assert_no_open_timer + the two-phone race resolver)
// ---------------------------------------------------------------------------

test('openTimer finds the open entry of a type, lowest seq first', () => {
  const f = fixture();
  assert.equal(openTimer(f.map, 'sleep'), null);
  const closed = f.add({ type: 'sleep', startedAt: '2026-09-01T07:00:00Z', endedAt: '2026-09-01T08:00:00Z' });
  assert.equal(openTimer(f.map, 'sleep'), null, 'closed timers do not count');
  const a = f.add({ type: 'sleep', startedAt: '2026-09-01T09:00:00Z' });
  assert.equal(openTimer(f.map, 'sleep').eid, a.eid);
  assert.equal(openTimer(f.map, 'breastfeed'), null);
  // Editing the open one itself is allowed (excludeEid).
  assert.equal(openTimer(f.map, 'sleep', a.eid), null);
  assert.equal(openTimer(f.map, 'sleep', closed.eid).eid, a.eid);
  // A deleted open timer does not block.
  f.remove(a);
  assert.equal(openTimer(f.map, 'sleep'), null);
  // Two open ones (race): the LOWER seq wins regardless of start time.
  const later = f.add({ type: 'sleep', startedAt: '2026-09-01T09:50:00Z' }); // seq 3
  const earlier = f.add({ type: 'sleep', startedAt: '2026-09-01T09:45:00Z' }); // seq 4
  assert.equal(openTimer(f.map, 'sleep').eid, later.eid);
  assert.equal(openTimer(f.map, 'sleep', later.eid).eid, earlier.eid);
});

test('duplicateOpenTimers reports each timer type with more than one open entry', () => {
  const f = fixture();
  assert.deepEqual(duplicateOpenTimers(f.map), []);
  f.add({ type: 'sleep', startedAt: '2026-09-01T08:00:00Z' });
  assert.deepEqual(duplicateOpenTimers(f.map), [], 'one open timer is fine');
  const s2 = f.add({ type: 'sleep', startedAt: '2026-09-01T07:00:00Z' });
  const s3 = f.add({ type: 'sleep', startedAt: '2026-09-01T09:00:00Z' });
  const b1 = f.add({ type: 'breastfeed', startedAt: '2026-09-01T09:10:00Z', details: { side: 'L' } });
  const b2 = f.add({ type: 'breastfeed', startedAt: '2026-09-01T09:05:00Z', details: { side: 'R' } });
  f.add({ type: 'breastfeed', startedAt: '2026-09-01T05:00:00Z', endedAt: '2026-09-01T05:10:00Z', details: { side: 'R' } });
  const dups = duplicateOpenTimers(f.map);
  assert.equal(dups.length, 2);
  assert.equal(dups[0].type, 'breastfeed');
  assert.equal(dups[0].keep.eid, b1.eid);
  assert.deepEqual(dups[0].others.map((e) => e.eid), [b2.eid]);
  assert.equal(dups[1].type, 'sleep');
  assert.equal(dups[1].keep.eid, eidOf(1), 'keep = lowest seq (first committed)');
  assert.deepEqual(dups[1].others.map((e) => e.eid), [s2.eid, s3.eid]);
  // Resolving (soft-deleting the others) clears the report.
  f.remove(s2);
  f.remove(s3);
  f.remove(b2);
  assert.deepEqual(duplicateOpenTimers(f.map), []);
});

// ---------------------------------------------------------------------------
// applyRow (seq-monotonic sync upsert)
// ---------------------------------------------------------------------------

const row = (eid, seq, extra = {}) => ({
  eid,
  seq,
  blob: 'AQ',
  plain: null,
  createdAt: '2026-09-01',
  updatedAt: '2026-09-01',
  deletedAt: null,
  ...extra,
});

const plainOf = (eid, rev, over = {}) => ({
  v: 1,
  eid,
  rev,
  type: 'diaper',
  startedAt: '2026-09-01T07:00:00Z',
  endedAt: null,
  details: { kind: 'pee' },
  loggedBy: 'Mama',
  ...over,
});

test('applyRow stores the row meta plus the plaintext in the contract shape', () => {
  const map = new Map();
  const eid = eidOf(7);
  assert.equal(applyRow(map, row(eid, 5), plainOf(eid, 2)), true);
  assert.deepEqual(map.get(eid), {
    eid,
    seq: 5,
    createdAt: '2026-09-01',
    updatedAt: '2026-09-01',
    deletedAt: null,
    rev: 2,
    type: 'diaper',
    startedAt: '2026-09-01T07:00:00Z',
    endedAt: null,
    details: { kind: 'pee' },
    loggedBy: 'Mama',
  });
  assert.equal('v' in map.get(eid), false, 'envelope version is not carried into the model');
  assert.equal('blob' in map.get(eid), false);
});

test('applyRow is seq-monotonic: same or lower seq is ignored, higher replaces', () => {
  const map = new Map();
  const eid = eidOf(1);
  assert.equal(applyRow(map, row(eid, 3), plainOf(eid, 1)), true);
  assert.equal(applyRow(map, row(eid, 3), plainOf(eid, 9, { details: { kind: 'poop' } })), false);
  assert.equal(map.get(eid).details.kind, 'pee');
  assert.equal(applyRow(map, row(eid, 2), plainOf(eid, 9, { details: { kind: 'poop' } })), false);
  assert.equal(map.get(eid).rev, 1);
  assert.equal(applyRow(map, row(eid, 4), plainOf(eid, 2, { details: { kind: 'both' } })), true);
  assert.equal(map.get(eid).seq, 4);
  assert.equal(map.get(eid).rev, 2);
  assert.equal(map.get(eid).details.kind, 'both');
  // Rows without a usable seq are ignored.
  assert.equal(applyRow(map, row(eid, undefined), plainOf(eid, 3)), false);
  assert.equal(applyRow(map, row(eid, 'x'), plainOf(eid, 3)), false);
  assert.equal(map.get(eid).seq, 4);
});

test('applyRow: tombstones replace live entries and leave liveEntries', () => {
  const map = new Map();
  const eid = eidOf(1);
  applyRow(map, row(eid, 1), plainOf(eid, 1));
  assert.equal(liveEntries(map).length, 1);
  assert.equal(applyRow(map, row(eid, 2, { deletedAt: '2026-09-01' }), plainOf(eid, 1)), true);
  assert.equal(map.get(eid).deletedAt, '2026-09-01');
  assert.equal(map.size, 1);
  assert.deepEqual(liveEntries(map), []);
  // Restore = a newer seq without deletedAt.
  assert.equal(applyRow(map, row(eid, 3), plainOf(eid, 1)), true);
  assert.equal(liveEntries(map).length, 1);
});

test('applyRow keeps undecryptable rows as {eid, seq, …, error}', () => {
  const map = new Map();
  const eid = eidOf(2);
  assert.equal(applyRow(map, row(eid, 1), { error: 'OperationError' }), true);
  assert.deepEqual(map.get(eid), {
    eid,
    seq: 1,
    createdAt: '2026-09-01',
    updatedAt: '2026-09-01',
    deletedAt: null,
    error: 'OperationError',
  });
  assert.deepEqual(liveEntries(map), []);
  assert.deepEqual(deriveState(map, NOW).openTimers, []);
  // Error objects and empty errors become a non-empty text; a missing
  // plaintext is an error too (never a half-entry).
  assert.equal(applyRow(map, row(eid, 2), { error: new Error('kaputt') }), true);
  assert.equal(map.get(eid).error, 'kaputt');
  assert.equal(applyRow(map, row(eid, 3), { error: '' }), true);
  assert.equal(map.get(eid).error, 'Ungültiger Datensatz');
  assert.equal(applyRow(map, row(eid, 4), undefined), true);
  assert.equal(map.get(eid).error, 'Ungültiger Datensatz');
  // A later good row heals it.
  assert.equal(applyRow(map, row(eid, 5), plainOf(eid, 1)), true);
  assert.equal('error' in map.get(eid), false);
  assert.equal(liveEntries(map).length, 1);
});

test('applyRow: legacy rows (blob null, plain from the server) get legacy:true and rev 0', () => {
  const map = new Map();
  const eid = eidOf(3);
  const legacyRow = row(eid, 1, {
    blob: null,
    plain: { type: 'bottle', startedAt: '2026-08-30T08:00:00Z', endedAt: null, details: { amount_ml: 90 }, loggedBy: 'Mama' },
  });
  // Explicit plain (the caller validated it) …
  assert.equal(applyRow(map, legacyRow, legacyRow.plain), true);
  assert.deepEqual(map.get(eid), {
    eid,
    seq: 1,
    createdAt: '2026-09-01',
    updatedAt: '2026-09-01',
    deletedAt: null,
    rev: 0,
    type: 'bottle',
    startedAt: '2026-08-30T08:00:00Z',
    endedAt: null,
    details: { amount_ml: 90 },
    loggedBy: 'Mama',
    legacy: true,
  });
  // … or omitted: row.plain is used.
  const map2 = new Map();
  assert.equal(applyRow(map2, legacyRow, undefined), true);
  assert.deepEqual(map2.get(eid), map.get(eid));
  // Once sealed (blob present, seq bumped) the entry is a normal one.
  assert.equal(applyRow(map, row(eid, 2), plainOf(eid, 1, { type: 'bottle', details: { amount_ml: 90 } })), true);
  assert.equal(map.get(eid).legacy, undefined);
  assert.equal(map.get(eid).rev, 1);
  // A legacy row whose plain failed validation is stored as an error row.
  const map3 = new Map();
  assert.equal(applyRow(map3, legacyRow, { error: 'Ungültiger Datensatz' }), true);
  assert.equal(map3.get(eid).error, 'Ungültiger Datensatz');
});

test('applyRow works on a plain object keyed by eid as well', () => {
  const obj = {};
  const eid = eidOf(4);
  assert.equal(applyRow(obj, row(eid, 1), plainOf(eid, 1)), true);
  assert.equal(applyRow(obj, row(eid, 1), plainOf(eid, 1)), false);
  assert.equal(obj[eid].seq, 1);
  assert.equal(liveEntries(obj).length, 1);
});

test('applied rows feed deriveState exactly like the fixtures', () => {
  const map = new Map();
  const a = eidOf(10);
  const b = eidOf(11);
  applyRow(map, row(a, 1), plainOf(a, 1, { type: 'sleep', startedAt: '2026-09-01T09:30:00Z', details: {} }));
  applyRow(map, row(b, 2), plainOf(b, 1, { type: 'bottle', startedAt: '2026-09-01T05:00:00Z', details: { amount_ml: 100 } }));
  const state = deriveState(map, NOW);
  assert.equal(state.today.sleepMinutes, 30);
  assert.equal(state.today.feeds, 1);
  assert.equal(state.lastFeed.eid, b);
  assert.equal(state.openTimers[0].eid, a);
});

test('deriveState defaults nowIso to the wall clock', () => {
  const state = deriveState(new Map());
  assert.match(state.serverNow, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(Math.abs(Date.parse(state.serverNow) - Date.now()) < 5000);
});

// ---------------------------------------------------------------------------
// Mahlzeiten (groupMeals): feeds at most MEAL_GAP_MIN minutes apart
// ---------------------------------------------------------------------------

const bf = (f, side, start, end, extra) =>
  f.add({ type: 'breastfeed', startedAt: start, endedAt: end, details: { side } }, extra);
const bottle = (f, start, ml) => f.add({ type: 'bottle', startedAt: start, details: { amount_ml: ml } });

test('groupMeals: the gap is fixed at 20 minutes', () => {
  assert.equal(MEAL_GAP_MIN, 20);
});

test('groupMeals: sides within 20 minutes of the meal so far form one meal, newest first', () => {
  const f = fixture();
  const l = bf(f, 'L', '2026-09-01T06:00:00Z', '2026-09-01T06:12:00Z');
  const r = bf(f, 'R', '2026-09-01T06:20:00Z', '2026-09-01T06:28:00Z'); // 8 min after the left side ended
  const later = bf(f, 'L', '2026-09-01T08:00:00Z', '2026-09-01T08:10:00Z');
  const meals = groupMeals(f.map, NOW);
  assert.equal(meals.length, 2);
  // Newest meal first; entries inside a meal oldest first.
  assert.deepEqual(meals[0].entries.map((e) => e.eid), [later.eid]);
  assert.deepEqual(meals[1].entries.map((e) => e.eid), [l.eid, r.eid]);
  const m = meals[1];
  assert.equal(m.startedAt, '2026-09-01T06:00:00Z');
  assert.equal(m.endedAt, '2026-09-01T06:28:00Z');
  assert.equal(m.open, false);
  assert.equal(m.minutes, 20);
  assert.deepEqual(m.sideMinutes, { L: 12, R: 8 });
  assert.equal(m.bottleMl, 0);
  assert.equal(m.firstSide, 'L');
  assert.equal(m.lastSide, 'R');
  assert.equal(m.partial, false);
  assert.deepEqual(Object.keys(m), ['startedAt', 'endedAt', 'open', 'partial', 'entries', 'minutes', 'sideMinutes', 'bottleMl', 'bottleColostrumMl', 'firstSide', 'lastSide']);
});

test('groupMeals: exactly 20 minutes joins, 20 minutes and a second does not', () => {
  const f = fixture();
  bf(f, 'L', '2026-09-01T06:00:00Z', '2026-09-01T06:10:00Z');
  bf(f, 'R', '2026-09-01T06:30:00Z', '2026-09-01T06:35:00Z'); // 20:00 after the end
  assert.equal(groupMeals(f.map, NOW).length, 1);
  const g = fixture();
  bf(g, 'L', '2026-09-01T06:00:00Z', '2026-09-01T06:10:00Z');
  bf(g, 'R', '2026-09-01T06:30:01Z', '2026-09-01T06:35:00Z'); // 20:01 after the end
  assert.equal(groupMeals(g.map, NOW).length, 2);
});

test('groupMeals: the gap counts from the END of the meal so far, not from the last start', () => {
  const f = fixture();
  bf(f, 'L', '2026-09-01T06:00:00Z', '2026-09-01T06:30:00Z'); // a long side
  bf(f, 'R', '2026-09-01T06:40:00Z', '2026-09-01T06:48:00Z'); // 40 min after the start, 10 after the end
  assert.equal(groupMeals(f.map, NOW).length, 1);
  // A side logged after the fact that ends before an earlier side does not
  // shorten the meal: the end stays the latest one.
  const g = fixture();
  bf(g, 'L', '2026-09-01T06:00:00Z', '2026-09-01T06:30:00Z');
  bf(g, 'R', '2026-09-01T06:05:00Z', '2026-09-01T06:12:00Z'); // overlaps, ends earlier
  bf(g, 'L', '2026-09-01T06:42:00Z', '2026-09-01T06:50:00Z'); // 12 min after 06:30
  const meals = groupMeals(g.map, NOW);
  assert.equal(meals.length, 1);
  assert.equal(meals[0].endedAt, '2026-09-01T06:50:00Z');
  assert.equal(meals[0].minutes, 30 + 7 + 8);
});

test('groupMeals: a Schoppen joins a meal and is summed in ml; sleep and diapers never join', () => {
  const f = fixture();
  bf(f, 'L', '2026-09-01T06:00:00Z', '2026-09-01T06:12:00Z');
  f.add({ type: 'diaper', startedAt: '2026-09-01T06:15:00Z', details: { kind: 'pee' } });
  f.add({ type: 'sleep', startedAt: '2026-09-01T06:16:00Z', endedAt: '2026-09-01T06:18:00Z' });
  bottle(f, '2026-09-01T06:20:00Z', 40);
  f.add({ type: 'bottle', startedAt: '2026-09-01T06:25:00Z', details: { amount_ml: 20, colostrum_ml: 5 } });
  const meals = groupMeals(f.map, NOW);
  assert.equal(meals.length, 1);
  assert.equal(meals[0].entries.length, 3);
  assert.equal(meals[0].bottleMl, 60);
  assert.equal(meals[0].bottleColostrumMl, 5, '«Muttermilch» stays apart, like on the row');
  assert.equal(meals[0].minutes, 12);
  assert.equal(meals[0].endedAt, '2026-09-01T06:25:00Z', 'a Schoppen is instant: it ends at its start');
  assert.equal(meals[0].firstSide, 'L');
  assert.equal(meals[0].lastSide, 'L', 'a Schoppen is not a side');
  // Two bottles alone: firstSide stays null.
  const g = fixture();
  bottle(g, '2026-09-01T06:00:00Z', 60);
  bottle(g, '2026-09-01T06:10:00Z', 30);
  const only = groupMeals(g.map, NOW);
  assert.equal(only.length, 1);
  assert.equal(only[0].firstSide, null);
  assert.equal(only[0].bottleMl, 90);
});

test('groupMeals: a quick-logged side (Ende == Start) has no minutes and ends at its start', () => {
  const f = fixture();
  bf(f, 'L', '2026-09-01T06:00:00Z', '2026-09-01T06:12:00Z');
  bf(f, 'R', '2026-09-01T06:20:00Z', '2026-09-01T06:20:00Z');
  const [m] = groupMeals(f.map, NOW);
  assert.equal(m.entries.length, 2);
  assert.equal(m.partial, true, 'the 12 minutes are only a lower bound');
  assert.equal(m.minutes, 12);
  assert.deepEqual(m.sideMinutes, { L: 12, R: 0 });
  assert.equal(m.endedAt, '2026-09-01T06:20:00Z');
  assert.equal(m.lastSide, 'R');
  // A quick feed followed by another side more than 20 minutes after its
  // START is a new meal — its true end is unknown.
  const g = fixture();
  bf(g, 'L', '2026-09-01T06:00:00Z', '2026-09-01T06:00:00Z');
  bf(g, 'R', '2026-09-01T06:21:00Z', '2026-09-01T06:21:00Z');
  assert.equal(groupMeals(g.map, NOW).length, 2);
});

test('groupMeals: a running Stillen timer keeps its meal open until now', () => {
  const f = fixture();
  const open = bf(f, 'L', '2026-09-01T09:00:00Z'); // still running at NOW (10:00)
  bottle(f, '2026-09-01T09:50:00Z', 30); // 50 min after the start — joins, the timer is still running
  const meals = groupMeals(f.map, NOW);
  assert.equal(meals.length, 1);
  assert.equal(meals[0].open, true);
  assert.equal(meals[0].minutes, 0, 'an open side has no minutes yet');
  assert.equal(meals[0].endedAt, '2026-09-01T09:50:00Z', 'the latest KNOWN end');
  assert.deepEqual(meals[0].entries.map((e) => e.eid), [open.eid, meals[0].entries[1].eid]);
  // Closing the timer at 09:20 makes the 09:50 bottle a meal of its own.
  f.map.set(open.eid, { ...open, endedAt: '2026-09-01T09:20:00Z', seq: 9, rev: 2 });
  assert.equal(groupMeals(f.map, NOW).length, 2);
});

test('groupMeals: minutes are per-entry rounded, so the sides add up to the total', () => {
  const f = fixture();
  bf(f, 'L', '2026-09-01T06:00:00Z', '2026-09-01T06:12:29Z'); // 12.48 -> 12
  bf(f, 'R', '2026-09-01T06:13:00Z', '2026-09-01T06:21:29Z'); // 8.48 -> 8
  const [m] = groupMeals(f.map, NOW);
  assert.deepEqual(m.sideMinutes, { L: 12, R: 8 });
  assert.equal(m.minutes, 20); // not round(20.97) = 21
});

test('groupMeals: tombstones and undecryptable rows are skipped, also as a bridge', () => {
  const f = fixture();
  bf(f, 'L', '2026-09-01T06:00:00Z', '2026-09-01T06:10:00Z');
  const mid = bf(f, 'R', '2026-09-01T06:20:00Z', '2026-09-01T06:30:00Z');
  bf(f, 'L', '2026-09-01T06:40:00Z', '2026-09-01T06:50:00Z');
  assert.equal(groupMeals(f.map, NOW).length, 1);
  f.remove(mid); // without the bridge the outer sides are 30 min apart
  assert.equal(groupMeals(f.map, NOW).length, 2);
  f.map.set('ff', { eid: 'ff', seq: 99, error: 'kaputt', deletedAt: null });
  assert.equal(groupMeals(f.map, NOW).length, 2);
});

test('groupMeals: accepts Map, object and array; empty input gives no meals', () => {
  const f = fixture();
  bf(f, 'L', '2026-09-01T06:00:00Z', '2026-09-01T06:10:00Z');
  const fromMap = groupMeals(f.map, NOW);
  assert.deepEqual(groupMeals(Object.fromEntries(f.map), NOW), fromMap);
  assert.deepEqual(groupMeals([...f.map.values()], NOW), fromMap);
  assert.deepEqual(groupMeals(new Map(), NOW), []);
  assert.deepEqual(groupMeals([], NOW), []);
});

test('groupMeals: identical starts keep the eid order (the model tie-break)', () => {
  const f = fixture();
  const a = bf(f, 'L', '2026-09-01T06:00:00Z', '2026-09-01T06:10:00Z');
  const b = bf(f, 'R', '2026-09-01T06:00:00Z', '2026-09-01T06:05:00Z');
  const [m] = groupMeals(f.map, NOW);
  assert.deepEqual(m.entries.map((e) => e.eid), [a.eid, b.eid]);
  assert.equal(m.firstSide, 'L');
});

test('state.lastMeal is the meal of the last feed (the open timer included); today.meals counts by meal start', () => {
  const f = fixture();
  // Yesterday evening (Zurich): a two-sided meal that ends after local midnight
  // — counted for yesterday, it STARTED there.
  bf(f, 'L', '2026-08-31T21:50:00Z', '2026-08-31T22:02:00Z');
  bf(f, 'R', '2026-08-31T22:05:00Z', '2026-08-31T22:15:00Z');
  // Today: one meal of two sides plus a bottle, one lone bottle, one open timer.
  bf(f, 'L', '2026-09-01T05:00:00Z', '2026-09-01T05:12:00Z');
  bf(f, 'R', '2026-09-01T05:20:00Z', '2026-09-01T05:28:00Z');
  bottle(f, '2026-09-01T05:30:00Z', 40);
  bottle(f, '2026-09-01T07:30:00Z', 90);
  const open = bf(f, 'L', '2026-09-01T09:40:00Z');
  const state = deriveState(f.map, NOW);
  // The old per-entry number: 5 today plus the right side at 00:05 local.
  assert.equal(state.today.feeds, 6);
  assert.equal(state.today.meals, 3);
  assert.equal(state.lastMeal.open, true);
  assert.deepEqual(state.lastMeal.entries.map((e) => e.eid), [open.eid]);
  assert.equal(state.lastFeed.eid, open.eid);
  // A meal that started yesterday and only ENDS today is not today's.
  const g = fixture();
  bf(g, 'L', '2026-08-31T21:50:00Z', '2026-08-31T22:02:00Z');
  bf(g, 'R', '2026-08-31T22:05:00Z', '2026-08-31T22:15:00Z');
  assert.equal(deriveState(g.map, NOW).today.meals, 0);
  assert.equal(deriveState(g.map, NOW).lastMeal.entries.length, 2);
  // lastMeal follows lastFeed after a soft delete of the newest side.
  const h = fixture();
  const first = bf(h, 'L', '2026-09-01T05:00:00Z', '2026-09-01T05:12:00Z');
  const second = bf(h, 'R', '2026-09-01T05:20:00Z', '2026-09-01T05:28:00Z');
  h.remove(second);
  const st = deriveState(h.map, NOW);
  assert.equal(st.lastFeed.eid, first.eid);
  assert.deepEqual(st.lastMeal.entries.map((e) => e.eid), [first.eid]);
  assert.equal(st.lastMeal.firstSide, 'L');
});

test('state.lastMeal: a side logged while an older timer runs joins that timer', () => {
  const f = fixture();
  const open = bf(f, 'L', '2026-09-01T08:00:00Z'); // running for 2 h at NOW
  const retro = bf(f, 'R', '2026-09-01T09:00:00Z', '2026-09-01T09:10:00Z');
  const state = deriveState(f.map, NOW);
  assert.equal(state.lastFeed.eid, retro.eid);
  assert.deepEqual(state.lastMeal.entries.map((e) => e.eid), [open.eid, retro.eid]);
  assert.equal(state.lastMeal.open, true);
  assert.equal(state.today.meals, 1);
});

test('groupMeals: a forgotten timer stops collecting feeds 3 h after its start', () => {
  assert.equal(OPEN_TIMER_JOIN_MAX_MIN, 180);
  const f = fixture();
  const open = bf(f, 'L', '2026-09-01T05:00:00Z'); // never stopped, 5 h ago
  const within = bottle(f, '2026-09-01T07:50:00Z', 40); // 2 h 50 after the start: joins
  const beyond = bf(f, 'R', '2026-09-01T08:25:00Z', '2026-09-01T08:35:00Z'); // 3 h 25: its own meal (the gap runs from 08:00)
  const meals = groupMeals(f.map, NOW);
  assert.equal(meals.length, 2);
  assert.deepEqual(meals[1].entries.map((e) => e.eid), [open.eid, within.eid]);
  assert.equal(meals[1].open, true);
  assert.deepEqual(meals[0].entries.map((e) => e.eid), [beyond.eid]);
  // The cap is relative to the timer's start, not to now: the same rows
  // group the same way an hour later.
  assert.deepEqual(
    groupMeals(f.map, '2026-09-01T11:00:00Z').map((m) => m.entries.map((e) => e.eid)),
    meals.map((m) => m.entries.map((e) => e.eid))
  );
  // The horizon is where the 20-minute gap starts counting: 3 h 20 min
  // after the start still joins, a second later does not.
  const g = fixture();
  bf(g, 'L', '2026-09-01T05:00:00Z');
  bottle(g, '2026-09-01T08:20:00Z', 40);
  assert.equal(groupMeals(g.map, NOW).length, 1);
  const h = fixture();
  bf(h, 'L', '2026-09-01T05:00:00Z');
  bottle(h, '2026-09-01T08:20:01Z', 40);
  assert.equal(groupMeals(h.map, NOW).length, 2);
});

test('deriveState: an open meal derives the same state as the clock moves (no churn)', () => {
  const f = fixture();
  bf(f, 'L', '2026-09-01T09:00:00Z', '2026-09-01T09:12:00Z');
  bf(f, 'R', '2026-09-01T09:20:00Z'); // running
  bottle(f, '2026-09-01T09:30:00Z', 30);
  const strip = (st) => JSON.stringify({ ...st, serverNow: null, today: { ...st.today, sleepMinutes: 0 } });
  assert.equal(strip(deriveState(f.map, NOW)), strip(deriveState(f.map, '2026-09-01T10:10:00Z')));
  assert.equal(deriveState(f.map, NOW).lastMeal.open, true);
});

test('state.lastNursingMeal: the last meal with a Stillen side survives a Schoppen in between', () => {
  const f = fixture();
  const l = bf(f, 'L', '2026-09-01T05:00:00Z', '2026-09-01T05:12:00Z');
  bf(f, 'R', '2026-09-01T05:20:00Z', '2026-09-01T05:28:00Z');
  const b = bottle(f, '2026-09-01T08:00:00Z', 90);
  const state = deriveState(f.map, NOW);
  assert.equal(state.lastMeal.entries[0].eid, b.eid);
  assert.equal(state.lastMeal.firstSide, null);
  assert.equal(state.lastNursingMeal.entries[0].eid, l.eid);
  assert.equal(state.lastNursingMeal.firstSide, 'L');
  // With a Stillen side in the last meal both are the same meal.
  bf(f, 'L', '2026-09-01T08:10:00Z', '2026-09-01T08:15:00Z');
  const st = deriveState(f.map, NOW);
  assert.deepEqual(st.lastNursingMeal, st.lastMeal);
  // No Stillen at all: null.
  const g = fixture();
  bottle(g, '2026-09-01T08:00:00Z', 90);
  assert.equal(deriveState(g.map, NOW).lastNursingMeal, null);
});

test('groupMeals: a repeated side adds up; quick sides first or twice are partial; a Schoppen first is no side', () => {
  const f = fixture();
  bf(f, 'L', '2026-09-01T06:00:00Z', '2026-09-01T06:10:00Z');
  bf(f, 'L', '2026-09-01T06:15:00Z', '2026-09-01T06:20:00Z');
  let [m] = groupMeals(f.map, NOW);
  assert.deepEqual(m.sideMinutes, { L: 15, R: 0 });
  assert.equal(m.minutes, 15);
  assert.equal(m.firstSide, 'L');
  assert.equal(m.lastSide, 'L');
  assert.equal(m.partial, false);
  // Two quick sides (what the partner's phone produces): one partial meal.
  const g = fixture();
  bf(g, 'L', '2026-09-01T06:00:00Z', '2026-09-01T06:00:00Z');
  bf(g, 'R', '2026-09-01T06:10:00Z', '2026-09-01T06:10:00Z');
  [m] = groupMeals(g.map, NOW);
  assert.equal(m.entries.length, 2);
  assert.equal(m.partial, true);
  assert.equal(m.minutes, 0);
  assert.equal(m.endedAt, '2026-09-01T06:10:00Z');
  // A quick FIRST side followed by a stopped one is partial as well.
  const h = fixture();
  bf(h, 'L', '2026-09-01T06:00:00Z', '2026-09-01T06:00:00Z');
  bf(h, 'R', '2026-09-01T06:10:00Z', '2026-09-01T06:18:00Z');
  [m] = groupMeals(h.map, NOW);
  assert.equal(m.partial, true);
  assert.deepEqual(m.sideMinutes, { L: 0, R: 8 });
  // A Schoppen first: the meal's first SIDE is the breastfeed after it.
  const k = fixture();
  bottle(k, '2026-09-01T06:00:00Z', 30);
  bf(k, 'R', '2026-09-01T06:05:00Z', '2026-09-01T06:15:00Z');
  [m] = groupMeals(k.map, NOW);
  assert.equal(m.firstSide, 'R');
  assert.equal(m.startedAt, '2026-09-01T06:00:00Z');
  // A millisecond now (ui.isoNow) groups exactly like the canonical one.
  const o = fixture();
  bf(o, 'L', '2026-09-01T09:30:00Z');
  bottle(o, '2026-09-01T09:50:00Z', 30);
  assert.deepEqual(groupMeals(o.map, '2026-09-01T10:00:00.123Z'), groupMeals(o.map, NOW));
});

// ---------------------------------------------------------------------------
// Family settings (the `settings` entry)
// ---------------------------------------------------------------------------

test('familySettingsRow: the live settings row with the highest seq; tombstones and errors skipped', () => {
  const f = fixture();
  assert.equal(familySettingsRow(f.map), null);
  const a = f.add({ type: 'settings', startedAt: '2026-09-01T08:00:00Z', details: { feedFromStart: true } });
  assert.equal(familySettingsRow(f.map).eid, a.eid);
  // A second row (two phones created one at once): the later commit wins,
  // whatever its startedAt says.
  const b = f.add({ type: 'settings', startedAt: '2026-09-01T07:00:00Z', details: { recommendedMl: 70 } });
  assert.equal(familySettingsRow(f.map).eid, b.eid);
  f.remove(b);
  assert.equal(familySettingsRow(f.map).eid, a.eid);
  f.map.set('ee', { eid: 'ee', seq: 99, error: 'kaputt', deletedAt: null });
  assert.equal(familySettingsRow(f.map).eid, a.eid);
});

test('deriveState.familySettings carries the row; the row is no event (Verlauf, lastByType)', () => {
  const f = fixture();
  f.add({ type: 'bottle', startedAt: '2026-09-01T06:00:00Z', details: { amount_ml: 60 } });
  const row = f.add(
    { type: 'settings', startedAt: '2026-09-01T08:00:00Z', details: { feedFromStart: true, bottlePresets: [50, 80, 110] } },
    { loggedBy: 'Papa' }
  );
  const state = deriveState(f.map, NOW);
  assert.deepEqual(state.familySettings, {
    eid: row.eid,
    seq: row.seq,
    changedAt: '2026-09-01T08:00:00Z',
    changedBy: 'Papa',
    values: { feedFromStart: true, bottlePresets: [50, 80, 110] },
  });
  assert.equal(Object.prototype.hasOwnProperty.call(state.lastByType, 'settings'), false);
  assert.deepEqual(listRange(f.map, '2026-09-01', '2026-09-01').map((e) => e.type), ['bottle']);
  assert.equal(state.today.feeds, 1);
  // The values are a copy: mutating the state must not reach the model.
  state.familySettings.values.feedFromStart = false;
  assert.equal(f.map.get(row.eid).details.feedFromStart, true);
});

test('effectiveFamilySettings: family row over the device fallback over the defaults, known keys only', () => {
  assert.deepEqual(FAMILY_SETTING_KEYS, [
    'feedFromStart',
    'recommendedMl',
    'bottlePresets',
    'formulaPresets',
    'birthDate',
    'mealsPerDay',
    'breastfeeding',
    'nursingMl',
  ]);
  const defaults = {
    feedFromStart: false,
    recommendedMl: null,
    bottlePresets: [60, 90, 120],
    formulaPresets: [10, 20, 30],
    birthDate: null,
    mealsPerDay: 6,
    breastfeeding: true,
    nursingMl: null,
  };
  assert.deepEqual(effectiveFamilySettings(null, null), defaults);
  assert.deepEqual(effectiveFamilySettings(null, { recommendedMl: 70 }), { ...defaults, recommendedMl: 70 });
  // The row's explicit null overrides the device's 70; an absent key does not.
  const row = { values: { feedFromStart: true, recommendedMl: null, nightMode: 'dim', birthDate: '2026-09-08', mealsPerDay: 7 } };
  assert.deepEqual(effectiveFamilySettings(row, { recommendedMl: 70, bottlePresets: [50, 80, 110] }), {
    feedFromStart: true,
    recommendedMl: null,
    bottlePresets: [50, 80, 110],
    formulaPresets: [10, 20, 30],
    birthDate: '2026-09-08',
    mealsPerDay: 7,
    breastfeeding: true,
    nursingMl: null,
  });
  assert.deepEqual(effectiveFamilySettings({ values: { formulaPresets: [5, 10, 15] } }, null).formulaPresets, [5, 10, 15]);
  // Fresh arrays every call: nobody can mutate the defaults through the result.
  const a = effectiveFamilySettings(null, null);
  a.bottlePresets[0] = 1;
  a.formulaPresets[0] = 1;
  assert.deepEqual(DEFAULT_FAMILY_SETTINGS.bottlePresets, [60, 90, 120]);
  assert.deepEqual(DEFAULT_FAMILY_SETTINGS.formulaPresets, [10, 20, 30]);
  assert.deepEqual(effectiveFamilySettings(null, null).bottlePresets, [60, 90, 120]);
  assert.deepEqual(effectiveFamilySettings(null, null).formulaPresets, [10, 20, 30]);
});

// ---------------------------------------------------------------------------
// Reminders + to-dos (the `reminder` and `task` entries)
// ---------------------------------------------------------------------------

test('deriveState.reminders lists the live schedules by first time; a reminder is no event', () => {
  const f = fixture();
  const ibu = f.add(
    { type: 'reminder', startedAt: '2026-09-01T06:00:00Z', details: { title: 'Ibuprofen 600', who: 'mama', times: ['18:00', '08:00'] } },
    { loggedBy: 'Papa' }
  );
  const vit = f.add({ type: 'reminder', startedAt: '2026-09-01T07:00:00Z', details: { title: 'Vitamin D', note: '2 Tropfen', times: ['09:00'] } });
  const gone = f.add({ type: 'reminder', startedAt: '2026-09-01T07:30:00Z', details: { title: 'Alt', times: ['07:00'] } });
  f.remove(gone);
  const state = deriveState(f.map, NOW);
  assert.deepEqual(state.reminders, [
    { eid: ibu.eid, seq: ibu.seq, title: 'Ibuprofen 600', who: 'mama', note: null, times: ['08:00', '18:00'], everyDays: 1, startDate: '2026-09-01', changedAt: '2026-09-01T06:00:00Z', changedBy: 'Papa' },
    { eid: vit.eid, seq: vit.seq, title: 'Vitamin D', who: 'baby', note: '2 Tropfen', times: ['09:00'], everyDays: 1, startDate: '2026-09-01', changedAt: '2026-09-01T07:00:00Z', changedBy: 'Mama' },
  ]);
  // No event: Verlauf skips it, lastByType has no key for it, today counts nothing.
  assert.deepEqual(listRange(f.map, '2026-09-01', '2026-09-01'), []);
  assert.equal(Object.prototype.hasOwnProperty.call(state.lastByType, 'reminder'), false);
  assert.equal(state.today.feeds, 0);
  // A copy: the times can be mutated without reaching the model.
  state.reminders[0].times.push('23:00');
  assert.deepEqual(f.map.get(ibu.eid).details.times, ['08:00', '18:00']);
});

test('deriveState.todos expands today and tomorrow (Zurich days) and marks the ticked slots', () => {
  const f = fixture();
  const vit = f.add({ type: 'reminder', startedAt: '2026-09-01T06:00:00Z', details: { title: 'Vitamin D', times: ['08:00', '20:00'] } });
  // Ticked at 08:05 local for the 08:00 slot (06:00Z in CEST).
  const tick = f.add(
    { type: 'task', startedAt: '2026-09-01T06:05:00Z', details: { title: 'Vitamin D', reminderEid: vit.eid, due: '2026-09-01T06:00:00Z' } },
    { loggedBy: 'Papa' }
  );
  const state = deriveState(f.map, NOW);
  assert.deepEqual(state.todos.today, [
    { reminderEid: vit.eid, title: 'Vitamin D', who: 'baby', note: null, time: '08:00', due: '2026-09-01T06:00:00Z', done: { eid: tick.eid, at: '2026-09-01T06:05:00Z', by: 'Papa' } },
    { reminderEid: vit.eid, title: 'Vitamin D', who: 'baby', note: null, time: '20:00', due: '2026-09-01T18:00:00Z', done: null },
  ]);
  assert.deepEqual(state.todos.tomorrow.map((o) => [o.time, o.due, o.done]), [
    ['08:00', '2026-09-02T06:00:00Z', null],
    ['20:00', '2026-09-02T18:00:00Z', null],
  ]);
  // The tick is an event of the day: Verlauf lists it, it is the last task.
  assert.deepEqual(listRange(f.map, '2026-09-01', '2026-09-01').map((e) => e.type), ['task']);
  assert.equal(state.lastByType.task.eid, tick.eid);
  assert.equal(state.today.feeds, 0);
  // The day follows the Zurich clock: at 23:45Z (01:45 local Sep 2) the slots are Sep 2's.
  const late = deriveState(f.map, '2026-09-01T23:45:00Z');
  assert.deepEqual(late.todos.today.map((o) => o.due), ['2026-09-02T06:00:00Z', '2026-09-02T18:00:00Z']);
  assert.equal(late.todos.today[0].done, null);
});
