// The drinking target («Trinkmenge») for the Schoppen form and the
// Einstellungen preview, computed on the phone from the family's settings
// (the synced `settings` entry, model.DEFAULT_FAMILY_SETTINGS: birth date,
// meals per day) and the baby's logged weight. The day's amount comes from
//   the first ten days   the midwives' rule of thumb — (Lebenstag − 1) × 60 ml;
//   after that           the paediatric rule of thumb for the milk months —
//                        a sixth of the body weight a day (≈ 140–180 ml per
//                        kg), from the last `weight` entry, never above a
//                        litre;
//   without a weight     a guide by age — 600 ml a day in the second week of
//                        life, 50 ml more each week, up to 800 ml: a sixth
//                        of the median weight week by week, up to the ≈ 800 ml
//                        a day the intake settles at around week eight —
// and is shared by the day's meals, a meal never above 230 ml. A manual
// amount per meal (`recommendedMl`, what the midwife said) overrides all of
// it: the rules know the average baby, the midwife knows this one.
//
// Days are calendar dates «YYYY-MM-DD» — the Zurich day of the entry, like
// «Heute» on the home screen (tz.zurichDateOf). Pure module: no DOM, no
// store, only the (pure) tz.js — runs under `node --test`.

import { zurichDateOf } from './tz.js';

export const ML_PER_LIFE_DAY = 60;
/** The first rule is a rule for the first days: past this Lebenstag the
 *  amount would keep growing by 60 ml a day for ever — from then on the
 *  weight (or the age) says how much. */
export const FORMULA_MAX_LIFE_DAY = 10;
/** Past the first days a day's amount is the body weight in grams divided by this. */
export const WEIGHT_DIVISOR = 6;
/** A weight older than this no longer stands for a baby that grows about 5 %
 *  a week: after three weeks a sixth of the OLD weight falls below the
 *  140 ml per kg the rule's band starts at — the guide by age takes over. */
export const WEIGHT_MAX_AGE_DAYS = 21;
/** Never more than a litre a day … */
export const DAILY_MAX_ML = 1000;
/** … and never more than this in one meal. */
export const MEAL_MAX_ML = 230;
/** The guide by age: this much a day in the second Lebenswoche, … */
export const AGE_DAILY_START_ML = 600;
/** … this much more with each further week, … */
export const AGE_DAILY_STEP_ML = 50;
/** … up to this. */
export const AGE_DAILY_TOP_ML = 800;
/** Weight and age are rules for the milk months (the first four to five):
 *  past this Lebenstag solids take over meal by meal and the rules say
 *  nothing any more — `recommendedMl` is the target then, and the form says so. */
export const GUIDE_MAX_LIFE_DAY = 150;
export const DEFAULT_MEALS_PER_DAY = 6;
export const MEALS_PER_DAY_MIN = 1;
export const MEALS_PER_DAY_MAX = 12;
/** A meal's share is rounded to this (a syringe or a bottle is not graded finer). */
export const MEAL_ROUND_ML = 5;
/** A day's amount by weight is rounded to this. */
export const DAILY_ROUND_ML = 10;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;

/** Calendar day number of «YYYY-MM-DD» (days since 1970-01-01, DST-free). */
function dayNumber(localDate) {
  const [y, m, d] = localDate.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

const isDate = (v) => typeof v === 'string' && DATE_RE.test(v);

/**
 * The Lebenstag of `localDate`: 1 on the birth day, 2 the day after, …
 * null without a birth date or for a day before the birth.
 */
export function lifeDay(birthDate, localDate) {
  if (!isDate(birthDate) || !isDate(localDate)) return null;
  const n = dayNumber(localDate) - dayNumber(birthDate) + 1;
  return n >= 1 ? n : null;
}

/** The Lebenswoche of a Lebenstag: 1 for days 1–7, 2 for days 8–14, … */
export function lifeWeek(day) {
  return Number.isInteger(day) && day >= 1 ? Math.ceil(day / 7) : null;
}

/** The day's amount by the first-days rule: (Lebenstag − 1) × 60 ml — 0 on
 *  the birth day, null past the rule's horizon (FORMULA_MAX_LIFE_DAY). */
export function dailyTargetMl(day) {
  return Number.isInteger(day) && day >= 1 && day <= FORMULA_MAX_LIFE_DAY ? (day - 1) * ML_PER_LIFE_DAY : null;
}

/** The day's amount by weight: a sixth of the grams, rounded to 10 ml, never
 *  above DAILY_MAX_ML. null without a weight. */
export function weightDailyMl(grams) {
  if (!Number.isFinite(grams) || grams <= 0) return null;
  return Math.min(DAILY_MAX_ML, Math.round(grams / WEIGHT_DIVISOR / DAILY_ROUND_ML) * DAILY_ROUND_ML);
}

/** The day's amount by age, for the days between the two horizons: 600 ml in
 *  the second Lebenswoche, 50 ml more each week, up to 800 ml. null outside. */
export function ageDailyMl(day) {
  if (!Number.isInteger(day) || day <= FORMULA_MAX_LIFE_DAY || day > GUIDE_MAX_LIFE_DAY) return null;
  return Math.min(AGE_DAILY_TOP_ML, AGE_DAILY_START_ML + (lifeWeek(day) - 2) * AGE_DAILY_STEP_ML);
}

/** One meal's share of the day's amount, rounded to MEAL_ROUND_ML, never above MEAL_MAX_ML. */
export function mealTargetMl(dailyMl, mealsPerDay = DEFAULT_MEALS_PER_DAY) {
  if (!Number.isFinite(dailyMl) || dailyMl < 0) return null;
  const n = Number.isInteger(mealsPerDay) && mealsPerDay >= 1 ? mealsPerDay : DEFAULT_MEALS_PER_DAY;
  return Math.min(MEAL_MAX_ML, Math.round(dailyMl / n / MEAL_ROUND_ML) * MEAL_ROUND_ML);
}

/**
 * The weight the rule goes by: the newest live `weight` entry among `entries`
 * as { grams, at, date } (`date` = the Zurich day of the weighing), or null.
 * A day is measured against the weight known THEN, not today's: the caller
 * hands in the entries up to the day in question (store.entries.range), or
 * names that day as `upTo` («YYYY-MM-DD») and later weighings are skipped —
 * the Verlauf walks the days of one list that way.
 */
export function lastWeight(entries, upTo = null) {
  const limit = isDate(upTo) ? upTo : null;
  let best = null;
  for (const e of entries || []) {
    if (!e || e.type !== 'weight' || e.deletedAt != null || e.error) continue;
    const grams = e.details && e.details.grams;
    if (!Number.isInteger(grams) || grams <= 0 || typeof e.startedAt !== 'string') continue;
    if (limit !== null && zurichDateOf(e.startedAt) > limit) continue;
    if (best === null || e.startedAt > best.at) best = { grams, at: e.startedAt };
  }
  return best && { ...best, date: zurichDateOf(best.at) };
}

/** The grams of `weight` ({grams, date}, lastWeight) when it counts for
 *  `localDate`: weighed that day or up to WEIGHT_MAX_AGE_DAYS before. */
function usableGrams(weight, localDate) {
  if (!weight || !Number.isFinite(weight.grams) || weight.grams <= 0) return null;
  if (!isDate(weight.date) || !isDate(localDate)) return null;
  const age = dayNumber(localDate) - dayNumber(weight.date);
  return age >= 0 && age <= WEIGHT_MAX_AGE_DAYS ? weight.grams : null;
}

/**
 * What the family's settings (and the baby's last weight, dose.lastWeight)
 * say for one day:
 *   lifeDay      the Lebenstag, or null without a birth date (or before it)
 *   dailyMl      the day's amount, or null (no birth date, the birth day
 *                itself — 0 ml is no target — or past GUIDE_MAX_LIFE_DAY)
 *   rule         what dailyMl comes from: 'formula' (the first ten days),
 *                'weight' (a sixth of a weight that counts for the day),
 *                'age' (the guide, without such a weight) — or null
 *   mealsPerDay  the setting (default 6)
 *   mealMl       the target per meal: the manual `recommendedMl` when set,
 *                else the day's share, else null
 *   source       where mealMl comes from — 'manual' or the rule — or, with
 *                no target, why: 'expired' (the day is past
 *                GUIDE_MAX_LIFE_DAY: time for a recommended amount) or null
 *                (nothing to go by)
 */
export function doseFor(settings, localDate, weight = null) {
  const s = settings || {};
  const mealsPerDay =
    Number.isInteger(s.mealsPerDay) && s.mealsPerDay >= MEALS_PER_DAY_MIN && s.mealsPerDay <= MEALS_PER_DAY_MAX
      ? s.mealsPerDay
      : DEFAULT_MEALS_PER_DAY;
  const day = lifeDay(s.birthDate, localDate);
  let dailyMl = null;
  let rule = null;
  if (day !== null && day <= FORMULA_MAX_LIFE_DAY) {
    dailyMl = dailyTargetMl(day) || null; // the birth day's 0 ml is no target
    if (dailyMl !== null) rule = 'formula';
  } else if (day !== null && day <= GUIDE_MAX_LIFE_DAY) {
    const grams = usableGrams(weight, localDate);
    dailyMl = grams !== null ? weightDailyMl(grams) : ageDailyMl(day);
    rule = grams !== null ? 'weight' : 'age';
  }
  const manual = Number.isInteger(s.recommendedMl) && s.recommendedMl >= 1 ? s.recommendedMl : null;
  let mealMl = null;
  let source = null;
  if (manual !== null) {
    mealMl = manual;
    source = 'manual';
  } else if (rule !== null) {
    mealMl = mealTargetMl(dailyMl, mealsPerDay);
    source = rule;
  } else if (day !== null && day > GUIDE_MAX_LIFE_DAY) {
    source = 'expired';
  }
  return { lifeDay: day, dailyMl, rule, mealsPerDay, mealMl, source };
}

/**
 * The day's target — what the Verlauf measures a day's milk against
 * (meals.dayMilk), from doseFor()'s result: the rule's day amount, or, once
 * the midwife's amount per meal is set, that amount times the meals a day
 * (the rules step back for it, so their day amount would contradict what
 * the meals add up to). null without a target: no birth date, the birth
 * day, the rules' horizon passed — each without a recommended amount.
 */
export function dayTargetMl(dose) {
  if (!dose) return null;
  if (dose.source === 'manual') return dose.mealMl * dose.mealsPerDay;
  return Number.isInteger(dose.dailyMl) && dose.dailyMl > 0 ? dose.dailyMl : null;
}

/**
 * Nurse first, then top up: what the bottle has to carry once the meal had
 * nursing. `mealMl` is the target per meal (doseFor().mealMl, or null),
 * `settings.nursingMl` the family's estimate of what one nursing session
 * gives, `nursed` whether the bottle's meal has a Stillen side
 * (meals.nursingBeforeBottle). Returns
 *   target     the meal's target, or null without one
 *   credit     the ml taken off it: the estimate when the meal was nursed and
 *              an estimate is set, else 0
 *   remaining  target − credit, never below 0 (null without a target)
 */
export function supplementFor(mealMl, settings, nursed) {
  const target = Number.isInteger(mealMl) && mealMl > 0 ? mealMl : null;
  const s = settings || {};
  const estimate = Number.isInteger(s.nursingMl) && s.nursingMl >= 1 ? s.nursingMl : 0;
  const credit = nursed ? estimate : 0;
  return { target, credit, remaining: target === null ? null : Math.max(0, target - credit) };
}
