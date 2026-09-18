// Reminders («Erinnerungen»): the family's daily schedules expanded into a
// day's to-dos, and the tick that closes one. Pure — imports tz.js only:
// model.deriveState calls it, the home view reads the result from the
// snapshot, tests/reminders.test.mjs pins the rules.
//
// A reminder entry (validate.js REMINDER_TYPE) is a schedule
// {title, who, note?, times: ['08:00', '18:00'], everyDays?, startDate?} in
// Zurich wall-clock time, like the day windows — so both phones agree when
// 18:00 is. Daily unless `everyDays` says every second, third … day,
// counted from `startDate` (the entry's own day when absent). For one
// local date every time becomes an OCCURRENCE with its due instant
// (tz.zurichTimeUtc); a live `task` entry that names the reminder and the
// same due instant ticks it off («Erledigt»). A task whose due matches no
// slot any more (the times were edited after the tick) still counts for the
// nearest open slot of its day, so the morning dose does not reappear as
// open after moving it from 08:00 to 08:30; a second task for a slot that is
// ticked already (the two-phone race) is ignored here and only shows in
// Verlauf.

import { t, localeMeta } from './i18n/index.js';
import { zurichTimeUtc, zurichDateOf } from './tz.js';

const DAY_MS = 86400000;
/** Calendar day number of «YYYY-MM-DD» (days since 1970-01-01, DST-free). */
const dayNumber = (localDate) => {
  const [y, m, d] = localDate.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
};

// Getters: each label is the translation of the moment it is read.
export const WHO_LABELS = {
  get baby() { return t('common.who.baby'); },
  get mama() { return t('common.who.mama'); },
  get papa() { return t('common.who.papa'); },
};

/** «Baby» / «Mama» / «Papa»; unknown values read as the baby. */
export function whoLabel(who) {
  return WHO_LABELS[who] || WHO_LABELS.baby;
}

// A slot due this long ago without a tick is overdue (the card turns red).
export const OVERDUE_AFTER_MIN = 60;

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byTitle = (a, b) => a.title.localeCompare(b.title, localeMeta().dateLocale) || cmp(a.eid || a.reminderEid, b.eid || b.reminderEid);

/** A reminder entry as the views use it (a copy: the model stays untouched). */
export function reminderOf(entry) {
  const d = entry.details || {};
  return {
    eid: entry.eid,
    seq: entry.seq,
    title: d.title,
    who: d.who || 'baby',
    note: d.note || null,
    times: [...(d.times || [])],
    everyDays: Number.isInteger(d.everyDays) && d.everyDays > 1 ? d.everyDays : 1,
    startDate: typeof d.startDate === 'string' && d.startDate ? d.startDate : zurichDateOf(entry.startedAt),
    changedAt: entry.startedAt,
    changedBy: entry.loggedBy === undefined ? null : entry.loggedBy,
  };
}

/** Reminders by their first time of day, then title. */
export function sortReminders(list) {
  return [...list].sort((a, b) => cmp(a.times[0] || '', b.times[0] || '') || byTitle(a, b));
}

/** «alle 2 Tage» / «wöchentlich» — the interval's words; '' when daily. */
export function intervalLabel(everyDays) {
  if (!(everyDays > 1)) return '';
  return everyDays === 7 ? t('common.weekly') : t('common.everyDays', { n: everyDays });
}

/** «Baby · 08:00 · 18:00», «Mama · alle 2 Tage · 08:00» — the schedule line under a reminder's title. */
export function reminderScheduleLabel(r) {
  return [whoLabel(r.who), intervalLabel(r.everyDays), ...r.times].filter(Boolean).join(' · ');
}

/**
 * Does the reminder fall on `localDate`? Daily ones always; an every-N-days
 * one on its start day and every N days after it, never before it.
 */
export function reminderDueOn(r, localDate) {
  const n = r.everyDays;
  if (!(n > 1)) return true;
  if (typeof r.startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.startDate)) return true;
  const diff = dayNumber(localDate) - dayNumber(r.startDate);
  return diff >= 0 && diff % n === 0;
}

/**
 * The to-dos of one Zurich day: one per reminder × time, by due instant
 * (then title), each
 *   {reminderEid, title, who, note, time, due, done}
 * with done = {eid, at, by} of the task that ticked it off, or null.
 * `reminders` are reminderOf() objects, `tasks` the live task entries.
 */
export function occurrencesFor(reminders, tasks, localDate) {
  const slots = [];
  for (const r of reminders) {
    if (!reminderDueOn(r, localDate)) continue;
    for (const time of r.times) {
      slots.push({
        reminderEid: r.eid,
        title: r.title,
        who: r.who,
        note: r.note || null,
        time,
        due: zurichTimeUtc(localDate, time),
        done: null,
      });
    }
  }
  slots.sort((a, b) => cmp(a.due, b.due) || byTitle(a, b));

  // The day's ticks per reminder, oldest commit first (the first tick of a
  // slot wins a race). A tick belongs to the day of the slot it stands for.
  const ticks = new Map();
  for (const task of tasks) {
    const d = task.details || {};
    if (!d.reminderEid) continue;
    const stamp = d.due || task.startedAt;
    if (zurichDateOf(stamp) !== localDate) continue;
    if (!ticks.has(d.reminderEid)) ticks.set(d.reminderEid, []);
    ticks.get(d.reminderEid).push({ task, due: stamp });
  }
  for (const list of ticks.values()) list.sort((a, b) => Number(a.task.seq) - Number(b.task.seq));

  const doneOf = (task) => ({ eid: task.eid, at: task.startedAt, by: task.loggedBy === undefined ? null : task.loggedBy });

  // Pass 1: the exact slot.
  const used = new Set();
  for (const slot of slots) {
    const hit = (ticks.get(slot.reminderEid) || []).find((x) => !used.has(x.task.eid) && x.due === slot.due);
    if (hit) {
      used.add(hit.task.eid);
      slot.done = doneOf(hit.task);
    }
  }
  // Pass 2: a tick whose slot no longer exists (edited times) closes the
  // nearest open slot of its reminder; a duplicate of a ticked slot does not.
  for (const [rid, list] of ticks) {
    const rSlots = slots.filter((s) => s.reminderEid === rid);
    for (const x of list) {
      if (used.has(x.task.eid) || rSlots.some((s) => s.due === x.due)) continue;
      const open = rSlots.filter((s) => !s.done);
      if (open.length === 0) break;
      const at = Date.parse(x.due);
      open.sort((a, b) => Math.abs(Date.parse(a.due) - at) - Math.abs(Date.parse(b.due) - at) || cmp(a.due, b.due));
      open[0].done = doneOf(x.task);
      used.add(x.task.eid);
    }
  }
  return slots;
}

/** 'upcoming' | 'due' | 'overdue' of an open occurrence at instant `at` (ms). */
export function todoStatus(o, at) {
  const dueMs = Date.parse(o.due);
  if (at < dueMs) return 'upcoming';
  return at - dueMs < OVERDUE_AFTER_MIN * 60000 ? 'due' : 'overdue';
}

/**
 * What the home card answers with: the first open to-do of today (an
 * overdue morning dose before the evening one), else the first open one of
 * tomorrow — as {item, day: 'today' | 'tomorrow', status}; null when
 * nothing is open (no reminders at all, or everything ticked).
 */
export function nextTodo(todos, at) {
  const open = (list) => (list || []).filter((o) => !o.done);
  const today = open(todos && todos.today);
  if (today.length) return { item: today[0], day: 'today', status: todoStatus(today[0], at) };
  const tomorrow = open(todos && todos.tomorrow);
  if (tomorrow.length) return { item: tomorrow[0], day: 'tomorrow', status: 'upcoming' };
  return null;
}

/**
 * The next instant (ms) at which an open to-do of today changes its status
 * by the clock alone — its due instant, or when it turns overdue — 0 when
 * none is ahead.
 */
export function todoFlipAt(todos, now) {
  let next = 0;
  for (const o of (todos && todos.today) || []) {
    if (o.done) continue;
    const dueMs = Date.parse(o.due);
    for (const at of [dueMs, dueMs + OVERDUE_AFTER_MIN * 60000]) {
      if (at > now && (!next || at < next)) next = at;
    }
  }
  return next;
}

/** How many open to-dos of today are overdue (todoStatus) — the home card's «2 Überfällig». */
export function overdueCount(todos, at) {
  let n = 0;
  for (const o of (todos && todos.today) || []) {
    if (!o.done && todoStatus(o, at) === 'overdue') n++;
  }
  return n;
}

/** {done, total} of a day's to-dos — the today line's «1 von 2 erledigt». */
export function todoProgress(list) {
  const all = list || [];
  return { done: all.filter((o) => !!o.done).length, total: all.length };
}
