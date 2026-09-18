// The drinking target (src/dose.js): the Lebenstag from the birth date, the
// rule (Lebenstag − 1) × 60 ml a day, one meal's rounded share, and the
// manual amount that overrides the rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ML_PER_LIFE_DAY,
  FORMULA_MAX_LIFE_DAY,
  DEFAULT_MEALS_PER_DAY,
  MEALS_PER_DAY_MIN,
  MEALS_PER_DAY_MAX,
  MEAL_ROUND_ML,
  lifeDay,
  dailyTargetMl,
  mealTargetMl,
  doseFor,
  supplementFor,
} from '../dose.js';

test('constants: 60 ml per life day for ten days, six meals, rounded to 5 ml', () => {
  assert.equal(ML_PER_LIFE_DAY, 60);
  assert.equal(FORMULA_MAX_LIFE_DAY, 10);
  assert.equal(DEFAULT_MEALS_PER_DAY, 6);
  assert.equal(MEALS_PER_DAY_MIN, 1);
  assert.equal(MEALS_PER_DAY_MAX, 12);
  assert.equal(MEAL_ROUND_ML, 5);
});

test('lifeDay: 1 on the birth day, counting calendar days, null before the birth or without a date', () => {
  assert.equal(lifeDay('2026-09-08', '2026-09-08'), 1);
  assert.equal(lifeDay('2026-09-08', '2026-09-09'), 2);
  assert.equal(lifeDay('2026-09-08', '2026-09-15'), 8);
  // Month and year boundaries, a leap day, a DST switch in between: calendar days, not 24-hour spans.
  assert.equal(lifeDay('2026-08-31', '2026-09-01'), 2);
  assert.equal(lifeDay('2025-12-31', '2026-01-01'), 2);
  assert.equal(lifeDay('2024-02-28', '2024-03-01'), 3);
  assert.equal(lifeDay('2026-03-28', '2026-03-30'), 3, 'the 23-hour day of 2026-03-29 counts as one day');
  assert.equal(lifeDay('2026-10-24', '2026-10-26'), 3, 'the 25-hour day of 2026-10-25 counts as one day');
  assert.equal(lifeDay('2026-09-08', '2026-09-07'), null, 'before the birth');
  assert.equal(lifeDay(null, '2026-09-07'), null);
  assert.equal(lifeDay(undefined, '2026-09-07'), null);
  assert.equal(lifeDay('gestern', '2026-09-07'), null);
  assert.equal(lifeDay('2026-09-08', 'heute'), null);
});

test('dailyTargetMl: (Lebenstag − 1) × 60, only up to the rule\'s horizon', () => {
  assert.equal(dailyTargetMl(1), 0);
  assert.equal(dailyTargetMl(2), 60);
  assert.equal(dailyTargetMl(8), 420);
  assert.equal(dailyTargetMl(10), 540);
  assert.equal(dailyTargetMl(11), null, 'past day ten the rule says nothing');
  assert.equal(dailyTargetMl(30), null);
  assert.equal(dailyTargetMl(null), null);
  assert.equal(dailyTargetMl(0), null);
  assert.equal(dailyTargetMl(2.5), null);
});

test('mealTargetMl: the share of the day, rounded to 5 ml, six meals by default', () => {
  assert.equal(mealTargetMl(420), 70);
  assert.equal(mealTargetMl(420, 6), 70);
  assert.equal(mealTargetMl(0, 6), 0);
  assert.equal(mealTargetMl(60, 6), 10);
  assert.equal(mealTargetMl(420, 7), 60);
  assert.equal(mealTargetMl(480, 7), 70, '68.6 rounds to 70');
  assert.equal(mealTargetMl(420, 8), 55, '52.5 rounds up to 55');
  assert.equal(mealTargetMl(600, 8), 75);
  assert.equal(mealTargetMl(420, 0), 70, 'a meaningless count falls back to six');
  assert.equal(mealTargetMl(420, null), 70);
  assert.equal(mealTargetMl(null), null);
  assert.equal(mealTargetMl(-5), null);
});

test('doseFor: the rule from the birth date, the manual amount on top, nothing without either', () => {
  const rule = doseFor({ birthDate: '2026-09-08', mealsPerDay: 6, recommendedMl: null }, '2026-09-15');
  assert.deepEqual(rule, { lifeDay: 8, dailyMl: 420, mealsPerDay: 6, mealMl: 70, source: 'formula' });

  const seven = doseFor({ birthDate: '2026-09-08', mealsPerDay: 7 }, '2026-09-15');
  assert.deepEqual(seven, { lifeDay: 8, dailyMl: 420, mealsPerDay: 7, mealMl: 60, source: 'formula' });

  // The midwife's number wins; the rule's day amount stays visible next to it.
  const manual = doseFor({ birthDate: '2026-09-08', mealsPerDay: 6, recommendedMl: 90 }, '2026-09-15');
  assert.deepEqual(manual, { lifeDay: 8, dailyMl: 420, mealsPerDay: 6, mealMl: 90, source: 'manual' });
  const manualOnly = doseFor({ recommendedMl: 90 }, '2026-09-15');
  assert.deepEqual(manualOnly, { lifeDay: null, dailyMl: null, mealsPerDay: 6, mealMl: 90, source: 'manual' });

  // The birth day itself: day 1, 0 ml by the rule — no target (a
  // colostrum syringe must not read as «über dem Ziel»).
  assert.deepEqual(doseFor({ birthDate: '2026-09-15' }, '2026-09-15'), {
    lifeDay: 1,
    dailyMl: null,
    mealsPerDay: 6,
    mealMl: null,
    source: null,
  });
  // Day ten is the last day of the rule; from day eleven it is expired —
  // the day count stays, the amounts go, the midwife's number still wins.
  assert.deepEqual(doseFor({ birthDate: '2026-09-06' }, '2026-09-15'), { lifeDay: 10, dailyMl: 540, mealsPerDay: 6, mealMl: 90, source: 'formula' });
  assert.deepEqual(doseFor({ birthDate: '2026-09-05' }, '2026-09-15'), { lifeDay: 11, dailyMl: null, mealsPerDay: 6, mealMl: null, source: 'expired' });
  assert.deepEqual(doseFor({ birthDate: '2026-08-01', recommendedMl: 120 }, '2026-09-15'), { lifeDay: 46, dailyMl: null, mealsPerDay: 6, mealMl: 120, source: 'manual' });
  // A day before the birth (a Nachtragen typo, a future birth date): no target.
  assert.deepEqual(doseFor({ birthDate: '2026-09-16' }, '2026-09-15'), {
    lifeDay: null,
    dailyMl: null,
    mealsPerDay: 6,
    mealMl: null,
    source: null,
  });
  assert.deepEqual(doseFor({}, '2026-09-15'), { lifeDay: null, dailyMl: null, mealsPerDay: 6, mealMl: null, source: null });
  assert.deepEqual(doseFor(null, '2026-09-15'), { lifeDay: null, dailyMl: null, mealsPerDay: 6, mealMl: null, source: null });

  // An out-of-range meals count (an older row, a typo) reads as the default.
  assert.equal(doseFor({ birthDate: '2026-09-08', mealsPerDay: 0 }, '2026-09-15').mealsPerDay, 6);
  assert.equal(doseFor({ birthDate: '2026-09-08', mealsPerDay: 13 }, '2026-09-15').mealsPerDay, 6);
  assert.equal(doseFor({ birthDate: '2026-09-08', mealsPerDay: '6' }, '2026-09-15').mealsPerDay, 6);
  assert.equal(doseFor({ birthDate: '2026-09-08', recommendedMl: 0 }, '2026-09-15').source, 'formula');
});

test('supplementFor: nurse first — the estimate comes off the target when the meal was nursed', () => {
  const fam = { nursingMl: 50 };
  assert.deepEqual(supplementFor(100, fam, true), { target: 100, credit: 50, remaining: 50 });
  assert.deepEqual(supplementFor(100, fam, false), { target: 100, credit: 0, remaining: 100 });
  // The estimate covers the target: nothing left for the bottle, never negative.
  assert.deepEqual(supplementFor(40, fam, true), { target: 40, credit: 50, remaining: 0 });
  // No estimate: the whole target stands, nursed or not.
  assert.deepEqual(supplementFor(100, { nursingMl: null }, true), { target: 100, credit: 0, remaining: 100 });
  assert.deepEqual(supplementFor(100, {}, true), { target: 100, credit: 0, remaining: 100 });
  assert.deepEqual(supplementFor(100, null, true), { target: 100, credit: 0, remaining: 100 });
  // No target: the credit is still reported, the rest is unknown.
  assert.deepEqual(supplementFor(null, fam, true), { target: null, credit: 50, remaining: null });
  assert.deepEqual(supplementFor(0, fam, false), { target: null, credit: 0, remaining: null });
  // Garbage estimates count as none.
  assert.deepEqual(supplementFor(100, { nursingMl: '50' }, true), { target: 100, credit: 0, remaining: 100 });
  assert.deepEqual(supplementFor(100, { nursingMl: 0 }, true), { target: 100, credit: 0, remaining: 100 });
});
