// Translations. One folder per language under locales/ (locales/README.md
// is the contributor guide); the active language is a module-level
// singleton so every module — the views, the pure model helpers, a thrown
// error message — reads the same one. Pure: no DOM needed (node tests run
// in German, the default), `document.lang` is set only when there is one.
//
//   t('home.hero.since', { name })   the string with {name} filled in
//   tn('history.diapers', 3)         '<key>.one' / '<key>.other' by the count, {n} filled in
//   setLocale('en') / getLocale()    the switch — prefs.lang is the per-device choice (main.js)
//   localeMeta().dateLocale          for Intl formatting (dates, decimal separators)
//
// A key missing in the active language falls back to German, then to the
// key itself, so a half-translated language still runs. Params are inserted
// verbatim: escape them (ui.escapeHtml) when the result lands in innerHTML.

import { LOCALES } from './locales/index.js';

export const DEFAULT_LOCALE = 'de';

let current = DEFAULT_LOCALE;
const listeners = new Set();
const warned = new Set();

/** [{ id, name }] — the languages the build ships, in registration order. */
export function availableLocales() {
  return Object.values(LOCALES).map((l) => ({ id: l.meta.id, name: l.meta.name }));
}

export function isLocale(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(LOCALES, id);
}

/**
 * The language to start with: the device's stored choice when it is one we
 * ship, else the first of the browser's languages we have ('en-US' → 'en'),
 * else German (the app's home).
 */
export function detectLocale(stored, languages = []) {
  if (isLocale(stored)) return stored;
  for (const lang of languages || []) {
    if (typeof lang !== 'string') continue;
    const base = lang.toLowerCase().split('-')[0];
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}

/** Switch the language; unknown ids fall back to German. Returns the id in force. */
export function setLocale(id) {
  const next = isLocale(id) ? id : DEFAULT_LOCALE;
  const changed = next !== current;
  current = next;
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = next;
  }
  if (changed) {
    listeners.forEach((fn) => {
      try {
        fn(next);
      } catch {
        /* one listener must not break the others */
      }
    });
  }
  return next;
}

export function getLocale() {
  return current;
}

/** The active language's meta (id, name, dateLocale, decimalSeparator). */
export function localeMeta() {
  return LOCALES[current].meta;
}

/** Called with the new id after every actual change; returns the unsubscribe. */
export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function lookup(key) {
  const own = LOCALES[current].messages;
  if (Object.prototype.hasOwnProperty.call(own, key)) return own[key];
  const base = LOCALES[DEFAULT_LOCALE].messages;
  if (Object.prototype.hasOwnProperty.call(base, key)) return base[key];
  return undefined;
}

export function hasKey(key) {
  return lookup(key) !== undefined;
}

function warnMissing(key) {
  if (warned.has(key)) return;
  warned.add(key);
  if (typeof console !== 'undefined' && console.warn) console.warn(`[i18n] missing key: ${key}`);
}

function fill(str, params) {
  if (!params) return str;
  return str.replace(/\{(\w+)\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m
  );
}

/** The translation of `key` with `{param}` placeholders filled from params. */
export function t(key, params) {
  const s = lookup(key);
  if (s === undefined) {
    warnMissing(key);
    return key;
  }
  return fill(s, params);
}

/**
 * Plural: '<key>.one' when n is exactly 1, '<key>.other' otherwise (both
 * German and English have just these two forms; a language with more
 * would extend this switch). {n} is always available to the string.
 */
export function tn(key, n, params) {
  const count = Number(n) || 0;
  const form = count === 1 ? 'one' : 'other';
  let s = lookup(`${key}.${form}`);
  if (s === undefined) s = lookup(`${key}.other`);
  if (s === undefined) {
    warnMissing(`${key}.${form}`);
    return `${count} ${key}`;
  }
  return fill(s, { n: count, ...(params || {}) });
}
