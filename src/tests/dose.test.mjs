// The drinking target (src/dose.js): the Lebenstag from the birth date, the
// rule (Lebenstag − 1) × 60 ml a day for the first ten days, then a sixth of
// the last weight (or the guide by age), one meal's rounded share, and the
// manual amount that overrides all of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ML_PER_LIFE_DAY,
  FORMULA_MAX_LIFE_DAY,
  WEIGHT_DIVISOR,
  WEIGHT_MAX_AGE_DAYS,
  DAILY_MAX_ML,
  MEAL_MAX_ML,
  AGE_DAILY_START_ML,
  AGE_DAILY_STEP_ML,
  AGE_DAILY_TOP_ML,
  GUIDE_MAX_LIFE_DAY,
  DEFAULT_MEALS_PER_DAY,
  MEALS_PER_DAY_MIN,
  MEALS_PER_DAY_MAX,
  MEAL_ROUND_ML,
  DAILY_ROUND_ML,
  lifeDay,
  lifeWeek,
  dailyTargetMl,
  weightDailyMl,
  ageDailyMl,
  mealTargetMl,
  lastWeight,
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

test('constants: after day ten a sixth of the weight, or 600 ml + 50 a week up to 800, inside a litre a day and 230 ml a meal', () => {
  assert.equal(WEIGHT_DIVISOR, 6);
  assert.equal(WEIGHT_MAX_AGE_DAYS, 21);
  assert.equal(DAILY_MAX_ML, 1000);
  assert.equal(MEAL_MAX_ML, 230);
  assert.equal(AGE_DAILY_START_ML, 600);
  assert.equal(AGE_DAILY_STEP_ML, 50);
  assert.equal(AGE_DAILY_TOP_ML, 800);
  assert.equal(GUIDE_MAX_LIFE_DAY, 150);
  assert.equal(DAILY_ROUND_ML, 10);
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

test('lifeWeek: days 1–7 are week one, 8–14 week two', () => {
  assert.equal(lifeWeek(1), 1);
  assert.equal(lifeWeek(7), 1);
  assert.equal(lifeWeek(8), 2);
  assert.equal(lifeWeek(14), 2);
  assert.equal(lifeWeek(15), 3);
  assert.equal(lifeWeek(150), 22);
  assert.equal(lifeWeek(0), null);
  assert.equal(lifeWeek(null), null);
  assert.equal(lifeWeek(2.5), null);
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

test('weightDailyMl: a sixth of the grams, rounded to 10 ml, never above a litre', () => {
  assert.equal(weightDailyMl(3600), 600);
  assert.equal(weightDailyMl(4200), 700);
  assert.equal(weightDailyMl(3500), 580, '583.3 rounds to 580');
  assert.equal(weightDailyMl(4230), 710, '705 rounds up to 710');
  assert.equal(weightDailyMl(5400), 900);
  assert.equal(weightDailyMl(6000), 1000);
  assert.equal(weightDailyMl(7500), 1000, 'a sixth would be 1250 ml: the litre stands');
  assert.equal(weightDailyMl(0), null);
  assert.equal(weightDailyMl(-3500), null);
  assert.equal(weightDailyMl(null), null);
  assert.equal(weightDailyMl('3500'), null);
});

test('ageDailyMl: 600 ml in week two, 50 ml more each week, 800 ml from week six – between the two horizons only', () => {
  assert.equal(ageDailyMl(10), null, 'day ten still belongs to the first rule');
  assert.equal(ageDailyMl(11), 600);
  assert.equal(ageDailyMl(14), 600);
  assert.equal(ageDailyMl(15), 650);
  assert.equal(ageDailyMl(21), 650);
  assert.equal(ageDailyMl(22), 700);
  assert.equal(ageDailyMl(29), 750);
  assert.equal(ageDailyMl(35), 750);
  assert.equal(ageDailyMl(36), 800);
  assert.equal(ageDailyMl(90), 800);
  assert.equal(ageDailyMl(150), 800);
  assert.equal(ageDailyMl(151), null, 'past the milk months');
  assert.equal(ageDailyMl(null), null);
  assert.equal(ageDailyMl(12.5), null);
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
  // Never more than 230 ml in one meal, however few meals share the day.
  assert.equal(mealTargetMl(1000, 5), 200);
  assert.equal(mealTargetMl(1000, 4), 230, '250 is capped');
  assert.equal(mealTargetMl(540, 1), 230);
});

const weightRow = (startedAt, grams, extra = {}) => ({ eid: `w${startedAt}`, type: 'weight', startedAt, endedAt: null, details: { grams }, ...extra });

test('lastWeight: the newest live weight entry with its Zurich day, whatever the order', () => {
  const rows = [
    weightRow('2026-09-10T08:00:00Z', 3400),
    { eid: 'b1', type: 'bottle', startedAt: '2026-09-19T08:00:00Z', details: { amount_ml: 70 } },
    weightRow('2026-09-18T07:30:00Z', 3650),
    weightRow('2026-09-14T07:30:00Z', 3500),
  ];
  assert.deepEqual(lastWeight(rows), { grams: 3650, at: '2026-09-18T07:30:00Z', date: '2026-09-18' });
  assert.deepEqual(lastWeight([...rows].reverse()), { grams: 3650, at: '2026-09-18T07:30:00Z', date: '2026-09-18' });
  // The day is the Zurich day: 22:30 UTC in September is half past midnight there.
  assert.equal(lastWeight([weightRow('2026-09-18T22:30:00Z', 3650)]).date, '2026-09-19');
  // Deleted rows, undecryptable rows and rows without a number do not count.
  assert.deepEqual(
    lastWeight([
      weightRow('2026-09-19T07:00:00Z', 3700, { deletedAt: '2026-09-19' }),
      weightRow('2026-09-19T08:00:00Z', 3700, { error: true }),
      { eid: 'w0', type: 'weight', startedAt: '2026-09-19T09:00:00Z', details: {} },
      { eid: 'w00', type: 'weight', startedAt: '2026-09-19T09:30:00Z', details: { grams: '3700' } },
      weightRow('2026-09-12T07:00:00Z', 3450),
    ]),
    { grams: 3450, at: '2026-09-12T07:00:00Z', date: '2026-09-12' }
  );
  assert.equal(lastWeight([]), null);
  assert.equal(lastWeight(null), null);
  assert.equal(lastWeight([null, { type: 'bottle' }]), null);
});

test('doseFor: the rule from the birth date, the manual amount on top, nothing without either', () => {
  const rule = doseFor({ birthDate: '2026-09-08', mealsPerDay: 6, recommendedMl: null }, '2026-09-15');
  assert.deepEqual(rule, { lifeDay: 8, dailyMl: 420, rule: 'formula', mealsPerDay: 6, mealMl: 70, source: 'formula' });

  const seven = doseFor({ birthDate: '2026-09-08', mealsPerDay: 7 }, '2026-09-15');
  assert.deepEqual(seven, { lifeDay: 8, dailyMl: 420, rule: 'formula', mealsPerDay: 7, mealMl: 60, source: 'formula' });

  // The midwife's number wins; the rule's day amount stays visible next to it.
  const manual = doseFor({ birthDate: '2026-09-08', mealsPerDay: 6, recommendedMl: 90 }, '2026-09-15');
  assert.deepEqual(manual, { lifeDay: 8, dailyMl: 420, rule: 'formula', mealsPerDay: 6, mealMl: 90, source: 'manual' });
  const manualOnly = doseFor({ recommendedMl: 90 }, '2026-09-15');
  assert.deepEqual(manualOnly, { lifeDay: null, dailyMl: null, rule: null, mealsPerDay: 6, mealMl: 90, source: 'manual' });

  // The birth day itself: day 1, 0 ml by the rule — no target (a
  // colostrum syringe must not read as «über dem Ziel»).
  assert.deepEqual(doseFor({ birthDate: '2026-09-15' }, '2026-09-15'), {
    lifeDay: 1,
    dailyMl: null,
    rule: null,
    mealsPerDay: 6,
    mealMl: null,
    source: null,
  });
  // Day ten is the last day of the first rule — a weight changes nothing there.
  assert.deepEqual(doseFor({ birthDate: '2026-09-06' }, '2026-09-15'), { lifeDay: 10, dailyMl: 540, rule: 'formula', mealsPerDay: 6, mealMl: 90, source: 'formula' });
  assert.deepEqual(doseFor({ birthDate: '2026-09-06' }, '2026-09-15', { grams: 4200, date: '2026-09-15' }), {
    lifeDay: 10,
    dailyMl: 540,
    rule: 'formula',
    mealsPerDay: 6,
    mealMl: 90,
    source: 'formula',
  });
  // A day before the birth (a Nachtragen typo, a future birth date): no target.
  assert.deepEqual(doseFor({ birthDate: '2026-09-16' }, '2026-09-15'), {
    lifeDay: null,
    dailyMl: null,
    rule: null,
    mealsPerDay: 6,
    mealMl: null,
    source: null,
  });
  assert.deepEqual(doseFor({}, '2026-09-15'), { lifeDay: null, dailyMl: null, rule: null, mealsPerDay: 6, mealMl: null, source: null });
  assert.deepEqual(doseFor(null, '2026-09-15'), { lifeDay: null, dailyMl: null, rule: null, mealsPerDay: 6, mealMl: null, source: null });
  // Without a birth date a weight alone is no target: the first days need far less than a sixth.
  assert.deepEqual(doseFor({}, '2026-09-15', { grams: 3500, date: '2026-09-15' }), {
    lifeDay: null,
    dailyMl: null,
    rule: null,
    mealsPerDay: 6,
    mealMl: null,
    source: null,
  });

  // An out-of-range meals count (an older row, a typo) reads as the default.
  assert.equal(doseFor({ birthDate: '2026-09-08', mealsPerDay: 0 }, '2026-09-15').mealsPerDay, 6);
  assert.equal(doseFor({ birthDate: '2026-09-08', mealsPerDay: 13 }, '2026-09-15').mealsPerDay, 6);
  assert.equal(doseFor({ birthDate: '2026-09-08', mealsPerDay: '6' }, '2026-09-15').mealsPerDay, 6);
  assert.equal(doseFor({ birthDate: '2026-09-08', recommendedMl: 0 }, '2026-09-15').source, 'formula');
});

test('doseFor after day ten: a sixth of the last weight, the guide by age without one, the manual amount on top', () => {
  const fam = { birthDate: '2026-09-05', mealsPerDay: 6 }; // 2026-09-15 = Lebenstag 11
  // By weight: 3600 g → 600 ml a day → 100 ml a meal.
  assert.deepEqual(doseFor(fam, '2026-09-15', { grams: 3600, date: '2026-09-14' }), {
    lifeDay: 11,
    dailyMl: 600,
    rule: 'weight',
    mealsPerDay: 6,
    mealMl: 100,
    source: 'weight',
  });
  // lastWeight's result goes in as it is.
  const w = lastWeight([{ type: 'weight', startedAt: '2026-09-14T07:00:00Z', details: { grams: 4230 } }]);
  assert.deepEqual(doseFor({ ...fam, mealsPerDay: 8 }, '2026-09-15', w), {
    lifeDay: 11,
    dailyMl: 710,
    rule: 'weight',
    mealsPerDay: 8,
    mealMl: 90,
    source: 'weight',
  });
  // No weight: the guide by age — 600 ml in week two, 650 in week three …
  assert.deepEqual(doseFor(fam, '2026-09-15'), { lifeDay: 11, dailyMl: 600, rule: 'age', mealsPerDay: 6, mealMl: 100, source: 'age' });
  assert.deepEqual(doseFor(fam, '2026-09-19', null), { lifeDay: 15, dailyMl: 650, rule: 'age', mealsPerDay: 6, mealMl: 110, source: 'age' });
  assert.deepEqual(doseFor({ birthDate: '2026-08-01' }, '2026-09-15'), { lifeDay: 46, dailyMl: 800, rule: 'age', mealsPerDay: 6, mealMl: 135, source: 'age' });

  // A weight counts for three weeks; older — or dated after the day — it is none.
  assert.equal(doseFor(fam, '2026-09-26', { grams: 3600, date: '2026-09-05' }).rule, 'weight', '21 days old');
  assert.equal(doseFor(fam, '2026-09-27', { grams: 3600, date: '2026-09-05' }).rule, 'age', '22 days old');
  assert.equal(doseFor(fam, '2026-09-15', { grams: 3600, date: '2026-09-15' }).rule, 'weight', 'weighed that day');
  assert.equal(doseFor(fam, '2026-09-15', { grams: 3600, date: '2026-09-16' }).rule, 'age', 'weighed after the day');
  assert.equal(doseFor(fam, '2026-09-15', { grams: 0, date: '2026-09-15' }).rule, 'age');
  assert.equal(doseFor(fam, '2026-09-15', { grams: 3600 }).rule, 'age', 'no date, no telling how old');
  assert.equal(doseFor(fam, '2026-09-15', { grams: 3600, date: 'gestern' }).rule, 'age');

  // The caps: a litre a day, 230 ml a meal.
  assert.deepEqual(doseFor({ birthDate: '2026-06-01', mealsPerDay: 4 }, '2026-09-15', { grams: 7200, date: '2026-09-10' }), {
    lifeDay: 107,
    dailyMl: 1000,
    rule: 'weight',
    mealsPerDay: 4,
    mealMl: 230,
    source: 'weight',
  });

  // The midwife's number wins; the day's amount and its rule stay visible next to it.
  assert.deepEqual(doseFor({ ...fam, recommendedMl: 90 }, '2026-09-15', { grams: 3600, date: '2026-09-14' }), {
    lifeDay: 11,
    dailyMl: 600,
    rule: 'weight',
    mealsPerDay: 6,
    mealMl: 90,
    source: 'manual',
  });
  assert.deepEqual(doseFor({ birthDate: '2026-08-01', recommendedMl: 120 }, '2026-09-15'), {
    lifeDay: 46,
    dailyMl: 800,
    rule: 'age',
    mealsPerDay: 6,
    mealMl: 120,
    source: 'manual',
  });

  // Day 150 is the last day of the guides; from 151 they are expired — the
  // day count stays, the amounts go, a weight does not help, the manual amount still wins.
  assert.equal(doseFor({ birthDate: '2026-04-19' }, '2026-09-15').lifeDay, 150);
  assert.equal(doseFor({ birthDate: '2026-04-19' }, '2026-09-15').source, 'age');
  assert.deepEqual(doseFor({ birthDate: '2026-04-18' }, '2026-09-15'), { lifeDay: 151, dailyMl: null, rule: null, mealsPerDay: 6, mealMl: null, source: 'expired' });
  assert.deepEqual(doseFor({ birthDate: '2026-04-18' }, '2026-09-15', { grams: 7000, date: '2026-09-15' }), {
    lifeDay: 151,
    dailyMl: null,
    rule: null,
    mealsPerDay: 6,
    mealMl: null,
    source: 'expired',
  });
  assert.deepEqual(doseFor({ birthDate: '2026-04-18', recommendedMl: 200 }, '2026-09-15'), {
    lifeDay: 151,
    dailyMl: null,
    rule: null,
    mealsPerDay: 6,
    mealMl: 200,
    source: 'manual',
  });
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
