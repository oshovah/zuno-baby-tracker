// Meal presentation logic (src/meals.js) over meals built by the real model:
// the strings the hero and the Verlauf head print, the next-side answer, the
// live side's place in its meal, the start-correction clamp, the Verlauf
// item list. Local-time strings are compared through fmtClock/localDateOf so
// the tests hold in any timezone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupMeals, deriveState, MEAL_GAP_MIN } from '../model.js';
import { fmtClock, localDateOf, shiftDate } from '../ui.js';
import {
  mealPartsLabel,
  mealSummary,
  mealClockRange,
  mealTotalShown,
  mealTotalText,
  mealSinceIso,
  sinceLabel,
  liveSideInMeal,
  startBackChips,
  START_BACK_CHIPS_MIN,
  nextSideFor,
  historyItems,
  dayCounts,
  WET_PER_DAY_GUIDE,
  wetCountLabel,
  nursingBeforeBottle,
} from '../meals.js';

const NOW = '2026-09-01T10:00:00Z';
const NOW_MS = Date.parse(NOW);
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
const bf = (side, s, e) => entry('breastfeed', s, e, { side });
const bottle = (s, ml, col = 0) => entry('bottle', s, null, col ? { amount_ml: ml, colostrum_ml: col } : { amount_ml: ml });
const diaper = (s) => entry('diaper', s, null, { kind: 'pee' });
const mealOf = (...entries) => groupMeals(entries, NOW)[0];

test('mealPartsLabel: sides in order of first appearance, minutes only when known, the bottles as one total', () => {
  const m = mealOf(
    bf('R', '2026-09-01T06:00:00Z', '2026-09-01T06:08:00Z'),
    bf('L', '2026-09-01T06:10:00Z', '2026-09-01T06:22:00Z'),
    bottle('2026-09-01T06:25:00Z', 40),
    bf('R', '2026-09-01T06:30:00Z', '2026-09-01T06:34:00Z') // the repeated side adds up
  );
  assert.equal(mealPartsLabel(m), 'Rechts 12 · Links 12 · Schoppen 40 ml');
  assert.equal(mealPartsLabel(m, { short: true }), 'R 12 · L 12 · Schoppen 40 ml');
  // A side that was never stopped has no number.
  const p = mealOf(bf('L', '2026-09-01T06:00:00Z', '2026-09-01T06:12:00Z'), bf('R', '2026-09-01T06:20:00Z', '2026-09-01T06:20:00Z'));
  assert.equal(mealPartsLabel(p), 'Links 12 · Rechts');
  // Two bottles: one part, everything summed — Muttermilch and formula
  // together (the composition sits on the entry rows in Verlauf).
  const b = mealOf(bottle('2026-09-01T06:00:00Z', 60), bottle('2026-09-01T06:10:00Z', 30, 5));
  assert.equal(mealPartsLabel(b), 'Schoppen 95 ml');
  const c = mealOf(bf('L', '2026-09-01T06:00:00Z', '2026-09-01T06:12:00Z'), bottle('2026-09-01T06:20:00Z', 0, 5));
  assert.equal(mealPartsLabel(c), 'Links 12 · Schoppen 5 ml');
});

test('mealSummary: total only when every side has a duration; "läuft" while a timer runs', () => {
  const full = mealOf(bf('L', '2026-09-01T06:00:00Z', '2026-09-01T06:12:00Z'), bf('R', '2026-09-01T06:20:00Z', '2026-09-01T06:28:00Z'));
  assert.equal(mealSummary(full), 'Mahlzeit · 20 Min.');
  const long = mealOf(bf('L', '2026-09-01T06:00:00Z', '2026-09-01T06:40:00Z'), bf('R', '2026-09-01T06:45:00Z', '2026-09-01T07:10:00Z'));
  assert.equal(mealSummary(long), 'Mahlzeit · 1 Std. 5 Min.');
  const partial = mealOf(bf('L', '2026-09-01T06:00:00Z', '2026-09-01T06:12:00Z'), bf('R', '2026-09-01T06:20:00Z', '2026-09-01T06:20:00Z'));
  assert.equal(mealSummary(partial), 'Mahlzeit', 'a lower bound would read as the whole meal');
  const open = mealOf(bf('L', '2026-09-01T06:00:00Z', '2026-09-01T06:12:00Z'), bf('R', '2026-09-01T06:20:00Z', null));
  assert.equal(open.entries.length, 2);
  assert.equal(mealSummary(open), 'Mahlzeit · läuft');
  const bottles = mealOf(bottle('2026-09-01T06:00:00Z', 60), bottle('2026-09-01T06:10:00Z', 30));
  assert.equal(mealSummary(bottles), 'Mahlzeit');
});

test('mealClockRange: start–end in local time; "seit" while running; a lone instant without a dash', () => {
  const m = mealOf(bf('L', '2026-09-01T06:00:00Z', '2026-09-01T06:12:00Z'), bottle('2026-09-01T06:20:00Z', 40));
  assert.equal(mealClockRange(m), `${fmtClock('2026-09-01T06:00:00Z')}–${fmtClock('2026-09-01T06:20:00Z')}`);
  const instant = mealOf(bottle('2026-09-01T06:00:00Z', 60));
  assert.equal(mealClockRange(instant), fmtClock('2026-09-01T06:00:00Z'));
  // Two instants within the same minute read as one time as well.
  const sameMinute = mealOf(bottle('2026-09-01T06:00:10Z', 60), bottle('2026-09-01T06:00:40Z', 20));
  assert.equal(mealClockRange(sameMinute), fmtClock('2026-09-01T06:00:10Z'));
  // A running side: no end that would contradict «läuft».
  const open = mealOf(bf('L', '2026-09-01T06:00:00Z', '2026-09-01T06:12:00Z'), bf('R', '2026-09-01T06:20:00Z', null));
  assert.equal(open.entries.length, 2);
  assert.equal(mealClockRange(open), `seit ${fmtClock('2026-09-01T06:00:00Z')}`);
});

test('mealTotalShown: only where the total sums several sides', () => {
  const two = mealOf(bf('L', '2026-09-01T06:00:00Z', '2026-09-01T06:12:00Z'), bf('R', '2026-09-01T06:20:00Z', '2026-09-01T06:28:00Z'));
  assert.equal(mealTotalShown(two), true);
  const withBottle = mealOf(bf('L', '2026-09-01T06:00:00Z', '2026-09-01T06:12:00Z'), bottle('2026-09-01T06:14:00Z', 30));
  assert.equal(mealTotalShown(withBottle), false, '«12 Min.» after «Schoppen 30 ml» would repeat the one side');
  const sameSide = mealOf(bf('L', '2026-09-01T06:00:00Z', '2026-09-01T06:12:00Z'), bf('L', '2026-09-01T06:20:00Z', '2026-09-01T06:23:00Z'));
  assert.equal(mealTotalShown(sameSide), false, '«Links 15» already is the total');
  const partial = mealOf(bf('L', '2026-09-01T06:00:00Z', '2026-09-01T06:12:00Z'), bf('R', '2026-09-01T06:20:00Z', '2026-09-01T06:20:00Z'));
  assert.equal(mealTotalShown(partial), false);
});

test('mealSinceIso / sinceLabel: from the meal end, or from its start on a phone that counts start to start', () => {
  const m = mealOf(bf('L', '2026-09-01T06:00:00Z', '2026-09-01T06:12:00Z'), bf('R', '2026-09-01T06:20:00Z', '2026-09-01T06:28:00Z'));
  assert.equal(mealSinceIso(m, false), '2026-09-01T06:28:00Z');
  assert.equal(mealSinceIso(m, true), '2026-09-01T06:00:00Z');
  assert.equal(sinceLabel(false), 'Seit letzter Mahlzeit');
  assert.equal(sinceLabel(true), 'Seit Beginn der letzten Mahlzeit');
});

test('mealTotalText: dataset strings, the live part rounded like a stored side', () => {
  assert.equal(mealTotalText('12', '2026-09-01T09:51:36Z', NOW_MS), '20 Min.'); // 8:24 -> 8
  assert.equal(mealTotalText('12', '2026-09-01T09:51:30Z', NOW_MS), '21 Min.'); // 8:30 -> 9, like minutesBetween
  assert.equal(mealTotalText(50, '2026-09-01T09:45:00Z', NOW_MS), '1 Std. 5 Min.');
  assert.equal(mealTotalText('0', '2026-09-01T10:00:20Z', NOW_MS), '0 Min.', 'a start slightly ahead of the clock is not negative');
});

test('liveSideInMeal: ordinal, repeat, known earlier minutes and the start floor', () => {
  const l = bf('L', '2026-09-01T09:00:00Z', '2026-09-01T09:12:00Z');
  const b = bottle('2026-09-01T09:15:00Z', 30);
  const r = bf('R', '2026-09-01T09:20:00Z', null);
  const m = mealOf(l, b, r);
  const live = liveSideInMeal(m, r.eid);
  assert.equal(live.index, 1, 'a Schoppen is not a side');
  assert.equal(live.label, ' · 2. Seite');
  assert.equal(live.earlierKnown, true);
  assert.equal(live.notBeforeMs, Date.parse('2026-09-01T09:15:00Z'), 'the bottle is a floor too');
  // The first side: no label, no floor.
  assert.deepEqual(liveSideInMeal(m, l.eid), { index: 0, label: '', earlierKnown: true, notBeforeMs: 0 });
  // The same breast again is «nochmals», not a second side; L, R, L too.
  const again = mealOf(bf('L', '2026-09-01T09:00:00Z', '2026-09-01T09:10:00Z'), bf('L', '2026-09-01T09:16:00Z', '2026-09-01T09:16:00Z'));
  assert.equal(liveSideInMeal(again, again.entries[1].eid).label, ' · nochmals');
  const third = mealOf(
    bf('L', '2026-09-01T09:00:00Z', '2026-09-01T09:10:00Z'),
    bf('R', '2026-09-01T09:12:00Z', '2026-09-01T09:20:00Z'),
    bf('L', '2026-09-01T09:22:00Z', '2026-09-01T09:22:00Z')
  );
  assert.equal(liveSideInMeal(third, third.entries[2].eid).label, ' · nochmals');
  // The same side straight after its «Pause» (the previous side is marked
  // paused): «weiter», not «nochmals» — and the pause minutes are nobody's.
  const resumed = mealOf(
    bf('L', '2026-09-01T09:00:00Z', '2026-09-01T09:08:00Z'),
    { ...bf('L', '2026-09-01T09:08:00Z', '2026-09-01T09:08:00Z'), details: { side: 'L' } }
  );
  assert.equal(liveSideInMeal(resumed, resumed.entries[1].eid).label, ' · nochmals', 'a repeat without the mark stays «nochmals»');
  const pausedFirst = { ...bf('L', '2026-09-01T09:00:00Z', '2026-09-01T09:08:00Z'), details: { side: 'L', paused: true } };
  const goesOn = bf('L', '2026-09-01T09:12:00Z', '2026-09-01T09:12:00Z');
  const afterPause = mealOf(pausedFirst, goesOn);
  assert.equal(afterPause.entries.length, 2, 'the pause is inside the meal gap');
  assert.equal(liveSideInMeal(afterPause, goesOn.eid).label, ' · weiter');
  assert.equal(liveSideInMeal(afterPause, goesOn.eid).notBeforeMs, Date.parse('2026-09-01T09:08:00Z'));
  assert.equal(mealPartsLabel(afterPause), 'Links 8', 'the paused side\'s minutes count, the pause does not');
  // A pause on the other side does not make this side a continuation.
  const otherPaused = mealOf({ ...pausedFirst, details: { side: 'R', paused: true } }, goesOn);
  assert.equal(liveSideInMeal(otherPaused, goesOn.eid).label, ' · 2. Seite');
  // An earlier side that was never stopped: its minutes are unknown.
  const partial = mealOf(bf('L', '2026-09-01T09:00:00Z', '2026-09-01T09:00:00Z'), bf('R', '2026-09-01T09:10:00Z', '2026-09-01T09:10:00Z'));
  const p = liveSideInMeal(partial, partial.entries[1].eid);
  assert.equal(p.earlierKnown, false);
  assert.equal(p.notBeforeMs, Date.parse('2026-09-01T09:00:00Z'), 'a quick side ends at its start');
  // Not in this meal, no meal, single entry: the neutral answer.
  const none = { index: -1, label: '', earlierKnown: true, notBeforeMs: 0 };
  assert.deepEqual(liveSideInMeal(m, 'nope'), none);
  assert.deepEqual(liveSideInMeal(null, r.eid), none);
  assert.deepEqual(liveSideInMeal(mealOf(l), l.eid), none);
});

test('startBackChips: chips that would cross the floor are left out', () => {
  assert.deepEqual(START_BACK_CHIPS_MIN, [2, 5, 8, 10]);
  const start = Date.parse('2026-09-01T09:20:00Z');
  assert.deepEqual(startBackChips(start), [2, 5, 8, 10]);
  assert.deepEqual(startBackChips(start, Date.parse('2026-09-01T09:14:00Z')), [2, 5]);
  assert.deepEqual(startBackChips(start, Date.parse('2026-09-01T09:15:00Z')), [2, 5], 'landing exactly on the floor is fine');
  assert.deepEqual(startBackChips(start, Date.parse('2026-09-01T09:19:00Z')), []);
});

test('nextSideFor: the other side than the last meal began with; the side just fed while it may continue', () => {
  const l = bf('L', '2026-09-01T09:00:00Z', '2026-09-01T09:12:00Z');
  const r = bf('R', '2026-09-01T09:20:00Z', '2026-09-01T09:28:00Z');
  const state = deriveState([l, r], NOW);
  // 32 min after the end: a new meal starts on the other side than L.
  assert.deepEqual(nextSideFor(state, false, NOW_MS), { nextSide: 'R', flipAtMs: 0 });
  // 5 min after the end: the meal may continue — the other side than R,
  // and the answer flips exactly 20 min after the end.
  const soon = Date.parse('2026-09-01T09:33:00Z');
  assert.deepEqual(nextSideFor(state, false, soon), { nextSide: 'L', flipAtMs: Date.parse('2026-09-01T09:48:00Z') });
  assert.equal(nextSideFor(state, false, Date.parse('2026-09-01T09:48:00Z')).nextSide, 'L', 'still open at 20:00');
  assert.equal(nextSideFor(state, false, Date.parse('2026-09-01T09:48:01Z')).nextSide, 'R');
  assert.equal(MEAL_GAP_MIN, 20);
  // The state may come back from the JSON cache: still the same answer.
  assert.deepEqual(nextSideFor(JSON.parse(JSON.stringify(state)), false, soon), nextSideFor(state, false, soon));
  // A one-sided meal: no flip needed, the answer is the same either way.
  assert.deepEqual(nextSideFor(deriveState([l], NOW), false, Date.parse('2026-09-01T09:15:00Z')), { nextSide: 'R', flipAtMs: 0 });
  // Nothing while a feed is live, nothing without any Stillen.
  assert.deepEqual(nextSideFor(state, true, NOW_MS), { nextSide: null, flipAtMs: 0 });
  assert.deepEqual(nextSideFor(deriveState([bottle('2026-09-01T09:00:00Z', 60)], NOW), false, NOW_MS), { nextSide: null, flipAtMs: 0 });
  // A Schoppen after the meal does not change the answer, and its own
  // join window is not the meal's.
  const withBottle = deriveState([l, r, bottle('2026-09-01T09:58:00Z', 60)], NOW);
  assert.deepEqual(nextSideFor(withBottle, false, NOW_MS), { nextSide: 'R', flipAtMs: 0 });
  // A side closed with «Pause» that nothing followed: the SAME side is next,
  // however long ago — the parent said so; a feed after it ends that.
  const pausedR = { ...bf('R', '2026-09-01T09:20:00Z', '2026-09-01T09:28:00Z'), details: { side: 'R', paused: true } };
  assert.deepEqual(nextSideFor(deriveState([l, pausedR], NOW), false, NOW_MS), { nextSide: 'R', flipAtMs: 0 });
  assert.deepEqual(nextSideFor(deriveState([l, pausedR], NOW), false, Date.parse('2026-09-01T09:30:00Z')), { nextSide: 'R', flipAtMs: 0 });
  assert.deepEqual(nextSideFor(deriveState([l, pausedR], NOW), true, NOW_MS), { nextSide: null, flipAtMs: 0 }, 'locked stays locked');
  const afterBottle = deriveState([l, pausedR, bottle('2026-09-01T09:35:00Z', 30)], NOW); // joins the meal; 25 min before NOW
  assert.deepEqual(nextSideFor(afterBottle, false, NOW_MS), { nextSide: 'R', flipAtMs: 0 }, 'a Schoppen later: the usual alternation (other side than L)');
});

test('historyItems: feeds fold into meals placed at their first side; the extra day is dropped, or shown whole when its meal reaches in', () => {
  const day = (iso) => localDateOf(iso);
  // Build local-day boundaries from the device timezone: `mid` is local
  // midnight between two days, whatever the zone.
  const d = new Date(NOW_MS);
  d.setHours(0, 0, 0, 0);
  const mid = d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const at = (minutesFromMid) => new Date(Date.parse(mid) + minutesFromMid * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const today = day(at(60));
  const yesterday = shiftDate(today, -1);
  assert.equal(day(at(-5)), yesterday);

  // Yesterday 23:50 L, today 00:05 R (one meal), a diaper on each day, a
  // lone bottle today.
  const l = bf('L', at(-10), at(2));
  const r = bf('R', at(5), at(13));
  const dY = diaper(at(-120));
  const dT = diaper(at(30));
  const b = bottle(at(120), 60);
  const all = [l, r, dY, dT, b];

  // Shown from today: the boundary meal reaches into today, so yesterday is
  // shown whole rather than hiding the 00:05 side.
  const shown = historyItems(all, today, NOW);
  assert.equal(shown.fromLocal, yesterday);
  assert.deepEqual(shown.items.map((it) => it.eid), [b.eid, dT.eid, l.eid, dY.eid], 'newest first, the meal at its first side');
  const meal = shown.items.find((it) => it.meal && it.meal.entries.length > 1);
  assert.deepEqual(meal.meal.entries.map((e) => e.eid), [l.eid, r.eid]);
  assert.equal(day(meal.startedAt), yesterday);

  // Without the reaching meal the extra day is dropped.
  const plain = historyItems([dY, dT, b, bf('L', at(-30), at(-20))], today, NOW);
  assert.equal(plain.fromLocal, today);
  assert.deepEqual(plain.items.map((it) => it.eid), [b.eid, dT.eid]);

  // A single-entry meal is an item with a one-entry meal (rendered plain).
  assert.equal(plain.items[0].meal.entries.length, 1);
});

test('dayCounts: meals not sides, wet/soiled with «Beides» as both, sleep clipped to the day (an open one until now), the ticks', () => {
  const d = new Date(NOW_MS);
  d.setHours(0, 0, 0, 0);
  const mid = d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const at = (minutesFromMid) => new Date(Date.parse(mid) + minutesFromMid * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const today = localDateOf(at(60));
  const yesterday = shiftDate(today, -1);
  const now = at(10 * 60); // today 10:00 local

  const all = [
    // Yesterday: two sides 2 min apart (one meal), a lone bottle (a second),
    // three diapers (pee, both, poop), a tick, a sleep 23:00–01:00 crossing
    // midnight, a weight the chips ignore.
    bf('L', at(-10 * 60), at(-10 * 60 + 12)),
    bf('R', at(-10 * 60 + 14), at(-10 * 60 + 22)),
    bottle(at(-6 * 60), 60),
    entry('diaper', at(-15 * 60), null, { kind: 'pee' }),
    entry('diaper', at(-12 * 60), null, { kind: 'both' }),
    entry('diaper', at(-8 * 60), null, { kind: 'poop' }),
    entry('task', at(-16 * 60), null, { title: 'Vitamin D', who: 'baby' }),
    entry('sleep', at(-60), at(60), null),
    entry('weight', at(-14 * 60), null, { grams: 3500 }),
    // Today: a sleep started 09:30 and still running.
    entry('sleep', at(9 * 60 + 30), null, null),
  ];
  const { items } = historyItems(all, yesterday, now);
  const byDay = new Map();
  for (const it of items) {
    const day = localDateOf(it.startedAt);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(it);
  }
  assert.deepEqual(dayCounts(byDay.get(yesterday), yesterday, all, Date.parse(now)), {
    meals: 2,
    wet: 2,
    soiled: 2,
    sleepMinutes: 60, // 23:00 to midnight; the rest is today's
    tasks: 1,
  });
  // Today: the crossing sleep's second hour plus the open one's 30 minutes so far.
  assert.deepEqual(dayCounts(byDay.get(today), today, all, Date.parse(now)), {
    meals: 0,
    wet: 0,
    soiled: 0,
    sleepMinutes: 90,
    tasks: 0,
  });
  // A day without items (nothing started on it) still gets its share of a
  // sleep that reaches into it.
  assert.equal(dayCounts([], today, [entry('sleep', at(-60), at(30), null)], Date.parse(now)).sleepMinutes, 30);
  assert.deepEqual(dayCounts([], shiftDate(yesterday, -1), all, Date.parse(now)), {
    meals: 0,
    wet: 0,
    soiled: 0,
    sleepMinutes: 0,
    tasks: 0,
  });
});

test('wetCountLabel: the day\'s wet diapers against the ~6-a-day guide', () => {
  assert.equal(WET_PER_DAY_GUIDE, 6);
  assert.equal(wetCountLabel(5), '5/~6');
  assert.equal(wetCountLabel(0), '0/~6');
  assert.equal(wetCountLabel(8), '8/~6');
});

test('nursingBeforeBottle: the nursing a bottle joins, by the meal rule', () => {
  const L = entry('breastfeed', '2026-09-01T09:00:00Z', '2026-09-01T09:12:00Z', { side: 'L' });
  const R = entry('breastfeed', '2026-09-01T09:13:00Z', '2026-09-01T09:22:00Z', { side: 'R' });
  const list = [L, R];
  // Within the join window after the last side: both sides, their minutes.
  assert.deepEqual(nursingBeforeBottle(list, '2026-09-01T09:30:00Z', null, NOW), {
    minutes: 21,
    sides: ['L', 'R'],
    partial: false,
    open: false,
  });
  // Exactly at the gap still joins; past it the bottle is a meal of its own.
  assert.ok(nursingBeforeBottle(list, '2026-09-01T09:42:00Z', null, NOW));
  assert.equal(nursingBeforeBottle(list, '2026-09-01T09:43:00Z', null, NOW), null);
  // Before the nursing, within the gap: the sides join the bottle's meal.
  assert.deepEqual(nursingBeforeBottle(list, '2026-09-01T08:50:00Z', null, NOW).sides, ['L', 'R']);
  // A meal of bottles only: nothing was nursed.
  const b1 = entry('bottle', '2026-09-01T07:00:00Z', null, { amount_ml: 60 });
  assert.equal(nursingBeforeBottle([b1], '2026-09-01T07:10:00Z', null, NOW), null);
  // Editing the bottle that already sits in the meal: it is left out, the nursing counts.
  const b2 = entry('bottle', '2026-09-01T09:30:00Z', null, { amount_ml: 40 });
  assert.equal(nursingBeforeBottle([...list, b2], '2026-09-01T09:30:00Z', b2.eid, NOW).minutes, 21);
  // A running timer holds its meal open: a bottle poured meanwhile joins it.
  const open = entry('breastfeed', '2026-09-01T09:40:00Z', null, { side: 'L' });
  assert.deepEqual(nursingBeforeBottle([open], '2026-09-01T09:55:00Z', null, NOW), {
    minutes: 0,
    sides: ['L'],
    partial: false,
    open: true,
  });
  // A quick-logged side (never stopped) has no duration: partial.
  const quick = entry('breastfeed', '2026-09-01T09:40:00Z', '2026-09-01T09:40:00Z', { side: 'R' });
  assert.deepEqual(nursingBeforeBottle([quick], '2026-09-01T09:50:00Z', null, NOW), {
    minutes: 0,
    sides: ['R'],
    partial: true,
    open: false,
  });
  // The probe never leaks into the caller's list, and a map works like an array.
  const arr = [...list];
  nursingBeforeBottle(arr, '2026-09-01T09:30:00Z', null, NOW);
  assert.equal(arr.length, 2);
  assert.equal(nursingBeforeBottle(new Map(list.map((e) => [e.eid, e])), '2026-09-01T09:30:00Z', null, NOW).minutes, 21);
  // Nothing at all.
  assert.equal(nursingBeforeBottle([], '2026-09-01T09:30:00Z', null, NOW), null);
});
