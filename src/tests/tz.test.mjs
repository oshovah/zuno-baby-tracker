// Europe/Zurich day windows — the numbers mirror what PHP's DateTimeZone
// produced for the same dates (see api/lib/entries.php bt_day_window_utc).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TZ, zurichDateOf, zurichDayWindowUtc, secondsBetween, zurichTimeUtc, shiftZurichDate } from '../tz.js';

test('TZ is Europe/Zurich', () => {
  assert.equal(TZ, 'Europe/Zurich');
});

test('summer day window (CEST, +02:00): 2026-09-01', () => {
  assert.deepEqual(zurichDayWindowUtc('2026-09-01'), ['2026-08-31T22:00:00Z', '2026-09-01T22:00:00Z']);
});

test('winter day window (CET, +01:00): 2026-01-15', () => {
  assert.deepEqual(zurichDayWindowUtc('2026-01-15'), ['2026-01-14T23:00:00Z', '2026-01-15T23:00:00Z']);
});

test('DST end 2026-10-25 is a 25-hour day', () => {
  const [start, end] = zurichDayWindowUtc('2026-10-25');
  assert.equal(start, '2026-10-24T22:00:00Z');
  assert.equal(end, '2026-10-25T23:00:00Z');
  assert.equal(secondsBetween(start, end), 25 * 3600);
  // The following day starts where this one ended.
  assert.equal(zurichDayWindowUtc('2026-10-26')[0], '2026-10-25T23:00:00Z');
});

test('DST start 2026-03-29 is a 23-hour day', () => {
  const [start, end] = zurichDayWindowUtc('2026-03-29');
  assert.equal(start, '2026-03-28T23:00:00Z');
  assert.equal(end, '2026-03-29T22:00:00Z');
  assert.equal(secondsBetween(start, end), 23 * 3600);
  assert.equal(zurichDayWindowUtc('2026-03-28')[1], '2026-03-28T23:00:00Z');
});

test('month and year boundaries roll over', () => {
  assert.deepEqual(zurichDayWindowUtc('2026-12-31'), ['2026-12-30T23:00:00Z', '2026-12-31T23:00:00Z']);
  assert.deepEqual(zurichDayWindowUtc('2024-02-29'), ['2024-02-28T23:00:00Z', '2024-02-29T23:00:00Z']);
});

test('zurichDateOf: late UTC evening is already the next local day', () => {
  assert.equal(zurichDateOf('2026-08-31T23:30:00Z'), '2026-09-01');
  assert.equal(zurichDateOf('2026-08-31T21:59:59Z'), '2026-08-31');
  assert.equal(zurichDateOf('2026-08-31T22:00:00Z'), '2026-09-01');
  assert.equal(zurichDateOf('2026-01-15T23:30:00Z'), '2026-01-16');
  assert.equal(zurichDateOf('2026-01-15T22:59:59Z'), '2026-01-15');
  assert.equal(zurichDateOf('2026-09-01T10:00:00Z'), '2026-09-01');
});

test('zurichDateOf around the DST switches', () => {
  assert.equal(zurichDateOf('2026-10-25T00:30:00Z'), '2026-10-25');
  assert.equal(zurichDateOf('2026-10-24T22:00:00Z'), '2026-10-25');
  assert.equal(zurichDateOf('2026-10-25T22:59:59Z'), '2026-10-25');
  assert.equal(zurichDateOf('2026-10-25T23:00:00Z'), '2026-10-26');
  assert.equal(zurichDateOf('2026-03-28T23:00:00Z'), '2026-03-29');
  assert.equal(zurichDateOf('2026-03-29T21:59:59Z'), '2026-03-29');
  assert.equal(zurichDateOf('2026-03-29T22:00:00Z'), '2026-03-30');
});

test('every instant falls inside the window of its own local date', () => {
  // Sweep a whole year hour by hour: the window of zurichDateOf(t) must
  // contain t, and consecutive windows must tile without gaps.
  let t = Date.parse('2026-01-01T00:00:00Z');
  const stop = Date.parse('2027-01-01T00:00:00Z');
  let prevEnd = null;
  let prevDate = null;
  while (t < stop) {
    const iso = new Date(t).toISOString().replace('.000Z', 'Z');
    const date = zurichDateOf(iso);
    const [start, end] = zurichDayWindowUtc(date);
    assert.ok(start <= iso && iso < end, `${iso} in [${start}, ${end}) of ${date}`);
    if (prevDate !== null && prevDate !== date) {
      assert.equal(start, prevEnd, `no gap between ${prevDate} and ${date}`);
    }
    prevEnd = end;
    prevDate = date;
    t += 3600 * 1000;
  }
});

test('secondsBetween is signed and truncates to whole seconds', () => {
  assert.equal(secondsBetween('2026-09-01T10:00:00Z', '2026-09-01T10:10:00Z'), 600);
  assert.equal(secondsBetween('2026-09-01T10:10:00Z', '2026-09-01T10:00:00Z'), -600);
  assert.equal(secondsBetween('2026-09-01T10:00:00Z', '2026-09-01T10:00:00Z'), 0);
  assert.equal(secondsBetween('2026-09-01T10:00:00Z', '2026-09-01T10:00:00.900Z'), 0);
});

test('zurichTimeUtc: a wall-clock time on a local date, DST-aware; shiftZurichDate moves whole days', () => {
  assert.equal(zurichTimeUtc('2026-09-01', '18:00'), '2026-09-01T16:00:00Z'); // CEST
  assert.equal(zurichTimeUtc('2026-01-09', '18:00'), '2026-01-09T17:00:00Z'); // CET
  assert.equal(zurichTimeUtc('2026-09-01', '00:00'), '2026-08-31T22:00:00Z');
  // The switch days themselves: 08:00 is after the change either way.
  assert.equal(zurichTimeUtc('2026-03-29', '08:00'), '2026-03-29T06:00:00Z');
  assert.equal(zurichTimeUtc('2026-10-25', '08:00'), '2026-10-25T07:00:00Z');
  // 01:30 lies before both switches: still on the old offset.
  assert.equal(zurichTimeUtc('2026-03-29', '01:30'), '2026-03-29T00:30:00Z');
  assert.equal(zurichTimeUtc('2026-10-25', '01:30'), '2026-10-24T23:30:00Z');
  assert.equal(shiftZurichDate('2026-09-30', 1), '2026-10-01');
  assert.equal(shiftZurichDate('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftZurichDate('2026-03-28', 1), '2026-03-29');
  assert.equal(shiftZurichDate('2026-03-29', 1), '2026-03-30');
});
