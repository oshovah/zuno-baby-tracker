// Entry validation: the details per type, canonical instants, local dates,
// "not in the future", the field rules of a create and the merge rules of an
// update. With end-to-end encryption the server never sees an entry, so the
// phone is the only validator — of its own input and of what the other
// phone wrote.
//
// Every failure throws a plain Error with its text in the active language
// (errors.validate.* — the UI toasts err.message verbatim) and an HTTP-like
// err.status (400, 409), the shape api.js gives a server error, so callers
// handle both alike.
//
// Pure module: no DOM, no IndexedDB, imports only the translations — runs
// under `node --test`.

import { t } from './i18n/index.js';

// The events of the day — what Verlauf lists and Nachtragen creates. `task`
// is a ticked-off reminder («Erledigt»: Vitamin D given, Mama took her
// pill) — or any chore logged after the fact.
export const EVENT_TYPES = ['breastfeed', 'bottle', 'diaper', 'sleep', 'weight', 'temperature', 'medication', 'task'];
// … plus the family's settings document: ONE entry of type `settings` per
// family (the live one with the highest seq counts), synced and encrypted
// like every row — the server never learns a preference either. Its
// startedAt is the time of the last change, loggedBy who made it.
export const SETTINGS_TYPE = 'settings';
// … and the family's reminders («Erinnerungen»): one entry of type
// `reminder` per daily schedule (what, for whom, at which times of day),
// startedAt = last change like the settings document. Not an event: the
// home screen expands them into today's to-dos (reminders.js) and a tick
// becomes a `task` entry that references the reminder and its due instant.
export const REMINDER_TYPE = 'reminder';
export const TYPES = [...EVENT_TYPES, SETTINGS_TYPE, REMINDER_TYPE];
export const TIMER_TYPES = ['breastfeed', 'sleep'];
export const FEED_TYPES = ['breastfeed', 'bottle'];

// Getters: each label is the translation of the moment it is read.
export const TYPE_LABELS = {
  get breastfeed() { return t('common.type.breastfeed'); },
  get bottle() { return t('common.type.bottle'); },
  get diaper() { return t('common.type.diaper'); },
  get sleep() { return t('common.type.sleep'); },
  get weight() { return t('common.type.weight'); },
  get temperature() { return t('common.type.temperature'); },
  get medication() { return t('common.type.medication'); },
  get task() { return t('common.type.task'); },
  get settings() { return t('common.type.settings'); },
  get reminder() { return t('common.type.reminder'); },
};

// Whom a reminder (and the task ticking it off) is for: the baby by default —
// medication for a parent is the other everyday case.
export const WHO_VALUES = ['baby', 'mama', 'papa'];
// The daily times of a reminder, "HH:MM" on the 24-hour clock (Europe/Zurich
// wall clock, like the day windows — so both phones agree when 18:00 is).
export const REMINDER_MAX_TIMES = 12;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isEventType(type) {
  return EVENT_TYPES.includes(type);
}

// Client clocks drift; anything further ahead than this is a typo, not skew.
export const FUTURE_GRACE_SECONDS = 600;

export function isTimerType(type) {
  return TIMER_TYPES.includes(type);
}

/** Error with a text and an HTTP-like status (see the file header). */
function fail(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** The 409 text for a second open timer of one type. */
export function timerRunningMessage(type) {
  return t('errors.validate.timerRunning', { type: TYPE_LABELS[type] || type });
}

const pad = (n, width = 2) => String(n).padStart(width, '0');

/** Canonical UTC ISO ("2026-09-01T14:30:00Z") of a millisecond timestamp. */
export function isoFromMs(ms) {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Validate an ISO 8601 datetime (seconds/ms optional, Z or offset required)
 * and canonicalize to UTC "YYYY-MM-DDTHH:MM:SSZ". Parsed by hand instead of
 * Date.parse so every engine accepts the same inputs PHP did ("+0200"
 * offsets, day/hour rollover such as "24:00" or Feb 31, fractional seconds
 * truncated).
 */
export function canonDatetime(value, name) {
  const m = typeof value === 'string' ? ISO_RE.exec(value) : null;
  if (!m) {
    throw fail(t('errors.validate.datetimeFormat', { name }));
  }
  const [year, month, day, hour, minute] = m.slice(1, 6).map(Number);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  // PHP's parser rejects these outright and rolls everything else over
  // (month/day 00 = the previous one, hour 24, second 60, Feb 31).
  if (month > 12 || day > 31 || hour > 24 || minute > 59 || second > 60) {
    throw fail(t('errors.validate.datetimeInvalid', { name }));
  }
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day); // year 0000 stays 0000 (Date.UTC would map it to 1900)
  d.setUTCHours(hour, minute, second, 0);
  let ms = d.getTime();
  if (m[7] !== 'Z') {
    const sign = m[7][0] === '-' ? -1 : 1;
    const digits = m[7].slice(1).replace(':', '');
    const offsetMin = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4));
    ms -= sign * offsetMin * 60000;
  }
  // Rollover out of the 4-digit year range would not be canonical any more.
  if (!Number.isFinite(ms) || ms < -62167219200000 || ms >= 253402300800000) {
    throw fail(t('errors.validate.datetimeInvalid', { name }));
  }
  return isoFromMs(ms);
}

/** Validate a local calendar date "YYYY-MM-DD" (PHP checkdate semantics). */
export function validLocalDate(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw fail(t('errors.validate.dateFormat', { name }));
  }
  const [y, m, d] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(2000, m - 1, d));
  probe.setUTCFullYear(y, m - 1, d);
  if (y < 1 || m < 1 || m > 12 || d < 1 || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw fail(t('errors.validate.dateInvalid', { name }));
  }
  return value;
}

/** Seconds between two ISO instants (positive when toIso is later). */
function secondsBetween(fromIso, toIso) {
  return Math.trunc((Date.parse(toIso) - Date.parse(fromIso)) / 1000);
}

/**
 * Reject instants beyond the clock-skew grace: a future entry would be
 * invisible in the history range (which ends today) yet win every "last
 * entry" query — wrong on the home screen with no way to fix it.
 */
export function assertNotFuture(iso, nowIso) {
  if (secondsBetween(nowIso, iso) > FUTURE_GRACE_SECONDS) {
    throw fail(t('errors.validate.future'));
  }
}

const isObject = (v) => typeof v === 'object' && v !== null;
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const EID_RE = /^[0-9a-f]{32}$/;

/** PHP trim(): strips " \t\n\r\0\x0B" only (not NBSP etc.). */
const phpTrim = (s) => s.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');

/**
 * PHP round($c, 1): the decimal the user typed decides, so 36.65 -> 36.7
 * even though the double is 36.649999… (PHP pre-rounds to 15 significant
 * digits before the half-up step).
 */
const round1 = (c) => Math.round(Number((c * 10).toPrecision(15))) / 10;

/** The title of a reminder or task: non-empty after trimming, ≤ 100 chars. */
function validTitle(title) {
  if (typeof title !== 'string' || phpTrim(title) === '' || [...phpTrim(title)].length > 100) {
    throw fail(t('errors.validate.title'));
  }
  return phpTrim(title);
}

/** For whom: absent = the baby. */
function validWho(who) {
  if (who === undefined || who === null) return 'baby';
  if (!WHO_VALUES.includes(who)) {
    throw fail(t('errors.validate.who'));
  }
  return who;
}

/** Validate + canonicalize the details object for one type. */
export function validDetails(type, details) {
  if (details === null || details === undefined) {
    details = {};
  }
  if (!isObject(details)) {
    throw fail(t('errors.validate.detailsObject'));
  }
  switch (type) {
    case 'breastfeed': {
      const side = details.side ?? null;
      if (side !== 'L' && side !== 'R') {
        throw fail(t('errors.validate.side'));
      }
      // «Pause» on the live hero closes the side and marks it: the parent
      // means to go on with the same side (ui.pausedFeed shows «Weiter» for
      // a while). Only `true` is kept; anything else means an ordinary end.
      return details.paused === true ? { side, paused: true } : { side };
    }
    case 'bottle': {
      // Formula (`amount_ml`) and breast milk (`colostrum_ml`, historical
      // key) are tracked separately; at least one of the two must be given.
      // Older entries only know amount_ml.
      const ml = details.amount_ml ?? 0;
      const col = details.colostrum_ml ?? 0;
      if (!isInt(ml) || ml < 0 || ml > 1000) {
        throw fail(t('errors.validate.formulaMl'));
      }
      if (!isInt(col) || col < 0 || col > 1000) {
        throw fail(t('errors.validate.breastMilkMl'));
      }
      if (ml + col < 1) {
        throw fail(t('errors.validate.bottleEmpty'));
      }
      const out = { amount_ml: ml };
      if (col > 0) {
        out.colostrum_ml = col;
      }
      return out;
    }
    case 'diaper': {
      const kind = details.kind ?? null;
      if (!['pee', 'poop', 'both'].includes(kind)) {
        throw fail(t('errors.validate.diaperKind'));
      }
      return { kind };
    }
    case 'sleep':
      return {};
    case 'weight': {
      const g = details.grams ?? null;
      if (!isInt(g) || g < 300 || g > 30000) {
        throw fail(t('errors.validate.grams'));
      }
      return { grams: g };
    }
    case 'temperature': {
      const c = details.celsius ?? null;
      if (typeof c !== 'number' || !Number.isFinite(c) || c < 30 || c > 45) {
        throw fail(t('errors.validate.celsius'));
      }
      return { celsius: round1(c) };
    }
    case 'medication': {
      const name = details.name ?? null;
      if (typeof name !== 'string' || phpTrim(name) === '' || [...phpTrim(name)].length > 100) {
        throw fail(t('errors.validate.medicationName'));
      }
      return { name: phpTrim(name) };
    }
    case 'task': {
      // A tick: what was done and for whom. When it ticks off a reminder it
      // names the reminder and the due instant it stands for, so both
      // phones mark the same slot (reminders.js) — a task logged by hand
      // under Nachtragen carries neither.
      const out = { title: validTitle(details.title), who: validWho(details.who) };
      if (details.reminderEid !== undefined && details.reminderEid !== null) {
        if (typeof details.reminderEid !== 'string' || !EID_RE.test(details.reminderEid)) {
          throw fail(t('errors.validate.reminderEid'));
        }
        out.reminderEid = details.reminderEid;
      }
      if (details.due !== undefined && details.due !== null) {
        out.due = canonDatetime(details.due, 'details.due');
      }
      return out;
    }
    case REMINDER_TYPE: {
      // A schedule: title («Vitamin D»), for whom, an optional note (the
      // dose: «2 Tropfen»), one to twelve times of day — sorted and unique,
      // so two phones render the same list — daily or every N days.
      const out = { title: validTitle(details.title), who: validWho(details.who) };
      if (details.note !== undefined && details.note !== null) {
        if (typeof details.note !== 'string' || [...phpTrim(details.note)].length > 100) {
          throw fail(t('errors.validate.note'));
        }
        if (phpTrim(details.note) !== '') out.note = phpTrim(details.note);
      }
      const times = details.times;
      if (!Array.isArray(times) || times.length < 1 || !times.every((x) => typeof x === 'string' && TIME_RE.test(x))) {
        throw fail(t('errors.validate.times'));
      }
      out.times = [...new Set(times)].sort();
      if (out.times.length > REMINDER_MAX_TIMES) {
        throw fail(t('errors.validate.timesMax', { max: REMINDER_MAX_TIMES }));
      }
      // Every N days instead of daily (reminders.reminderDueOn): 1 or absent
      // = daily and is not stored; the first day it counts from.
      if (details.everyDays !== undefined && details.everyDays !== null) {
        const n = details.everyDays;
        if (!isInt(n) || n < 1 || n > 365) throw fail(t('errors.validate.everyDays'));
        if (n > 1) out.everyDays = n;
      }
      if (details.startDate !== undefined && details.startDate !== null) {
        if (typeof details.startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(details.startDate)) {
          throw fail(t('errors.validate.startDate'));
        }
        try {
          validLocalDate(details.startDate, 'details.startDate');
        } catch {
          throw fail(t('errors.validate.dateInvalid', { name: 'details.startDate' }));
        }
        out.startDate = details.startDate;
      }
      return out;
    }
    case SETTINGS_TYPE: {
      // The family settings document. Every field is optional (a save
      // carries only what changed; absent = not set for the family yet).
      // Unknown keys are kept untouched: a phone on an older shell must not
      // drop a setting a newer shell added when it saves its own.
      const out = { ...details };
      if (details.feedFromStart !== undefined && typeof details.feedFromStart !== 'boolean') {
        throw fail(t('errors.validate.feedFromStart'));
      }
      if (details.recommendedMl !== undefined) {
        const ml = details.recommendedMl;
        if (ml !== null && (!isInt(ml) || ml < 1 || ml > 1000)) {
          throw fail(t('errors.validate.recommendedMl'));
        }
      }
      // The Schoppen form's quick picks: three for Muttermilch
      // (`bottlePresets`, the historical name) and three for the formula.
      for (const key of ['bottlePresets', 'formulaPresets']) {
        if (details[key] === undefined) continue;
        const p = details[key];
        if (!Array.isArray(p) || p.length !== 3 || !p.every((n) => isInt(n) && n >= 1 && n <= 1000)) {
          throw fail(t('errors.validate.presets', { key }));
        }
        out[key] = [...p];
      }
      // The drinking target (dose.js): the baby's birth date and the meals a
      // day the rule shares the amount by. Null clears either.
      if (details.birthDate !== undefined && details.birthDate !== null) {
        if (typeof details.birthDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(details.birthDate)) {
          throw fail(t('errors.validate.birthDateFormat'));
        }
        try {
          validLocalDate(details.birthDate, 'details.birthDate');
        } catch {
          throw fail(t('errors.validate.dateInvalid', { name: 'details.birthDate' }));
        }
      }
      if (details.mealsPerDay !== undefined && details.mealsPerDay !== null) {
        const n = details.mealsPerDay;
        if (!isInt(n) || n < 1 || n > 12) {
          throw fail(t('errors.validate.mealsPerDay'));
        }
      }
      // «Stillen» on/off for the family, and the estimate of what one
      // nursing session gives (dose.supplementFor). Null clears the estimate.
      if (details.breastfeeding !== undefined && typeof details.breastfeeding !== 'boolean') {
        throw fail(t('errors.validate.breastfeeding'));
      }
      if (details.nursingMl !== undefined && details.nursingMl !== null) {
        const ml = details.nursingMl;
        if (!isInt(ml) || ml < 1 || ml > 1000) {
          throw fail(t('errors.validate.nursingMl'));
        }
      }
      return out;
    }
    default:
      throw fail(t('errors.validate.unknownType'));
  }
}

/** Wall-clock now as canonical ISO (callers normally pass a skew-corrected now). */
const wallClockIso = () => isoFromMs(Date.now());

/**
 * Field rules of bt_create_entry for { type, startedAt?, endedAt?, details? }:
 * startedAt defaults to now; timer types without endedAt become open timers.
 * Returns the canonical { type, startedAt, endedAt, details }. The
 * one-open-timer rule is not checked here (see model.openTimer).
 */
export function validateCreate(input, nowIso) {
  const now = nowIso ?? wallClockIso();
  const body = isObject(input) ? input : {};

  const type = body.type ?? null;
  if (typeof type !== 'string' || !TYPES.includes(type)) {
    throw fail(t('errors.validate.type'));
  }

  let startedAt = now;
  if (body.startedAt !== undefined && body.startedAt !== null) {
    startedAt = canonDatetime(body.startedAt, 'startedAt');
    assertNotFuture(startedAt, now);
  }

  let endedAt = null;
  if (body.endedAt !== undefined && body.endedAt !== null) {
    if (!isTimerType(type)) {
      throw fail(t('errors.validate.noEnd'));
    }
    endedAt = canonDatetime(body.endedAt, 'endedAt');
    assertNotFuture(endedAt, now);
    if (endedAt < startedAt) {
      throw fail(t('errors.validate.endBeforeStart'));
    }
  }

  const details = pauseInvariant(validDetails(type, body.details ?? null), startedAt, endedAt);

  return { type, startedAt, endedAt, details };
}

/**
 * A Stillen side's pause mark (`details.paused`, set by the hero's «Pause»)
 * only means something on a CLOSED row with a duration: an open timer is
 * running, not paused, and a row whose end equals its start is a quick log
 * («läuft») — the mark is dropped on both, whoever sends it (a reopened
 * timer must not come back paused). Everything else passes untouched.
 */
function pauseInvariant(details, startedAt, endedAt) {
  if (!details || details.paused !== true) return details;
  if (endedAt === null || endedAt === startedAt) {
    const { paused, ...rest } = details;
    return rest;
  }
  return details;
}

/**
 * Merge rules of bt_update_entry: patch { startedAt?, endedAt?, details?,
 * ifOpen? } onto an existing entry. endedAt: a value closes a timer, explicit
 * null reopens it (timer types only). The type is immutable. `ifOpen: true`
 * (the stop buttons) 409s when the entry is already closed. Returns the merged
 * { type, startedAt, endedAt, details }; loggedBy is never re-authored (not
 * part of the result at all).
 */
export function validateUpdate(existing, patch, nowIso) {
  const now = nowIso ?? wallClockIso();
  const body = isObject(patch) ? patch : {};
  const type = existing.type;

  if (body.type !== undefined && body.type !== type) {
    throw fail(t('errors.validate.typeImmutable'));
  }

  if (body.ifOpen && existing.endedAt !== null && existing.endedAt !== undefined) {
    throw fail(t('errors.validate.timerAlreadyEnded'), 409);
  }

  let startedAt = existing.startedAt;
  if (body.startedAt !== undefined) {
    if (body.startedAt === null) {
      throw fail(t('errors.validate.startEmpty'));
    }
    startedAt = canonDatetime(body.startedAt, 'startedAt');
    assertNotFuture(startedAt, now);
  }

  let endedAt = existing.endedAt === undefined ? null : existing.endedAt;
  if (body.endedAt !== undefined) {
    if (body.endedAt === null) {
      endedAt = null;
    } else {
      if (!isTimerType(type)) {
        throw fail(t('errors.validate.noEnd'));
      }
      endedAt = canonDatetime(body.endedAt, 'endedAt');
      assertNotFuture(endedAt, now);
    }
  }
  if (endedAt !== null && endedAt < startedAt) {
    throw fail(t('errors.validate.endBeforeStart'));
  }

  let details = isObject(existing.details) ? existing.details : {};
  if (body.details !== undefined) {
    details = validDetails(type, body.details);
  }
  details = pauseInvariant(details, startedAt, endedAt);

  return { type, startedAt, endedAt, details };
}

const isCanonIso = (v) => {
  try {
    return typeof v === 'string' && canonDatetime(v, 'x') === v;
  } catch {
    return false;
  }
};

/**
 * Shape check for a DECRYPTED entry from another device (or a tampering
 * server): type known, canonical ISO instants, details valid for the type,
 * loggedBy string|null, rev integer >= 1, eid 32 hex. Returns the object
 * untouched; throws Error('Ungültiger Datensatz') on any problem — the caller
 * keeps such rows as {eid, error} and skips them everywhere.
 */
export function validatePlain(obj) {
  if (!isPlainShape(obj)) {
    throw fail(t('errors.validate.invalidRecord'));
  }
  return obj;
}

function isPlainShape(obj) {
  if (!isObject(obj)) return false;
  if (typeof obj.type !== 'string' || !TYPES.includes(obj.type)) return false;
  if (!isCanonIso(obj.startedAt)) return false;
  if (obj.endedAt !== null && !isCanonIso(obj.endedAt)) return false;
  if (obj.loggedBy !== null && typeof obj.loggedBy !== 'string') return false;
  if (!isInt(obj.rev) || obj.rev < 1) return false;
  if (typeof obj.eid !== 'string' || !EID_RE.test(obj.eid)) return false;
  try {
    validDetails(obj.type, obj.details);
  } catch {
    return false;
  }
  return true;
}
