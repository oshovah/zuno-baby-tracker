// "Nachtragen" — create any entry type with a freely chosen time, plus the
// measurement types that have no quick action on the home screen and
// «Erledigt» for a chore that was no reminder.

import { store } from '../store.js';
import { openEntryForm } from '../entry-form.js';
import { TYPE_META, icon } from '../ui.js';
import { t } from '../i18n/index.js';

const CREATE_TYPES = ['breastfeed', 'bottle', 'diaper', 'sleep', 'weight', 'temperature', 'medication', 'task'];

export function renderBackfill(el) {
  // «Stillen» off for the family (Einstellungen › Stillen): no nursing here either.
  const types = CREATE_TYPES.filter((type) => type !== 'breastfeed' || store.settings.current.breastfeeding !== false);
  el.innerHTML = `
    <header class="view-head"><h1>${t('history.backfill.title')}</h1></header>
    <p class="hint">${t('history.backfill.hint')}</p>
    <div class="more-grid">
      ${types.map(
        (type) => `
        <button type="button" class="more-btn ${TYPE_META[type].hue}" data-create="${type}">
          ${icon(type, 'q-emoji')}<span>${TYPE_META[type].label}</span>
        </button>`
      ).join('')}
    </div>`;

  el.querySelectorAll('[data-create]').forEach((btn) =>
    btn.addEventListener('click', () =>
      openEntryForm({
        type: btn.dataset.create,
        onSaved: () => store.refresh().catch(() => {}),
      })
    )
  );

  return () => {};
}
