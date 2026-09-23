// The reminder sheet (Mehr › Erinnerungen): create and edit share it, like
// the entry form. A reminder is a schedule — what, for whom, an optional
// note (the dose), one to twelve times of day, daily or every N days from
// a first day — stored as one
// `reminder` entry of the family (validate.js REMINDER_TYPE) through
// store.entries, so it is encrypted, synced and compare-and-set like a feed:
// an edit carries the seq it was opened with, and a change made on the other
// phone meanwhile is a 409 (a deletion a 404) — the stale sheet shows the
// reason and closes.

import { store } from './store.js';
import { t } from './i18n/index.js';
import { openSheet } from './sheet.js';
import { whoSegment, segValue, wireSegmented } from './entry-form.js';
import { escapeHtml, toast, isoNow, localToday } from './ui.js';
import { REMINDER_MAX_TIMES } from './validate.js';
import { zurichDateOf } from './tz.js';

const CONFLICT_CLOSE_MS = 2500;
const DEFAULT_TIME = '08:00';
// The usual slots, one tap each; the time picker covers the rest.
const QUICK_TIMES = ['08:00', '12:00', '18:00', '22:00'];
// The usual intervals, one tap each; the number field covers the rest.
const QUICK_EVERY = [1, 2, 3, 7];
const EVERY_MAX = 365;

/** «Täglich» / «Alle 2 Tage» / «Wöchentlich» — a quick interval chip's word. */
function everyLabel(n) {
  if (n === 1) return t('forms.reminder.daily');
  if (n === 7) return t('forms.reminder.weekly');
  return t('forms.reminder.everyN', { n });
}

/** The current times as removable chips. */
function timesHtml(times) {
  if (times.length === 0) return `<span class="times-empty">${t('forms.reminder.noTimes')}</span>`;
  return times
    .map(
      (time) => `<span class="time-chip">${time}
        <button type="button" class="time-remove" data-remove-time="${time}" aria-label="${t('forms.reminder.removeTimeAria', { time })}">✕</button></span>`
    )
    .join('');
}

/**
 * Open the sheet. entry = null creates a new reminder; otherwise edits the
 * given reminder entry (with its seq). onSaved() runs after any successful
 * save or delete.
 */
export function openReminderForm({ entry = null, onSaved = () => {} }) {
  const isEdit = entry !== null;
  const d = (isEdit && entry.details) || {};
  let times = [...(d.times || [])];
  const everyInitial = Number.isInteger(d.everyDays) && d.everyDays > 1 ? d.everyDays : 1;
  // The first day of an every-N-days reminder: what was saved, else the
  // reminder's own day, else today (Zurich, like the schedule itself).
  const startInitial = d.startDate || (isEdit ? zurichDateOf(entry.startedAt) : zurichDateOf(isoNow()));

  openSheet(isEdit ? t('forms.title.edit', { type: t('common.type.reminder') }) : t('common.type.reminder'), (body, close, setGuard) => {
    body.innerHTML = `
      <form class="entry-form" novalidate>
        <label class="field"><span>${t('forms.field.what')}</span>
          <input name="title" type="text" maxlength="100" value="${escapeHtml(d.title || '')}"
            placeholder="${t('forms.placeholder.exampleTitle')}" required />
        </label>
        <div class="field"><span>${t('forms.field.who')}</span>${whoSegment(d.who)}</div>
        <label class="field"><span>${t('forms.field.note')} <small>${t('forms.field.optional')}</small></span>
          <input name="note" type="text" maxlength="100" value="${escapeHtml(d.note || '')}"
            placeholder="${t('forms.placeholder.note')}" />
        </label>
        <div class="field"><span>${t('forms.reminder.dailyAt')}</span>
          <div class="chip-row times" data-times>${timesHtml(times)}</div>
          <div class="chip-row even" data-quick-times>
            ${QUICK_TIMES.map((q) => `<button type="button" class="chip" data-add-time="${q}">${q}</button>`).join('')}
          </div>
          <div class="end-row">
            <input name="time" type="time" value="${DEFAULT_TIME}" aria-label="${t('forms.reminder.moreTimeAria')}" />
            <button type="button" class="chip" data-add-custom>${t('forms.action.add')}</button>
          </div>
        </div>
        <div class="field"><span>${t('forms.reminder.repeat')}</span>
          <div class="chip-row even" data-every-chips>
            ${QUICK_EVERY.map((n) => `<button type="button" class="chip${n === everyInitial ? ' active' : ''}" data-every="${n}">${everyLabel(n)}</button>`).join('')}
          </div>
          <div class="end-row">
            <input name="everyDays" type="number" inputmode="numeric" min="1" max="${EVERY_MAX}" value="${everyInitial}"
              aria-label="${t('forms.reminder.everyDaysAria')}" />
            <span class="hint">${t('forms.reminder.daysWord')}</span>
          </div>
        </div>
        <label class="field" data-start-field ${everyInitial > 1 ? '' : 'hidden'}><span>${t('forms.reminder.startDate')}</span>
          <input name="startDate" type="date" value="${escapeHtml(startInitial)}" />
        </label>
        <p class="form-error" aria-live="polite"></p>
        <div class="form-actions">
          ${isEdit ? `<button type="button" class="btn danger" data-delete>${t('common.action.delete')}</button>` : ''}
          <button type="submit" class="btn primary">${t('common.action.save')}</button>
        </div>
      </form>`;

    wireSegmented(body);
    const form = body.querySelector('form');
    const errEl = body.querySelector('.form-error');
    const timesEl = body.querySelector('[data-times]');
    // querySelector, not form.title: a form's `title` is also its attribute.
    const titleInput = form.querySelector('[name="title"]');
    const noteInput = form.querySelector('[name="note"]');
    const timeInput = form.querySelector('[name="time"]');
    const everyInput = form.querySelector('[name="everyDays"]');
    const startField = body.querySelector('[data-start-field]');
    const startInput = form.querySelector('[name="startDate"]');

    let dirty = false;
    form.addEventListener('input', () => {
      dirty = true;
    });
    form.addEventListener('click', (e) => {
      if (e.target.closest('.seg, .chip')) dirty = true;
    });
    setGuard(() => !dirty);

    function renderTimes() {
      timesEl.innerHTML = timesHtml(times);
      body.querySelectorAll('[data-add-time]').forEach((chip) => {
        chip.classList.toggle('active', times.includes(chip.dataset.addTime));
      });
    }

    function addTime(time) {
      errEl.textContent = '';
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time || '')) {
        errEl.textContent = t('forms.error.pickTime');
        return;
      }
      if (times.includes(time)) return;
      if (times.length >= REMINDER_MAX_TIMES) {
        errEl.textContent = t('forms.error.tooManyTimes', { max: REMINDER_MAX_TIMES });
        return;
      }
      times = [...times, time].sort();
      dirty = true;
      renderTimes();
    }

    // The quick chips toggle: a second tap on 08:00 takes it out again.
    body.querySelectorAll('[data-add-time]').forEach((chip) =>
      chip.addEventListener('click', () => {
        const time = chip.dataset.addTime;
        if (times.includes(time)) {
          times = times.filter((x) => x !== time);
          dirty = true;
          renderTimes();
        } else {
          addTime(time);
        }
      })
    );
    body.querySelector('[data-add-custom]').addEventListener('click', () => addTime(timeInput.value));

    // The interval: the chips and the number field say the same thing; the
    // first-day field shows only once it is not daily.
    function syncEvery() {
      const n = parseInt(everyInput.value, 10);
      body.querySelectorAll('[data-every]').forEach((chip) => chip.classList.toggle('active', Number(chip.dataset.every) === n));
      startField.hidden = !(n > 1);
    }
    body.querySelectorAll('[data-every]').forEach((chip) =>
      chip.addEventListener('click', () => {
        everyInput.value = chip.dataset.every;
        dirty = true;
        syncEvery();
      })
    );
    everyInput.addEventListener('input', syncEvery);
    // The list re-renders, so the remove buttons are delegated.
    timesEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-remove-time]');
      if (!btn) return;
      times = times.filter((x) => x !== btn.dataset.removeTime);
      dirty = true;
      renderTimes();
    });
    renderTimes();

    /** Has the reminder this form was opened from moved on (edited or deleted
     *  on the OTHER phone)? Our own write landing meanwhile does not count. */
    function rowMoved() {
      const cur = store.entries.get(entry.eid);
      return !cur || cur.deletedAt != null || store.entries.changedSince(entry.eid, entry.seq);
    }

    /** A 409/404 on a row that moved under this sheet: show why, then close (see entry-form.js). */
    function closeWhenMoved(err, reenable) {
      const status = err && err.status;
      if (!isEdit || (status !== 409 && status !== 404)) return false;
      if (rowMoved()) {
        setTimeout(close, CONFLICT_CLOSE_MS);
        return true;
      }
      if (status !== 404) return false;
      const closeAt = Date.now() + CONFLICT_CLOSE_MS;
      store
        .refresh()
        .catch(() => {})
        .then(() => {
          if (rowMoved()) setTimeout(close, Math.max(0, closeAt - Date.now()));
          else reenable();
        });
      return true;
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errEl.textContent = '';
      const submit = form.querySelector('button[type="submit"]');
      try {
        const title = titleInput.value.trim();
        if (!title) throw new Error(t('forms.error.reminderTitleMissing'));
        if ([...title].length > 100) throw new Error(t('forms.error.titleTooLong', { max: 100 }));
        const note = noteInput.value.trim();
        if ([...note].length > 100) throw new Error(t('forms.error.noteTooLong', { max: 100 }));
        if (times.length === 0) throw new Error(t('forms.error.timesMissing'));
        const everyDays = parseInt(everyInput.value, 10);
        if (!Number.isInteger(everyDays) || everyDays < 1 || everyDays > EVERY_MAX) throw new Error(t('forms.error.everyDaysRange'));
        const details = { title, who: segValue(body, 'who') || 'baby', note: note || null, times };
        if (everyDays > 1) {
          const startDate = startInput.value;
          if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new Error(t('forms.error.startDateMissing'));
          details.everyDays = everyDays;
          details.startDate = startDate;
        }
        submit.disabled = true;
        await store.ready;
        if (isEdit) {
          // startedAt = the time of the change (the Mehr list shows it).
          await store.entries.update(entry.eid, { startedAt: isoNow(), details }, { ifSeq: entry.seq });
          toast(t('forms.toast.reminderSaved'), 'success');
        } else {
          await store.entries.create({ type: 'reminder', details });
          toast(t('forms.toast.reminderCreated', { title }), 'success');
        }
        close();
        onSaved();
      } catch (err) {
        errEl.textContent = err.message;
        if (closeWhenMoved(err, () => (submit.disabled = false))) return;
        submit.disabled = false;
      }
    });

    // Delete = two taps, disarming after 3 s; the toast offers the undo.
    const delBtn = body.querySelector('[data-delete]');
    if (delBtn) {
      let disarmTimer = null;
      delBtn.addEventListener('click', async () => {
        if (!delBtn.dataset.armed) {
          delBtn.dataset.armed = '1';
          delBtn.textContent = t('forms.action.confirmDelete');
          disarmTimer = setTimeout(() => {
            delete delBtn.dataset.armed;
            delBtn.textContent = t('common.action.delete');
          }, 3000);
          return;
        }
        clearTimeout(disarmTimer);
        delBtn.disabled = true;
        try {
          await store.ready;
          await store.entries.remove(entry.eid);
          toast(t('forms.toast.reminderDeleted'), 'success', {
            action: {
              label: t('common.action.undo'),
              onClick: async () => {
                try {
                  await store.entries.restore(entry.eid);
                  onSaved();
                } catch (err) {
                  toast(err.message);
                }
              },
            },
          });
          close();
          onSaved();
        } catch (err) {
          errEl.textContent = err.message;
          if (closeWhenMoved(err, () => (delBtn.disabled = false))) return;
          delBtn.disabled = false;
        }
      });
    }
  });
}
