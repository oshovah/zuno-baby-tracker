// Shared UI helpers: escaping, time formatting in the active language, toasts,
// type metadata. Every label is read through t() when it is shown (getters on
// the metadata tables), never at module load — the language can switch at
// run time.

import { t, tn, localeMeta } from './i18n/index.js';
import { WHO_LABELS } from './reminders.js';
import { MEAL_GAP_MIN } from './model.js';

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// --- entry type metadata ----------------------------------------------------

// `label` is a getter: the translation of the moment it is read.
export const TYPE_META = {
  breastfeed: { get label() { return t('common.type.breastfeed'); }, emoji: '🤱', hue: 'milk', timer: true },
  bottle: { get label() { return t('common.type.bottle'); }, emoji: '🍼', hue: 'milk', timer: false },
  diaper: { get label() { return t('common.type.diaper'); }, emoji: '💧', hue: 'diaper', timer: false },
  sleep: { get label() { return t('common.type.sleep'); }, emoji: '😴', hue: 'sleep', timer: true },
  weight: { get label() { return t('common.type.weight'); }, emoji: '⚖️', hue: 'measure', timer: false },
  temperature: { get label() { return t('common.type.temperature'); }, emoji: '🌡️', hue: 'measure', timer: false },
  medication: { get label() { return t('common.type.medication'); }, emoji: '💊', hue: 'measure', timer: false },
  task: { get label() { return t('common.type.task'); }, emoji: '✅', hue: 'measure', timer: false },
};

export const DIAPER_KINDS = {
  pee: { get label() { return t('common.diaper.wet'); }, emoji: '💧' },
  poop: { get label() { return t('common.diaper.soiled'); }, emoji: '💩' },
  both: { get label() { return t('common.diaper.both'); }, emoji: '💧💩' },
};

export const SIDE_LABELS = {
  get L() { return t('common.side.L'); },
  get R() { return t('common.side.R'); },
};

/** «40 ml Muttermilch» / «70 ml Formula» / «40 ml Muttermilch + 30 ml Formula»
 *  for bottle details — Muttermilch first: it is what the parents reach for
 *  first, the formula tops the meal up (the stored key stays `colostrum_ml`:
 *  the field began as colostrum syringes). */
export function bottleAmountLabel(d) {
  const milk = (d && d.amount_ml) || 0;
  const col = (d && d.colostrum_ml) || 0;
  const parts = [];
  if (col) parts.push(t('common.milk.breastMl', { ml: col }));
  if (milk || !col) parts.push(t('common.milk.formulaMl', { ml: milk }));
  return parts.join(' + ');
}

/** Everything in the bottle: Muttermilch and formula together. */
export function bottleTotalMl(d) {
  return ((d && d.amount_ml) || 0) + ((d && d.colostrum_ml) || 0);
}

/**
 * The second line of a Verlauf row, before the name: what was in the
 * Schoppen — the composition when it was both («40 ml Muttermilch + 30 ml
 * Formula»), just the kind when it was one («Muttermilch», «Formula»; the
 * amount is on the first line already). Empty for every other type.
 */
export function entryDetail(entry) {
  if (!entry || entry.type !== 'bottle') return '';
  const d = entry.details || {};
  const milk = d.amount_ml || 0;
  const col = d.colostrum_ml || 0;
  if (milk && col) return bottleAmountLabel(d);
  return t(col ? 'common.milk.breast' : 'common.milk.formulaShort');
}

/**
 * One-line description of an entry ("Schoppen · 90 ml") in the active
 * language. Raw text: the caller escapes it (a title or a name may be in
 * it) before it lands in innerHTML.
 */
export function entrySummary(entry) {
  const d = entry.details || {};
  switch (entry.type) {
    case 'breastfeed': {
      const side = SIDE_LABELS[d.side] || '';
      // Quick-logged feeds have no duration (endedAt == startedAt) — omit it.
      let dur = ` · ${t('common.running')}`;
      if (entry.endedAt) {
        const mins = minutesBetween(entry.startedAt, entry.endedAt);
        dur = mins > 0 ? ` · ${fmtDurationMin(mins)}` : '';
      }
      return `${t('common.summary.nursing', { side })}${dur}`;
    }
    case 'bottle':
      // The total on the row; the composition is its second line (entryDetail).
      return `${t('common.type.bottle')} · ${bottleTotalMl(d)} ml`;
    case 'diaper':
      return `${t('common.type.diaper')} · ${(DIAPER_KINDS[d.kind] || { label: '?' }).label}`;
    case 'sleep': {
      const dur = entry.endedAt
        ? ` · ${fmtDurationMin(minutesBetween(entry.startedAt, entry.endedAt))}`
        : ` · ${t('common.running')}`;
      return `${t('common.type.sleep')}${dur}`;
    }
    case 'weight':
      return `${t('common.type.weight')} · ${fmtGrams(d.grams)}`;
    case 'temperature':
      return `${t('common.type.temperature')} · ${String(d.celsius).replace('.', localeMeta().decimalSeparator)} °C`;
    case 'medication':
      return `${t('common.type.medication')} · ${d.name}`;
    case 'task': {
      // A ticked-off reminder (or a chore logged by hand); the baby's are
      // unmarked, a parent's say so — the app is the baby's log.
      const forWho = d.who && d.who !== 'baby' ? ` · ${t('common.summary.forWho', { who: WHO_LABELS[d.who] || d.who })}` : '';
      return `${t('common.type.task')} · ${d.title}${forWho}`;
    }
  }
  return entry.type;
}

// --- "feeding right now" ------------------------------------------------------

// A quick-logged feed (Ende == Start) counts as "probably feeding right now"
// for this long: the hero shows a live timer + stop button, the same side's
// quick button locks so the feed isn't logged twice, and the screen stays on.
export const QUICK_FEED_LIVE_MIN = 45;

// A side closed with «Pause» (details.paused) keeps the hero in its paused
// state — «Weiter» on the same side — for this long after the meal's end;
// then the pause was the end of the meal. The meal gap, not a constant of
// its own: exactly as long as a «Weiter» would still join the meal
// (model.groupMeals) the side can go on; a longer window would let «Weiter»
// start a second meal, a shorter one would hide it while the side still
// joins.
export const PAUSE_MAX_MIN = MEAL_GAP_MIN;

/** When the pause runs out (ms): the meal's last known end plus the gap. */
export function pauseEndsMs(state) {
  const f = state.lastFeed;
  const meal = state.lastMeal;
  const mealEnd = meal && !meal.open && meal.endedAt ? new Date(meal.endedAt).getTime() : 0;
  return Math.max(mealEnd, new Date(f.endedAt).getTime()) + PAUSE_MAX_MIN * 60000;
}

/**
 * The feed paused right now (the hero's «Pause» closed it and marked it, and
 * nothing came after it): the last feed when it is a Stillen side with
 * `details.paused`, closed with a duration, no timer runs, and the pause has
 * not run out (pauseEndsMs) — or null. A Schoppen or the other side logged
 * meanwhile, on either phone, is the last feed then and ends the pause on
 * both. Both phones read the same answer from the synced rows.
 */
export function pausedFeed(state, at = nowMs()) {
  if (!state) return null;
  if ((state.openTimers || []).some((x) => x.type === 'breastfeed')) return null;
  const f = state.lastFeed;
  if (!f || f.type !== 'breastfeed' || !f.endedAt || f.endedAt === f.startedAt) return null;
  if (!(f.details && f.details.paused === true)) return null;
  return at <= pauseEndsMs(state) ? f : null;
}

/** A Stillen timer is open, a quick-logged feed is still in its live window,
 *  or a side is paused (the parent wants «Weiter» right there). */
export function isFeedingNow(state, at = nowMs()) {
  if (!state) return false;
  if ((state.openTimers || []).some((x) => x.type === 'breastfeed')) return true;
  if (pausedFeed(state, at)) return true;
  const f = state.lastFeed;
  if (!f || f.type !== 'breastfeed' || !f.endedAt || f.endedAt !== f.startedAt) return false;
  return (at - new Date(f.startedAt).getTime()) / 60000 <= QUICK_FEED_LIVE_MIN;
}

// --- icons -----------------------------------------------------------------
// Every pictogram in the UI goes through icon(): an emoji glyph by default,
// which a design may replace with its own monochrome SVG per name (see
// src/themes/README.md, "Icons"). The names are the contract with the themes.

export const ICONS = {
  breastfeed: '🤱',
  bottle: '🍼',
  diaper: '💧',
  pee: '💧',
  poop: '💩',
  both: '💧💩',
  sleep: '😴',
  wake: '☀️',
  weight: '⚖️',
  temperature: '🌡️',
  medication: '💊',
  task: '✅',
  reminder: '⏰',
  sync: '🔄',
  lock: '🔒',
  bolt: '⚡',
  care: '🩺',
  phone: '📲',
};

/** `<span class="ico …" data-ico="name"><i>emoji</i></span>` — decorative. */
export function icon(name, cls = '') {
  const glyph = ICONS[name] || '•';
  return `<span class="ico${cls ? ` ${cls}` : ''}" data-ico="${name}" aria-hidden="true"><i>${glyph}</i></span>`;
}

/** The icon for an entry: its diaper kind, else its type. */
export function entryIcon(entry, cls = '') {
  if (entry.type === 'diaper') {
    const kind = (entry.details || {}).kind;
    return icon(DIAPER_KINDS[kind] ? kind : 'pee', cls);
  }
  return icon(TYPE_META[entry.type] ? entry.type : 'dot', cls);
}

// --- time -------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');

// Server-vs-device clock offset, fed by store.js from the sync feed's serverNow.
// All elapsed displays use it so two phones agree about the same timer even
// when one clock drifts.
let clockSkewMs = 0;

export function setClockSkew(ms) {
  clockSkewMs = ms;
}

/** "Now" in server time — the reference for every elapsed display. */
export function nowMs() {
  return Date.now() + clockSkewMs;
}

/** Current instant (skew-corrected, see nowMs) as a server-friendly ISO string. */
export function isoNow() {
  return new Date(nowMs()).toISOString();
}

/** UTC ISO -> "14:32" in the device's local time. */
export function fmtClock(iso) {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** UTC ISO -> local calendar date "YYYY-MM-DD". */
export function localDateOf(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function localToday() {
  return localDateOf(new Date().toISOString());
}

/** Local date "YYYY-MM-DD" shifted by n days. */
export function shiftDate(localDate, days) {
  const [y, m, d] = localDate.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

/** Local date "YYYY-MM-DD" -> "Heute" / "Gestern" / "Mo, 1. Sep. 2026" (in the active language). */
export function fmtDayHeading(localDate) {
  const today = localToday();
  if (localDate === today) return t('common.today');
  if (localDate === shiftDate(today, -1)) return t('common.yesterday');
  const [y, m, d] = localDate.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const opts = { weekday: 'short', day: 'numeric', month: 'short' };
  if (y !== new Date().getFullYear()) opts.year = 'numeric';
  return dt.toLocaleDateString(localeMeta().dateLocale, opts);
}

export function minutesBetween(fromIso, toIso) {
  return Math.max(0, Math.round((new Date(toIso) - new Date(fromIso)) / 60000));
}

/** 25 -> "25 Min.", 95 -> "1 Std. 35 Min.", 120 -> "2 Std." */
export function fmtDurationMin(mins) {
  if (mins < 60) return t('common.span.minutes', { n: mins });
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? t('common.span.hours', { n: h }) : t('common.span.hoursMinutes', { h, m });
}

/**
 * Elapsed time as big-numeral parts for the hero display:
 * [{v: 2, u: 'Std.'}, {v: 41, u: 'Min.'}]. Days take over past 48h.
 * The units are the short words of the active language.
 */
export function agoParts(iso, at = nowMs()) {
  const mins = Math.max(0, Math.floor((at - new Date(iso)) / 60000));
  const MIN = t('common.unit.min');
  const HOUR = t('common.unit.hour');
  if (mins < 60) return [{ v: mins, u: MIN }];
  if (mins < 48 * 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m === 0 ? [{ v: h, u: HOUR }] : [{ v: h, u: HOUR }, { v: m, u: MIN }];
  }
  return [{ v: Math.floor(mins / 1440), u: t('common.unit.days') }];
}

/**
 * The span of the half-width cards: "45 Min.", then half hours — "1 Std.",
 * "1½ Std.", "3½ Std." — and "2 Tagen" past 48 h. Coarse on purpose:
 * "3 Std. 35 Min." wrapped the line on a narrow phone, and the exact time
 * is one tap away (Verlauf, the reminders sheet) — the hero keeps its big
 * exact numerals (agoParts).
 */
export function fmtSpanShort(mins) {
  const m = Math.max(0, Math.floor(mins));
  if (m < 60) return t('common.span.minutes', { n: m });
  if (m < 48 * 60) {
    const halves = Math.round(m / 30);
    const h = Math.floor(halves / 2);
    return halves % 2 ? t('common.span.halfHours', { h }) : t('common.span.hours', { n: h });
  }
  return tn('common.span.days', Math.floor(m / 1440));
}

/** "in 45 Min." / "in 1½ Std." — fmtSpanShort ahead of now; "jetzt" within a minute (or once passed). */
export function fmtInShort(iso, at = nowMs()) {
  const secs = Math.floor((new Date(iso) - at) / 1000);
  if (secs < 60) return t('common.time.now');
  return t('common.time.in', { span: fmtSpanShort(secs / 60) });
}

/** "gerade eben" / "vor 12 Min." / "vor 3½ Std." — the diaper card. */
export function fmtAgoShort(iso, at = nowMs()) {
  const secs = Math.floor((at - new Date(iso)) / 1000);
  if (secs < 90) return t('common.time.justNow');
  return t('common.time.ago', { span: fmtSpanShort(secs / 60) });
}

/**
 * For "seit …" / "for …": "kurzem" / "12 Min." / "3½ Std." ("Wach seit
 * gerade eben" is not German; English reads "awake for a moment").
 */
export function fmtAgoBareShort(iso, at = nowMs()) {
  const secs = Math.floor((at - new Date(iso)) / 1000);
  if (secs < 90) return t('common.time.sinceJustNow');
  return fmtSpanShort(secs / 60);
}

/** Running timer: 754s -> "12:34", 3874s -> "1:04:34". */
export function fmtTimer(totalSecs) {
  const s = Math.max(0, Math.floor(totalSecs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(sec)}` : `${m}:${pad2(sec)}`;
}

/** 3450 -> "3,45 kg" — the decimal separator of the active language ("3.45 kg"). */
export function fmtGrams(grams) {
  if (grams >= 1000) {
    const kg = (grams / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    return `${kg.replace('.', localeMeta().decimalSeparator)} kg`;
  }
  return `${grams} g`;
}

/** UTC ISO -> value for <input type="datetime-local"> (local wall time). */
export function toLocalInput(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** <input type="datetime-local"> value -> UTC ISO (null for empty). */
export function fromLocalInput(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// --- toasts -----------------------------------------------------------------

const TOAST_MS = { error: 5000, success: 2600 };

// Appended to every success toast while writes wait in the outbox (main.js
// sets it from the store): «Windel gespeichert · wartet auf Netz» — a save
// made without network is a save on this phone, and the toast says so.
let toastHint = () => '';
export function setToastHint(fn) {
  toastHint = typeof fn === 'function' ? fn : () => '';
}

/**
 * toast('Windel gespeichert', 'success', { action: { label: 'Rückgängig',
 * onClick } }) — the action button keeps the toast up a little longer.
 */
export function toast(message, type = 'error', opts = {}) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');

  const text = document.createElement('span');
  const hint = type === 'success' ? toastHint() : '';
  text.textContent = hint ? `${message} · ${hint}` : message;
  el.appendChild(text);

  let ms = opts.ms || TOAST_MS[type] || 4000;
  if (opts.action) {
    ms = opts.ms || 6000;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = opts.action.label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      el.remove();
      opts.action.onClick();
    });
    el.appendChild(btn);
  } else {
    // Tap-to-dismiss only when there is no action: a near-miss on Rückgängig
    // must not destroy the one undo path.
    el.addEventListener('click', () => el.remove());
  }
  host.appendChild(el);
  setTimeout(() => {
    el.classList.add('hide');
    setTimeout(() => el.remove(), 350);
  }, ms);
}

export function errorBlock(message) {
  return `
    <div class="empty">
      <p>${escapeHtml(message)}</p>
      <button type="button" class="btn" data-retry>${t('common.action.retry')}</button>
    </div>`;
}
