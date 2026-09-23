// «Noch nicht gesendet»: the entries this phone still owes the server
// (store.outbox), in the bottom sheet — opened from the chip on «Jetzt».
// One row per op: the type, the time it was logged, what it is (new / changed
// / deleted / restored) and its state; «Jetzt senden» kicks the flusher; an
// op the server refused for good («nicht gesendet») can be tried again or
// given up (two taps, like a delete). Follows the store while it is up.

import { store } from './store.js';
import { t } from './i18n/index.js';
import { openSheet } from './sheet.js';
import { TYPE_LABELS } from './validate.js';
import { escapeHtml, toast, fmtClock, fmtDayHeading, localDateOf, localToday, icon } from './ui.js';

const ARM_MS = 3000;

const KIND_KEYS = { create: 'forms.outbox.kind.create', update: 'forms.outbox.kind.update', remove: 'forms.outbox.kind.remove', restore: 'forms.outbox.kind.restore' };
const STATUS_KEYS = { waiting: 'forms.outbox.status.waiting', sending: 'forms.outbox.status.sending', parked: 'forms.outbox.status.parked' };

/** «Heute 14:03» / «Gestern 23:10» — when the tap happened. */
function whenLabel(iso) {
  if (typeof iso !== 'string') return '';
  const day = localDateOf(iso);
  const clock = fmtClock(iso);
  return day === localToday() ? clock : `${fmtDayHeading(day)} ${clock}`;
}

function rowHtml(item, armedKey) {
  const typeLabel = item.type && TYPE_LABELS[item.type] ? TYPE_LABELS[item.type] : t('forms.outbox.kind.entry');
  const status = item.status === 'parked' && item.parked && item.parked.message ? escapeHtml(item.parked.message) : t(STATUS_KEYS[item.status] || STATUS_KEYS.waiting);
  const armed = armedKey === item.key;
  return `
    <div class="entry-row outbox-row${item.status === 'parked' ? ' parked' : ''}">
      ${item.type ? icon(item.type, 'e-emoji') : ''}
      <span class="e-text">
        <span class="e-summary">${escapeHtml(typeLabel)} · ${t(KIND_KEYS[item.kind] || KIND_KEYS.create)}</span>
        <span class="e-by">${escapeHtml(whenLabel(item.queuedAt))} · ${status}</span>
      </span>
      ${
        item.status === 'parked'
          ? `<span class="outbox-actions">
              <button type="button" class="chip" data-retry="${escapeHtml(item.key)}">${t('forms.outbox.retry')}</button>
              <button type="button" class="chip${armed ? ' danger' : ''}" data-discard="${escapeHtml(item.key)}">${armed ? t('forms.outbox.discardConfirm') : t('forms.outbox.discard')}</button>
            </span>`
          : ''
      }
    </div>`;
}

/** Open the list of what still waits to be sent. */
export function openOutboxSheet() {
  openSheet(t('forms.outbox.title'), (body) => {
    let busy = false;
    let armedKey = null;
    let armTimer = null;
    let lastKey = null;

    function disarm() {
      clearTimeout(armTimer);
      armTimer = null;
      armedKey = null;
    }

    function render(force = false) {
      const list = store.outbox.list();
      const key = JSON.stringify([list, armedKey, busy]);
      if (!force && key === lastKey) return;
      lastKey = key;
      const waiting = list.some((i) => i.status !== 'parked');
      body.innerHTML = `
        <p class="hint">${t('forms.outbox.hint')}</p>
        ${list.length ? `<div class="entry-list outbox-list">${list.map((i) => rowHtml(i, armedKey)).join('')}</div>` : `<p class="empty">${t('forms.outbox.empty')}</p>`}
        ${waiting ? `<button type="button" class="btn wide" data-send ${busy ? 'disabled' : ''}>${busy ? t('forms.outbox.sending') : t('forms.outbox.sendNow')}</button>` : ''}`;

      const send = body.querySelector('[data-send]');
      if (send) {
        send.addEventListener('click', async () => {
          if (busy) return;
          busy = true;
          render(true);
          try {
            await store.refresh().catch(() => {});
            await store.outbox.flush();
          } finally {
            busy = false;
          }
          if (body.isConnected) {
            if (store.outbox.count > 0) toast(t('forms.outbox.stillWaiting'));
            render(true);
          }
        });
      }
      body.querySelectorAll('[data-retry]').forEach((btn) =>
        btn.addEventListener('click', async () => {
          if (busy) return;
          busy = true;
          disarm();
          btn.disabled = true;
          try {
            await store.outbox.retry(btn.dataset.retry);
          } catch (err) {
            toast(err.message);
          } finally {
            busy = false;
          }
          if (body.isConnected) render(true);
        })
      );
      body.querySelectorAll('[data-discard]').forEach((btn) =>
        btn.addEventListener('click', async () => {
          if (busy) return;
          const key = btn.dataset.discard;
          if (armedKey !== key) {
            disarm();
            armedKey = key;
            armTimer = setTimeout(() => {
              if (!body.isConnected) return;
              disarm();
              render();
            }, ARM_MS);
            render();
            return;
          }
          busy = true;
          disarm();
          btn.disabled = true;
          try {
            await store.outbox.discard(key);
            toast(t('forms.outbox.discarded'), 'success');
          } catch (err) {
            toast(err.message);
          } finally {
            busy = false;
          }
          if (body.isConnected) render(true);
        })
      );
    }

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
