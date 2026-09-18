// Mahlzeit presentation logic shared by the home hero and Verlauf: the
// wording of a meal (in the active language, read through t() when shown),
// the next-side suggestion, the live side's place in its meal, the
// start-correction clamp and the Verlauf item list. Pure functions over
// model.groupMeals output (no DOM), node-tested in tests/meals.test.mjs —
// the home view's closure used to hold this and nothing could assert it.

import { t } from './i18n/index.js';
import { groupMeals, liveEntries, sortNewest, MEAL_GAP_MIN } from './model.js';
import { FEED_TYPES, isoFromMs } from './validate.js';
import { SIDE_LABELS, bottleTotalMl, fmtClock, fmtDurationMin, localDateOf, nowMs } from './ui.js';

// --- wording -----------------------------------------------------------------
// A single-entry meal keeps the plain entry wording elsewhere; these helpers
// describe a meal of several feeds.

/**
 * The parts of a meal in order of first appearance, each side with its
 * minutes when it has any: "Links 12 · Rechts 8", "Links 12 · Rechts",
 * "Links 12 · Schoppen 70 ml" (everything in the bottles, Muttermilch and
 * formula together — the composition is on the entry rows, a part must
 * stay one short unbreakable piece on the hero) — or with `short`,
 * "L 12 · R 8".
 */
export function mealPartsLabel(meal, opts = {}) {
  const keys = [];
  for (const e of meal.entries) {
    const k = e.type === 'bottle' ? 'bottle' : (e.details || {}).side;
    if ((k === 'L' || k === 'R' || k === 'bottle') && !keys.includes(k)) keys.push(k);
  }
  return keys
    .map((k) => {
      if (k === 'bottle') {
        return t('common.meal.bottlePart', { ml: bottleTotalMl({ amount_ml: meal.bottleMl, colostrum_ml: meal.bottleColostrumMl }) });
      }
      const name = opts.short ? k : SIDE_LABELS[k].charAt(0).toUpperCase() + SIDE_LABELS[k].slice(1);
      const mins = meal.sideMinutes[k];
      return mins > 0 ? `${name} ${mins}` : name;
    })
    .join(' · ');
}

/**
 * "Mahlzeit · 20 Min." — the Verlauf group head. "Mahlzeit · läuft" while a
 * side's timer runs; "Mahlzeit" alone when the total is unknown (no
 * durations, or a side that was never stopped — a lower bound would read as
 * the whole meal).
 */
export function mealSummary(meal) {
  const meal_ = t('common.meal');
  if (meal.open) return `${meal_} · ${t('common.running')}`;
  return meal.minutes > 0 && !meal.partial ? `${meal_} · ${fmtDurationMin(meal.minutes)}` : meal_;
}

/** "13:02–13:31"; "seit 13:02" while a side still runs; just "13:02" for an instant. */
export function mealClockRange(meal) {
  const a = fmtClock(meal.startedAt);
  if (meal.open) return t('common.time.since', { time: a });
  const b = meal.endedAt ? fmtClock(meal.endedAt) : null;
  return b && b !== a ? `${a}–${b}` : a;
}

/**
 * The instant «seit letzter Mahlzeit» counts from: the meal's end (the last
 * known instant of it), or its start when this phone counts feeds start to
 * start (prefs.feedFromStart). Only for a closed meal — the hero shows a
 * running one as the live timer.
 */
export function mealSinceIso(meal, fromStart) {
  return fromStart ? meal.startedAt : meal.endedAt;
}

/** The hero label above the interval, naming what it counts from. */
export function sinceLabel(fromStart) {
  return fromStart ? t('common.meal.sinceLastStart') : t('common.meal.sinceLast');
}

/**
 * The total is informative only when it sums several sides: "Links 12 ·
 * Rechts 8  20 Min." — not after "Links 12 · Schoppen 30 ml", where it would
 * repeat the one side's number, and never while a side's minutes are unknown.
 */
export function mealTotalShown(meal) {
  return !meal.partial && Object.values(meal.sideMinutes).filter((m) => m > 0).length > 1;
}

/**
 * The running total under the live timer: the stored sides' minutes plus the
 * live side's elapsed time, rounded like a stored side (minutesBetween) so
 * the number does not jump the moment "Stillen beenden" stores it. The
 * dataset hands over strings.
 */
export function mealTotalText(baseMinutes, liveStartedAt, at = nowMs()) {
  return fmtDurationMin(Number(baseMinutes) + Math.max(0, Math.round((at - new Date(liveStartedAt)) / 60000)));
}

// --- the live side inside its meal ------------------------------------------

/**
 * Where the feed that is live right now (an open timer, or a quick-logged
 * feed in its live window) sits in `meal`:
 *   index        its position among the meal's Stillen entries, -1 when it
 *                is not in this meal (a timer nobody stopped may sit outside
 *                the last meal, see OPEN_TIMER_JOIN_MAX_MIN) or the meal has
 *                one entry
 *   label        " · 2. Seite" for the first time on the other breast,
 *                " · weiter" when the side goes on after a «Pause» (the
 *                meal's previous side is the same one, marked paused),
 *                " · nochmals" for any other repeat of a side, "" for the
 *                first side
 *   earlierKnown every earlier side was stopped (its minutes are known) —
 *                the running total is only honest then
 *   notBeforeMs  the latest end of every earlier feed of the meal: the start
 *                corrections must not push this side back over it
 */
export function liveSideInMeal(meal, liveEid) {
  const none = { index: -1, label: '', earlierKnown: true, notBeforeMs: 0 };
  if (!meal || !liveEid || meal.entries.length < 2) return none;
  const sides = meal.entries.filter((e) => e.type === 'breastfeed');
  const index = sides.findIndex((e) => e.eid === liveEid);
  if (index < 0) return none;
  const liveSide = (sides[index].details || {}).side;
  const before = sides.slice(0, index);
  const prev = before[before.length - 1];
  const afterPause = !!prev && (prev.details || {}).side === liveSide && (prev.details || {}).paused === true;
  const label = index === 0
    ? ''
    : afterPause
      ? ` · ${t('common.liveSide.resumed')}`
      : before.some((e) => (e.details || {}).side === liveSide)
        ? ` · ${t('common.liveSide.again')}`
        : ` · ${t('common.liveSide.second')}`;
  const earlierKnown = before.every((e) => e.endedAt !== e.startedAt);
  const all = meal.entries.slice(0, meal.entries.findIndex((e) => e.eid === liveEid));
  const notBeforeMs = all.reduce((m, e) => Math.max(m, new Date(e.endedAt || e.startedAt).getTime()), 0);
  return { index, label, earlierKnown, notBeforeMs };
}

// "The timer was started five minutes into the feed": one-tap corrections
// (minutes added to the feed, i.e. the start moves earlier). Four chips fit
// one phone row.
export const START_BACK_CHIPS_MIN = [2, 5, 8, 10];

/** The chips whose new start would not fall before `notBeforeMs`. */
export function startBackChips(startMs, notBeforeMs = 0) {
  return START_BACK_CHIPS_MIN.filter((m) => startMs - m * 60000 >= notBeforeMs);
}

// --- which side next ----------------------------------------------------------

/**
 * The likely next side, answered on the quick button. While the last meal can
 * still continue (its end less than MEAL_GAP_MIN ago), the other side than the
 * one just fed; once it is over, the next meal starts on the other side than
 * this one did — the usual alternation advice, counted per meal, not per
 * side. A Schoppen in between does not change which breast is fuller: the
 * last meal WITH a Stillen side (state.lastNursingMeal) answers. Nothing
 * while a feed is live (`feedLocked`). Returns {nextSide, flipAtMs}: flipAtMs
 * is when the answer changes by the clock alone (0 = never).
 */
export function nextSideFor(state, feedLocked, at = nowMs()) {
  const lastMeal = state.lastMeal || null;
  const sideMeal = state.lastNursingMeal || null;
  if (feedLocked || !sideMeal) return { nextSide: null, flipAtMs: 0 };
  // A side closed with «Pause» that nothing followed: the parent said «this
  // side goes on» — that outranks the alternation, however long ago (a
  // pause the baby slept through is a meal that ends on the side it should
  // have continued on).
  const last = state.lastFeed || null;
  if (last && last.type === 'breastfeed' && last.details && last.details.paused === true && (last.details.side === 'L' || last.details.side === 'R')) {
    return { nextSide: last.details.side, flipAtMs: 0 };
  }
  const mealEndMs = lastMeal && !lastMeal.open ? new Date(lastMeal.endedAt).getTime() : 0;
  const joinable = mealEndMs > 0 && (at - mealEndMs) / 60000 <= MEAL_GAP_MIN;
  // The snapshot may come from JSON: compare meals by their first entry, not by identity.
  const continuing = joinable && sideMeal.entries[0].eid === lastMeal.entries[0].eid;
  const baseSide = continuing ? sideMeal.lastSide : sideMeal.firstSide;
  return {
    nextSide: baseSide ? (baseSide === 'L' ? 'R' : 'L') : null,
    flipAtMs: continuing && sideMeal.lastSide !== sideMeal.firstSide ? mealEndMs + MEAL_GAP_MIN * 60000 : 0,
  };
}

// --- zuerst stillen ------------------------------------------------------------

const PROBE_EID = '__bottle_probe__';

/**
 * The nursing a Schoppen at `atIso` would share its meal with — the Schoppen
 * form's «zuerst stillen» credit (dose.supplementFor). A probe feed at that
 * instant runs through model.groupMeals with the live feeds (the bottle
 * being edited, `excludeEid`, left out: the probe stands where it stands),
 * and the meal the probe lands in is looked at. Null when that meal has no
 * Stillen side; else { minutes, sides, partial, open } of its nursing —
 * closed minutes as the Verlauf shows them, the sides in order of first
 * appearance, `partial` when a side was never stopped, `open` while a
 * timer still runs (a running timer holds its meal open, so a bottle poured
 * meanwhile joins it).
 */
export function nursingBeforeBottle(entries, atIso, excludeEid = null, nowIso = isoFromMs(nowMs())) {
  const probe = { eid: PROBE_EID, type: 'bottle', startedAt: isoFromMs(Date.parse(atIso)), endedAt: null, details: {}, deletedAt: null };
  const feeds = liveEntries(entries).filter((e) => e.eid !== excludeEid && FEED_TYPES.includes(e.type));
  const meal = groupMeals([...feeds, probe], nowIso).find((m) => m.entries.some((e) => e.eid === PROBE_EID));
  if (!meal || meal.firstSide === null) return null;
  const sides = [];
  for (const e of meal.entries) {
    const side = e.type === 'breastfeed' ? (e.details || {}).side : null;
    if ((side === 'L' || side === 'R') && !sides.includes(side)) sides.push(side);
  }
  return { minutes: meal.minutes, sides, partial: meal.partial, open: meal.open };
}

// --- Verlauf ------------------------------------------------------------------

/** [startMs, endMs) of one device-local calendar day. */
function dayWindowMs(localDate) {
  const [y, m, d] = localDate.split('-').map(Number);
  return [new Date(y, m - 1, d).getTime(), new Date(y, m - 1, d + 1).getTime()];
}

// The wet diapers a newborn should produce a day once the milk is in (from
// about day five): the guide shown behind the day's Pipi count («💧 5/~6»)
// in Verlauf and on the home screen's today line.
export const WET_PER_DAY_GUIDE = 6;

/** «5/~6» — the wet count against the guide. */
export function wetCountLabel(wet) {
  return `${wet}/~${WET_PER_DAY_GUIDE}`;
}

/**
 * One Verlauf day summed up — {meals, wet, soiled, sleepMinutes, tasks}:
 * meals, not sides (the home screen's «Heute» counts the same way); wet
 * and soiled diapers, «Beides» counting as both; the sleep that fell into
 * the day = the overlap of EVERY loaded sleep entry with the day's window,
 * an open one running until `now` — the clipping the home screen's number
 * uses, so the two never contradict each other across midnight (a sleep
 * that crossed it sits under the day it started, its rest counts for the
 * next day); the ticks. `dayItems` are the day's historyItems, `allEntries`
 * everything loaded.
 */
export function dayCounts(dayItems, localDate, allEntries, now = nowMs()) {
  let meals = 0;
  let wet = 0;
  let soiled = 0;
  let tasks = 0;
  for (const it of dayItems) {
    if (it.meal) meals++;
    else if (it.entry.type === 'diaper') {
      const kind = (it.entry.details || {}).kind;
      if (kind === 'pee' || kind === 'both') wet++;
      if (kind === 'poop' || kind === 'both') soiled++;
    } else if (it.entry.type === 'task') {
      tasks++;
    }
  }
  const [start, end] = dayWindowMs(localDate);
  let sleepMinutes = 0;
  for (const e of allEntries) {
    if (e.type !== 'sleep') continue;
    const s = new Date(e.startedAt).getTime();
    const en = e.endedAt ? new Date(e.endedAt).getTime() : now;
    const from = Math.max(s, start);
    const to = Math.min(en, end);
    if (to > from) sleepMinutes += Math.round((to - from) / 60000);
  }
  return { meals, wet, soiled, sleepMinutes, tasks };
}

/**
 * The Verlauf list: every feed folded into its meal, everything else as
 * itself, newest first — {startedAt, eid, entry, meal?}. A meal sits where
 * its FIRST side starts and under that day, even when a later side crosses
 * midnight. `entries` covers one day more than shown (the day before
 * `fromLocal`, so a meal that began that evening groups with its later
 * sides); that day is dropped again — unless one of its meals reaches into
 * the shown days, then it is shown whole rather than hiding those sides.
 * Returns {items, fromLocal} with the day actually shown from.
 */
export function historyItems(entries, fromLocal, nowIso) {
  const meals = groupMeals(entries, nowIso);
  const boundary = meals.find(
    (m) => localDateOf(m.startedAt) < fromLocal && m.entries.some((e) => localDateOf(e.startedAt) >= fromLocal)
  );
  const shownFrom = boundary ? localDateOf(boundary.startedAt) : fromLocal;
  const items = entries
    .filter((e) => e.type !== 'breastfeed' && e.type !== 'bottle')
    .map((e) => ({ startedAt: e.startedAt, eid: e.eid, entry: e }))
    .concat(meals.map((m) => ({ startedAt: m.startedAt, eid: m.entries[0].eid, entry: m.entries[0], meal: m })))
    .filter((it) => localDateOf(it.startedAt) >= shownFrom)
    .sort(sortNewest);
  return { items, fromLocal: shownFrom };
}
