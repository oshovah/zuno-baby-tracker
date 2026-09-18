// reminders.js: schedules expanded into a day's to-dos, ticks matched to
// their slots, the home card's answer and its time-driven flips. Same NOW as
// the model tests (2026-09-01T10:00:00Z = 12:00 Zurich, CEST).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WHO_LABELS,
  whoLabel,
  OVERDUE_AFTER_MIN,
  reminderOf,
  sortReminders,
  reminderScheduleLabel,
  occurrencesFor,
  todoStatus,
  nextTodo,
  todoFlipAt,
  todoProgress,
  overdueCount,
  reminderDueOn,
  intervalLabel,
} from '../reminders.js';

const NOW = '2026-09-01T10:00:00Z';
const NOW_MS = Date.parse(NOW);
const DAY = '2026-09-01';
const eidOf = (n) => n.toString(16).padStart(32, '0');

const reminder = (n, details, extra = {}) =>
  reminderOf({ eid: eidOf(n), seq: n, startedAt: '2026-09-01T05:00:00Z', loggedBy: 'Mama', details, ...extra });

let seq = 100;
/** A task entry ticking `r` for the slot due at `due`, done at `at`. */
const tick = (r, due, at, extra = {}) => ({
  eid: eidOf(++seq),
  seq,
  type: 'task',
  startedAt: at,
  endedAt: null,
  loggedBy: 'Papa',
  details: { title: r.title, who: r.who, reminderEid: r.eid, due },
  ...extra,
});

test('reminderOf copies the schedule; sortReminders orders by first time, then title', () => {
  const ibu = reminder(1, { title: 'Ibuprofen 600', who: 'mama', times: ['08:00', '18:00'] }, { loggedBy: 'Papa' });
  assert.deepEqual(ibu, {
    eid: eidOf(1),
    seq: 1,
    title: 'Ibuprofen 600',
    who: 'mama',
    note: null,
    times: ['08:00', '18:00'],
    everyDays: 1,
    startDate: '2026-09-01',
    changedAt: '2026-09-01T05:00:00Z',
    changedBy: 'Papa',
  });
  const vit = reminder(2, { title: 'Vitamin D', note: '2 Tropfen', times: ['08:00'] });
  const abend = reminder(3, { title: 'Abendritual', times: ['19:00'] });
  const ohneWho = reminder(4, { title: 'Ärztin anrufen', times: ['08:00'] });
  assert.deepEqual(sortReminders([abend, vit, ohneWho, ibu]).map((r) => r.title), ['Ärztin anrufen', 'Ibuprofen 600', 'Vitamin D', 'Abendritual']);
  assert.equal(ohneWho.who, 'baby');
  assert.equal(reminderScheduleLabel(ibu), 'Mama · 08:00 · 18:00');
  assert.equal(reminderScheduleLabel(vit), 'Baby · 08:00');
  // Every N days: carried from the entry, the first day defaulting to the entry's own day.
  const bath = reminder(5, { title: 'Baden', times: ['18:00'], everyDays: 2, startDate: '2026-08-30' });
  assert.equal(bath.everyDays, 2);
  assert.equal(bath.startDate, '2026-08-30');
  assert.equal(reminderScheduleLabel(bath), 'Baby · alle 2 Tage · 18:00');
  assert.equal(reminderScheduleLabel(reminder(6, { title: 'Wiegen', times: ['09:00'], everyDays: 7 })), 'Baby · wöchentlich · 09:00');
  assert.equal(intervalLabel(1), '');
  assert.equal(reminder(7, { title: 'X', times: ['09:00'], everyDays: 1 }).everyDays, 1);
  assert.deepEqual(WHO_LABELS, { baby: 'Baby', mama: 'Mama', papa: 'Papa' });
  assert.equal(whoLabel('papa'), 'Papa');
  assert.equal(whoLabel(undefined), 'Baby');
});

test('occurrencesFor: one slot per reminder × time, by due instant then title, ticks matched by exact due', () => {
  const ibu = reminder(1, { title: 'Ibuprofen 600', who: 'mama', times: ['08:00', '18:00'] });
  const vit = reminder(2, { title: 'Vitamin D', note: '2 Tropfen', times: ['08:00'] });
  const done = tick(vit, '2026-09-01T06:00:00Z', '2026-09-01T06:05:00Z');
  const yesterday = tick(ibu, '2026-08-31T06:00:00Z', '2026-08-31T06:01:00Z');
  const handLogged = { ...tick(vit, undefined, '2026-09-01T07:00:00Z'), details: { title: 'Nabel', who: 'baby' } };
  const list = occurrencesFor([ibu, vit], [done, yesterday, handLogged], DAY);
  assert.deepEqual(list, [
    { reminderEid: ibu.eid, title: 'Ibuprofen 600', who: 'mama', note: null, time: '08:00', due: '2026-09-01T06:00:00Z', done: null },
    { reminderEid: vit.eid, title: 'Vitamin D', who: 'baby', note: '2 Tropfen', time: '08:00', due: '2026-09-01T06:00:00Z', done: { eid: done.eid, at: '2026-09-01T06:05:00Z', by: 'Papa' } },
    { reminderEid: ibu.eid, title: 'Ibuprofen 600', who: 'mama', note: null, time: '18:00', due: '2026-09-01T16:00:00Z', done: null },
  ]);
  // Tomorrow is a fresh day; in January the same wall clock is an hour later in UTC.
  assert.deepEqual(occurrencesFor([vit], [done], '2026-09-02').map((o) => [o.due, o.done]), [['2026-09-02T06:00:00Z', null]]);
  assert.deepEqual(occurrencesFor([vit], [], '2026-01-09').map((o) => o.due), ['2026-01-09T07:00:00Z']);
  assert.deepEqual(occurrencesFor([], [done], DAY), []);
});

test('occurrencesFor: a tick for a slot that no longer exists closes the nearest open slot; duplicates are ignored', () => {
  // The morning dose was ticked at 08:00, then the family moved it to 08:30.
  const vit = reminder(2, { title: 'Vitamin D', times: ['08:30', '20:00'] });
  const oldSlot = tick(vit, '2026-09-01T06:00:00Z', '2026-09-01T06:05:00Z');
  let list = occurrencesFor([vit], [oldSlot], DAY);
  assert.deepEqual(list.map((o) => [o.time, o.done && o.done.eid]), [['08:30', oldSlot.eid], ['20:00', null]]);
  // A second tick for the SAME slot (two phones raced): the first commit
  // counts, the other neither closes the evening slot nor anything else.
  const first = tick(vit, '2026-09-01T06:30:00Z', '2026-09-01T06:31:00Z');
  const second = tick(vit, '2026-09-01T06:30:00Z', '2026-09-01T06:30:30Z');
  list = occurrencesFor([vit], [second, first], DAY);
  assert.deepEqual(list.map((o) => [o.time, o.done && o.done.eid]), [['08:30', first.eid], ['20:00', null]]);
  // An orphan tick with two open slots picks the closer one (18:30 is nearer to 20:00).
  const orphan = tick(vit, '2026-09-01T16:30:00Z', '2026-09-01T16:31:00Z');
  list = occurrencesFor([vit], [orphan], DAY);
  assert.deepEqual(list.map((o) => [o.time, o.done && o.done.eid]), [['08:30', null], ['20:00', orphan.eid]]);
  // A tick of another reminder never closes this one's slots.
  const other = reminder(3, { title: 'Ibuprofen', who: 'mama', times: ['08:30'] });
  list = occurrencesFor([vit], [tick(other, '2026-09-01T06:30:00Z', '2026-09-01T06:31:00Z')], DAY);
  assert.deepEqual(list.map((o) => o.done), [null, null]);
});

test('todoStatus: upcoming until due, due for the grace hour, overdue after it', () => {
  const o = { due: NOW };
  assert.equal(OVERDUE_AFTER_MIN, 60);
  assert.equal(todoStatus(o, NOW_MS - 1), 'upcoming');
  assert.equal(todoStatus(o, NOW_MS), 'due');
  assert.equal(todoStatus(o, NOW_MS + 59 * 60000), 'due');
  assert.equal(todoStatus(o, NOW_MS + 60 * 60000), 'overdue');
});

test('nextTodo: the first open slot of today (an overdue one before the evening), else tomorrow, else null', () => {
  const ibu = reminder(1, { title: 'Ibuprofen 600', who: 'mama', times: ['08:00', '18:00'] });
  const vit = reminder(2, { title: 'Vitamin D', times: ['08:00'] });
  const tasks = [tick(vit, '2026-09-01T06:00:00Z', '2026-09-01T06:05:00Z')];
  const todos = { today: occurrencesFor([ibu, vit], tasks, DAY), tomorrow: occurrencesFor([ibu, vit], tasks, '2026-09-02') };
  // 12:00 local: the 08:00 Ibuprofen is four hours overdue and comes first.
  let next = nextTodo(todos, NOW_MS);
  assert.equal(next.day, 'today');
  assert.equal(next.status, 'overdue');
  assert.equal(next.item.time, '08:00');
  assert.equal(next.item.title, 'Ibuprofen 600');
  // At 07:30 local the same slot is upcoming; at 08:20 it is due.
  assert.equal(nextTodo(todos, Date.parse('2026-09-01T05:30:00Z')).status, 'upcoming');
  assert.equal(nextTodo(todos, Date.parse('2026-09-01T06:20:00Z')).status, 'due');
  // Everything ticked today: tomorrow's first, always upcoming.
  const all = [...tasks, tick(ibu, '2026-09-01T06:00:00Z', '2026-09-01T06:02:00Z'), tick(ibu, '2026-09-01T16:00:00Z', '2026-09-01T16:03:00Z')];
  const doneTodos = { today: occurrencesFor([ibu, vit], all, DAY), tomorrow: occurrencesFor([ibu, vit], all, '2026-09-02') };
  next = nextTodo(doneTodos, Date.parse('2026-09-01T20:00:00Z'));
  assert.deepEqual([next.day, next.status, next.item.due], ['tomorrow', 'upcoming', '2026-09-02T06:00:00Z']);
  assert.deepEqual(todoProgress(doneTodos.today), { done: 3, total: 3 });
  assert.deepEqual(todoProgress(todos.today), { done: 1, total: 3 });
  assert.equal(nextTodo({ today: [], tomorrow: [] }, NOW_MS), null);
  assert.equal(nextTodo(null, NOW_MS), null);
});

test('todoFlipAt: the next due instant or overdue moment of an open slot today, 0 when none is ahead', () => {
  const ibu = reminder(1, { title: 'Ibuprofen 600', who: 'mama', times: ['08:00', '18:00'] });
  const todos = { today: occurrencesFor([ibu], [], DAY), tomorrow: occurrencesFor([ibu], [], '2026-09-02') };
  // 12:00 local: the morning slot is long overdue, the evening one flips at 18:00.
  assert.equal(todoFlipAt(todos, NOW_MS), Date.parse('2026-09-01T16:00:00Z'));
  // 18:30 local: it turns overdue at 19:00.
  assert.equal(todoFlipAt(todos, Date.parse('2026-09-01T16:30:00Z')), Date.parse('2026-09-01T17:00:00Z'));
  // 20:00 local: nothing ahead today (tomorrow is a new derived state).
  assert.equal(todoFlipAt(todos, Date.parse('2026-09-01T18:00:00Z')), 0);
  // Ticked slots do not flip.
  const done = [tick(ibu, '2026-09-01T16:00:00Z', '2026-09-01T15:00:00Z')];
  assert.equal(todoFlipAt({ today: occurrencesFor([ibu], done, DAY) }, NOW_MS), 0);
});

test('overdueCount: open slots of today past their grace hour, ticked ones not', () => {
  const ibu = reminder(1, { title: 'Ibuprofen 600', who: 'mama', times: ['08:00', '18:00'] });
  const vit = reminder(2, { title: 'Vitamin D', times: ['07:00'] });
  const todos = { today: occurrencesFor([ibu, vit], [], DAY), tomorrow: occurrencesFor([ibu, vit], [], '2026-09-02') };
  // 12:00 local: the 07:00 and 08:00 slots are overdue, 18:00 is ahead.
  assert.equal(overdueCount(todos, NOW_MS), 2);
  // 08:30 local: 07:00 is overdue, 08:00 still within its hour.
  assert.equal(overdueCount(todos, Date.parse('2026-09-01T06:30:00Z')), 1);
  // 06:00 local: nothing due yet.
  assert.equal(overdueCount(todos, Date.parse('2026-09-01T04:00:00Z')), 0);
  // A tick takes the slot out of the count; tomorrow never counts.
  const ticked = { today: occurrencesFor([ibu, vit], [tick(vit, '2026-09-01T05:00:00Z', '2026-09-01T05:10:00Z')], DAY) };
  assert.equal(overdueCount(ticked, NOW_MS), 1);
  assert.equal(overdueCount({ tomorrow: todos.tomorrow }, NOW_MS), 0);
  assert.equal(overdueCount(null, NOW_MS), 0);
});

test('reminderDueOn / occurrencesFor: an every-N-days reminder falls on its first day and every N days after, never before', () => {
  const bath = reminder(5, { title: 'Baden', times: ['18:00'], everyDays: 2, startDate: '2026-09-01' });
  assert.equal(reminderDueOn(bath, '2026-09-01'), true);
  assert.equal(reminderDueOn(bath, '2026-09-02'), false);
  assert.equal(reminderDueOn(bath, '2026-09-03'), true);
  assert.equal(reminderDueOn(bath, '2026-08-31'), false);
  // Across a month end and the DST change in October (day counting, not hours).
  const weekly = reminder(6, { title: 'Wiegen', times: ['09:00'], everyDays: 7, startDate: '2026-09-28' });
  assert.equal(reminderDueOn(weekly, '2026-10-05'), true);
  assert.equal(reminderDueOn(weekly, '2026-10-26'), true);
  assert.equal(reminderDueOn(weekly, '2026-10-27'), false);
  // Daily ones ignore the start day; a missing start day counts from the entry's own day.
  const daily = reminder(7, { title: 'Vitamin D', times: ['08:00'] });
  assert.equal(reminderDueOn(daily, '2026-08-01'), true);
  const fromEntry = reminder(8, { title: 'Baden', times: ['18:00'], everyDays: 3 }); // entry day 2026-09-01
  assert.equal(fromEntry.startDate, '2026-09-01');
  assert.equal(reminderDueOn(fromEntry, '2026-09-04'), true);
  assert.equal(reminderDueOn(fromEntry, '2026-09-05'), false);
  // The day's to-dos skip it on an off day; a tick on an on day closes it.
  assert.deepEqual(occurrencesFor([bath, daily], [], '2026-09-02').map((o) => o.title), ['Vitamin D']);
  assert.deepEqual(occurrencesFor([bath, daily], [], '2026-09-03').map((o) => o.title), ['Vitamin D', 'Baden']);
  const done = tick(bath, '2026-09-03T16:00:00Z', '2026-09-03T16:10:00Z');
  assert.equal(occurrencesFor([bath], [done], '2026-09-03')[0].done.eid, done.eid);
});
