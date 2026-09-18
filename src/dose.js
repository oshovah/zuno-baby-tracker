// The drinking target («Trinkmenge») for the Schoppen form and the
// Einstellungen preview: the midwives' rule of thumb for the first days —
// (Lebenstag − 1) × 60 ml over the day, shared by the day's meals — computed
// on the phone from the family's birth date and meals-per-day settings (the
// synced `settings` entry, model.DEFAULT_FAMILY_SETTINGS). A manual amount
// per meal (`recommendedMl`, what the midwife said) overrides the formula:
// the rule grows without bound, the midwife's number does not.
//
// Days are calendar dates «YYYY-MM-DD» — the Zurich day of the entry, like
// «Heute» on the home screen (tz.zurichDateOf). Pure module: no DOM, no
// store, no imports — runs under `node --test`.

export const ML_PER_LIFE_DAY = 60;
/** The rule is a rule for the first days: past this Lebenstag it says
 *  nothing any more (the amount would keep growing by 60 ml a day for
 *  ever) — from then on the midwife's number, `recommendedMl`, is the
 *  target, and the form says so. */
export const FORMULA_MAX_LIFE_DAY = 10;
export const DEFAULT_MEALS_PER_DAY = 6;
export const MEALS_PER_DAY_MIN = 1;
export const MEALS_PER_DAY_MAX = 12;
/** A meal's share is rounded to this (a syringe or a bottle is not graded finer). */
export const MEAL_ROUND_ML = 5;

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

/** The day's amount by the rule: (Lebenstag − 1) × 60 ml — 0 on the birth
 *  day, null past the rule's horizon (FORMULA_MAX_LIFE_DAY). */
export function dailyTargetMl(day) {
  return Number.isInteger(day) && day >= 1 && day <= FORMULA_MAX_LIFE_DAY ? (day - 1) * ML_PER_LIFE_DAY : null;
}

/** One meal's share of the day's amount, rounded to MEAL_ROUND_ML. */
export function mealTargetMl(dailyMl, mealsPerDay = DEFAULT_MEALS_PER_DAY) {
  if (!Number.isFinite(dailyMl) || dailyMl < 0) return null;
  const n = Number.isInteger(mealsPerDay) && mealsPerDay >= 1 ? mealsPerDay : DEFAULT_MEALS_PER_DAY;
  return Math.round(dailyMl / n / MEAL_ROUND_ML) * MEAL_ROUND_ML;
}

/**
 * What the family's settings say for one day:
 *   lifeDay      the Lebenstag, or null without a birth date (or before it)
 *   dailyMl      the rule's amount for the day, or null (no birth date, the
 *                birth day itself — 0 ml is no target — or past the horizon)
 *   mealsPerDay  the setting (default 6)
 *   mealMl       the target per meal: the manual `recommendedMl` when set,
 *                else the rule's share, else null
 *   source       where mealMl comes from — 'manual' | 'formula' — or, with
 *                no target, why: 'expired' (the day is past
 *                FORMULA_MAX_LIFE_DAY: time for the midwife's number) or
 *                null (nothing to go by)
 */
export function doseFor(settings, localDate) {
  const s = settings || {};
  const mealsPerDay =
    Number.isInteger(s.mealsPerDay) && s.mealsPerDay >= MEALS_PER_DAY_MIN && s.mealsPerDay <= MEALS_PER_DAY_MAX
      ? s.mealsPerDay
      : DEFAULT_MEALS_PER_DAY;
  const day = lifeDay(s.birthDate, localDate);
  const dailyMl = dailyTargetMl(day);
  const manual = Number.isInteger(s.recommendedMl) && s.recommendedMl >= 1 ? s.recommendedMl : null;
  let mealMl = null;
  let source = null;
  if (manual !== null) {
    mealMl = manual;
    source = 'manual';
  } else if (dailyMl !== null && dailyMl > 0) {
    mealMl = mealTargetMl(dailyMl, mealsPerDay);
    source = 'formula';
  } else if (day !== null && day > FORMULA_MAX_LIFE_DAY) {
    source = 'expired';
  }
  return { lifeDay: day, dailyMl: dailyMl !== null && dailyMl > 0 ? dailyMl : null, mealsPerDay, mealMl, source };
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
