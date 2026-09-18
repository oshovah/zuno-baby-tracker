// Today's reminders as a checklist in the bottom sheet, opened from the
// «Erinnerungen» tile on the home screen (the Schlaf tile's slot): the open
// slots as one-tap «erledigt» rows, the ticked ones compact below them — a
// tick can be taken back with a second tap on its row (armed for 3 s, like
// the delete button). The list follows the store while the sheet is open, so
// the partner's ticks land in it too. tickTodo() is shared with the home
// card's one-tap path.

import { store } from './store.js';
import { t } from './i18n/index.js';
import { openSheet } from './sheet.js';
import { todoStatus, todoProgress, whoLabel } from './reminders.js';
import { escapeHtml, toast, fmtClock, nowMs } from './ui.js';

const ARM_MS = 3000;

/** «2 Tropfen · Mama» — the note and, for a parent, whom it is for. */
export function todoDetail(o) {
  return [o.note, o.who && o.who !== 'baby' ? whoLabel(o.who) : null].filter(Boolean).join(' · ');
}

/** The sync-fresh copy of an occurrence (the snapshot may have moved since a render). */
function freshOccurrence(o) {
  const todos = (store.snapshot && store.snapshot.data.todos) || { today: [] };
  return todos.today.find((x) => x.reminderEid === o.reminderEid && x.due === o.due) || null;
}

/**
 * Tick `o` off: a `task` entry naming the reminder and the slot it stands
 * for (both phones then mark the same slot), with an undo toast. A slot the
 * partner ticked meanwhile (a sync applied since the render) is not ticked
 * twice — the toast says so. Resolves with the entry, or null then. Waits
 * for the local rows like every write.
 */
export async function tickTodo(o) {
  await store.ready;
  const fresh = freshOccurrence(o);
  if (fresh && fresh.done) {
    toast(
      fresh.done.by ? t('forms.todo.alreadyDoneBy', { title: o.title, by: fresh.done.by }) : t('forms.todo.alreadyDone', { title: o.title }),
      'info'
    );
    return null;
  }
  const entry = await store.entries.create({
    type: 'task',
    details: { title: o.title, who: o.who, reminderEid: o.reminderEid, due: o.due },
  });
  toast(t('forms.todo.ticked', { title: o.title }), 'success', {
    action: {
      label: t('common.action.undo'),
      onClick: () =>
        store.entries
          .remove(entry.eid)
          .then(() => store.refreshAfterWrite())
          .catch((e) => toast(e.message)),
    },
  });
  return entry;
}

/** Take a tick back (soft delete — Verlauf can restore it), with an undo toast. */
async function untickTodo(o) {
  await store.ready;
  const fresh = freshOccurrence(o);
  const eid = fresh && fresh.done ? fresh.done.eid : o.done && o.done.eid;
  if (!eid) return;
  await store.entries.remove(eid);
  toast(t('forms.todo.unticked', { title: o.title }), 'success', {
    action: {
      label: t('common.action.undo'),
      onClick: () =>
        store.entries
          .restore(eid)
          .then(() => store.refreshAfterWrite())
          .catch((e) => toast(e.message)),
    },
  });
}

function todoTextHtml(o) {
  const detail = todoDetail(o);
  return `<span class="todo-text"><span class="todo-title">${escapeHtml(o.title)}</span>${
    detail ? `<span class="todo-detail">${escapeHtml(detail)}</span>` : ''
  }</span>`;
}

/** The rows: open slots first (by time), ticked ones after; `armedEid` = the tick awaiting its second tap. */
function listHtml(list, armedEid, now) {
  const open = [];
  const done = [];
  list.forEach((o, i) => {
    if (o.done) {
      const armed = armedEid === o.done.eid;
      done.push(`
        <button type="button" class="todo-row done${armed ? ' armed' : ''}" data-untick="${i}"
          aria-label="${t('forms.todo.doneRowAria', { title: escapeHtml(o.title), time: o.time, at: fmtClock(o.done.at) })}">
          <span class="todo-time">${o.time}</span>
          ${todoTextHtml(o)}
          <span class="todo-done">${armed ? t('forms.todo.untickAgain') : `✓ ${fmtClock(o.done.at)}${o.done.by ? ` · ${escapeHtml(o.done.by)}` : ''}`}</span>
        </button>`);
    } else {
      open.push(`
        <button type="button" class="todo-row ${todoStatus(o, now)}" data-tick="${i}"
          aria-label="${t('forms.todo.tickRowAria', { title: escapeHtml(o.title), time: o.time })}">
          <span class="todo-time">${o.time}</span>
          ${todoTextHtml(o)}
          <span class="todo-check" aria-hidden="true"></span>
        </button>`);
    }
  });
  return `<div class="todo-list">${open.join('')}${done.join('')}</div>`;
}

/** Open the checklist of today's to-dos. */
export function openTodoSheet() {
  openSheet(t('forms.todo.title'), (body) => {
    let busy = false;
    let armedEid = null;
    let armTimer = null;
    let lastKey = null;

    const todosNow = () => ((store.snapshot && store.snapshot.data.todos) || { today: [] }).today;

    function disarm() {
      clearTimeout(armTimer);
      armTimer = null;
      armedEid = null;
    }

    function render(force = false) {
      const list = todosNow();
      const key = JSON.stringify([list, armedEid]);
      if (!force && key === lastKey) return;
      lastKey = key;
      const { done, total } = todoProgress(list);
      body.innerHTML = `
        ${total ? `<p class="hint todo-progress">${t('forms.todo.progress', { done, total })}</p>` : ''}
        ${listHtml(list, armedEid, nowMs())}
        <p class="hint todo-foot">${t('forms.todo.foot')}</p>`;

      body.querySelectorAll('[data-tick]').forEach((btn) =>
        btn.addEventListener('click', async () => {
          if (busy) return;
          const o = list[Number(btn.dataset.tick)];
          if (!o) return;
          busy = true;
          btn.disabled = true;
          disarm();
          try {
            await tickTodo(o);
          } catch (err) {
            toast(err.message);
            btn.disabled = false;
          } finally {
            busy = false;
          }
          store.refreshAfterWrite().catch(() => {});
        })
      );
      body.querySelectorAll('[data-untick]').forEach((btn) =>
        btn.addEventListener('click', async () => {
          if (busy) return;
          const o = list[Number(btn.dataset.untick)];
          if (!o || !o.done) return;
          if (armedEid !== o.done.eid) {
            // First tap: arm this row only, for a few seconds.
            disarm();
            armedEid = o.done.eid;
            armTimer = setTimeout(() => {
              if (!body.isConnected) return;
              disarm();
              render();
            }, ARM_MS);
            render();
            return;
          }
          busy = true;
          btn.disabled = true;
          disarm();
          try {
            await untickTodo(o);
          } catch (err) {
            toast(err.message);
            btn.disabled = false;
          } finally {
            busy = false;
          }
          store.refreshAfterWrite().catch(() => {});
        })
      );
    }

    // Follow the store (own writes, the partner's ticks) while the sheet is
    // up; the subscription ends itself once the sheet left the DOM.
    const unsubscribe = store.subscribe(() => {
      if (!body.isConnected) {
        unsubscribe();
        disarm();
        return;
      }
      render();
    });
    render(true);
  });
}
