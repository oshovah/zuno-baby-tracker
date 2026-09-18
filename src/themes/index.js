// Designs (themes). One CSS file per design in this folder, one entry here;
// the active design is a `data-theme` attribute on <html> and a per-device
// preference (prefs.theme) — never synced, a phone's look is its owner's.
// Tokens and the contributor checklist: _template.css and README.md.
//
// All designs are bundled (a few hundred bytes each) so switching is
// instant and works offline; only the attribute changes. Fonts: fonts.css
// declares the bundled faces (fonts/README.md); a design names one in its
// --font stack and the browser fetches it on first use.

import './fonts.css';
import './nursery.css';
import './swiss.css';
import './bauhaus.css';
import { t } from '../i18n/index.js';

/** id = the `[data-theme]` value and the file name; name/description are
 *  getters so they follow the active language (read when shown, never at
 *  module load — the texts live in the `more` namespace). */
export const THEMES = [
  {
    id: 'nursery',
    get name() { return t('more.theme.nursery.name'); },
    get description() { return t('more.theme.nursery.description'); },
  },
  {
    id: 'swiss',
    get name() { return t('more.theme.swiss.name'); },
    get description() { return t('more.theme.swiss.description'); },
  },
  {
    id: 'bauhaus',
    get name() { return t('more.theme.bauhaus.name'); },
    get description() { return t('more.theme.bauhaus.description'); },
  },
];

export const DEFAULT_THEME = THEMES[0].id;

export function isTheme(id) {
  return THEMES.some((t) => t.id === id);
}

/** Put the design on <html>; unknown ids fall back to the default. */
export function applyTheme(id) {
  const theme = isTheme(id) ? id : DEFAULT_THEME;
  document.documentElement.dataset.theme = theme;
  return theme;
}

/** Light/dark override: 'light' | 'dark' | null (= the phone's setting). */
export const SCHEMES = [
  { id: null, get label() { return t('more.scheme.auto'); } },
  { id: 'light', get label() { return t('more.scheme.light'); } },
  { id: 'dark', get label() { return t('more.scheme.dark'); } },
];

/** Force a colour scheme on <html>: every `light-dark()` token and the
 *  native controls follow it; '' restores the phone's setting. */
export function applyScheme(scheme) {
  const value = scheme === 'light' || scheme === 'dark' ? scheme : null;
  document.documentElement.style.colorScheme = value || '';
  return value;
}
