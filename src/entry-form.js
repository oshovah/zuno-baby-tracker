// The one entry form: creates ("Nachtragen"/quick sheets) and edits use the
// same sheet, so every type is editable with the same fields it was created
// with. openEntryForm({ type, entry?, onSaved? }). Writes go through
// store.entries (validated, encrypted and synced there); an edit carries the
// seq it was opened with, so a change made on the other phone meanwhile is
// a 409 instead of a silent overwrite (a row deleted there a 404) — either
// way the stale sheet shows the reason and closes.

import { store } from './store.js';
import { t } from './i18n/index.js';
import { openSheet } from './sheet.js';
import { WHO_LABELS } from './reminders.js';
import { doseFor, supplementFor, FORMULA_MAX_LIFE_DAY } from './dose.js';
import { nursingBeforeBottle } from './meals.js';
import { zurichDateOf, shiftZurichDate } from './tz.js';
import {
  escapeHtml,
  TYPE_META,
  DIAPER_KINDS,
  toLocalInput,
  fromLocalInput,
  isoNow,
  nowMs,
  toast,
  icon,
  fmtClock,
  fmtDayHeading,
} from './ui.js';

/** The «Für» control shared by tasks and reminders: Baby · Mama · Papa. */
export function whoSegment(selected) {
  return segmented(
    'who',
    t('forms.field.who'),
    Object.entries(WHO_LABELS).map(([value, label]) => ({ value, label })),
    WHO_LABELS[selected] ? selected : 'baby'
  );
}

const FUTURE_GRACE_MS = 10 * 60000; // matches the store's clock-skew grace (validate.js)
const CONFLICT_CLOSE_MS = 2500; // a 409/404 stays readable this long before the sheet goes

// NOT a <label>: a label's implicit control is its first button, so tapping
// the caption would silently flip the selection to "Links"/"Pipi".
function segmented(name, label, options, selected) {
  return `
    <div class="segmented" role="group" aria-label="${escapeHtml(label)}" data-name="${name}">
      ${options
        .map(
          (o) => `
        <button type="button" aria-pressed="${o.value === selected}"
          class="seg${o.value === selected ? ' active' : ''}" data-value="${escapeHtml(o.value)}">
          ${o.icon ? `${icon(o.icon)} ` : ''}${escapeHtml(o.label)}
        </button>`
        )
        .join('')}
    </div>`;
}

function wireSegmented(root) {
  root.querySelectorAll('.segmented').forEach((group) => {
    group.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg');
      if (!btn) return;
      group.querySelectorAll('.seg').forEach((b) => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      });
    });
  });
}

export function segValue(root, name) {
  const active = root.querySelector(`.segmented[data-name="${name}"] .seg.active`);
  return active ? active.dataset.value : null;
}

export { segmented, wireSegmented };

/** Type-specific fields (create and edit render the same controls). */
function detailFields(type, details) {
  const d = details || {};
  switch (type) {
    case 'breastfeed':
      return `<div class="field"><span>${t('forms.field.side')}</span>${segmented('side', t('forms.field.side'), [
        { value: 'L', label: t('forms.side.left') },
        { value: 'R', label: t('forms.side.right') },
      ], d.side || 'L')}</div>`;
    case 'bottle': {
      // Muttermilch first — it is what the parents reach for first, the
      // formula («Milch (Formula)», the stored `amount_ml`) tops the meal up
      // to the target. No remembered amount: the ★ chip is the one-tap path,
      // and what was pumped differs from meal to meal. The target block, the
      // ★ / «Rest» chips and the sum line are filled by wireBottleDose().
      // Each row has its own three quick picks (Mehr › Einstellungen):
      // bottle-sized ones for Muttermilch, small ones for the top-up.
      const fam = store.settings.current;
      const chips = (name, presets) =>
        presets.map((ml) => `<button type="button" class="chip" data-ml-for="${name}" data-ml="${ml}">${ml} ml</button>`).join('');
      return `
        <div class="dose-info" data-dose-info></div>
        <label class="field"><span>${t('forms.bottle.breastMl')}</span>
          <input name="colostrum_ml" type="number" inputmode="numeric" min="0" max="1000"
            value="${d.colostrum_ml || ''}" placeholder="0" />
        </label>
        <div class="chip-row even">
          <button type="button" class="chip recommended" data-target-milk hidden></button>
          ${chips('colostrum_ml', fam.bottlePresets)}
        </div>
        <label class="field"><span>${t('forms.bottle.formulaMl')} <small>${t('forms.bottle.formulaHint')}</small></span>
          <input name="amount_ml" type="number" inputmode="numeric" min="0" max="1000"
            value="${d.amount_ml || ''}" placeholder="0" />
        </label>
        <div class="chip-row even">
          <button type="button" class="chip recommended" data-rest-formula hidden></button>
          ${chips('amount_ml', fam.formulaPresets)}
        </div>
        <p class="dose-sum" data-dose-sum aria-live="polite"></p>`;
    }
    case 'diaper':
      return `<div class="field"><span>${t('forms.field.diaperKind')}</span>${segmented(
        'kind',
        t('forms.field.diaperKind'),
        Object.entries(DIAPER_KINDS).map(([value, k]) => ({ value, label: k.label, icon: value })),
        d.kind || 'pee'
      )}</div>`;
    case 'sleep':
      return '';
    case 'weight':
      return `<label class="field"><span>${t('forms.field.weight')}</span>
        <input name="grams" type="number" inputmode="numeric" min="300" max="30000"
          value="${d.grams || ''}" placeholder="${t('forms.placeholder.weight')}" required />
      </label>`;
    case 'temperature':
      return `<label class="field"><span>${t('forms.field.temperature')}</span>
        <input name="celsius" type="number" inputmode="decimal" step="0.1" min="30" max="45"
          value="${d.celsius != null ? d.celsius : ''}" placeholder="${t('forms.placeholder.temperature')}" required />
      </label>`;
    case 'medication': {
      const recent = store.snapshot ? store.snapshot.data.recentMedicationNames || [] : [];
      return `
        <label class="field"><span>${t('common.type.medication')}</span>
          <input name="name" type="text" maxlength="100" value="${escapeHtml(d.name || '')}"
            placeholder="${t('forms.placeholder.exampleTitle')}" required />
        </label>
        ${recent.length
          ? `<div class="chip-row">${recent
              .map((n) => `<button type="button" class="chip" data-med="${escapeHtml(n)}">${escapeHtml(n)}</button>`)
              .join('')}</div>`
          : ''}`;
    }
    case 'task': {
      // A ticked-off reminder keeps its reference (readDetails carries it
      // over); the note says which slot it stands for.
      const ref = d.reminderEid && d.due ? `<p class="hint">${t('forms.task.fromReminder', { time: fmtClock(d.due) })}</p>` : '';
      return `
        <label class="field"><span>${t('forms.field.what')}</span>
          <input name="title" type="text" maxlength="100" value="${escapeHtml(d.title || '')}"
            placeholder="${t('forms.placeholder.exampleTitle')}" required />
        </label>
        <div class="field"><span>${t('forms.field.who')}</span>${whoSegment(d.who)}</div>
        ${ref}`;
    }
  }
  return '';
}

/** Read + client-validate the details from the form; throws Error on bad input.
 *  Ranges mirror validate.js (which the store applies again on save) so the
 *  messages here can stay in friendlier German than the rule texts.
 *  `existing` = the edited entry's details (a task keeps its reminder
 *  reference, which has no control of its own). */
function readDetails(type, body, existing = null) {
  switch (type) {
    case 'breastfeed': {
      // A side closed with «Pause» keeps its mark through an edit (the
      // validator drops it again when the edit reopens the timer).
      const out = { side: segValue(body, 'side') || 'L' };
      if (existing && existing.paused === true) out.paused = true;
      return out;
    }
    case 'bottle': {
      // Number(), not parseInt: "0.5" must be rejected loudly, not silently
      // truncated to 0 (colostrum syringes are graded in fractions).
      const mlRaw = body.querySelector('[name="amount_ml"]').value.trim();
      const colRaw = body.querySelector('[name="colostrum_ml"]').value.trim();
      const ml = mlRaw === '' ? 0 : Number(mlRaw);
      const col = colRaw === '' ? 0 : Number(colRaw);
      if (!Number.isInteger(ml) || ml < 0 || ml > 1000 || !Number.isInteger(col) || col < 0 || col > 1000) {
        throw new Error(t('forms.error.bottleWholeMl'));
      }
      if (ml + col < 1) {
        throw new Error(t('forms.error.bottleEmpty'));
      }
      const out = { amount_ml: ml };
      if (col > 0) out.colostrum_ml = col;
      return out;
    }
    case 'diaper':
      return { kind: segValue(body, 'kind') || 'pee' };
    case 'sleep':
      return {};
    case 'weight': {
      const g = parseInt(body.querySelector('[name="grams"]').value, 10);
      if (!Number.isInteger(g) || g < 300 || g > 30000) {
        throw new Error(t('forms.error.weightRange'));
      }
      return { grams: g };
    }
    case 'temperature': {
      const c = parseFloat(body.querySelector('[name="celsius"]').value.replace(',', '.'));
      if (!Number.isFinite(c) || c < 30 || c > 45) {
        throw new Error(t('forms.error.temperatureRange'));
      }
      return { celsius: c };
    }
    case 'medication': {
      const name = body.querySelector('[name="name"]').value.trim();
      if (!name) throw new Error(t('forms.error.nameMissing'));
      return { name };
    }
    case 'task': {
      const title = body.querySelector('[name="title"]').value.trim();
      if (!title) throw new Error(t('forms.error.taskTitleMissing'));
      if ([...title].length > 100) throw new Error(t('forms.error.titleTooLong', { max: 100 }));
      const out = { title, who: segValue(body, 'who') || 'baby' };
      if (existing && existing.reminderEid) out.reminderEid = existing.reminderEid;
      if (existing && existing.due) out.due = existing.due;
      return out;
    }
  }
  return {};
}

/**
 * The Schoppen form's target: the day's rule (dose.doseFor over the family
 * settings, for the Zurich day of the form's time — a Nachtragen for
 * yesterday gets yesterday's Lebenstag), what that day already had in the
 * bottle (store.entries.range, the edited entry included as it stands), the
 * ★ chip that fills Muttermilch to the target, the «Rest» chip that fills the
 * formula up to it, and the sum line under the fields. Everything re-reads
 * on input; the tally waits for store.ready (the form may open straight
 * from the cached paint, before the local rows are decrypted).
 */
function wireBottleDose(body, form, excludeEid) {
  const info = body.querySelector('[data-dose-info]');
  const sum = body.querySelector('[data-dose-sum]');
  const targetChip = body.querySelector('[data-target-milk]');
  const restChip = body.querySelector('[data-rest-formula]');
  const milkInput = form.colostrum_ml;
  const formulaInput = form.amount_ml;
  const num = (input) => {
    const n = Number(input.value.trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  let rowsReady = false;

  /** «Heute schon 190 ml im Schoppen (120 Muttermilch · 70 Formula)» for
   *  `day` — the other bottles of the day, not the one being edited. */
  function tallyHtml(day) {
    if (!rowsReady) return '';
    let milk = 0;
    let formula = 0;
    let count = 0;
    for (const e of store.entries.range(day, day)) {
      if (e.type !== 'bottle' || e.eid === excludeEid) continue;
      count++;
      milk += (e.details && e.details.colostrum_ml) || 0;
      formula += (e.details && e.details.amount_ml) || 0;
    }
    if (!count) return '';
    const when = fmtDayHeading(day);
    const parts = [];
    if (milk) parts.push(t('forms.dose.tallyBreast', { ml: milk }));
    if (formula) parts.push(t('forms.dose.tallyFormula', { ml: formula }));
    const params = { day: escapeHtml(when), ml: milk + formula };
    return `<p>${
      parts.length > 1 ? t('forms.dose.tallyWithParts', { ...params, parts: parts.join(' · ') }) : t('forms.dose.tally', params)
    }</p>`;
  }

  function update() {
    // The form's time (now when the input is empty or unreadable) and its Zurich day.
    const at = fromLocalInput(form.startedAt.value) || isoNow();
    const day = zurichDateOf(at);
    const fam = store.settings.current;
    const dose = doseFor(fam, day);
    // Nurse first, then top up: the nursing this bottle shares its meal with
    // takes the family's estimate off the target (dose.supplementFor) — once
    // the rows are in; before that the whole target stands, like the tally.
    const nursed = rowsReady
      ? nursingBeforeBottle(store.entries.range(shiftZurichDate(day, -1), shiftZurichDate(day, 1)), at, excludeEid)
      : null;
    const sup = supplementFor(dose.mealMl, fam, !!nursed);
    // What the ★ chips and the sum line aim for: the rest after nursing.
    const target = sup.remaining !== null && sup.remaining > 0 ? sup.remaining : null;

    // The target line: the midwife's number, the rule's share, or why there
    // is none (the rule's horizon passed; no birth date yet).
    let line;
    if (dose.source === 'manual') {
      line = dose.lifeDay
        ? t('forms.dose.manualWithDay', { ml: dose.mealMl, day: dose.lifeDay })
        : t('forms.dose.manual', { ml: dose.mealMl });
    } else if (dose.source === 'formula') {
      line = t('forms.dose.rule', { day: dose.lifeDay, ml: dose.mealMl, daily: dose.dailyMl });
    } else if (dose.source === 'expired') {
      line = t('forms.dose.expired', { day: dose.lifeDay, maxDay: FORMULA_MAX_LIFE_DAY });
    } else if (dose.lifeDay === 1) {
      line = t('forms.dose.birthDay');
    } else {
      line = t('forms.dose.noBirthDate');
    }
    // The credit line: what nursing is assumed to have given and what is
    // left for the bottle; with an estimate set and no nursing in this meal,
    // that the bottle carries the whole target.
    let credit = '';
    if (rowsReady && sup.target !== null) {
      if (sup.credit > 0) {
        credit =
          sup.remaining > 0
            ? t('forms.dose.nursed', { credit: sup.credit, rest: sup.remaining })
            : t('forms.dose.nursedCovered', { credit: sup.credit });
      } else if (fam.breastfeeding !== false && Number.isInteger(fam.nursingMl) && fam.nursingMl >= 1) {
        credit = t('forms.dose.notNursed');
      }
    }
    info.innerHTML = `<p class="dose-target">${line}</p>${credit ? `<p class="dose-credit">${credit}</p>` : ''}${tallyHtml(day)}`;

    // The chips: ★ under Muttermilch fills it to the target; ★ under the
    // formula fills THAT up to the target — the rest once some Muttermilch
    // is in, the whole target while there is none.
    const milk = num(milkInput);
    const formula = num(formulaInput);
    targetChip.hidden = !target;
    if (target) {
      targetChip.textContent = `★ ${target} ml`;
      targetChip.dataset.ml = String(target);
      targetChip.setAttribute('aria-label', t('forms.dose.fillBreastAria', { ml: target }));
    }
    const rest = target ? target - milk : 0;
    restChip.hidden = !(target && rest > 0);
    if (target && rest > 0) {
      restChip.textContent = `★ ${rest} ml`;
      restChip.dataset.ml = String(rest);
      restChip.setAttribute(
        'aria-label',
        milk > 0 ? t('forms.dose.topUpFormulaAria', { ml: rest }) : t('forms.dose.fillFormulaAria', { ml: rest })
      );
    }
    // A preset that says the same as the row's ★ chip steps aside.
    body.querySelectorAll('.chip[data-ml-for]').forEach((chip) => {
      const star = chip.dataset.mlFor === 'colostrum_ml' ? targetChip : restChip;
      chip.hidden = !star.hidden && chip.dataset.ml === star.dataset.ml;
    });

    // The sum line.
    const total = milk + formula;
    sum.classList.remove('reached');
    if (total === 0 || (!target && !(milk && formula))) {
      sum.textContent = '';
    } else if (!target) {
      sum.textContent = t('forms.dose.sum', { ml: total });
    } else if (total < target) {
      sum.textContent = t('forms.dose.sumBelow', { ml: total, rest: target - total });
    } else {
      sum.classList.add('reached');
      sum.textContent = total === target
        ? t('forms.dose.sumReached', { ml: total })
        : t('forms.dose.sumAbove', { ml: total, over: total - target });
    }
  }

  targetChip.addEventListener('click', () => {
    milkInput.value = targetChip.dataset.ml;
    update();
  });
  restChip.addEventListener('click', () => {
    formulaInput.value = restChip.dataset.ml;
    update();
  });
  body.querySelectorAll('.chip[data-ml-for]').forEach((chip) =>
    chip.addEventListener('click', () => {
      form[chip.dataset.mlFor].value = chip.dataset.ml;
      update();
    })
  );
  form.addEventListener('input', update);
  update();
  store.ready.then(() => {
    rowsReady = true;
    if (document.body.contains(body)) update();
  });
}

/**
 * Open the sheet. entry = null creates a new entry of `type`; otherwise edits.
 * onSaved() runs after any successful save/delete/restore (views reload there).
 */
export function openEntryForm({ type, entry = null, onSaved = () => {} }) {
  const meta = TYPE_META[type];
  const isEdit = entry !== null;
  const title = isEdit ? t('forms.title.edit', { type: meta.label }) : meta.label;

  openSheet(title, (body, close, setGuard) => {
    const startValue = toLocalInput(isEdit ? entry.startedAt : isoNow());
    const endValue = isEdit && entry.endedAt ? toLocalInput(entry.endedAt) : '';
    const maxValue = toLocalInput(isoNow());

    body.innerHTML = `
      <form class="entry-form" novalidate>
        ${detailFields(type, isEdit ? entry.details : null)}
        <label class="field"><span>${meta.timer ? t('forms.field.start') : t('forms.field.time')}</span>
          <span class="input-row">
            <input name="startedAt" type="datetime-local" value="${startValue}" max="${maxValue}" required />
          </span>
        </label>
        ${meta.timer
          ? `<label class="field"><span>${t('forms.field.end')} <small>${t('forms.field.endHint')}</small></span>
              <span class="end-row">
                <input name="endedAt" type="datetime-local" value="${endValue}" max="${maxValue}" />
                <button type="button" class="chip" data-end-now>${t('forms.action.now')}</button>
              </span>
            </label>`
          : ''}
        ${type === 'breastfeed'
          ? `<p class="chip-row-label">${t('forms.nursing.durationHint')}</p>
            <div class="chip-row even">
              ${[10, 15, 20, 30]
                .map((m) => `<button type="button" class="chip" data-dur-min="${m}">${t('forms.nursing.durationChip', { n: m })}</button>`)
                .join('')}
            </div>`
          : ''}
        <p class="form-error" aria-live="polite"></p>
        <div class="form-actions">
          ${isEdit ? `<button type="button" class="btn danger" data-delete>${t('common.action.delete')}</button>` : ''}
          <button type="submit" class="btn primary">${t('common.action.save')}</button>
        </div>
      </form>`;

    wireSegmented(body);

    body.querySelectorAll('.chip[data-med]').forEach((chip) =>
      chip.addEventListener('click', () => {
        body.querySelector('[name="name"]').value = chip.dataset.med;
      })
    );
    body.querySelector('[data-end-now]')?.addEventListener('click', () => {
      body.querySelector('[name="endedAt"]').value = toLocalInput(isoNow());
    });
    // Duration chips: Ende = Start + X — the natural input when the feed's
    // length is known but its wall-clock end is not.
    body.querySelectorAll('[data-dur-min]').forEach((chip) =>
      chip.addEventListener('click', () => {
        const start = fromLocalInput(form.startedAt.value);
        if (!start) return;
        form.endedAt.value = toLocalInput(
          new Date(new Date(start).getTime() + Number(chip.dataset.durMin) * 60000).toISOString()
        );
      })
    );

    const form = body.querySelector('form');
    const errEl = body.querySelector('.form-error');
    if (type === 'bottle') wireBottleDose(body, form, isEdit ? entry.eid : null);

    // Dismissing a touched form (backdrop/Esc/Back) needs a second tap.
    let dirty = false;
    form.addEventListener('input', () => {
      dirty = true;
    });
    form.addEventListener('click', (e) => {
      if (e.target.closest('.seg, .chip')) dirty = true;
    });
    setGuard(() => !dirty);

    let confirmReopen = false;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errEl.textContent = '';
      const submit = form.querySelector('button[type="submit"]');
      try {
        const details = readDetails(type, body, isEdit ? entry.details : null);
        const startedAt = fromLocalInput(form.startedAt.value);
        if (!startedAt) throw new Error(t('forms.error.timeMissing'));
        if (new Date(startedAt) - nowMs() > FUTURE_GRACE_MS) {
          throw new Error(t('forms.error.timeInFuture'));
        }
        let endedAt = null;
        if (meta.timer) {
          endedAt = form.endedAt.value ? fromLocalInput(form.endedAt.value) : null;
          if (endedAt && new Date(endedAt) - nowMs() > FUTURE_GRACE_MS) {
            throw new Error(t('forms.error.endInFuture'));
          }
          // Clearing a previously set Ende turns the entry back into a RUNNING
          // timer — on quick-logged feeds (Ende == Start) that is usually a
          // mistake, so ask once.
          if (isEdit && entry.endedAt && !endedAt && !confirmReopen) {
            confirmReopen = true;
            errEl.textContent = t('forms.confirm.reopen');
            return;
          }
        }
        submit.disabled = true;
        await store.ready; // local rows decrypted (the form may open straight from the cached paint)
        if (isEdit) {
          // Only send what changed: an untouched time must not lose its
          // seconds to the minute-granular datetime-local input.
          const payload = { details };
          if (form.startedAt.value !== startValue) payload.startedAt = startedAt;
          if (meta.timer && form.endedAt.value !== endValue) payload.endedAt = endedAt;
          // ifSeq = the seq this form was opened with: the store's field
          // merge runs on the current row, but a row that moved meanwhile
          // (other phone) is a 409, never a blind overwrite.
          await store.entries.update(entry.eid, payload, { ifSeq: entry.seq });
          toast(
            meta.timer && !endedAt && entry.endedAt ? t('forms.toast.timerResumed', { type: meta.label }) : t('forms.toast.saved'),
            'success'
          );
        } else {
          const payload = { type, startedAt, details };
          if (meta.timer) payload.endedAt = endedAt;
          await store.entries.create(payload);
          toast(
            meta.timer && !endedAt ? t('forms.toast.timerStarted', { type: meta.label }) : t('forms.toast.typeSaved', { type: meta.label }),
            'success'
          );
        }
        close();
        onSaved();
      } catch (err) {
        errEl.textContent = err.message;
        if (closeWhenMoved(err, () => (submit.disabled = false))) return;
        submit.disabled = false;
      }
    });

    /** Has the entry this form was opened from moved on (edited or deleted elsewhere)? */
    function rowMoved() {
      const cur = store.entries.get(entry.eid);
      return !cur || cur.deletedAt != null || cur.seq !== entry.seq;
    }

    /**
     * A 409/404 on an edit whose row moved under this form (edited or deleted
     * on the other phone — the store has synced and the list behind the sheet
     * re-rendered): the values here are stale, so trying again is not an
     * option. The reason stays readable inline, then the sheet closes so the
     * fresh entry can be reopened. A 409 with the seq unchanged is a local
     * rule (a second open timer) — stay editable. A 404 while the local row
     * still looks live means this phone has not synced the tombstone yet:
     * sync now and close once it landed, else hand the form back (`reenable`).
     * Returns true when the caller must leave its controls disabled.
     */
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

    // Delete = two taps (the second tap confirms), disarming after 3 s so an
    // unrelated graze later can't delete; the toast offers a real undo.
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
          toast(t('forms.toast.entryDeleted'), 'success', {
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
          // Already deleted elsewhere (404): the sheet closes like after a
          // conflicting save — there is nothing left to delete or undo.
          if (closeWhenMoved(err, () => (delBtn.disabled = false))) return;
          delBtn.disabled = false;
        }
      });
    }
  });
}
