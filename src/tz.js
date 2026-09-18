// Europe/Zurich calendar days — the port of bt_day_window_utc /
// bt_local_date_of / bt_seconds_between from api/lib/entries.php. "Today" on
// the home screen and the history range are Zurich days no matter where the
// phone is, exactly as the server computed them before E2EE.
//
// Built on Intl.DateTimeFormat (DST-safe, no tz table shipped): the wall
// clock of an instant comes from formatToParts; local midnight is found by
// probing the UTC offset at a guess and correcting once when the probe
// straddles a DST switch (midnight itself is never inside a switch, they
// happen at 02:00/03:00 local).
//
// Pure module: no DOM, no IndexedDB, no imports — runs under `node --test`.

export const TZ = 'Europe/Zurich';

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const pad = (n, width = 2) => String(n).padStart(width, '0');

/** Canonical UTC ISO of a millisecond timestamp. */
function isoFromMs(ms) {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

/** Zurich wall clock of an instant as {year, month, day, hour, minute, second}. */
function wallClock(ms) {
  const out = {};
  for (const { type, value } of fmt.formatToParts(new Date(ms))) {
    if (type !== 'literal') out[type] = Number(value);
  }
  // Engines without hourCycle support print midnight as "24".
  out.hour %= 24;
  return out;
}

/** The wall clock of an instant re-read as if it were UTC (ms). */
function wallClockAsUtcMs(ms) {
  const w = wallClock(ms);
  const d = new Date(0);
  d.setUTCFullYear(w.year, w.month - 1, w.day);
  d.setUTCHours(w.hour, w.minute, w.second, 0);
  return d.getTime();
}

/** UTC offset of Zurich at an instant, in ms (+7200000 in summer). */
function offsetMs(ms) {
  return wallClockAsUtcMs(ms) - ms;
}

/**
 * UTC instant (ms) of the Zurich wall-clock time y-m-d hh:mm. Midnight is
 * never inside a DST switch; for other times the fall-back hour (02:00–03:00
 * happens twice) resolves to the first pass and the spring-forward gap
 * (02:00–03:00 does not exist) to the instant that hour would have been —
 * both once a year, both good enough for a reminder.
 */
function wallToUtcMs(y, m, d, hh = 0, mm = 0) {
  const guess = new Date(0);
  guess.setUTCFullYear(y, m - 1, d); // d may overflow (next day's window)
  guess.setUTCHours(hh, mm, 0, 0);
  const wall = guess.getTime();
  let t = wall - offsetMs(wall);
  if (wallClockAsUtcMs(t) !== wall) {
    // The offset changed between the guess and the real instant (DST
    // switch on that day): re-probe at the candidate, which is on the
    // right side of the switch.
    t = wall - offsetMs(t);
  }
  return t;
}

/** UTC instant (ms) of Zurich midnight starting the local date y-m-d. */
function localMidnightUtcMs(y, m, d) {
  return wallToUtcMs(y, m, d);
}

/** The Europe/Zurich calendar date ("YYYY-MM-DD") of a UTC ISO instant. */
export function zurichDateOf(iso) {
  const w = wallClock(Date.parse(iso));
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
}

/**
 * [startUtcIso, endUtcIso) of one Europe/Zurich calendar day "YYYY-MM-DD".
 * DST days come out 23 or 25 hours long, as with PHP's DateTimeZone.
 */
export function zurichDayWindowUtc(localDate) {
  const [y, m, d] = String(localDate).split('-').map(Number);
  return [isoFromMs(localMidnightUtcMs(y, m, d)), isoFromMs(localMidnightUtcMs(y, m, d + 1))];
}

/**
 * The UTC instant of a Zurich wall-clock time "HH:MM" on the local date
 * "YYYY-MM-DD" — a reminder's due instant, the same on both phones.
 */
export function zurichTimeUtc(localDate, time) {
  const [y, m, d] = String(localDate).split('-').map(Number);
  const [hh, mm] = String(time).split(':').map(Number);
  return isoFromMs(wallToUtcMs(y, m, d, hh, mm));
}

/** The local date "YYYY-MM-DD" shifted by n days (Zurich calendar, DST-safe). */
export function shiftZurichDate(localDate, days) {
  const [y, m, d] = String(localDate).split('-').map(Number);
  // Noon of the shifted day never lands in a DST switch — its date is exact.
  return zurichDateOf(isoFromMs(wallToUtcMs(y, m, d + days, 12, 0)));
}

/** Whole seconds between two ISO instants (positive when toIso is later). */
export function secondsBetween(fromIso, toIso) {
  return Math.trunc((Date.parse(toIso) - Date.parse(fromIso)) / 1000);
}
