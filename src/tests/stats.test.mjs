// The per-day figures and measurement series behind Verlauf › Grafik
// (src/stats.js), over entries built like the meals tests build them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastDays, dailyStats, measurementSeries, avgPerDay } from '../stats.js';
import { localDateOf, shiftDate } from '../ui.js';

const NOW = '2026-09-02T10:00:00Z';
let n = 0;
const entry = (type, startedAt, endedAt, details) => ({
  eid: String(++n).padStart(32, '0'),
  seq: n,
  rev: 1,
  type,
  startedAt,
  endedAt,
  details,
  loggedBy: 'Mama',
  createdAt: '2026-09-01',
  updatedAt: '2026-09-01',
  deletedAt: null,
});
const D1 = localDateOf('2026-09-01T12:00:00Z');
const D2 = localDateOf('2026-09-02T09:00:00Z');

test('lastDays: n dates ending on the last one, oldest first', () => {
  assert.deepEqual(lastDays('2026-09-02', 3), ['2026-08-31', '2026-09-01', '2026-09-02']);
  assert.deepEqual(lastDays('2026-09-02', 1), ['2026-09-02']);
  assert.deepEqual(lastDays('2026-09-02', 0), []);
});

test('dailyStats: meals like the day chips, diapers, sleep, nursing minutes per side, bottle ml', () => {
  const entries = [
    // One meal of two sides (12 + 9 min) and a bottle 10 min later, on day 1.
    entry('breastfeed', '2026-09-01T12:00:00Z', '2026-09-01T12:12:00Z', { side: 'L' }),
    entry('breastfeed', '2026-09-01T12:13:00Z', '2026-09-01T12:22:00Z', { side: 'R' }),
    entry('bottle', '2026-09-01T12:32:00Z', null, { colostrum_ml: 40, amount_ml: 30 }),
    // A second meal: a quick-logged side (no duration) — counts as a meal, no minutes.
    entry('breastfeed', '2026-09-01T16:00:00Z', '2026-09-01T16:00:00Z', { side: 'L' }),
    entry('diaper', '2026-09-01T13:00:00Z', null, { kind: 'both' }),
    entry('diaper', '2026-09-01T15:00:00Z', null, { kind: 'pee' }),
    entry('sleep', '2026-09-01T13:30:00Z', '2026-09-01T15:00:00Z', {}),
    // Day 2: a bottle-only meal and an open sleep since 09:00 (now 10:00).
    entry('bottle', '2026-09-02T08:00:00Z', null, { amount_ml: 80 }),
    entry('sleep', '2026-09-02T09:00:00Z', null, {}),
    entry('diaper', '2026-09-02T08:30:00Z', null, { kind: 'poop' }),
  ];
  const [d1, d2] = dailyStats(entries, [D1, D2], NOW);
  assert.deepEqual(d1, { day: D1, meals: 2, wet: 2, soiled: 1, sleepMin: 90, nursingMin: { L: 12, R: 9 }, bottleMl: { breast: 40, formula: 30 } });
  assert.deepEqual(d2, { day: D2, meals: 1, wet: 0, soiled: 1, sleepMin: 60, nursingMin: { L: 0, R: 0 }, bottleMl: { breast: 0, formula: 80 } });
});

test('dailyStats: days without entries are zero rows, deleted rows are skipped, no days → []', () => {
  const gone = entry('bottle', '2026-09-01T08:00:00Z', null, { amount_ml: 50 });
  gone.deletedAt = '2026-09-01';
  const D0 = shiftDate(D1, -1);
  const rows = dailyStats([gone], [D0, D1], NOW);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1].bottleMl, { breast: 0, formula: 0 });
  assert.equal(rows[0].day, D0);
  assert.deepEqual(dailyStats([], [], NOW), []);
});

test('measurementSeries: weight and temperature points oldest first, junk skipped', () => {
  const entries = [
    entry('weight', '2026-09-02T08:00:00Z', null, { grams: 3620 }),
    entry('weight', '2026-08-30T08:00:00Z', null, { grams: 3450 }),
    entry('temperature', '2026-09-01T20:00:00Z', null, { celsius: 37.2 }),
    entry('weight', '2026-09-01T08:00:00Z', null, {}),
    entry('bottle', '2026-09-01T08:00:00Z', null, { amount_ml: 50 }),
  ];
  assert.deepEqual(measurementSeries(entries, 'weight').map((p) => [p.t, p.v]), [
    ['2026-08-30T08:00:00Z', 3450],
    ['2026-09-02T08:00:00Z', 3620],
  ]);
  assert.deepEqual(measurementSeries(entries, 'temperature').map((p) => p.v), [37.2]);
  assert.deepEqual(measurementSeries(entries, 'diaper'), []);
});

test('avgPerDay: over the days that have the figure, never over the day to skip (today), rounded; null without any', () => {
  const rows = [
    { day: '2026-09-20', meals: 0, ml: 0 },
    { day: '2026-09-21', meals: 8, ml: 150 },
    { day: '2026-09-22', meals: 7, ml: 105 },
    { day: '2026-09-23', meals: 3, ml: 40 }, // today, half over
  ];
  assert.equal(avgPerDay(rows, (r) => r.meals, '2026-09-23'), 7.5, 'today left out, the empty day too');
  assert.equal(avgPerDay(rows, (r) => r.meals), 6, 'without a day to skip, today counts');
  assert.equal(avgPerDay(rows, (r) => r.ml, '2026-09-23', 0), 128, '127.5 rounds to 128 at 0 digits');
  assert.equal(avgPerDay(rows, (r) => r.ml, '2026-09-23', 1), 127.5);
  assert.equal(avgPerDay(rows.slice(3), (r) => r.meals, '2026-09-23'), null, 'only today: no average yet');
  assert.equal(avgPerDay([], (r) => r.meals, '2026-09-23'), null);
});
