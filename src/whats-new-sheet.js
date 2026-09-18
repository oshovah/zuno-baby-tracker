// The «Was ist neu» bottom sheet: the entries' notes as a list, one section
// per deploy, an «Alles klar» button. Shown by the shell after an update
// (main.js) and from «Mehr › Anleitung» on demand.

import { openSheet } from './sheet.js';
import { escapeHtml } from './ui.js';
import { t, getLocale, localeMeta } from './i18n/index.js';
import { notesFor } from './whats-new.js';

/** '2026-09-17' (or '2026-09-17-b') → the day in the active language. */
function entryDate(id) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(id));
  if (!m) return escapeHtml(String(id));
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  try {
    return escapeHtml(dt.toLocaleDateString(localeMeta().dateLocale, { day: 'numeric', month: 'long', year: 'numeric' }));
  } catch {
    return escapeHtml(m[0]);
  }
}

export function openWhatsNewSheet(entries) {
  return openSheet(t('shell.whatsNew.title'), (body, close) => {
    const locale = getLocale();
    const sections = entries
      .map(
        (e) => `<section class="whats-new-entry">
          <h3>${entryDate(e.id)}</h3>
          <ul>${notesFor(e, locale)
            .map((n) => `<li>${escapeHtml(n)}</li>`)
            .join('')}</ul>
        </section>`
      )
      .join('');
    body.innerHTML = `
      <div class="whats-new">${sections || `<p class="hint">${escapeHtml(t('shell.whatsNew.empty'))}</p>`}</div>
      <button type="button" class="btn primary big wide" data-ok>${escapeHtml(t('common.action.ok'))}</button>`;
    body.querySelector('[data-ok]').addEventListener('click', close);
  });
}
