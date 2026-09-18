// The shared layer in English: the label tables (getters), the time words
// and a validation message follow setLocale() — node runs in German by
// default, so this file switches to 'en' and back.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setLocale, getLocale } from '../i18n/index.js';
import {
  TYPE_META,
  DIAPER_KINDS,
  SIDE_LABELS,
  fmtDayHeading,
  localToday,
  shiftDate,
  fmtDurationMin,
  fmtSpanShort,
  fmtInShort,
  fmtAgoShort,
  fmtAgoBareShort,
  agoParts,
  fmtGrams,
  bottleAmountLabel,
  entryDetail,
  entrySummary,
} from '../ui.js';
import { mealSummary, mealClockRange, sinceLabel, mealPartsLabel, liveSideInMeal } from '../meals.js';
import { WHO_LABELS, whoLabel, reminderScheduleLabel } from '../reminders.js';
import { TYPE_LABELS, timerRunningMessage, validDetails, validateCreate, validatePlain } from '../validate.js';
import { listRange } from '../model.js';

const T = Date.parse('2026-09-01T10:00:00Z');
const at = (mins) => new Date(T + mins * 60000).toISOString();

after(() => setLocale('de'));

test('the label tables answer in English after setLocale("en") and in German again after the switch back', () => {
  setLocale('en');
  assert.equal(getLocale(), 'en');
  assert.equal(TYPE_META.bottle.label, 'Bottle');
  assert.equal(TYPE_META.breastfeed.label, 'Nursing');
  assert.equal(TYPE_META.task.label, 'Done');
  assert.equal(DIAPER_KINDS.poop.label, 'Poo');
  assert.deepEqual({ ...SIDE_LABELS }, { L: 'left', R: 'right' });
  assert.deepEqual({ ...WHO_LABELS }, { baby: 'Baby', mama: 'Mom', papa: 'Dad' });
  assert.equal(whoLabel('nobody'), 'Baby');
  assert.deepEqual(Object.entries(WHO_LABELS).map(([, v]) => v), ['Baby', 'Mom', 'Dad']);
  assert.equal(TYPE_LABELS.settings, 'Settings');
  assert.equal(TYPE_LABELS.sleep, 'Sleep');
  setLocale('de');
  assert.equal(TYPE_META.bottle.label, 'Schoppen');
  assert.equal(WHO_LABELS.mama, 'Mama');
  assert.equal(TYPE_LABELS.settings, 'Einstellungen');
});

test('day headings and the time words read in English', () => {
  setLocale('en');
  assert.equal(fmtDayHeading(localToday()), 'Today');
  assert.equal(fmtDayHeading(shiftDate(localToday(), -1)), 'Yesterday');
  assert.equal(fmtDurationMin(25), '25 min');
  assert.equal(fmtDurationMin(95), '1 h 35 min');
  assert.equal(fmtDurationMin(120), '2 h');
  assert.equal(fmtSpanShort(75), '1½ h');
  assert.equal(fmtSpanShort(48 * 60), '2 days');
  assert.equal(fmtInShort(at(0.5), T), 'now');
  assert.equal(fmtInShort(at(12), T), 'in 12 min');
  assert.equal(fmtAgoShort(at(-1), T), 'just now');
  assert.equal(fmtAgoShort(at(-12), T), '12 min ago');
  assert.equal(fmtAgoShort(at(-215), T), '3½ h ago');
  assert.equal(fmtAgoBareShort(at(-1), T), 'a moment');
  assert.equal(fmtAgoBareShort(at(-12), T), '12 min');
  assert.deepEqual(agoParts(at(-161), T), [{ v: 2, u: 'h' }, { v: 41, u: 'min' }]);
  assert.deepEqual(agoParts(at(-3 * 1440), T), [{ v: 3, u: 'days' }]);
  assert.equal(fmtGrams(3450), '3.45 kg');
  assert.equal(fmtGrams(980), '980 g');
});

test('entry, bottle and meal summaries read in English', () => {
  setLocale('en');
  assert.equal(bottleAmountLabel({ amount_ml: 30, colostrum_ml: 40 }), '40 ml breast milk + 30 ml formula');
  const bottle = { type: 'bottle', startedAt: at(0), endedAt: null, details: { amount_ml: 0, colostrum_ml: 40 } };
  assert.equal(entrySummary(bottle), 'Bottle · 40 ml');
  assert.equal(entryDetail(bottle), 'Breast milk');
  const feed = { type: 'breastfeed', startedAt: at(-20), endedAt: at(0), details: { side: 'L' } };
  assert.equal(entrySummary(feed), 'Nursing left · 20 min');
  assert.equal(entrySummary({ ...feed, endedAt: null }), 'Nursing left · running');
  assert.equal(entrySummary({ type: 'diaper', startedAt: at(0), details: { kind: 'both' } }), 'Diaper · Both');
  assert.equal(entrySummary({ type: 'temperature', startedAt: at(0), details: { celsius: 37.2 } }), 'Temperature · 37.2 °C');
  assert.equal(entrySummary({ type: 'task', startedAt: at(0), details: { title: 'Ibuprofen', who: 'mama' } }), 'Done · Ibuprofen · for Mom');
  const meal = {
    open: false,
    partial: false,
    minutes: 20,
    startedAt: at(-30),
    endedAt: at(-10),
    entries: [
      { eid: 'a', type: 'breastfeed', startedAt: at(-30), endedAt: at(-18), details: { side: 'L' } },
      { eid: 'b', type: 'breastfeed', startedAt: at(-18), endedAt: at(-10), details: { side: 'R' } },
      { eid: 'c', type: 'bottle', startedAt: at(-10), endedAt: at(-10), details: { amount_ml: 30 } },
    ],
    sideMinutes: { L: 12, R: 8 },
    bottleMl: 30,
    bottleColostrumMl: 0,
  };
  assert.equal(mealSummary(meal), 'Meal · 20 min');
  assert.equal(mealSummary({ ...meal, open: true }), 'Meal · running');
  assert.equal(mealPartsLabel(meal), 'Left 12 · Right 8 · Bottle 30 ml');
  assert.equal(liveSideInMeal(meal, 'b').label, ' · 2nd side');
  assert.match(mealClockRange({ ...meal, open: true }), /^since \d\d:\d\d$/);
  assert.equal(sinceLabel(false), 'Since last meal');
  assert.equal(sinceLabel(true), 'Since last meal began');
  assert.equal(reminderScheduleLabel({ who: 'papa', times: ['08:00', '18:00'] }), 'Dad · 08:00 · 18:00');
});

test('validation messages follow the language too', () => {
  setLocale('en');
  assert.equal(timerRunningMessage('sleep'), 'A Sleep timer is already running');
  assert.throws(() => validDetails('bottle', {}), { message: 'Please enter an amount – breast milk or formula' });
  assert.throws(() => validateCreate({ type: 'nap' }), { message: '"type" must be one of the known entry types' });
  assert.throws(() => validateCreate({ type: 'diaper', startedAt: 'nope', details: { kind: 'pee' } }), {
    message: '"startedAt" must be an ISO 8601 date-time with a time zone',
  });
  assert.throws(() => validatePlain(null), { message: 'Invalid record' });
  assert.throws(() => listRange(new Map(), '2026-09-02', '2026-09-01'), { message: '"to" is before "from"' });
  setLocale('de');
  assert.equal(timerRunningMessage('sleep'), 'Es läuft bereits ein Schlaf-Timer');
  assert.throws(() => validatePlain(null), { message: 'Ungültiger Datensatz' });
});
