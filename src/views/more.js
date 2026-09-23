// "Mehr" — the family's reminders, per-device and family settings, the
// account (display name, own password, logout) with the family below it
// (password, recovery code, export, encryption status), and the how-to.
//
// Every key flow lives in session.js; this view only collects the typed
// passwords, shows the KDF/server progress on the submit button and toasts
// the German result. Nothing here talks to the API directly.

import * as session from '../session.js';
import { store, prefs, DEFAULT_BOTTLE_PRESETS, DEFAULT_FORMULA_PRESETS, HOME_CARDS } from '../store.js';
import { openReminderForm } from '../reminder-form.js';
import { howtoHtml } from './howto.js';
import { reminderScheduleLabel } from '../reminders.js';
import { escapeHtml, toast, localToday, fmtClock, fmtDayHeading, localDateOf, icon, isoNow } from '../ui.js';
import {
  doseFor,
  mealTargetMl,
  lastWeight,
  lifeWeek,
  ML_PER_LIFE_DAY,
  FORMULA_MAX_LIFE_DAY,
  GUIDE_MAX_LIFE_DAY,
  WEIGHT_MAX_AGE_DAYS,
  DAILY_MAX_ML,
  MEAL_MAX_ML,
  AGE_DAILY_START_ML,
  AGE_DAILY_STEP_ML,
  AGE_DAILY_TOP_ML,
  MEALS_PER_DAY_MIN,
  MEALS_PER_DAY_MAX,
  DEFAULT_MEALS_PER_DAY,
} from '../dose.js';
import { zurichDateOf } from '../tz.js';
import { THEMES, DEFAULT_THEME, SCHEMES, applyTheme, applyScheme } from '../themes/index.js';
import { t, tn, availableLocales, getLocale, setLocale } from '../i18n/index.js';
import { openWhatsNewSheet } from '../whats-new-sheet.js';
import { WHATS_NEW } from '../whats-new.js';

// Labels are read when shown (getters), never at module load: the language
// can switch while the app runs.
const HOME_CARD_LABELS = {
  get sleep() { return t('common.type.sleep'); },
  get reminders() { return t('more.pane.reminders'); },
  get both() { return t('more.homeCard.both'); },
  get none() { return t('more.homeCard.none'); },
};

/** The two display-name chips in the active language — a tap stores the word as shown. */
const presetNames = () => [t('common.who.mama'), t('common.who.papa')];

/** The "Angemeldet als …" line. Every value comes from the server — escape. */
function accountHtml() {
  const u = prefs.user;
  if (!u) return '…';
  // A cookie-only boot (lost localStorage) knows the username before the
  // profile blob is decrypted — the username stands in until then.
  const name = u.displayName || u.username;
  return t('more.account.signedInAs', {
    name: escapeHtml(name),
    username: escapeHtml(u.username),
    family: escapeHtml(u.familyName || ''),
  });
}

/** «Zuletzt geändert von Mama · Heute 14:03» under the family settings, or
 *  the note that the family has not saved one yet. */
function familyMetaHtml() {
  const meta = store.settings.meta;
  if (!meta) return t('more.family.meta.none');
  const when = { day: escapeHtml(fmtDayHeading(localDateOf(meta.changedAt))), time: fmtClock(meta.changedAt) };
  if (meta.changedBy) return t('more.family.meta.changedBy', { ...when, name: escapeHtml(meta.changedBy) });
  return t('more.family.meta.changed', when);
}

/** «Heute Tag 8: 420 ml am Tag, ≈ 70 ml pro Mahlzeit.» — what the drinking
 *  target settings amount to today (dose.doseFor over the Zurich day, like
 *  «Heute» on the home screen), by the first days' rule, by the last weight
 *  (the snapshot's latest reading, so the cached paint has it) or by age. */
function dosePreviewHtml(fam) {
  const last = store.snapshot && store.snapshot.data.lastByType && store.snapshot.data.lastByType.weight;
  const weight = lastWeight(last ? [last] : []);
  const dose = doseFor(fam, zurichDateOf(isoNow()), weight);
  // Whole sentences, joined by a space — never fragments of one.
  const sentences = (...parts) => parts.filter(Boolean).join(' ');
  const manual = dose.source === 'manual' ? t('more.dose.manualApplies', { ml: dose.mealMl }) : '';
  if (!fam.birthDate) return sentences(t('more.dose.noBirthDate'), manual);
  if (!dose.lifeDay) return sentences(t('more.dose.birthInFuture'), manual);
  if (dose.lifeDay === 1) return sentences(t('more.dose.firstDay'), manual);
  if (dose.lifeDay > GUIDE_MAX_LIFE_DAY) {
    return sentences(
      t('more.dose.ruleExpired', { day: dose.lifeDay, max: GUIDE_MAX_LIFE_DAY }),
      manual || t('more.dose.afterRule')
    );
  }
  const params = {
    day: dose.lifeDay,
    week: lifeWeek(dose.lifeDay),
    daily: dose.dailyMl,
    share: mealTargetMl(dose.dailyMl, dose.mealsPerDay),
    meals: dose.mealsPerDay,
  };
  let today;
  if (dose.rule === 'weight') {
    today = t('more.dose.todayByWeight', { ...params, grams: weight.grams, weighed: escapeHtml(fmtDayHeading(localDateOf(weight.at))) });
  } else if (dose.rule === 'age') {
    today = sentences(t('more.dose.todayByAge', params), t('more.dose.weightHint', { days: WEIGHT_MAX_AGE_DAYS }));
  } else {
    today = t('more.dose.today', params);
  }
  return sentences(today, manual ? t('more.dose.manualOverrides', { ml: dose.mealMl }) : '');
}

/** The family's reminders as tappable rows (from the snapshot, so the cached
 *  paint has them), or the empty note. */
function reminderListHtml() {
  const list = (store.snapshot && store.snapshot.data.reminders) || [];
  if (list.length === 0) {
    return `<p class="hint">${t('more.reminders.empty')}</p>`;
  }
  return list
    .map(
      (r) => `
      <button type="button" class="entry-row reminder-row" data-reminder="${r.eid}">
        ${icon('reminder', 'e-emoji')}
        <span class="e-text">
          <span class="e-summary">${escapeHtml(r.title)}${r.note ? ` · ${escapeHtml(r.note)}` : ''}</span>
          <span class="e-by">${escapeHtml(reminderScheduleLabel(r))}</span>
        </span>
        <span class="e-chevron" aria-hidden="true">›</span>
      </button>`
    )
    .join('');
}

/** The note under the reminders while this phone does not show them on «Jetzt». */
function homeCardNoteHtml() {
  if (prefs.homeCard === 'reminders' || prefs.homeCard === 'both') {
    return '';
  }
  const note = prefs.homeCard === 'sleep' ? 'more.reminders.homeCardNote.sleep' : 'more.reminders.homeCardNote.none';
  return `<p class="notice" data-home-card-note>${t(note)} <button type="button" class="link-btn" data-show-reminders>${t(
    'more.reminders.showOnHome'
  )}</button></p>`;
}

/** Encryption status: undecryptable rows, else all good. */
function cryptoStatusHtml() {
  const lines = [];
  const n = store.decryptErrors;
  if (n >= 1) lines.push(tn('more.crypto.undecryptable', n));
  if (lines.length === 0) {
    lines.push(store.keyState === 'ready' ? t('more.crypto.allGood') : t('more.crypto.noKey'));
  }
  return lines.map((line) => `<p class="hint">${escapeHtml(line)}</p>`).join('');
}

/**
 * Run a session flow from a form: every control is disabled meanwhile and
 * the submit button shows the stage the flow reports ('kdf' = PBKDF2, the
 * one slow step; 'server' = the request). Resolves with the flow's result,
 * rejects with its error — the caller toasts.
 */
async function runForm(form, flow, serverLabel = t('more.progress.saving')) {
  const btn = form.querySelector('button[type="submit"]');
  const controls = [...form.querySelectorAll('input, button')];
  const idle = btn.textContent;
  controls.forEach((c) => (c.disabled = true));
  const onProgress = (stage) => {
    btn.textContent = stage === 'kdf' ? t('more.progress.kdf') : serverLabel;
  };
  try {
    return await flow({ onProgress });
  } finally {
    btn.textContent = idle;
    controls.forEach((c) => (c.disabled = false));
  }
}

// --- export ------------------------------------------------------------------

const canDownload = () => typeof HTMLAnchorElement !== 'undefined' && 'download' in HTMLAnchorElement.prototype;

function isStandalone() {
  try {
    return (
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      navigator.standalone === true
    );
  } catch {
    return false;
  }
}

/**
 * Hand `text` to the user as a file: a Blob URL <a download> where the
 * browser supports it, the share sheet (navigator.share with a File —
 * "In Dateien sichern") where it does not. An installed iOS app counts as
 * "does not": its download links do nothing. Resolves with false when the
 * user dismissed the share sheet.
 */
async function deliverFile(name, text) {
  const type = 'application/json';
  let file = null;
  try {
    file = new File([text], name, { type });
  } catch {
    file = null;
  }
  const shareable = !!(
    file &&
    typeof navigator.share === 'function' &&
    typeof navigator.canShare === 'function' &&
    navigator.canShare({ files: [file] })
  );
  const share = async () => {
    try {
      await navigator.share({ files: [file], title: name });
      return true;
    } catch (err) {
      if (err && err.name === 'AbortError') return false;
      // e.g. NotAllowedError when the tap is too long ago — a second tap works.
      throw new Error(t('more.export.shareFailed'));
    }
  };

  if (shareable && (isStandalone() || !canDownload())) return share();
  if (canDownload()) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoking at once cancels the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return true;
  }
  if (shareable) return share();
  throw new Error(t('more.export.unsupported'));
}

/**
 * Every decrypted entry as a JSON file — the last-resort recovery from any
 * logged-in device. Waits for the local rows; when the last sync is old (or
 * the first one is still running, e.g. right after a login) it syncs first
 * so the file is complete — a failed sync exports what this device holds.
 */
async function exportData() {
  if (store.keyState !== 'ready') throw new Error(t('more.error.locked'));
  await store.ready;
  if (store.isStale()) {
    try {
      await store.refresh();
    } catch {
      /* offline: export the local state */
    }
  }
  const entries = store.exportPlain();
  const u = prefs.user;
  const payload = {
    format: 'baby-tracker-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    family: u ? u.familyName : null,
    exportedBy: u ? u.username : null,
    undecryptable: store.decryptErrors,
    entries,
  };
  const delivered = await deliverFile(`baby-tracker-export-${localToday()}.json`, JSON.stringify(payload, null, 2));
  return delivered ? entries.length : null;
}

// --- the view ------------------------------------------------------------------

// The four panes of «Mehr»: the family's reminders first (the one thing
// here that is edited every few days), then the everyday settings (Schoppen
// amounts, install tip), then the own account with everything the family
// shares below it, then the how-to. The pane lives in the hash (#/mehr,
// #/mehr/einstellungen, #/mehr/konto, #/mehr/anleitung) so a toast can
// deep-link to it; #/mehr/familie (the recovery nag, older links) opens the
// Konto pane scrolled to its family half. Switching panes only toggles
// [hidden] and rewrites the hash without a hashchange, so typed input
// survives.
const PANES = [
  { key: 'erinnerungen', get label() { return t('more.pane.reminders'); }, hash: '#/mehr' },
  { key: 'einstellungen', get label() { return t('more.pane.settings'); }, hash: '#/mehr/einstellungen' },
  { key: 'konto', get label() { return t('more.pane.account'); }, hash: '#/mehr/konto' },
  { key: 'anleitung', get label() { return t('more.pane.guide'); }, hash: '#/mehr/anleitung' },
];

function paneFromHash() {
  const m = (location.hash || '').match(/^#\/mehr\/(einstellungen|konto|familie|anleitung)\/?$/);
  if (!m) return 'erinnerungen';
  return m[1] === 'familie' ? 'konto' : m[1];
}

const isFamilyLink = () => /^#\/mehr\/familie\/?$/.test(location.hash || '');

/** The dot on a sub tab: something to do there (the unconfirmed recovery
 *  code under Konto, the unread how-to after a sign-up). */
function paneDot(key) {
  const on = (key === 'konto' && prefs.recoveryPending) || (key === 'anleitung' && prefs.howtoPending);
  return on ? `<span class="seg-dot" aria-label="${escapeHtml(t('more.pane.dot'))}"></span>` : '';
}

export function renderMore(el) {
  let disposed = false;
  let unsubscribe = null;
  let flushFamilyInputs = () => {};

  function render() {
    const user = prefs.user;
    const name = user ? user.displayName || '' : '';
    const presets = presetNames();
    const isCustom = name && !presets.includes(name);
    const pane = paneFromHash();
    const fam = store.settings.current;
    const paneAttr = (key) => `class="pane" data-pane="${key}"${pane === key ? '' : ' hidden'}`;
    /** A translated text inside an attribute value (quotes must not end it). */
    const attr = (key, params) => escapeHtml(t(key, params));
    const min = session.PASSWORD_MIN;
    // The two preset rows of the Schoppen form, keyed by their settings key.
    const presetRows = [
      { key: 'bottlePresets', label: t('common.milk.breast') },
      { key: 'formulaPresets', label: t('common.milk.formula') },
    ];
    const locale = getLocale();

    el.innerHTML = `
      <header class="view-head"><h1>${t('shell.tab.more')}</h1></header>
      <div class="segmented subtabs" role="tablist" aria-label="${attr('more.pane.list')}">
        ${PANES.map(
          (p) => `<button type="button" class="seg${pane === p.key ? ' active' : ''}" role="tab"
            aria-selected="${pane === p.key}" data-subtab="${p.key}">${p.label}${paneDot(p.key)}</button>`
        ).join('')}
      </div>

      <section ${paneAttr('erinnerungen')}>
      <h2 class="section-title">${t('more.pane.reminders')}</h2>
      <p class="hint">${t('more.reminders.hint')}</p>
      <div class="reminder-list" data-reminder-list>${reminderListHtml()}</div>
      <button type="button" class="btn wide" data-add-reminder>${t('more.reminders.add')}</button>
      <div data-home-card-note-wrap>${homeCardNoteHtml()}</div>
      </section>

      <section ${paneAttr('einstellungen')}>
      <p class="group-label">${t('more.settings.familyGroup')}</p>
      <p class="hint">${t('more.settings.familyHint')} <span data-family-meta>${familyMetaHtml()}</span></p>

      <h2 class="section-title">${t('more.dose.title')}</h2>
      <p class="hint">${t('more.dose.hint', {
        days: FORMULA_MAX_LIFE_DAY,
        ml: ML_PER_LIFE_DAY,
        dayMax: DAILY_MAX_ML,
        mealMax: MEAL_MAX_ML,
        weightDays: WEIGHT_MAX_AGE_DAYS,
        ageStart: AGE_DAILY_START_ML,
        ageStep: AGE_DAILY_STEP_ML,
        ageTop: AGE_DAILY_TOP_ML,
      })}</p>
      <p class="hint">${t('more.dose.hintPlan')}</p>
      <div class="dose-row">
        <label class="field"><span>${t('more.dose.birthDate')}</span>
          <input type="date" value="${fam.birthDate || ''}" max="${localToday()}" data-birth-date />
        </label>
        <label class="field"><span>${t('more.dose.mealsPerDay')}</span>
          <input type="number" inputmode="numeric" min="${MEALS_PER_DAY_MIN}" max="${MEALS_PER_DAY_MAX}"
            placeholder="${DEFAULT_MEALS_PER_DAY}" value="${fam.mealsPerDay || ''}" data-meals-per-day />
        </label>
      </div>
      <p class="hint" data-dose-preview>${dosePreviewHtml(fam)}</p>

      <h2 class="section-title">${t('more.recommended.title')}</h2>
      <p class="hint">${t('more.recommended.hint')}</p>
      <div class="preset-row">
        <input type="number" inputmode="numeric" min="1" max="1000" placeholder="${attr('more.recommended.placeholder')}"
          value="${fam.recommendedMl || ''}" data-recommended aria-label="${attr('more.recommended.inputLabel')}" />
      </div>

      <h2 class="section-title">${t('more.presets.title')}</h2>
      <p class="hint">${t('more.presets.hint')}</p>
      ${presetRows
        .map(
          ({ key, label }) => `
      <p class="preset-label">${label}</p>
      <div class="preset-row" data-presets="${key}">
        ${fam[key]
          .map(
            (ml, i) => `<input type="number" inputmode="numeric" min="1" max="1000"
              value="${ml}" data-preset="${i}" aria-label="${attr('more.presets.inputLabel', { row: label, n: i + 1 })}" />`
          )
          .join('')}
        <button type="button" class="chip" data-preset-reset="${key}">${t('more.presets.reset')}</button>
      </div>`
        )
        .join('')}

      <h2 class="section-title">${t('more.nursing.title')}</h2>
      <label class="confirm-row switch-row">
        <input type="checkbox" data-breastfeeding ${fam.breastfeeding !== false ? 'checked' : ''} />
        <span>${t('more.nursing.enabled')}</span>
      </label>
      <p class="hint">${t('more.nursing.enabledHint')}</p>
      <div data-nursing-block ${fam.breastfeeding !== false ? '' : 'hidden'}>
        <p class="preset-label">${t('more.nursing.mlLabel')}</p>
        <div class="preset-row">
          <input type="number" inputmode="numeric" min="1" max="1000" placeholder="${attr('more.nursing.placeholder')}"
            value="${fam.nursingMl || ''}" data-nursing-ml aria-label="${attr('more.nursing.inputLabel')}" />
        </div>
        <p class="hint">${t('more.nursing.hint')}</p>
      </div>

      <h2 class="section-title">${t('more.interval.title')}</h2>
      <label class="confirm-row switch-row">
        <input type="checkbox" data-feed-from-start ${fam.feedFromStart ? 'checked' : ''} />
        <span>${t('more.interval.fromStart')}</span>
      </label>
      <p class="hint">${t('more.interval.hint')}</p>

      <p class="group-label">${t('more.settings.deviceGroup')}</p>

      <h2 class="section-title">${t('more.homeCard.title')}</h2>
      <p class="hint">${t('more.homeCard.hint')}</p>
      <div class="segmented two-by-two" role="radiogroup" aria-label="${attr('more.homeCard.groupLabel')}" data-home-cards>
        ${HOME_CARDS.map((id) => {
          const on = id === prefs.homeCard;
          return `<button type="button" class="seg${on ? ' active' : ''}" role="radio"
            aria-checked="${on}" data-home-card="${id}">${HOME_CARD_LABELS[id]}</button>`;
        }).join('')}
      </div>

      <h2 class="section-title">${t('more.screen.title')}</h2>
      ${'wakeLock' in navigator
        ? `<label class="confirm-row switch-row">
            <input type="checkbox" data-keep-awake ${prefs.keepAwake ? 'checked' : ''} />
            <span>${t('more.screen.keepAwake')}</span>
          </label>
          <p class="hint">${t('more.screen.keepAwakeHint')}</p>`
        : `<p class="hint">${t('more.screen.unsupported')}</p>`}

      <h2 class="section-title">${t('more.app.title')}</h2>
      <p class="hint">${t('more.app.installHint')}</p>

      <h2 class="section-title">${t('more.theme.title')}</h2>
      <div class="theme-list" role="radiogroup" aria-label="${attr('more.theme.title')}" data-themes>
        ${THEMES.map((th) => {
          const on = th.id === (prefs.theme || DEFAULT_THEME);
          return `<button type="button" class="theme-option${on ? ' active' : ''}" role="radio"
            aria-checked="${on}" data-theme-id="${th.id}">
            <span class="swatch" data-theme="${th.id}" aria-hidden="true"><i style="background: var(--bg)"></i><i
              style="background: var(--surface-2)"></i><i style="background: var(--milk)"></i><i
              style="background: var(--diaper)"></i><i style="background: var(--sleep)"></i></span>
            <span class="theme-text"><b>${escapeHtml(th.name)}</b><small>${escapeHtml(th.description)}</small></span>
          </button>`;
        }).join('')}
      </div>

      <h2 class="section-title">${t('more.scheme.title')}</h2>
      <p class="hint">${t('more.scheme.hint')}</p>
      <div class="segmented" role="radiogroup" aria-label="${attr('more.scheme.title')}">
        ${SCHEMES.map((s) => {
          const on = (s.id || '') === (prefs.scheme || '');
          return `<button type="button" class="seg${on ? ' active' : ''}" role="radio"
            aria-checked="${on}" data-scheme="${s.id || ''}">${s.label}</button>`;
        }).join('')}
      </div>

      <h2 class="section-title">${t('common.language')}</h2>
      <div class="segmented" role="radiogroup" aria-label="${attr('common.language')}" data-langs>
        ${availableLocales()
          .map((l) => {
            const on = l.id === locale;
            return `<button type="button" class="seg${on ? ' active' : ''}" role="radio"
            aria-checked="${on}" data-lang="${l.id}" lang="${l.id}">${escapeHtml(l.name)}</button>`;
          })
          .join('')}
      </div>
      </section>

      <section ${paneAttr('konto')}>
      <p class="group-label">${t('more.account.group')}</p>
      <p data-account>${accountHtml()}</p>

      <h2 class="section-title">${t('more.account.displayName')}</h2>
      <p class="hint">${t('more.account.displayNameHint')}</p>
      <div class="chip-row" data-who>
        ${presets
          .map(
            (p) =>
              `<button type="button" class="chip${name === p ? ' active' : ''}" data-name="${escapeHtml(p)}">${escapeHtml(p)}</button>`
          )
          .join('')}
        <input type="text" maxlength="40" placeholder="${attr('more.account.otherName')}" value="${isCustom ? escapeHtml(name) : ''}" />
      </div>

      <h2 class="section-title">${t('more.password.change')}</h2>
      <p class="hint">${t('more.password.hint')}</p>
      <form class="stack-form" data-own-pw novalidate>
        <input type="password" name="currentPassword" autocomplete="current-password"
          placeholder="${attr('more.password.current')}" aria-label="${attr('more.password.current')}" required />
        <input type="password" name="newPassword" autocomplete="new-password" minlength="${min}"
          placeholder="${attr('more.password.newPlaceholder', { min })}" aria-label="${attr('more.password.new')}" required />
        <button type="submit" class="btn wide">${t('more.password.change')}</button>
      </form>

      <h2 class="section-title">${t('more.logout.action')}</h2>
      <p class="hint">${t('more.logout.hint')}</p>
      <p class="hint danger-text" data-logout-hint hidden></p>
      <button type="button" class="btn wide" data-logout>${t('more.logout.action')}</button>

      <p class="group-label" data-family-group>${t('more.family.group', { name: escapeHtml((user && user.familyName) || '') })}</p>
      <p class="hint">${t('more.family.hint')}</p>

      <h2 class="section-title">${t('more.familyPassword.title')}</h2>
      <p class="hint">${t('more.familyPassword.hint')}</p>
      <form class="stack-form" data-family-pw novalidate>
        <input type="password" name="familyPassword" autocomplete="new-password" minlength="${min}"
          placeholder="${attr('more.familyPassword.newPlaceholder', { min })}" aria-label="${attr('more.familyPassword.new')}" required />
        <input type="password" name="currentPassword" autocomplete="current-password"
          placeholder="${attr('more.familyPassword.confirm')}" aria-label="${attr('more.familyPassword.confirm')}" required />
        <button type="submit" class="btn wide">${t('more.familyPassword.submit')}</button>
      </form>

      <h2 class="section-title">${t('more.recovery.title')}</h2>
      <p class="hint">${t('more.recovery.hint')}</p>
      <p class="notice" data-recovery-pending${prefs.recoveryPending ? '' : ' hidden'}>
        <strong>${t('more.recovery.pendingTitle')}</strong> ${t('more.recovery.pendingHint')}</p>
      <form class="stack-form" data-recovery novalidate>
        <input type="password" name="currentPassword" autocomplete="current-password"
          placeholder="${attr('more.recovery.password')}" aria-label="${attr('more.recovery.password')}" required />
        <button type="submit" class="btn wide">${t('more.recovery.show')}</button>
      </form>
      <div data-recovery-out hidden>
        <p class="notice">${t('more.recovery.yours')}<br /><code data-recovery-code></code></p>
        <button type="button" class="btn wide" data-recovery-hide>${t('more.recovery.hide')}</button>
      </div>

      <h2 class="section-title">${t('more.export.action')}</h2>
      <p class="hint">${t('more.export.hint')}</p>
      <button type="button" class="btn wide" data-export>${t('more.export.action')}</button>

      <h2 class="section-title">${t('more.crypto.title')}</h2>
      <div data-crypto>${cryptoStatusHtml()}</div>
      </section>

      <section ${paneAttr('anleitung')}>
      ${howtoHtml()}
      <button type="button" class="btn wide" data-whats-new>${t('shell.whatsNew.title')}</button>
      </section>`;

    // --- sub tabs: toggle the panes, keep the hash in step (no hashchange:
    //     replaceState, so the view is not rebuilt and typed input survives) ---
    function showPane(key) {
      const def = PANES.find((p) => p.key === key);
      if (!def) return;
      el.querySelectorAll('[data-subtab]').forEach((b) => {
        const on = b.dataset.subtab === key;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      el.querySelectorAll('[data-pane]').forEach((s) => {
        s.hidden = s.dataset.pane !== key;
      });
      history.replaceState(null, '', def.hash);
      if (key === 'anleitung') howtoSeen();
    }
    el.querySelectorAll('[data-subtab]').forEach((btn) =>
      btn.addEventListener('click', () => showPane(btn.dataset.subtab))
    );

    // The how-to was opened: the shell stops pointing a fresh sign-up here
    // (main.js), the sub tab loses its dot.
    function howtoSeen() {
      if (!prefs.howtoPending) return;
      prefs.howtoPending = false;
      el.querySelector('[data-subtab="anleitung"] .seg-dot')?.remove();
    }
    if (pane === 'anleitung') howtoSeen();
    // «Was ist neu»: the release notes, re-readable from the how-to's foot.
    el.querySelector('[data-whats-new]').addEventListener('click', () => openWhatsNewSheet(WHATS_NEW.slice(0, 10)));
    // #/mehr/familie: the family half of the Konto pane (the recovery nag's
    // deep link) — scroll there, the route just reset the page to the top.
    if (isFamilyLink()) {
      el.querySelector('[data-family-group]').scrollIntoView({ block: 'start' });
    }

    // --- reminders: the list follows the store (the partner may add one);
    //     rows open the sheet with the entry as the model holds it (seq
    //     included, so an edit made elsewhere meanwhile is a 409) ---
    const reminderList = el.querySelector('[data-reminder-list]');
    const homeCardNoteWrap = el.querySelector('[data-home-card-note-wrap]');
    function syncReminders() {
      const html = reminderListHtml();
      if (reminderList.innerHTML !== html) reminderList.innerHTML = html;
      const note = homeCardNoteHtml();
      if (homeCardNoteWrap.innerHTML !== note) homeCardNoteWrap.innerHTML = note;
    }
    const afterReminderWrite = () => store.refreshAfterWrite().catch(() => {});
    reminderList.addEventListener('click', (e) => {
      const row = e.target.closest('[data-reminder]');
      if (!row) return;
      const eid = row.dataset.reminder;
      store.ready.then(() => {
        if (disposed) return;
        const entry = store.entries.get(eid);
        if (!entry || entry.deletedAt != null || entry.error) {
          toast(t('more.reminders.notFound'));
          return;
        }
        openReminderForm({ entry, onSaved: afterReminderWrite });
      });
    });
    el.querySelector('[data-add-reminder]').addEventListener('click', () => {
      if (store.keyState !== 'ready') {
        toast(t('more.error.locked'));
        return;
      }
      openReminderForm({ onSaved: afterReminderWrite });
    });
    // «Erinnerungen zeigen» in the note: the per-device switch, from here.
    homeCardNoteWrap.addEventListener('click', (e) => {
      if (!e.target.closest('[data-show-reminders]')) return;
      setHomeCard('reminders');
    });

    // --- encryption status: follows the store (sync, writes) ---
    const cryptoNode = el.querySelector('[data-crypto]');
    if (unsubscribe) unsubscribe();
    unsubscribe = store.subscribe(() => {
      if (disposed) return;
      const html = cryptoStatusHtml();
      if (cryptoNode.innerHTML !== html) cryptoNode.innerHTML = html;
      syncFamilyInputs();
      syncReminders();
    });

    // --- family settings: the inputs follow the synced document, except the
    //     one the user is typing in right now ---
    // The two preset rows, keyed by their settings key.
    const PRESET_KEYS = ['bottlePresets', 'formulaPresets'];
    const presetInputs = {};
    for (const key of PRESET_KEYS) presetInputs[key] = [...el.querySelectorAll(`[data-presets="${key}"] [data-preset]`)];
    const recInput = el.querySelector('[data-recommended]');
    const fromStartInput = el.querySelector('[data-feed-from-start]');
    const birthInput = el.querySelector('[data-birth-date]');
    const mealsInput = el.querySelector('[data-meals-per-day]');
    const nursingInput = el.querySelector('[data-nursing-ml]');
    const breastfeedingInput = el.querySelector('[data-breastfeeding]');
    const nursingBlock = el.querySelector('[data-nursing-block]');
    const dosePreview = el.querySelector('[data-dose-preview]');
    const familyMeta = el.querySelector('[data-family-meta]');
    function syncFamilyInputs() {
      const fam = store.settings.current;
      for (const key of PRESET_KEYS) {
        presetInputs[key].forEach((input, i) => {
          if (document.activeElement !== input) input.value = fam[key][i];
        });
      }
      if (document.activeElement !== recInput) recInput.value = fam.recommendedMl || '';
      fromStartInput.checked = fam.feedFromStart;
      if (document.activeElement !== birthInput) birthInput.value = fam.birthDate || '';
      if (document.activeElement !== mealsInput) mealsInput.value = fam.mealsPerDay || '';
      if (document.activeElement !== nursingInput) nursingInput.value = fam.nursingMl || '';
      breastfeedingInput.checked = fam.breastfeeding !== false;
      nursingBlock.hidden = fam.breastfeeding === false;
      const preview = dosePreviewHtml(fam);
      if (dosePreview.innerHTML !== preview) dosePreview.innerHTML = preview;
      const metaHtml = familyMetaHtml();
      if (familyMeta.innerHTML !== metaHtml) familyMeta.innerHTML = metaHtml;
    }

    /** Save one family setting from a switch or chip; the control is
     *  disabled meanwhile and every field snaps back to the stored values
     *  on failure. */
    async function saveFamily(control, patch, okText) {
      control.disabled = true;
      try {
        await store.settings.save(patch);
        toast(okText, 'success');
      } catch (err) {
        toast(err.message);
      } finally {
        control.disabled = false;
        syncFamilyInputs();
      }
    }

    // The amount fields save WHILE typing (a second after the last key) as
    // well as on change: on a phone a tap on the tab bar or a sub tab can
    // leave the view without ever blurring the field, and a value that only
    // saved on blur was silently lost. The field is never disabled for it —
    // that would close the keyboard mid-typing — saves run one after the
    // other, a value already handed to the store is not saved again on
    // blur, and whatever is still pending when the view is left is flushed.
    const TYPING_SAVE_MS = 1000;
    const inflight = {}; // key -> JSON of the value on its way to the store
    const typingTimers = {};
    let saveChain = Promise.resolve();

    function queueFamilyValue(key, value, okText) {
      const json = JSON.stringify(value);
      if (json === inflight[key] || json === JSON.stringify(store.settings.current[key])) return;
      inflight[key] = json;
      saveChain = saveChain
        .then(() => store.settings.save({ [key]: value }))
        .then(
          () => toast(okText, 'success'),
          (err) => toast(err.message)
        )
        .then(() => {
          if (inflight[key] === json) delete inflight[key];
          if (!disposed) syncFamilyInputs();
        });
    }

    /** Debounced: runs `commit` once the user paused typing. */
    function whileTyping(key, commit) {
      clearTimeout(typingTimers[key]);
      typingTimers[key] = setTimeout(() => {
        delete typingTimers[key];
        commit();
      }, TYPING_SAVE_MS);
    }

    /** Leaving the view: pending saves run now instead of a second later. */
    function flushTyping() {
      for (const key of Object.keys(typingTimers)) {
        clearTimeout(typingTimers[key]);
        delete typingTimers[key];
      }
      for (const key of PRESET_KEYS) commitPresets(key, false);
      commitRecommended(false);
      commitMealsPerDay(false);
      commitNursingMl(false);
    }

    const parseMl = (raw) => {
      const ml = parseInt(raw, 10);
      return Number.isInteger(ml) && ml >= 1 && ml <= 1000 ? ml : null;
    };

    const presetOk = (key) => t('more.presets.saved', { row: presetRows.find((r) => r.key === key).label });

    /** Save one row's three presets as typed; `strict` (on change) also
     *  complains about an invalid field and snaps it back. */
    function commitPresets(key, strict) {
      const inputs = presetInputs[key];
      const presets = [...store.settings.current[key]];
      let valid = true;
      inputs.forEach((input, i) => {
        const ml = parseMl(input.value);
        if (ml === null) {
          valid = false;
          if (strict) input.value = presets[i];
        } else {
          presets[i] = ml;
        }
      });
      if (!valid) {
        if (strict) toast(t('more.error.mlRange'));
        return;
      }
      if (strict) inputs.forEach((input, i) => (input.value = presets[i])); // normalize e.g. "090"
      queueFamilyValue(key, presets, presetOk(key));
    }

    function commitRecommended(strict) {
      const raw = recInput.value.trim();
      if (raw === '') {
        queueFamilyValue('recommendedMl', null, t('more.recommended.removed'));
        return;
      }
      const ml = parseMl(raw);
      if (ml === null) {
        if (strict) {
          toast(t('more.error.mlRange'));
          recInput.value = store.settings.current.recommendedMl || '';
        }
        return;
      }
      if (strict) recInput.value = ml;
      queueFamilyValue('recommendedMl', ml, t('more.recommended.set', { ml }));
    }

    /** The meals a day the rule shares the amount by; empty = the default. */
    function commitMealsPerDay(strict) {
      const raw = mealsInput.value.trim();
      if (raw === '') {
        queueFamilyValue('mealsPerDay', null, t('more.dose.mealsPerDayDefault', { n: DEFAULT_MEALS_PER_DAY }));
        return;
      }
      const n = parseInt(raw, 10);
      if (!Number.isInteger(n) || n < MEALS_PER_DAY_MIN || n > MEALS_PER_DAY_MAX) {
        if (strict) {
          toast(t('more.error.mealsPerDayRange', { min: MEALS_PER_DAY_MIN, max: MEALS_PER_DAY_MAX }));
          mealsInput.value = store.settings.current.mealsPerDay || '';
        }
        return;
      }
      if (strict) mealsInput.value = n;
      queueFamilyValue('mealsPerDay', n, t('more.dose.mealsPerDaySet', { n }));
    }

    /** ≈ ml one nursing session gives (dose.supplementFor); empty = no estimate. */
    function commitNursingMl(strict) {
      const raw = nursingInput.value.trim();
      if (raw === '') {
        queueFamilyValue('nursingMl', null, t('more.nursing.removed'));
        return;
      }
      const ml = parseMl(raw);
      if (ml === null) {
        if (strict) {
          toast(t('more.error.mlRange'));
          nursingInput.value = store.settings.current.nursingMl || '';
        }
        return;
      }
      if (strict) nursingInput.value = ml;
      queueFamilyValue('nursingMl', ml, t('more.nursing.set', { ml }));
    }
    flushFamilyInputs = flushTyping;

    // --- display name ---
    const who = el.querySelector('[data-who]');
    const chips = [...who.querySelectorAll('.chip[data-name]')];
    const customInput = who.querySelector('input');

    /** Chip + custom input reflect the stored display name. */
    function syncWho() {
      const current = (prefs.user && prefs.user.displayName) || '';
      chips.forEach((c) => c.classList.toggle('active', c.dataset.name === current));
      customInput.value = presets.includes(current) ? '' : current;
    }

    // The display name lives in the account's encrypted profile blob and is
    // shown on new entries only (history keeps the name current at the time).
    async function saveDisplayName(displayName) {
      chips.forEach((c) => (c.disabled = true));
      customInput.disabled = true;
      try {
        const u = await session.updateDisplayName(displayName);
        el.querySelector('[data-account]').innerHTML = accountHtml();
        toast(t('more.account.displayNameSaved', { name: u.displayName }), 'success');
      } catch (err) {
        toast(err.message);
      } finally {
        chips.forEach((c) => (c.disabled = false));
        customInput.disabled = false;
        syncWho();
      }
    }

    chips.forEach((chip) =>
      chip.addEventListener('click', () => {
        if (prefs.user && prefs.user.displayName === chip.dataset.name) return;
        chips.forEach((c) => c.classList.toggle('active', c === chip));
        customInput.value = '';
        saveDisplayName(chip.dataset.name);
      })
    );
    customInput.addEventListener('change', () => {
      const v = customInput.value.trim();
      if (!v || (prefs.user && prefs.user.displayName === v)) {
        syncWho(); // emptied or unchanged: fall back to what is stored
        return;
      }
      chips.forEach((c) => c.classList.remove('active'));
      saveDisplayName(v);
    });

    // --- design (per device): applied at once, no reload ---
    const themeBtns = [...el.querySelectorAll('[data-theme-id]')];
    themeBtns.forEach((btn) =>
      btn.addEventListener('click', () => {
        const id = applyTheme(btn.dataset.themeId);
        prefs.theme = id;
        themeBtns.forEach((b) => {
          const on = b.dataset.themeId === id;
          b.classList.toggle('active', on);
          b.setAttribute('aria-checked', on ? 'true' : 'false');
        });
      })
    );

    // --- the home screen's fourth slot (per device) ---
    const homeCardBtns = [...el.querySelectorAll('[data-home-card]')];
    function setHomeCard(id) {
      prefs.homeCard = id;
      const value = prefs.homeCard;
      homeCardBtns.forEach((b) => {
        const on = b.dataset.homeCard === value;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
      syncReminders();
      const toastKey = {
        sleep: 'more.homeCard.toast.sleep',
        reminders: 'more.homeCard.toast.reminders',
        both: 'more.homeCard.toast.both',
      }[value];
      toast(t(toastKey || 'more.homeCard.toast.none'), 'success');
    }
    homeCardBtns.forEach((btn) =>
      btn.addEventListener('click', () => {
        if (btn.dataset.homeCard !== prefs.homeCard) setHomeCard(btn.dataset.homeCard);
      })
    );

    // --- keep the screen on while feeding (per device) ---
    el.querySelector('[data-keep-awake]')?.addEventListener('change', (e) => {
      prefs.keepAwake = e.currentTarget.checked;
      window.dispatchEvent(new Event('bt-prefs'));
      toast(prefs.keepAwake ? t('more.screen.keepAwakeOn') : t('more.screen.keepAwakeOff'), 'success');
    });

    // --- light/dark override (per device) ---
    const schemeBtns = [...el.querySelectorAll('[data-scheme]')];
    schemeBtns.forEach((btn) =>
      btn.addEventListener('click', () => {
        const value = applyScheme(btn.dataset.scheme || null);
        prefs.scheme = value;
        schemeBtns.forEach((b) => {
          const on = (b.dataset.scheme || '') === (value || '');
          b.classList.toggle('active', on);
          b.setAttribute('aria-checked', on ? 'true' : 'false');
        });
      })
    );

    // --- language (per device): the shell relabels the tab bar and re-routes
    //     on `bt-lang` (main.js), which rebuilds this view on the same pane —
    //     the route's cleanup flushes an amount still being typed. The router
    //     scrolls to the top; the picker sits at the foot of the pane, so the
    //     scroll position is put back. ---
    el.querySelectorAll('[data-lang]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const id = btn.dataset.lang;
        if (id === getLocale()) return;
        const y = window.scrollY;
        prefs.lang = id;
        setLocale(id);
        window.dispatchEvent(new Event('bt-lang'));
        window.scrollTo(0, y);
      })
    );

    // --- bottle presets / recommended amount / meal interval (family) ---
    // The amounts save while typing and on change (see queueFamilyValue);
    // invalid input snaps back to the stored value on change instead of
    // persisting garbage.
    for (const key of PRESET_KEYS) {
      presetInputs[key].forEach((input) => {
        input.addEventListener('input', () => whileTyping(key, () => commitPresets(key, false)));
        input.addEventListener('change', () => {
          clearTimeout(typingTimers[key]);
          delete typingTimers[key];
          commitPresets(key, true);
        });
      });
    }
    recInput.addEventListener('input', () => whileTyping('recommendedMl', () => commitRecommended(false)));
    recInput.addEventListener('change', () => {
      clearTimeout(typingTimers.recommendedMl);
      delete typingTimers.recommendedMl;
      commitRecommended(true);
    });

    mealsInput.addEventListener('input', () => whileTyping('mealsPerDay', () => commitMealsPerDay(false)));
    mealsInput.addEventListener('change', () => {
      clearTimeout(typingTimers.mealsPerDay);
      delete typingTimers.mealsPerDay;
      commitMealsPerDay(true);
    });
    nursingInput.addEventListener('input', () => whileTyping('nursingMl', () => commitNursingMl(false)));
    nursingInput.addEventListener('change', () => {
      clearTimeout(typingTimers.nursingMl);
      delete typingTimers.nursingMl;
      commitNursingMl(true);
    });
    // «Stillen» on/off for the family: the home screen and Nachtragen follow
    // through the synced row (store.subscribe re-renders them).
    breastfeedingInput.addEventListener('change', () => {
      const on = breastfeedingInput.checked;
      saveFamily(breastfeedingInput, { breastfeeding: on }, on ? t('more.nursing.on') : t('more.nursing.off'));
    });
    // The birth date comes from the picker: one save on change, empty clears.
    birthInput.addEventListener('change', () => {
      const value = birthInput.value;
      if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        toast(t('more.error.invalidDate'));
        birthInput.value = store.settings.current.birthDate || '';
        return;
      }
      saveFamily(
        birthInput,
        { birthDate: value || null },
        value ? t('more.dose.birthDateSet', { date: fmtDayHeading(value) }) : t('more.dose.birthDateRemoved')
      );
    });

    const PRESET_DEFAULTS = { bottlePresets: DEFAULT_BOTTLE_PRESETS, formulaPresets: DEFAULT_FORMULA_PRESETS };
    el.querySelectorAll('[data-preset-reset]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const key = btn.dataset.presetReset;
        saveFamily(btn, { [key]: [...PRESET_DEFAULTS[key]] }, t('more.presets.resetDone'));
      })
    );

    fromStartInput.addEventListener('change', () => {
      const on = fromStartInput.checked;
      saveFamily(fromStartInput, { feedFromStart: on }, on ? t('more.interval.fromStartOn') : t('more.interval.fromStartOff'));
    });

    // --- family password rotation ---
    // Any member, confirmed with their OWN password (it unlocks the raw FDK,
    // which is re-wrapped under the new family password). Only joining needs
    // the family password, so nobody already in the family is affected.
    const familyForm = el.querySelector('[data-family-pw]');
    familyForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const familyPassword = familyForm.familyPassword.value;
      const currentPassword = familyForm.currentPassword.value;
      if ([...familyPassword].length < session.PASSWORD_MIN) {
        toast(t('more.familyPassword.tooShort', { min: session.PASSWORD_MIN }));
        familyForm.familyPassword.focus();
        return;
      }
      if (!currentPassword) {
        toast(t('more.familyPassword.confirmMissing'));
        familyForm.currentPassword.focus();
        return;
      }
      try {
        await runForm(familyForm, (opts) => session.rotateFamilyPassword(currentPassword, familyPassword, opts));
        familyForm.reset();
        toast(t('more.familyPassword.saved'), 'success', { ms: 6000 });
      } catch (err) {
        toast(err.message);
      }
    });

    // --- own password change ---
    const ownForm = el.querySelector('[data-own-pw]');
    ownForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const currentPassword = ownForm.currentPassword.value;
      const newPassword = ownForm.newPassword.value;
      if (!currentPassword) {
        toast(t('more.password.currentMissing'));
        ownForm.currentPassword.focus();
        return;
      }
      if ([...newPassword].length < session.PASSWORD_MIN) {
        toast(t('more.password.tooShort', { min: session.PASSWORD_MIN }));
        ownForm.newPassword.focus();
        return;
      }
      try {
        await runForm(ownForm, (opts) => session.changePassword(currentPassword, newPassword, opts));
        ownForm.reset();
        toast(t('more.password.saved'), 'success', { ms: 6000 });
      } catch (err) {
        toast(err.message);
      }
    });

    // --- recovery code ---
    // Shown only after the own password verified (it is the raw family key).
    // Stays on screen until hidden or the view is left; never stored here.
    // A successful reveal also settles prefs.recoveryPending (set by the
    // registration screen, nagged about by the shell until the code was seen).
    const recoveryForm = el.querySelector('[data-recovery]');
    const recoveryOut = el.querySelector('[data-recovery-out]');
    const recoveryCode = el.querySelector('[data-recovery-code]');
    const recoveryPending = el.querySelector('[data-recovery-pending]');
    const hideRecovery = () => {
      recoveryCode.textContent = '';
      recoveryOut.hidden = true;
    };
    recoveryForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const currentPassword = recoveryForm.currentPassword.value;
      if (!currentPassword) {
        toast(t('more.recovery.passwordMissing'));
        recoveryForm.currentPassword.focus();
        return;
      }
      try {
        const code = await runForm(
          recoveryForm,
          (opts) => session.revealRecoveryCode(currentPassword, opts),
          t('more.progress.checking')
        );
        if (disposed) return; // the code never reached this pane: keep the nag
        prefs.recoveryPending = false;
        recoveryForm.reset();
        recoveryPending.hidden = true;
        el.querySelector('[data-subtab="konto"] .seg-dot')?.remove();
        recoveryCode.textContent = code;
        recoveryOut.hidden = false;
        recoveryOut.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } catch (err) {
        toast(err.message);
      }
    });
    el.querySelector('[data-recovery-hide]').addEventListener('click', hideRecovery);

    // --- export ---
    const exportBtn = el.querySelector('[data-export]');
    const exportLabel = exportBtn.textContent;
    exportBtn.addEventListener('click', async () => {
      exportBtn.disabled = true;
      exportBtn.textContent = t('more.export.progress');
      try {
        const count = await exportData();
        if (count === null) return; // share sheet dismissed
        toast(tn('more.export.done', count), 'success');
      } catch (err) {
        toast((err && err.message) || t('more.export.failed'));
      } finally {
        exportBtn.textContent = exportLabel;
        exportBtn.disabled = false;
      }
    });

    // --- logout ---
    // session.logout wipes this device (key, IndexedDB, snapshot, prefs) no
    // matter what the server says: handing the phone away must be safe. A
    // failed revoke only means the cookie expires on its own.
    // Writes still in the outbox would go with the wipe: try to send them
    // first, then ask — the second tap within a few seconds logs out anyway.
    const logoutBtn = el.querySelector('[data-logout]');
    const logoutHint = el.querySelector('[data-logout-hint]');
    let logoutArmedUntil = 0;
    logoutBtn.addEventListener('click', async () => {
      logoutBtn.disabled = true;
      if (store.outbox.count + store.outbox.parked > 0 && Date.now() > logoutArmedUntil) {
        logoutBtn.textContent = t('more.logout.sending');
        await store.refresh().catch(() => {});
        await store.outbox.flush().catch(() => {});
        if (disposed) return;
        const left = store.outbox.count + store.outbox.parked;
        if (left > 0) {
          logoutArmedUntil = Date.now() + 8000;
          logoutHint.hidden = false;
          logoutHint.textContent = tn('more.logout.pending', left);
          logoutBtn.textContent = t('more.logout.anyway');
          logoutBtn.disabled = false;
          setTimeout(() => {
            if (disposed || Date.now() < logoutArmedUntil) return;
            logoutHint.hidden = true;
            logoutBtn.textContent = t('more.logout.action');
          }, 8100);
          return;
        }
      }
      logoutBtn.textContent = t('more.logout.progress');
      let serverFailed = false;
      try {
        serverFailed = await session.logout();
      } catch {
        serverFailed = true;
      }
      hideRecovery();
      window.dispatchEvent(new Event('bt-logout'));
      if (serverFailed) toast(t('more.logout.serverFailed'), 'error', { ms: 6000 });
    });
  }

  render();
  return () => {
    // An amount still being typed saves now — the tab tap that leaves the
    // view never blurred it.
    flushFamilyInputs();
    disposed = true;
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
  };
}
