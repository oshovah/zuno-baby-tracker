// The compact spans on the home cards (ui.js): half hours from one hour on,
// so «15:00 · seit 3½ Std.» fits a half-width card on a narrow phone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fmtSpanShort,
  fmtInShort,
  fmtAgoShort,
  fmtAgoBareShort,
  bottleAmountLabel,
  bottleTotalMl,
  entrySummary,
  entryDetail,
  pausedFeed,
  pauseEndsMs,
  isFeedingNow,
  PAUSE_MAX_MIN,
  QUICK_FEED_LIVE_MIN,
} from '../ui.js';

const T = Date.parse('2026-09-01T10:00:00Z');
const at = (mins) => new Date(T + mins * 60000).toISOString();

test('fmtSpanShort: minutes under an hour, then the nearest half hour, days past 48 h', () => {
  assert.equal(fmtSpanShort(0), '0 Min.');
  assert.equal(fmtSpanShort(45), '45 Min.');
  assert.equal(fmtSpanShort(59), '59 Min.');
  assert.equal(fmtSpanShort(60), '1 Std.');
  assert.equal(fmtSpanShort(74), '1 Std.');
  assert.equal(fmtSpanShort(75), '1½ Std.');
  assert.equal(fmtSpanShort(104), '1½ Std.');
  assert.equal(fmtSpanShort(105), '2 Std.');
  assert.equal(fmtSpanShort(215), '3½ Std.');
  assert.equal(fmtSpanShort(230), '4 Std.');
  assert.equal(fmtSpanShort(48 * 60), '2 Tagen');
  assert.equal(fmtSpanShort(-5), '0 Min.');
});

test('fmtInShort / fmtAgoShort / fmtAgoBareShort: the compact span with the usual words around now', () => {
  assert.equal(fmtInShort(at(0.5), T), 'jetzt');
  assert.equal(fmtInShort(at(-10), T), 'jetzt');
  assert.equal(fmtInShort(at(12), T), 'in 12 Min.');
  assert.equal(fmtInShort(at(125), T), 'in 2 Std.');
  assert.equal(fmtInShort(at(215), T), 'in 3½ Std.');
  assert.equal(fmtAgoShort(at(-1), T), 'gerade eben');
  assert.equal(fmtAgoShort(at(-12), T), 'vor 12 Min.');
  assert.equal(fmtAgoShort(at(-70), T), 'vor 1 Std.');
  assert.equal(fmtAgoShort(at(-215), T), 'vor 3½ Std.');
  assert.equal(fmtAgoBareShort(at(-1), T), 'kurzem');
  assert.equal(fmtAgoBareShort(at(-12), T), '12 Min.');
  assert.equal(fmtAgoBareShort(at(-215), T), '3½ Std.');
});

test('bottle labels: Muttermilch first, the formula by name, the total on the Verlauf row and the composition below it', () => {
  assert.equal(bottleAmountLabel({ amount_ml: 70 }), '70 ml Formula');
  assert.equal(bottleAmountLabel({ colostrum_ml: 40 }), '40 ml Muttermilch');
  assert.equal(bottleAmountLabel({ amount_ml: 30, colostrum_ml: 40 }), '40 ml Muttermilch + 30 ml Formula');
  assert.equal(bottleAmountLabel({ amount_ml: 0, colostrum_ml: 40 }), '40 ml Muttermilch');
  assert.equal(bottleTotalMl({ amount_ml: 30, colostrum_ml: 40 }), 70);
  assert.equal(bottleTotalMl({ amount_ml: 90 }), 90);
  const both = { type: 'bottle', startedAt: at(0), endedAt: null, details: { amount_ml: 30, colostrum_ml: 40 } };
  assert.equal(entrySummary(both), 'Schoppen · 70 ml');
  assert.equal(entryDetail(both), '40 ml Muttermilch + 30 ml Formula');
  const milkOnly = { ...both, details: { amount_ml: 0, colostrum_ml: 40 } };
  assert.equal(entrySummary(milkOnly), 'Schoppen · 40 ml');
  assert.equal(entryDetail(milkOnly), 'Muttermilch');
  const formulaOnly = { ...both, details: { amount_ml: 90 } };
  assert.equal(entrySummary(formulaOnly), 'Schoppen · 90 ml');
  assert.equal(entryDetail(formulaOnly), 'Formula');
  assert.equal(entryDetail({ type: 'diaper', details: { kind: 'pee' } }), '');
  assert.equal(entryDetail(null), '');
});

test('pausedFeed / isFeedingNow: a side closed with «Pause» keeps the phone in feeding mode for PAUSE_MAX_MIN', () => {
  assert.equal(PAUSE_MAX_MIN, 20);
  const paused = (endMins, extra = {}) => ({
    openTimers: [],
    lastFeed: { type: 'breastfeed', startedAt: at(endMins - 8), endedAt: at(endMins), details: { side: 'L', paused: true }, ...extra },
  });
  assert.equal(pausedFeed(paused(-2), T).details.side, 'L');
  assert.equal(pausedFeed(paused(-20), T).details.side, 'L', 'at the limit it still counts');
  assert.equal(pausedFeed(paused(-20.1), T), null, 'past it the pause was the end');
  assert.equal(pauseEndsMs(paused(-2)), T + 18 * 60000);
  assert.equal(isFeedingNow(paused(-2), T), true);
  assert.equal(isFeedingNow(paused(-21), T), false);
  // The window is measured from the MEAL's last end when that is later than
  // the paused side's (a side entered afterwards that overlaps) — the same
  // window a «Weiter» has to join the meal.
  const mealLater = { ...paused(-19), lastMeal: { open: false, endedAt: at(-4), entries: [] } };
  assert.equal(pausedFeed(mealLater, T).details.side, 'L');
  assert.equal(pauseEndsMs(mealLater), T + 16 * 60000);
  const mealOpen = { ...paused(-2), lastMeal: { open: true, endedAt: at(-2), entries: [] } };
  assert.equal(pauseEndsMs(mealOpen), T + 18 * 60000, 'an open meal end is not an anchor');
  // A quick-logged row can carry no pause (its end is its start).
  assert.equal(pausedFeed({ openTimers: [], lastFeed: { type: 'breastfeed', startedAt: at(-2), endedAt: at(-2), details: { side: 'L', paused: true } } }, T), null);
  // Not paused: an ordinary closed side, a bottle, a running timer (the timer wins), no state.
  const closed = { openTimers: [], lastFeed: { type: 'breastfeed', startedAt: at(-10), endedAt: at(-2), details: { side: 'L' } } };
  assert.equal(pausedFeed(closed, T), null);
  assert.equal(isFeedingNow(closed, T), false);
  const bottle = { openTimers: [], lastFeed: { type: 'bottle', startedAt: at(-2), endedAt: null, details: { amount_ml: 60, paused: true } } };
  assert.equal(pausedFeed(bottle, T), null);
  const running = { ...paused(-2), openTimers: [{ type: 'breastfeed', startedAt: at(-1), endedAt: null, details: { side: 'R' } }] };
  assert.equal(pausedFeed(running, T), null);
  assert.equal(isFeedingNow(running, T), true);
  assert.equal(pausedFeed(null, T), null);
  // A quick-logged feed (Ende == Start) is live for QUICK_FEED_LIVE_MIN, paused or not.
  const quick = { openTimers: [], lastFeed: { type: 'breastfeed', startedAt: at(-10), endedAt: at(-10), details: { side: 'L' } } };
  assert.equal(isFeedingNow(quick, T), true);
  assert.equal(isFeedingNow(quick, T + (QUICK_FEED_LIVE_MIN + 1) * 60000), false);
});
