// «Mehr › Anleitung» — how the app is used, as static copy: the four tabs,
// the one-tap logging on «Jetzt» (and the corrections around it), meals,
// Nachtragen, Verlauf, the reminders, the two-phone sync, the settings, the
// account and the keys, installing. Nothing here comes from the server or
// the user; the wording follows the labels the views actually show, so
// keep it in step when a label changes. The shell points a first sign-up
// here with a toast (prefs.howtoPending, main.js); opening the pane clears
// the flag (more.js).
//
// The copy lives in the `howto` namespace (src/i18n/locales/*/howto.js):
// one key per section title and per paragraph / list item, <strong> inside
// the strings, the pictograms here. Everything is read at render time so
// a language switch takes effect on the next open.

import { icon } from '../ui.js';
import { t } from '../i18n/index.js';

/** A section heading in the design's section-title voice (swiss lowercases
 *  and rules it, bauhaus tracks it out) with a pictogram from its icon set. */
const head = (ico, key) => `<h2 class="section-title">${icon(ico)}<span>${t(key)}</span></h2>`;

const li = (key) => `<li>${t(key)}</li>`;
const p = (key, params) => `<p>${t(key, params)}</p>`;

export function howtoHtml() {
  return `
    <div class="howto">
      <p class="lead">${t('howto.lead')}</p>

      ${head('bolt', 'howto.tabs.title')}
      <ul>
        ${li('howto.tabs.now')}
        ${li('howto.tabs.log')}
        ${li('howto.tabs.history')}
        ${li('howto.tabs.more')}
      </ul>

      ${head('breastfeed', 'howto.nursing.title')}
      <ul>
        ${li('howto.nursing.start')}
        ${li('howto.nursing.stop')}
        ${li('howto.nursing.switch')}
        ${li('howto.nursing.pause')}
        ${li('howto.nursing.lateStart')}
      </ul>

      ${head('bottle', 'howto.bottle.title')}
      ${p('howto.bottle.body')}

      ${head('diaper', 'howto.diaper.title')}
      ${p('howto.diaper.body')}

      ${head('sleep', 'howto.sleep.title')}
      ${p('howto.sleep.body')}

      ${head('sync', 'howto.undo.title')}
      ${p('howto.undo.body')}

      ${head('bottle', 'howto.meals.title')}
      ${p('howto.meals.body')}

      ${head('weight', 'howto.log.title')}
      ${p('howto.log.body')}

      ${head('task', 'howto.history.title')}
      ${p('howto.history.body')}

      ${head('reminder', 'howto.reminders.title')}
      ${p('howto.reminders.body')}

      ${head('phone', 'howto.twoPhones.title')}
      ${p('howto.twoPhones.body')}

      ${head('wake', 'howto.settings.title')}
      ${p('howto.settings.body')}

      ${head('lock', 'howto.account.title')}
      ${p('howto.account.body')}
      ${p('howto.account.encryption')}

      ${head('phone', 'howto.install.title')}
      ${p('howto.install.body')}
    </div>`;
}
