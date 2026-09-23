// The figures behind «Verlauf › Grafik» (src/charts.js draws them): per-day
// counts and sums for a run of days, and the measurement series (weight,
// temperature). Pure — over the store's live entries (an array), the days
// grouped like the Verlauf groups its rows (device-local dates), node-tested
// in tests/stats.test.mjs.

import { historyItems, dayCounts } from './meals.js';
import { localDateOf, shiftDate, nowMs } from './ui.js';
import { isoFromMs } from './validate.js';

/** `n` local dates ending on `last`, oldest first. */
export function lastDays(last, n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(shiftDate(last, -i));
  return out;
}

const emptyDay = (day) => ({
  day,
  meals: 0,
  wet: 0,
  soiled: 0,
  sleepMin: 0,
  nursingMin: { L: 0, R: 0 },
  bottleMl: { breast: 0, formula: 0 },
});

/**
 * Per-day figures for `days` (local dates, oldest first):
 *   meals        meals begun that day (meals.dayCounts — the day chips' and
 *                the «Heute» card's number)
 *   wet, soiled  diapers, a «Beides» counting for both
 *   sleepMin     sleep clipped to the day (an open sleep runs until now)
 *   nursingMin   {L, R}: closed Stillen sides by their start, the minutes
 *                as the Verlauf row shows them
 *   bottleMl     {breast, formula}: what the day's bottles held
 */
export function dailyStats(entries, days, nowIso = isoFromMs(nowMs())) {
  if (!days.length) return [];
  const byDay = new Map(days.map((d) => [d, emptyDay(d)]));
  const { items } = historyItems(entries, days[0], nowIso);
  const grouped = new Map();
  for (const it of items) {
    const d = localDateOf(it.startedAt);
    if (!grouped.has(d)) grouped.set(d, []);
    grouped.get(d).push(it);
  }
  const now = Date.parse(nowIso);
  for (const [d, row] of byDay) {
    const c = dayCounts(grouped.get(d) || [], d, entries, now);
    row.meals = c.meals;
    row.wet = c.wet;
    row.soiled = c.soiled;
    row.sleepMin = c.sleepMinutes;
  }
  for (const e of entries) {
    if (e.deletedAt != null || e.error) continue;
    const row = byDay.get(localDateOf(e.startedAt));
    if (!row) continue;
    if (e.type === 'breastfeed') {
      const side = (e.details || {}).side;
      if ((side === 'L' || side === 'R') && e.endedAt && e.endedAt !== e.startedAt) {
        row.nursingMin[side] += Math.max(0, Math.round((Date.parse(e.endedAt) - Date.parse(e.startedAt)) / 60000));
      }
    } else if (e.type === 'bottle') {
      const d = e.details || {};
      row.bottleMl.breast += Number(d.colostrum_ml) || 0;
      row.bottleMl.formula += Number(d.amount_ml) || 0;
    }
  }
  return days.map((d) => byDay.get(d));
}

/**
 * The average of a figure per day over `rows` (dailyStats): only the days
 * that have it (the days before the app was in use would drag a 28-day
 * average down to nothing) and never `skipDay` — today, which is not over
 * yet. Rounded to `digits`; null when no day counts.
 */
export function avgPerDay(rows, pick, skipDay = null, digits = 1) {
  const vals = rows.filter((r) => r.day !== skipDay).map(pick).filter((v) => v > 0);
  if (!vals.length) return null;
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  return Math.round(mean * 10 ** digits) / 10 ** digits;
}

const MEASURE_KEY = { weight: 'grams', temperature: 'celsius' };

/** The points of a measurement type, oldest first: [{ t: startedAt, ms, v }]
 *  — weight in grams, temperature in °C. Rows without a number are skipped. */
export function measurementSeries(entries, type) {
  const key = MEASURE_KEY[type];
  if (!key) return [];
  return entries
    .filter((e) => e.type === type && e.deletedAt == null && !e.error && e.details && Number.isFinite(Number(e.details[key])))
    .map((e) => ({ t: e.startedAt, ms: Date.parse(e.startedAt), v: Number(e.details[key]) }))
    .sort((a, b) => a.ms - b.ms || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
}
