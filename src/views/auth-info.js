// Info overlays for the login / registration / unlock screen: what each field
// means, how a family is created or joined, and — the part people must not
// miss — what the end-to-end encryption implies: the server holds only
// usernames and family names, everything else is encrypted on the phone, so
// nobody (not even whoever runs the app) can read entries or reset a
// password. Three keys open the data: the own password, the family password
// and the recovery code. Reuses the app's bottom sheet (Esc, backdrop tap and
// Back all close it). Static copy only: nothing here comes from the server or
// the user — the strings live in the `authInfo` namespace (one key per title,
// paragraph and list item; the block structure is assembled here), read when
// a sheet opens so it comes up in the active language.

import { openSheet } from '../sheet.js';
import { t } from '../i18n/index.js';

const s = (key) => t(`authInfo.${key}`);
const p = (key) => `<p>${s(key)}</p>`;
const h3 = (key) => `<h3>${s(key)}</h3>`;
const list = (tag, keys) => `<${tag}>${keys.map((key) => `<li>${s(key)}</li>`).join('')}</${tag}>`;

/** The «Drei Schlüssel» block the reset sheet shares. */
function threeKeysHtml() {
  return h3('threeKeys.title') + list('ul', ['threeKeys.own', 'threeKeys.family', 'threeKeys.recovery']);
}

/**
 * The topics, keyed by the [data-info] value: each with the sheet title and
 * the body HTML. Built on every call — the copy must be read when shown,
 * never at module load, or it would stay in the language the app started with.
 */
function topics() {
  return {
    howto: {
      title: s('howto.title'),
      html:
        p('howto.whatIsFamily') +
        list('ol', ['howto.stepCreate', 'howto.stepJoin', 'howto.stepDone']) +
        p('howto.moreMembers') +
        p('howto.nameCheck') +
        h3('howto.privacyTitle') +
        p('howto.privacy'),
    },
    username: {
      title: s('username.title'),
      html: p('username.purpose') + p('username.rules') + p('username.remember'),
    },
    password: {
      title: s('password.title'),
      html: p('password.purpose') + p('password.neverLeaves') + p('password.forgotten'),
    },
    displayName: {
      title: s('displayName.title'),
      html: p('displayName.purpose') + p('displayName.change'),
    },
    family: {
      title: s('family.title'),
      html: p('family.purpose') + p('family.newOrExisting') + p('family.scope'),
    },
    familyPassword: {
      title: s('familyPassword.title'),
      html: p('familyPassword.purpose') + p('familyPassword.oneTime') + p('familyPassword.nextPerson'),
    },
    recovery: {
      title: s('recovery.title'),
      html: p('recovery.what') + p('recovery.use') + p('recovery.format'),
    },
    unlock: {
      title: s('unlock.title'),
      html: p('unlock.why') + p('unlock.what') + p('unlock.forgotten'),
    },
    reset: {
      title: s('reset.title'),
      html:
        p('reset.noReset') +
        threeKeysHtml() +
        h3('reset.ownTitle') +
        p('reset.own') +
        h3('reset.familyTitle') +
        p('reset.family') +
        h3('reset.allLostTitle') +
        p('reset.allLost') +
        h3('reset.nextTimeTitle') +
        p('reset.nextTime'),
    },
  };
}

/** { title, html } of a topic in the active language, or null for an unknown key (pure, testable). */
export function authInfoContent(topic) {
  const all = topics();
  return Object.prototype.hasOwnProperty.call(all, topic) ? all[topic] : null;
}

/** Open the info sheet for a topic key (unknown keys are ignored). */
export function openAuthInfo(topic) {
  const def = authInfoContent(topic);
  if (!def) return;
  openSheet(def.title, (body) => {
    body.innerHTML = `<div class="info-body">${def.html}</div>`;
  });
}

/** Wire every [data-info] button inside root to its topic sheet. */
export function bindAuthInfo(root) {
  root.querySelectorAll('[data-info]').forEach((btn) =>
    btn.addEventListener('click', () => openAuthInfo(btn.dataset.info))
  );
}
