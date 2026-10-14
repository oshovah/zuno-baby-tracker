// «Ort melden» in the bottom sheet:
//   openSpotForm({lon, lat, onSent})  a parent reports the place under the
//                                     crosshair: what is there (chips), a
//                                     name, where exactly — sent at once by
//                                     store.spots.suggest, never queued
//   openSpotsSheet()                  the operator's list: the open reports
//                                     (approve as they are, «Bearbeiten &
//                                     freigeben» swaps the body to the same
//                                     form, reject with two taps) and the
//                                     approved places (withdraw with two
//                                     taps), each with «Auf der Karte zeigen»
//                                     and the nearest known place as a
//                                     duplicate warning
// ONE sheet whose body swaps between the list and the form (a second
// openSheet right after close() would race the history pop). The checks
// and shapes are the pure src/spots.js. Everything a report carries is
// user text: escaped before it reaches innerHTML.

import { store } from './store.js';
import { t, localeMeta } from './i18n/index.js';
import { openSheet } from './sheet.js';
import { escapeHtml, toast } from './ui.js';
import { loadPois } from './pois.js';
import { nearest, distanceLabel, poiTitle } from './mapdata.js';
import { SPOT_KINDS, SPOT_NAME_MAX, SPOT_NOTE_MAX, spotText, spotDraftError, withSpots, focusMapAt } from './spots.js';

const ARM_MS = 3000;
/** Beyond this a «nearest known place» is no duplicate warning any more. */
const NEAR_M = 300;
const KIND_KEYS = { changing: 'map.filter.changing', nursing: 'map.filter.nursing' };

const draftErrorText = (error) => t(error, { max: error === 'spots.form.errorName' ? SPOT_NAME_MAX : SPOT_NOTE_MAX });

/** «12. Okt. 2026» for a row's day. */
function dayLabel(iso) {
  try {
    const [y, m, d] = String(iso).split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(localeMeta().dateLocale, { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return String(iso || '');
  }
}

function kindChipsHtml(kinds) {
  return SPOT_KINDS.map(
    (k) => `<button type="button" class="chip${kinds.includes(k) ? ' active' : ''}" data-kind="${k}" aria-pressed="${kinds.includes(k)}">
        <span class="poi-dot${k === 'nursing' ? ' nursing' : ''}" aria-hidden="true"></span>${escapeHtml(t(KIND_KEYS[k]))}</button>`
  ).join('');
}

/** The form both roles use: the kind chips, a name, where exactly (with a counter). */
function formHtml(draft, { intro, privacy, submit }) {
  return `
    <form class="entry-form spot-form" novalidate>
      ${intro ? `<p class="hint">${escapeHtml(intro)}</p>` : ''}
      <div class="field"><span>${escapeHtml(t('spots.form.kindLabel'))}</span>
        <div class="chip-row" role="group" aria-label="${escapeHtml(t('spots.form.kindLabel'))}">${kindChipsHtml(draft.kinds)}</div>
      </div>
      <label class="field"><span>${escapeHtml(t('spots.form.nameLabel'))}</span>
        <input type="text" name="name" maxlength="${SPOT_NAME_MAX + 20}" value="${escapeHtml(draft.name)}"
          placeholder="${escapeHtml(t('spots.form.namePlaceholder'))}" autocomplete="off" />
      </label>
      <label class="field"><span>${escapeHtml(t('spots.form.noteLabel'))}
          <small data-count></small></span>
        <textarea name="note" class="fb-text" rows="3" maxlength="${SPOT_NOTE_MAX + 50}"
          placeholder="${escapeHtml(t('spots.form.notePlaceholder'))}">${escapeHtml(draft.note)}</textarea>
      </label>
      ${privacy ? `<p class="hint">${escapeHtml(privacy)}</p>` : ''}
      <p class="form-error" aria-live="polite"></p>
      <div class="form-actions">
        <button type="submit" class="btn primary" data-submit>${escapeHtml(submit)}</button>
      </div>
    </form>`;
}

/**
 * Wire the form: chips toggle, the counter follows the note, `onDirty` on
 * any input, `onSubmit(values, ctl)` with the raw values and the controls
 * (ctl.error(text), ctl.busy(label), ctl.idle(label)).
 */
function wireForm(body, { onDirty, onSubmit }) {
  const form = body.querySelector('form');
  const nameEl = form.querySelector('[name="name"]');
  const noteEl = form.querySelector('[name="note"]');
  const countEl = form.querySelector('[data-count]');
  const errEl = form.querySelector('.form-error');
  const submitBtn = form.querySelector('[data-submit]');
  const ctl = {
    error(text) {
      errEl.textContent = text || '';
    },
    busy(label) {
      submitBtn.disabled = true;
      submitBtn.textContent = label;
    },
    idle(label) {
      submitBtn.disabled = false;
      submitBtn.textContent = label;
    },
  };
  const read = () => ({
    kinds: [...form.querySelectorAll('[data-kind].active')].map((b) => b.dataset.kind),
    name: nameEl.value,
    note: noteEl.value,
  });
  const syncCount = () => {
    const n = [...spotText(noteEl.value)].length;
    countEl.textContent = t('spots.form.count', { n, max: SPOT_NOTE_MAX });
    countEl.classList.toggle('over', n > SPOT_NOTE_MAX);
  };
  const touched = () => {
    errEl.textContent = '';
    onDirty();
  };
  form.querySelectorAll('[data-kind]').forEach((b) =>
    b.addEventListener('click', () => {
      const on = !b.classList.contains('active');
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
      touched();
    })
  );
  nameEl.addEventListener('input', touched);
  noteEl.addEventListener('input', () => {
    touched();
    syncCount();
  });
  syncCount();
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    onSubmit(read(), ctl);
  });
}

/** A parent reports the place at (lon, lat) — the map centre under the crosshair. */
export function openSpotForm({ lon, lat, onSent }) {
  openSheet(t('spots.form.title'), (body, close, setGuard) => {
    body.innerHTML = formHtml({ kinds: [], name: '', note: '' }, { intro: t('spots.form.intro'), privacy: t('spots.form.privacy'), submit: t('spots.form.send') });
    let dirty = false;
    setGuard(() => !dirty);
    wireForm(body, {
      onDirty: () => {
        dirty = true;
      },
      onSubmit: async (values, ctl) => {
        const draft = { lat, lon, ...values };
        const error = spotDraftError(draft);
        if (error) {
          ctl.error(draftErrorText(error));
          return;
        }
        ctl.busy(t('spots.form.sending'));
        try {
          await store.spots.suggest(draft);
          dirty = false;
          toast(t('spots.form.sent'), 'success');
          close();
          if (onSent) onSent();
        } catch (err) {
          // Nothing was stored: the input stays, the button comes back.
          ctl.error(err && err.code === 'spots.unavailable' ? t('spots.form.unavailable') : err.message);
          ctl.idle(t('spots.form.send'));
        }
      },
    });
  });
}

/** The operator's list of reported places. */
export function openSpotsSheet() {
  openSheet(t('spots.sheet.title'), (body, close, setGuard) => {
    let pending = [];
    let loading = true;
    let mode = 'list'; // 'list' | 'edit'
    let dirty = false;
    let armedId = null;
    let armTimer = null;
    let known = null; // every place the phone knows (the OSM file + the approved reports), for the duplicate warning
    setGuard(() => !dirty);

    // store.spots.items carry no status (the public shape); here they are the approved ones.
    const approved = () => store.spots.items.map((s) => ({ ...s, status: 'approved' }));
    const find = (id) => pending.find((s) => s.id === id) || approved().find((s) => s.id === id) || null;

    function nearestLine(spot) {
      if (!known) return '';
      const others = known.filter((f) => f.properties.id !== `s${spot.id}`);
      const hit = nearest(others, spot.lon, spot.lat, 1)[0];
      if (!hit || hit.meters > NEAR_M) return t('spots.sheet.nearestNone');
      return t('spots.sheet.nearest', { name: poiTitle(hit.feature.properties), d: distanceLabel(hit.meters) });
    }

    function itemHtml(spot, open) {
      const armed = armedId === spot.id;
      const kinds = spot.kinds
        .map((k) => `<span class="poi-dot${k === 'nursing' ? ' nursing' : ''}" aria-hidden="true"></span>${escapeHtml(t(KIND_KEYS[k]))}`)
        .join(' · ');
      const when = open && spot.createdAt ? t('spots.sheet.reported', { date: dayLabel(spot.createdAt) }) : '';
      const removeKey = open ? (armed ? 'spots.sheet.rejectConfirm' : 'spots.sheet.reject') : armed ? 'spots.sheet.withdrawConfirm' : 'spots.sheet.withdraw';
      return `
        <article class="spot-item">
          <p class="spot-head"><span class="spot-kinds">${kinds}</span>${when ? `<span class="spot-when">${escapeHtml(when)}</span>` : ''}</p>
          <p class="spot-name">${spot.name ? `<strong>${escapeHtml(spot.name)}</strong>` : `<em class="spot-noname">${escapeHtml(t('spots.sheet.noName'))}</em>`}</p>
          ${spot.note ? `<p class="spot-note">${escapeHtml(spot.note)}</p>` : ''}
          <p class="hint spot-near">${escapeHtml(nearestLine(spot))}</p>
          <span class="fb-actions">
            <button type="button" class="chip" data-map="${spot.id}">${escapeHtml(t('map.showOnMap'))}</button>
            ${open ? `<button type="button" class="chip" data-edit="${spot.id}">${escapeHtml(t('spots.sheet.edit'))}</button>
            <button type="button" class="chip" data-approve="${spot.id}">${escapeHtml(t('spots.sheet.approve'))}</button>` : ''}
            <button type="button" class="chip${armed ? ' danger' : ''}" data-remove="${spot.id}">${escapeHtml(t(removeKey))}</button>
          </span>
        </article>`;
    }

    function renderList() {
      mode = 'list';
      const open = pending.map((s) => itemHtml(s, true)).join('');
      const done = approved()
        .map((s) => itemHtml(s, false))
        .join('');
      body.innerHTML = `
        <div class="spots-list">
          <h3 class="section-title">${escapeHtml(t('spots.sheet.pendingHead'))}</h3>
          ${loading ? `<p class="hint">${escapeHtml(t('spots.sheet.loading'))}</p>` : open || `<p class="hint">${escapeHtml(t('spots.sheet.emptyPending'))}</p>`}
          <h3 class="section-title">${escapeHtml(t('spots.sheet.approvedHead'))}</h3>
          ${done || `<p class="hint">${escapeHtml(t('spots.sheet.emptyApproved'))}</p>`}
        </div>`;
    }

    /** «Bearbeiten & freigeben»: the form, prefilled; «Freigeben» saves the corrections and approves. */
    function renderEdit(spot) {
      mode = 'edit';
      body.innerHTML = `${formHtml(spot, { intro: t('spots.sheet.editTitle'), submit: t('spots.sheet.approve') })}
        <button type="button" class="btn wide" data-back>${escapeHtml(t('spots.sheet.back'))}</button>`;
      wireForm(body, {
        onDirty: () => {
          dirty = true;
        },
        onSubmit: async (values, ctl) => {
          const error = spotDraftError({ lat: spot.lat, lon: spot.lon, ...values });
          if (error) {
            ctl.error(draftErrorText(error));
            return;
          }
          ctl.busy(t('spots.form.sending'));
          try {
            await store.spots.save(spot, { approve: true, kinds: values.kinds, name: spotText(values.name), note: spotText(values.note) });
            dirty = false;
            pending = pending.filter((s) => s.id !== spot.id);
            toast(t('spots.sheet.approved'), 'success');
            refreshKnown();
            renderList();
          } catch (err) {
            ctl.error(err.message);
            ctl.idle(t('spots.sheet.approve'));
          }
        },
      });
      body.querySelector('[data-back]').addEventListener('click', () => {
        dirty = false;
        renderList();
      });
      body.scrollTop = 0;
    }

    function disarm() {
      clearTimeout(armTimer);
      armTimer = null;
      armedId = null;
    }

    async function refreshKnown() {
      try {
        const fc = await loadPois();
        known = withSpots(fc.features, store.spots.items);
      } catch {
        known = withSpots([], store.spots.items); // no places file: the approved reports still warn
      }
    }

    body.addEventListener('click', async (e) => {
      if (mode !== 'list') return;
      const mapBtn = e.target.closest('[data-map]');
      if (mapBtn) {
        const spot = find(Number(mapBtn.dataset.map));
        if (!spot) return;
        focusMapAt({ lon: spot.lon, lat: spot.lat, zoom: 17 });
        await close(); // the sheet's history entry must be gone before the hash moves
        location.hash = '#/karte';
        return;
      }
      const edit = e.target.closest('[data-edit]');
      if (edit) {
        const spot = find(Number(edit.dataset.edit));
        if (spot) renderEdit(spot);
        return;
      }
      const approve = e.target.closest('[data-approve]');
      if (approve) {
        const spot = find(Number(approve.dataset.approve));
        if (!spot) return;
        approve.disabled = true;
        try {
          await store.spots.save(spot, { approve: true });
          pending = pending.filter((s) => s.id !== spot.id);
          toast(t('spots.sheet.approved'), 'success');
          await refreshKnown();
        } catch (err) {
          toast(err.message);
        }
        if (mode === 'list') renderList();
        return;
      }
      const remove = e.target.closest('[data-remove]');
      if (remove) {
        const id = Number(remove.dataset.remove);
        if (armedId !== id) {
          disarm();
          armedId = id;
          armTimer = setTimeout(() => {
            disarm();
            if (mode === 'list') renderList();
          }, ARM_MS);
          renderList();
          return;
        }
        disarm();
        const spot = find(id);
        if (!spot) return;
        try {
          await store.spots.remove(spot);
          pending = pending.filter((s) => s.id !== id);
          toast(t(spot.status === 'approved' ? 'spots.sheet.withdrawn' : 'spots.sheet.rejected'), 'success');
          await refreshKnown();
        } catch (err) {
          toast(err.message);
        }
        if (mode === 'list') renderList();
      }
    });

    renderList();
    (async () => {
      try {
        pending = await store.spots.pendingList();
      } catch (err) {
        toast(err.message);
      }
      loading = false;
      if (!body.isConnected) return;
      renderList();
      await refreshKnown();
      if (body.isConnected && mode === 'list') renderList();
    })();
  });
}
