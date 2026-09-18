// The in-memory entry model: what the server used to compute in
// api/lib/entries.php (bt_state, bt_list_entries, the open-timer lookups)
// now runs on the phone over the decrypted rows.
//
// Entries in the map carry {eid, seq, rev, type, startedAt, endedAt, details,
// loggedBy, createdAt, updatedAt, deletedAt, legacy?, error?}: the server's
// row meta plus the decrypted plaintext. Rows that failed to decrypt or
// validate are kept as {eid, seq, …, error} and skipped everywhere (counted
// under Mehr). Soft-deleted rows (deletedAt) stay in the map as tombstones.
//
// Ordering everywhere is startedAt DESC, then eid DESC (the old
// "started_at DESC, id DESC"); the tie-break only matters for identical
// seconds.
//
// Pure module: no DOM, no IndexedDB; imports only validate.js, tz.js and
// reminders.js (itself pure).

import { t } from './i18n/index.js';
import { TYPES, EVENT_TYPES, FEED_TYPES, SETTINGS_TYPE, REMINDER_TYPE, isTimerType, isEventType, validLocalDate, isoFromMs } from './validate.js';
import { zurichDateOf, zurichDayWindowUtc, shiftZurichDate, secondsBetween } from './tz.js';
import { reminderOf, sortReminders, occurrencesFor } from './reminders.js';

const cmpDesc = (a, b) => (a < b ? 1 : a > b ? -1 : 0);

/** Newest first: startedAt DESC, then eid DESC. */
export function sortNewest(a, b) {
  return cmpDesc(a.startedAt, b.startedAt) || cmpDesc(a.eid, b.eid);
}

/** Oldest first (bt_state's open timers: ORDER BY started_at). */
const sortOldest = (a, b) => -sortNewest(a, b);

const isLive = (e) => e && e.deletedAt == null && !e.error;

function values(map) {
  if (Array.isArray(map)) return map;
  if (map instanceof Map) return [...map.values()];
  return Object.values(map || {});
}

/** All live entries (no tombstones, no undecryptable rows), newest first. */
export function liveEntries(map) {
  return values(map).filter(isLive).sort(sortNewest);
}

// --- family settings -------------------------------------------------------
// The family's settings document is an entry of type `settings` (validate.js):
// synced and encrypted like every row, one per family — when two phones
// created one at the same time, the row with the highest seq (the last
// committed on the server) counts on every phone.

export const DEFAULT_FAMILY_SETTINGS = Object.freeze({
  feedFromStart: false,
  recommendedMl: null,
  bottlePresets: Object.freeze([60, 90, 120]), // the Muttermilch chips (historical name)
  formulaPresets: Object.freeze([10, 20, 30]), // the «Milch (Formula)» chips — a top-up, so small
  birthDate: null, // «YYYY-MM-DD» — the drinking target's Lebenstag (dose.js)
  mealsPerDay: 6, // the meals the day's amount is shared by
  breastfeeding: true, // «Stillen» on «Jetzt» and «Nachtragen»; off once the baby is no longer nursed
  nursingMl: null, // ≈ ml one nursing session gives — the Schoppen form takes it off the target (dose.supplementFor)
});
export const FAMILY_SETTING_KEYS = Object.keys(DEFAULT_FAMILY_SETTINGS);

/** The live settings row that counts (highest seq), or null. */
export function familySettingsRow(entries) {
  let best = null;
  for (const e of values(entries)) {
    if (!isLive(e) || e.type !== SETTINGS_TYPE) continue;
    if (!best || Number(e.seq) > Number(best.seq)) best = e;
  }
  return best;
}

/**
 * The values that apply: the family row's fields over `fallback` (the
 * device's own older per-device values, so nothing is lost when a family
 * saves its first setting) over the defaults. Only the known keys.
 */
export function effectiveFamilySettings(row, fallback) {
  const out = {
    ...DEFAULT_FAMILY_SETTINGS,
    bottlePresets: [...DEFAULT_FAMILY_SETTINGS.bottlePresets],
    formulaPresets: [...DEFAULT_FAMILY_SETTINGS.formulaPresets],
  };
  for (const src of [fallback, row && row.values]) {
    if (!src || typeof src !== 'object') continue;
    for (const k of FAMILY_SETTING_KEYS) {
      if (src[k] !== undefined) out[k] = Array.isArray(src[k]) ? [...src[k]] : src[k];
    }
  }
  return out;
}

// --- Mahlzeiten -------------------------------------------------------------
// A "Mahlzeit" is a derived grouping, never stored: consecutive feeds
// (Stillen of either side, Schoppen) with at most MEAL_GAP_MIN minutes between
// the end of the meal so far and the next start form one meal. "Links 12 Min.,
// pause, rechts 8 Min." is one meal of 20 minutes, and "seit letzter
// Mahlzeit" counts from its end. Both phones derive the same meals from the
// same synced rows; the gap is fixed on purpose (a per-device setting could
// make the phones disagree on a borderline pause).

export const MEAL_GAP_MIN = 20;

// A running Stillen timer keeps its meal open for later feeds — but only
// this long after its start. A timer nobody stopped would otherwise swallow
// every feed of the day into one meal; past the horizon its end counts as
// start + OPEN_TIMER_JOIN_MAX_MIN and the usual gap runs from there (a feed
// up to 3 h 20 min after the start still joins). Same horizon as the home
// screen's "this feed is still recent" (RETRO_MAX_AGE_MIN).
export const OPEN_TIMER_JOIN_MAX_MIN = 180;

/** Whole minutes of a closed span, rounded like the UI's minutesBetween. */
const roundedMinutes = (fromIso, toIso) =>
  Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60000));

/** A Stillen timer still running (a Schoppen has endedAt null too — it is instant). */
const isOpenTimer = (e) => isTimerType(e.type) && e.endedAt === null;

/**
 * The instant an entry stops occupying the parent, for the join test: its
 * end, its start for instant entries (Schoppen, a quick-logged feed), and
 * while a timer still runs `nowIso` — capped at OPEN_TIMER_JOIN_MAX_MIN after
 * its start. The cap is data-relative, so a feed's membership never changes
 * with the clock.
 */
function feedEndOf(e, nowIso) {
  if (!isOpenTimer(e)) return e.endedAt || e.startedAt;
  const capMs = Date.parse(e.startedAt) + OPEN_TIMER_JOIN_MAX_MIN * 60000;
  return Date.parse(nowIso) < capMs ? nowIso : isoFromMs(capMs);
}

function newMeal(e, nowIso) {
  const meal = {
    startedAt: e.startedAt,
    endedAt: e.startedAt,
    open: false,
    partial: false,
    entries: [],
    minutes: 0,
    sideMinutes: { L: 0, R: 0 },
    bottleMl: 0,
    bottleColostrumMl: 0,
    firstSide: null,
    lastSide: null,
  };
  addToMeal(meal, e, nowIso);
  return meal;
}

function addToMeal(meal, e, nowIso) {
  meal.entries.push(e);
  if (e.startedAt < meal.startedAt) meal.startedAt = e.startedAt;
  if (isOpenTimer(e)) {
    meal.open = true;
  } else {
    const end = e.endedAt || e.startedAt;
    if (end > meal.endedAt) meal.endedAt = end;
  }
  if (e.type === 'breastfeed') {
    const side = (e.details || {}).side;
    if (side === 'L' || side === 'R') {
      if (meal.firstSide === null) meal.firstSide = side;
      meal.lastSide = side;
      if (e.endedAt === e.startedAt) {
        meal.partial = true; // quick-logged, never stopped: duration unknown
      } else if (e.endedAt) {
        const mins = roundedMinutes(e.startedAt, e.endedAt);
        meal.minutes += mins;
        meal.sideMinutes[side] += mins;
      }
    }
  } else if (e.type === 'bottle') {
    const d = e.details || {};
    meal.bottleMl += Number(d.amount_ml) || 0;
    meal.bottleColostrumMl += Number(d.colostrum_ml) || 0; // «Muttermilch», kept apart like the row
  }
  // The "end so far" for the join test — a running timer keeps the meal open
  // until now, so anything logged meanwhile joins it.
  const joinEnd = feedEndOf(e, nowIso);
  if (meal._joinEnd === undefined || joinEnd > meal._joinEnd) meal._joinEnd = joinEnd;
}

/**
 * Group the live feed entries of `entries` (map or array) into meals, NEWEST
 * first; each meal lists its entries oldest first. Meal fields:
 *   startedAt   first start
 *   endedAt     the latest known end (a Schoppen or a quick-logged feed ends
 *               at its start) — "seit letzter Mahlzeit" counts from here
 *   open        true while one of its Stillen timers still runs
 *   partial     true when a Stillen side has no duration (quick-logged and
 *               never stopped): `minutes` is then only a lower bound
 *   minutes     Stillen minutes, closed entries only, each rounded like the
 *               Verlauf row shows it — so the sides always add up
 *   sideMinutes {L, R}; bottleMl + bottleColostrumMl (the Schoppen sums,
 *               formula and «Muttermilch» apart); firstSide, lastSide
 *               ('L' | 'R' | null)
 */
export function groupMeals(entries, nowIso) {
  // Canonical seconds, whatever the caller's ISO flavour (isoNow() has ms).
  const now = isoFromMs(nowIso ? Date.parse(nowIso) : Date.now());
  const feeds = liveEntries(entries)
    .filter((e) => FEED_TYPES.includes(e.type))
    .sort(sortOldest);
  const meals = [];
  let cur = null;
  for (const e of feeds) {
    const gapMin = cur ? (Date.parse(e.startedAt) - Date.parse(cur._joinEnd)) / 60000 : Infinity;
    if (cur && gapMin <= MEAL_GAP_MIN) {
      addToMeal(cur, e, now);
    } else {
      cur = newMeal(e, now);
      meals.push(cur);
    }
  }
  for (const m of meals) delete m._joinEnd;
  return meals.reverse();
}

/**
 * Field-for-field port of bt_state for the home view: open timers (oldest
 * first), the last entry per type (timer types: the last CLOSED one — "Wach
 * seit" depends on it), the last feed of either kind (an OPEN breastfeed
 * included: "time since last feed" counts from its start), today's counts in
 * the Europe/Zurich day of nowIso, sleep minutes as the clipped overlap of
 * every sleep with that day (open sleeps run until now; seconds summed, then
 * divided), and recent medication names for the entry form.
 *
 * On top of the old shape: `lastMeal` (the meal the last feed belongs to, see
 * groupMeals), `lastNursingMeal` (the last meal with a Stillen side — the
 * "which side next" question survives a Schoppen in between), `today.meals`
 * (meals that STARTED today — the number the midwife asks for, a two-sided
 * feed counted once), `familySettings` ({eid, seq, changedAt, changedBy,
 * values} of the family's settings row, or null — see familySettingsRow),
 * `reminders` (the family's schedules, reminders.reminderOf, by first time)
 * and `todos` ({today, tomorrow}: those schedules expanded into the day's
 * to-dos with their ticks, reminders.occurrencesFor — the home card and
 * checklist).
 *
 * `entries` is the map or any array of entries (filtered + sorted here);
 * nowIso should be the skew-corrected now (defaults to the wall clock).
 */
export function deriveState(entries, nowIso) {
  const now = nowIso ?? isoFromMs(Date.now());
  const live = liveEntries(entries);

  const openTimers = live.filter((e) => isTimerType(e.type) && e.endedAt === null).sort(sortOldest);

  const lastByType = {};
  for (const type of EVENT_TYPES) {
    lastByType[type] =
      live.find((e) => e.type === type && (!isTimerType(type) || e.endedAt !== null)) || null;
  }

  const lastFeed = live.find((e) => FEED_TYPES.includes(e.type)) || null;
  const meals = groupMeals(live, now);
  const lastMeal = meals[0] || null;
  const lastNursingMeal = meals.find((m) => m.firstSide !== null) || null;

  const settingsRow = familySettingsRow(live);
  const familySettings = settingsRow
    ? {
        eid: settingsRow.eid,
        seq: settingsRow.seq,
        changedAt: settingsRow.startedAt,
        changedBy: settingsRow.loggedBy,
        values: { ...(settingsRow.details || {}) },
      }
    : null;

  // The family's reminders, and today's + tomorrow's to-dos with their ticks.
  const reminders = sortReminders(live.filter((e) => e.type === REMINDER_TYPE).map(reminderOf));
  const tasks = live.filter((e) => e.type === 'task');
  const todayDate = zurichDateOf(now);
  const todos = {
    today: occurrencesFor(reminders, tasks, todayDate),
    tomorrow: occurrencesFor(reminders, tasks, shiftZurichDate(todayDate, 1)),
  };

  // Today (Europe/Zurich calendar day of now).
  const [dayStart, dayEnd] = zurichDayWindowUtc(todayDate);
  let feeds = 0;
  const diaperKinds = { pee: 0, poop: 0, both: 0 };
  for (const e of live) {
    if (e.startedAt < dayStart || e.startedAt >= dayEnd) continue;
    if (FEED_TYPES.includes(e.type)) {
      feeds++;
    } else if (e.type === 'diaper') {
      const kind = (e.details || {}).kind;
      if (Object.prototype.hasOwnProperty.call(diaperKinds, kind)) {
        diaperKinds[kind]++;
      }
    }
  }

  let todayMeals = 0;
  for (const m of meals) {
    if (m.startedAt >= dayStart && m.startedAt < dayEnd) todayMeals++;
  }

  // Sleep minutes today: overlap of each sleep entry (open ones run until
  // now) with the day window.
  let sleepSeconds = 0;
  for (const e of live) {
    if (e.type !== 'sleep') continue;
    if (!(e.startedAt < dayEnd && (e.endedAt === null || e.endedAt > dayStart))) continue;
    const s = e.startedAt > dayStart ? e.startedAt : dayStart;
    const end = e.endedAt === null ? now : e.endedAt;
    const to = end < dayEnd ? end : dayEnd;
    if (to > s) {
      sleepSeconds += secondsBetween(s, to);
    }
  }

  // Recent medication names (unique, newest first): newest 20 -> unique -> 5.
  const medNames = [];
  for (const e of live.filter((x) => x.type === 'medication').slice(0, 20)) {
    const name = (e.details || {}).name;
    if (typeof name === 'string' && name !== '' && !medNames.includes(name)) {
      medNames.push(name);
      if (medNames.length >= 5) break;
    }
  }

  return {
    serverNow: now,
    openTimers,
    lastByType,
    lastFeed,
    lastMeal,
    lastNursingMeal,
    familySettings,
    reminders,
    todos,
    today: {
      feeds,
      meals: todayMeals,
      diapers: diaperKinds.pee + diaperKinds.poop + diaperKinds.both,
      diaperKinds,
      sleepMinutes: Math.floor(sleepSeconds / 60),
    },
    recentMedicationNames: medNames,
  };
}

/**
 * Port of bt_list_entries: live entries whose start falls in the local-date
 * range [fromLocal, toLocal] (Europe/Zurich days), newest first. Throws the
 * old 400 texts for bad dates or a reversed range.
 */
export function listRange(entries, fromLocal, toLocal) {
  validLocalDate(fromLocal, 'from');
  validLocalDate(toLocal, 'to');
  if (toLocal < fromLocal) {
    const err = new Error(t('errors.validate.rangeReversed'));
    err.status = 400;
    throw err;
  }
  const [startUtc] = zurichDayWindowUtc(fromLocal);
  const [, endUtc] = zurichDayWindowUtc(toLocal);
  // Events only: the settings document is no line in the day.
  return liveEntries(entries).filter(
    (e) => isEventType(e.type) && e.startedAt >= startUtc && e.startedAt < endUtc
  );
}

const openOfType = (entries, type) =>
  liveEntries(entries)
    .filter((e) => e.type === type && e.endedAt === null)
    .sort((a, b) => a.seq - b.seq || cmpDesc(b.eid, a.eid));

/**
 * The open timer of one type (the one with the LOWEST seq = first committed,
 * today's server semantics when two phones raced), or null. excludeEid = the
 * entry being edited.
 */
export function openTimer(entries, type, excludeEid) {
  return openOfType(entries, type).find((e) => e.eid !== excludeEid) || null;
}

/**
 * Two-phone race detection after a sync: every timer type with more than one
 * open entry, as {type, keep, others} — keep = lowest seq, others ascending.
 */
export function duplicateOpenTimers(entries) {
  const out = [];
  for (const type of TYPES) {
    if (!isTimerType(type)) continue;
    const open = openOfType(entries, type);
    if (open.length > 1) {
      out.push({ type, keep: open[0], others: open.slice(1) });
    }
  }
  return out;
}

const errorText = (e) => {
  if (typeof e === 'string' && e !== '') return e;
  if (e && typeof e.message === 'string' && e.message !== '') return e.message;
  return t('errors.validate.invalidRecord');
};

/**
 * Seq-monotonic upsert of one server row {eid, seq, blob|null, plain|null,
 * createdAt, updatedAt, deletedAt} into the map (a Map, or a plain object
 * keyed by eid). `plainOrError` is the
 * decrypted+validated plaintext, or {error} for a row that failed; for a
 * legacy row (blob null, `plain` from the server) it may be omitted and
 * row.plain is used — legacy entries get legacy:true and rev 0. Returns
 * whether the map changed (false when it already holds this eid at the same
 * or a higher seq).
 */
export function applyRow(map, row, plainOrError) {
  const seq = Number(row.seq);
  if (!Number.isFinite(seq)) return false;
  const isMap = map instanceof Map;
  const existing = isMap ? map.get(row.eid) : map[row.eid];
  if (existing && Number(existing.seq) >= seq) return false;

  const legacy = row.blob == null && row.plain != null && typeof row.plain === 'object';
  const src = plainOrError !== undefined ? plainOrError : legacy ? row.plain : undefined;

  const meta = {
    eid: row.eid,
    seq,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
    deletedAt: row.deletedAt ?? null,
  };

  let entry;
  if (src && typeof src === 'object' && !('error' in src)) {
    entry = {
      ...meta,
      rev: legacy ? 0 : src.rev,
      type: src.type,
      startedAt: src.startedAt,
      endedAt: src.endedAt === undefined ? null : src.endedAt,
      details: src.details && typeof src.details === 'object' ? src.details : {},
      loggedBy: src.loggedBy === undefined ? null : src.loggedBy,
    };
    if (legacy) entry.legacy = true;
  } else {
    entry = { ...meta, error: errorText(src && typeof src === 'object' ? src.error : src) };
  }
  if (isMap) map.set(row.eid, entry);
  else map[row.eid] = entry;
  return true;
}
