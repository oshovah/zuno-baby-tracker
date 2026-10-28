// «Analog-Buttons» in the bottom sheet (Mehr › Einstellungen › Analog-Buttons):
//   openDeviceSheet({onChanged})        add one: a name, then the code the
//                                       sketch wants — the same sheet swaps
//                                       its body to the detail view
//   openDeviceSheet({eid, onChanged})   an existing one: the code again (to
//                                       copy), what each button combination
//                                       ticks off, a «Testdruck» that sends
//                                       one press exactly as the device
//                                       would, removal with two taps
// ONE sheet whose body swaps between the form and the detail (a second
// openSheet right after close() would race the history pop). The pure
// shapes are src/devices.js; the store does the talking (store.devices).

import { store } from './store.js';
import { t } from './i18n/index.js';
import { openSheet } from './sheet.js';
import { escapeHtml, toast, fmtDayHeading, localDateOf } from './ui.js';
import { DEVICE_NAME_MAX, groupedCode, SKETCH_URL, COMBO_MASKS, COMBO_NEXT, comboLabel } from './devices.js';

const ARM_MS = 3000;

function formHtml() {
  return `
    <form class="entry-form device-form" novalidate>
      <p class="hint">${escapeHtml(t('devices.add.intro'))}</p>
      <label class="field"><span>${escapeHtml(t('devices.add.nameLabel'))}</span>
        <input type="text" name="name" maxlength="${DEVICE_NAME_MAX}" value="${escapeHtml(t('devices.defaultName'))}"
          placeholder="${escapeHtml(t('devices.add.namePlaceholder'))}" autocomplete="off" />
      </label>
      <p class="form-error" aria-live="polite"></p>
      <div class="form-actions">
        <button type="submit" class="btn primary" data-submit>${escapeHtml(t('devices.add.submit'))}</button>
      </div>
    </form>`;
}

/** The family's reminders as the snapshot lists them (reminders.reminderOf, by first time). */
function familyReminders() {
  const data = store.snapshot && store.snapshot.data;
  return (data && Array.isArray(data.reminders) && data.reminders) || [];
}

/** One combination's chips: Nichts · Nächste offene · each reminder; the assigned one active. */
function comboChipsHtml(mask, target, reminders) {
  const chip = (value, label) =>
    `<button type="button" class="chip${value === (target || '') ? ' active' : ''}" data-target="${escapeHtml(value)}">${escapeHtml(label)}</button>`;
  return [chip('', t('devices.combo.none')), chip(COMBO_NEXT, t('devices.combo.next')), ...reminders.map((r) => chip(r.eid, r.title))].join('');
}

/** «Kombinationen»: per combination of the sketch's buttons, what it ticks off. */
function combosHtml(combos, reminders) {
  const rows = COMBO_MASKS.map((mask) => {
    const target = combos[String(mask)] || '';
    const gone = target && target !== COMBO_NEXT && !reminders.some((r) => r.eid === target);
    const label = comboLabel(mask);
    return `
      <div class="field combo-field">
        <span class="combo-head">${escapeHtml(label.names)} <span class="combo-buttons">${escapeHtml(label.buttons)}</span></span>
        <div class="chip-row" data-combo="${mask}">${comboChipsHtml(mask, target, reminders)}</div>
        ${gone ? `<p class="hint">${escapeHtml(t('devices.combo.gone'))}</p>` : ''}
      </div>`;
  }).join('');
  return `
      <p class="field-label">${escapeHtml(t('devices.combo.title'))}</p>
      <p class="hint">${escapeHtml(t('devices.combo.hint'))}</p>
      ${reminders.length === 0 ? `<p class="hint">${escapeHtml(t('devices.combo.noReminders'))}</p>` : ''}
      ${rows}`;
}

function detailHtml(entry, code, armed) {
  const d = entry.details;
  return `
    <div class="device-detail">
      <p class="hint">${escapeHtml(t('devices.detail.meta', { name: d.name, day: fmtDayHeading(localDateOf(entry.startedAt)) }))}</p>
      <p class="field-label">${escapeHtml(t('devices.detail.codeLabel'))}</p>
      <div class="recovery-code device-code" data-code translate="no">${escapeHtml(groupedCode(code))}</div>
      <button type="button" class="btn wide" data-copy>${escapeHtml(t('devices.detail.copy'))}</button>
      <p class="hint">${escapeHtml(t('devices.detail.codeHint'))}
        <a href="${SKETCH_URL}" target="_blank" rel="noopener">${escapeHtml(t('devices.detail.sketch'))}</a></p>
      <div data-combos>${combosHtml(d.combos || {}, familyReminders())}</div>
      <button type="button" class="btn wide" data-test>${escapeHtml(t('devices.detail.test'))}</button>
      <p class="hint">${escapeHtml(t('devices.detail.testHint'))}</p>
      <button type="button" class="btn wide danger" data-remove>${escapeHtml(t(armed ? 'devices.detail.removeConfirm' : 'devices.detail.remove'))}</button>
      <p class="hint">${escapeHtml(t('devices.detail.removeHint'))}</p>
    </div>`;
}

/**
 * Open the sheet: without `eid` the add form, with one the device's detail.
 * `onChanged` runs after a device was added or removed.
 */
export function openDeviceSheet({ eid = null, onChanged } = {}) {
  openSheet(t(eid ? 'devices.detail.title' : 'devices.add.title'), (body, close, setGuard) => {
    let dirty = false;
    let armed = false;
    let armTimer = null;
    setGuard(() => !dirty);

    function showDetail(entry) {
      let code;
      try {
        code = store.devices.code(entry.eid);
      } catch (err) {
        toast((err && err.message) || t('devices.detail.gone'));
        close();
        return;
      }
      body.innerHTML = detailHtml(entry, code, armed);
      const codeEl = body.querySelector('[data-code]');
      body.querySelector('[data-copy]').addEventListener('click', async () => {
        try {
          if (!navigator.clipboard) throw new Error('no clipboard');
          await navigator.clipboard.writeText(code);
          toast(t('devices.detail.copied'), 'success');
        } catch {
          // No clipboard API (older WebViews): select the code for a manual copy.
          try {
            const range = document.createRange();
            range.selectNodeContents(codeEl);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
          } catch {
            /* ignore */
          }
          toast(t('devices.detail.copyFailed'), 'info');
        }
      });
      // A tap assigns at once (an update of the device entry); the chip
      // lights before the write lands, a refusal puts the row back.
      body.querySelector('[data-combos]').addEventListener('click', async (ev) => {
        const chip = ev.target.closest('[data-target]');
        const row = chip && chip.closest('[data-combo]');
        if (!row || chip.classList.contains('active')) return;
        const mask = Number(row.dataset.combo);
        const target = chip.dataset.target || null;
        const before = row.innerHTML;
        row.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
        try {
          await store.devices.setCombo(entry.eid, mask, target);
          const gone = row.parentElement.querySelector('p.hint');
          if (gone) gone.remove();
          toast(t('devices.combo.saved', { combo: comboLabel(mask).names, target: chip.textContent }), 'success');
        } catch (err) {
          row.innerHTML = before;
          toast((err && err.message) || t('errors.store.badPage'));
        }
      });
      const testBtn = body.querySelector('[data-test]');
      testBtn.addEventListener('click', async () => {
        testBtn.disabled = true;
        testBtn.textContent = t('devices.detail.testing');
        try {
          await store.devices.press(entry.eid);
          toast(t('devices.detail.tested'), 'success');
          // The press is on the server: the next sync makes the entry — now.
          store.refreshAfterWrite().catch(() => {});
        } catch (err) {
          toast((err && err.message) || t('errors.store.badPage'));
        } finally {
          testBtn.disabled = false;
          testBtn.textContent = t('devices.detail.test');
        }
      });
      const removeBtn = body.querySelector('[data-remove]');
      removeBtn.addEventListener('click', async () => {
        if (!armed) {
          armed = true;
          removeBtn.textContent = t('devices.detail.removeConfirm');
          clearTimeout(armTimer);
          armTimer = setTimeout(() => {
            armed = false;
            removeBtn.textContent = t('devices.detail.remove');
          }, ARM_MS);
          return;
        }
        clearTimeout(armTimer);
        removeBtn.disabled = true;
        removeBtn.textContent = t('devices.detail.removing');
        try {
          await store.devices.remove(entry.eid);
          toast(t('devices.detail.removed', { name: entry.details.name }), 'success');
          close();
          if (onChanged) onChanged();
        } catch (err) {
          toast((err && err.message) || t('errors.store.badPage'));
          armed = false;
          removeBtn.disabled = false;
          removeBtn.textContent = t('devices.detail.remove');
        }
      });
    }

    if (eid) {
      const entry = store.entries.get(eid);
      if (!entry || entry.deletedAt != null || entry.error) {
        toast(t('devices.detail.gone'));
        close();
        return;
      }
      showDetail(entry);
      return;
    }

    body.innerHTML = formHtml();
    const form = body.querySelector('form');
    const nameEl = form.querySelector('[name="name"]');
    const errEl = form.querySelector('.form-error');
    const submitBtn = form.querySelector('[data-submit]');
    nameEl.addEventListener('input', () => {
      dirty = true;
      errEl.textContent = '';
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submitBtn.disabled = true;
      submitBtn.textContent = t('devices.add.working');
      try {
        const entry = await store.devices.add(nameEl.value);
        dirty = false;
        toast(t('devices.add.done', { name: entry.details.name }), 'success');
        if (onChanged) onChanged();
        showDetail(entry);
      } catch (err) {
        // Nothing to show yet: the input stays, the button comes back.
        errEl.textContent = (err && err.message) || t('errors.store.badPage');
        submitBtn.disabled = false;
        submitBtn.textContent = t('devices.add.submit');
      }
    });
    setTimeout(() => nameEl.focus(), 50);
  });
}
