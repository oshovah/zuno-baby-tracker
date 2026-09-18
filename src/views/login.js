// Login / registration / unlock screen: one card, five modes.
//   login     username + password → session.login
//   register  the one registration form; a live check on the family name
//             decides create (new name) or join (known name + family
//             password). After a CREATE the recovery code is shown and must
//             be acknowledged before the app opens (prefs.recoveryPending
//             stays set until then — the shell nags when a reload skipped
//             the screen; «Mehr» shows the code again after the password).
//   recovery  a new account in an existing family via the recovery code
//             (the family key itself) instead of the family password
//   unlock    the cookie is alive but this device lost the key: password
//             only, the username comes from prefs.user → session.unlock
// Every flow runs PBKDF2 on the phone (~0.1–0.3 s): the submit button reads
// "Schlüssel wird berechnet …" for that stage, then the server label.
//
// Every string comes from the `login` namespace (src/i18n) and is read when
// the screen renders; the language toggle under the title (bindLangSwitch)
// re-renders the current mode in the new language, typed values kept.
//
// renderLogin(root, {mode, onAuthed(user), onUnlocked()}); the shell
// (main.js) passes mode 'unlock' when store.keyState is 'locked'.

import { api } from '../api.js';
import { prefs } from '../store.js';
import * as session from '../session.js';
import { escapeHtml, toast, icon } from '../ui.js';
import { t, tn, getLocale, setLocale, availableLocales } from '../i18n/index.js';
import { bindAuthInfo } from './auth-info.js';
import { badgeSrc, bindBadgeFallback } from '../art.js';
import { SHOTS, SHOT_SIZE, shotFile } from '../shots.js';

// The slider's pictures by file name → the URL Vite gave them (hashed in a build).
const SHOT_URLS = import.meta.glob('../shots/*.webp', { eager: true, query: '?url', import: 'default' });

const CHECK_DEBOUNCE_MS = 400;
// The display-name chips: the word the chip shows is what gets stored (an
// English family is «Mom» and «Dad» to each other) — the same rule as the
// chips under Mehr › Konto (more.js presetNames).
const presetNames = () => [t('common.who.mama'), t('common.who.papa')];

/** The language toggle: one radio per shipped language, the active one marked. */
function langSwitchHtml() {
  const current = getLocale();
  const buttons = availableLocales()
    .map((l) => {
      const active = l.id === current;
      return `<button type="button" role="radio" aria-checked="${active}"${active ? ' class="active"' : ''} data-lang="${l.id}" lang="${l.id}">${escapeHtml(l.name)}</button>`;
    })
    .join('');
  return `<div class="lang-switch" role="radiogroup" aria-label="${t('common.language')}">${buttons}</div>`;
}

// The wordmark: «Zuno» is the name a parent remembers and passes on, «Baby
// Tracker» says what it is. Names stay untranslated (locales/README.md).
function logoHtml() {
  return `
      <div class="auth-logo" aria-hidden="true">
        <img src="${badgeSrc()}" alt="" width="96" height="96" />
      </div>
      <h1 class="brand"><span class="brand-name">Zuno</span> <span class="brand-kind">Baby Tracker</span></h1>
      ${langSwitchHtml()}`;
}

// The pitch under the login form — what whoever got the link is looking at.
// The form stays on top so a returning parent logs in without scrolling;
// the two selling points lead: one shared state across both phones, and
// end-to-end encryption; the hosting panel (hostingHtml) closes the list
// before the CTA. [hue, icon, key under login.pitch.*]
const PITCH_FEATURES = [
  ['milk', 'sync', 'sync'],
  ['sleep', 'lock', 'e2ee'],
  ['milk', 'bolt', 'oneTap'],
  ['diaper', 'care', 'midwife'],
  ['sleep', 'reminder', 'reminders'],
  ['measure', 'phone', 'noStore'],
];

// How the app looks, before anyone signs up: real screens with invented data
// (scripts/make-screenshots.mjs takes them, src/shots.js lists them, the
// files sit in src/shots/) in a
// strip that scrolls sideways. Swiping is the browser's own scroll-snap; the
// script (bindShots) only moves the dots and lets a tap bring a picture to
// the middle. The caption doubles as the picture's alt text, so the visible
// copy is hidden from screen readers — one reading, not two.
function shotsHtml() {
  const locale = getLocale();
  const shown = SHOTS.filter((id) => SHOT_URLS[`../shots/${shotFile(id, locale)}`]);
  if (shown.length === 0) return ''; // a checkout without pictures: no strip, no broken images
  const slides = shown.map((id) => {
    const caption = escapeHtml(t(`login.shots.${id}`));
    return `
            <figure class="shot">
              <img src="${SHOT_URLS[`../shots/${shotFile(id, locale)}`]}" alt="${caption}" width="${SHOT_SIZE.width}" height="${SHOT_SIZE.height}" loading="lazy" decoding="async" />
              <figcaption aria-hidden="true">${caption}</figcaption>
            </figure>`;
  }).join('');
  const dots = shown.map(
    (id, i) =>
      `<button type="button" data-shot-dot${i === 0 ? ' aria-current="true"' : ''} aria-label="${escapeHtml(t('login.shots.dot', { n: i + 1, total: shown.length }))}"></button>`
  ).join('');
  return `
        <div class="shots">
          <div class="shots-strip" data-shots tabindex="0" role="region" aria-label="${escapeHtml(t('login.shots.label'))}">${slides}
          </div>
          <div class="shots-dots">${dots}</div>
          <p class="shots-note">${t('login.shots.note')}</p>
        </div>`;
}

// Where THIS installation runs, named on the pitch (login.hosting.*). The
// «nothing else» half of that panel holds for every copy of the app — the
// packaged CSP (scripts/package.mjs) allows the own origin only —, the host
// and the place do not: whoever runs a copy elsewhere changes this constant
// and the wording in the locales.
const HOSTER = { name: 'cyon', url: 'https://www.cyon.ch/' };

// The public source: the link that closes the hosting panel («glauben musst
// du das nicht») and the last line of the tech note. AGPL §13: whoever runs
// a MODIFIED copy for other people points this at the source of THAT copy.
const SOURCE_URL = 'https://github.com/oshovah/zuno-baby-tracker';

/** A link that leaves the app: new tab, no opener, no referrer. `label` is HTML. */
const extLink = (url, label) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;

// What is missing on purpose — the tags under login.hosting.none.*
const HOSTING_NONE = ['cdn', 'fonts', 'analytics', 'ads', 'login', 'ai'];

// The whole data path as a drawing: two phones, ONE server between them.
// Strokes in currentColor — muted from .hosting-map, the server in the
// accent (.map-server, style.css); the labels are HTML underneath so they
// follow the language.
const HOSTING_MAP_SVG = `
          <svg viewBox="0 0 300 64" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <g>
              <rect x="18" y="6" width="30" height="52" rx="7" /><path d="M29 51h8" />
              <rect x="252" y="6" width="30" height="52" rx="7" /><path d="M263 51h8" />
            </g>
            <path d="M60 32h48M192 32h48" stroke-dasharray="2 6" />
            <g class="map-server">
              <rect x="120" y="9" width="60" height="20" rx="6" /><path d="M150 19h19" />
              <rect x="120" y="35" width="60" height="20" rx="6" /><path d="M150 45h19" />
              <circle cx="132" cy="19" r="1.6" fill="currentColor" stroke="none" />
              <circle cx="132" cy="45" r="1.6" fill="currentColor" stroke="none" />
            </g>
          </svg>`;

function hostingHtml() {
  const name = escapeHtml(HOSTER.name);
  const host = extLink(HOSTER.url, name);
  const source = t('login.hosting.source', { link: extLink(SOURCE_URL, t('login.hosting.sourceLink')) });
  const none = HOSTING_NONE.map(
    (key) => `<li><span aria-hidden="true">✕</span>${t(`login.hosting.none.${key}`)}</li>`
  ).join('');
  return `
        <div class="hosting">
          <h3>${t('login.hosting.title')}</h3>
          <div class="hosting-map" aria-hidden="true">${HOSTING_MAP_SVG}
            <div class="hosting-map-labels">
              <span>${t('login.hosting.map.phone')}</span>
              <b>${t('login.hosting.map.server', { name })}</b>
              <span>${t('login.hosting.map.partner')}</span>
            </div>
          </div>
          <p>${t('login.hosting.where', { host })}</p>
          <p>${t('login.hosting.only', { name })}</p>
          <p class="hosting-none-title" id="hosting-none-title">${t('login.hosting.noneTitle')}</p>
          <ul class="hosting-none" aria-labelledby="hosting-none-title">${none}</ul>
          <p class="hosting-proof">${t('login.hosting.proof')} ${source}</p>
        </div>`;
}

function pitchHtml() {
  const features = PITCH_FEATURES.map(
    ([hue, ic, key]) => `
          <li><span class="f-icon ${hue}" aria-hidden="true">${icon(ic)}</span><div>
            <b>${t(`login.pitch.${key}.title`)}</b>
            <p>${t(`login.pitch.${key}.body`)}</p></div></li>`
  ).join('');
  return `
      <section class="pitch" aria-labelledby="pitch-title">
        <h2 id="pitch-title">${t('login.pitch.title')}</h2>
        <p class="lead">${t('login.pitch.lead')}</p>${shotsHtml()}
        <ul class="features">${features}
        </ul>${hostingHtml()}
        <button type="button" class="btn primary wide cta" data-switch="register">${t('login.pitch.cta')}</button>
        <p class="cta-note">${t('login.pitch.ctaNote')}</p>
        <div class="about" aria-labelledby="about-title">
          <h3 id="about-title">${t('login.about.title')}</h3>
          <p>${t('login.about.p1')}</p>
          <p>${t('login.about.p2')}</p>
          <p>${t('login.about.p3')}</p>
          <p class="about-tech">${t('login.about.tech')} ${t('login.about.source', { link: extLink(SOURCE_URL, SOURCE_URL.replace(/^https?:\/\//, '')) })}</p>
        </div>
      </section>`;
}

// The scroll cue between the title and the login form: on a phone the pitch
// starts below the fold and nothing else says there is more — this line is
// visible on every screen height and jumps there (bindPitchCue).
function pitchCueHtml() {
  return `
      <button type="button" class="pitch-cue" data-pitch-cue aria-controls="pitch-title">
        ${t('login.pitchCue')} <span class="pitch-cue-arrow" aria-hidden="true">▾</span>
      </button>`;
}

const USERNAME_ATTRS =
  'type="text" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required';

const passphraseHint = () => t('login.field.passphraseHint', { min: session.PASSWORD_MIN });

/** Label row with an ⓘ button that opens the topic's info sheet. */
function fieldHead(forId, label, topic) {
  return `<div class="field-head">
      <label for="${forId}">${label}</label>
      <button type="button" class="info-btn" data-info="${topic}" aria-label="${t('login.field.info', { label })}">i</button>
    </div>`;
}

/** The display-name picker (chips + free text) shared by register and recovery. */
function whoFieldHtml(id) {
  const label = t('login.field.displayName');
  return `<div class="field who" role="group" aria-labelledby="${id}-label">
      <div class="field-head">
        <span id="${id}-label">${label}</span>
        <button type="button" class="info-btn" data-info="displayName" aria-label="${t('login.field.info', { label })}">i</button>
      </div>
      <div class="chip-row">
        ${presetNames()
          .map((p) => `<button type="button" class="chip" data-name="${escapeHtml(p)}">${escapeHtml(p)}</button>`)
          .join('')}
        <input name="customName" type="text" maxlength="40" placeholder="${t('login.field.otherName')}" />
      </div>
    </div>`;
}

function bindWhoField(root, form) {
  const chips = [...root.querySelectorAll('.chip[data-name]')];
  chips.forEach((chip) =>
    chip.addEventListener('click', () => {
      chips.forEach((c) => c.classList.toggle('active', c === chip));
      form.customName.value = '';
    })
  );
  form.customName.addEventListener('input', () => {
    chips.forEach((c) => c.classList.remove('active'));
  });
}

function readDisplayName(root, form) {
  const activeChip = root.querySelector('.chip[data-name].active');
  return form.customName.value.trim() || (activeChip ? activeChip.dataset.name : '');
}

function adoptedMessage(n) {
  return tn('login.recoveryCode.adopted', n);
}

/** Progress hook for session.*: the button shows the KDF stage, then `serverLabel`. */
const stages = (btn, serverLabel) => (stage) => {
  btn.textContent = stage === 'kdf' ? t('login.kdfWorking') : serverLabel;
};

/**
 * Run an auth flow behind its submit button: disabled + aria-busy while it
 * runs, the error shown inline and the button restored on failure. On
 * success the button stays disabled — the caller swaps the screen.
 * Resolves with {ok: true, value} or {ok: false, error}.
 */
async function runFlow(btn, errEl, flow) {
  errEl.textContent = '';
  const idle = btn.textContent;
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  try {
    const value = await flow();
    btn.textContent = idle;
    btn.removeAttribute('aria-busy');
    return { ok: true, value };
  } catch (error) {
    errEl.textContent = (error && error.message) || t('common.error.generic');
    btn.textContent = idle;
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    return { ok: false, error };
  }
}

/** Inline validation: show `message`, focus `input`, return false. */
function reject(errEl, input, message) {
  errEl.textContent = message;
  if (input && typeof input.focus === 'function') input.focus();
  return false;
}

const tooShort = (pw) => [...pw].length < session.PASSWORD_MIN;

export function renderLogin(root, opts = {}) {
  const callbacks = typeof opts === 'function' ? { onAuthed: opts } : opts || {};
  const onAuthed = typeof callbacks.onAuthed === 'function' ? callbacks.onAuthed : () => {};
  const onUnlocked = typeof callbacks.onUnlocked === 'function' ? callbacks.onUnlocked : () => {};
  // The username survives a mode switch and a 401 (prefs.user is kept), so a
  // re-login at 3am is one password away.
  let username = (prefs.user && prefs.user.username) || '';
  let mode = callbacks.mode || 'login';
  if (mode === 'unlock' && !prefs.user) mode = 'login'; // nothing to unlock for
  let codeResult = null; // the create's answer while the recovery code is on screen (mode 'code')
  let codeConfirmed = false; // «Ich habe den Code notiert» ticked (survives a language switch)
  let pendingError = ''; // shown by the next render (e.g. unlock → session gone → login)
  let autoFocus = true; // off during a language re-render: no keyboard pop for a tap on the toggle
  let disposeMode = () => {};

  function switchMode(next, error = '') {
    disposeMode();
    disposeMode = () => {};
    const field = root.querySelector('input[name="username"]:not([readonly])');
    if (field) username = field.value.trim();
    mode = next;
    pendingError = error;
    window.scrollTo(0, 0); // the login pitch may have been scrolled to its CTA
    render();
  }

  function focusField(el) {
    if (autoFocus && el && typeof el.focus === 'function') el.focus();
  }

  function focusFirstEmpty(form) {
    focusField(form.username.value ? form.password : form.username);
  }

  /** Every mode switch link: data-switch="login|register|recovery". */
  function bindSwitches() {
    root.querySelectorAll('[data-switch]').forEach((btn) =>
      btn.addEventListener('click', () => switchMode(btn.dataset.switch))
    );
  }

  /** The «Was die App kann» cue scrolls to the pitch (the form sits above the fold, the pitch below it). */
  function bindPitchCue() {
    const cue = root.querySelector('[data-pitch-cue]');
    const pitch = root.querySelector('.pitch');
    if (!cue || !pitch) return;
    cue.addEventListener('click', () => {
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      pitch.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
    });
  }

  /** The screenshot strip: the dots follow the scroll position; a dot or a picture brings that picture to the middle. */
  function bindShots() {
    const strip = root.querySelector('[data-shots]');
    if (!strip) return;
    const slides = [...strip.querySelectorAll('.shot')];
    const dots = [...root.querySelectorAll('[data-shot-dot]')];
    const middle = (el) => el.offsetLeft + el.offsetWidth / 2; // the strip is the offset parent (position: relative)
    let frame = 0;
    const mark = () => {
      frame = 0;
      const at = strip.scrollLeft + strip.clientWidth / 2;
      let active = 0;
      slides.forEach((slide, i) => {
        if (Math.abs(middle(slide) - at) < Math.abs(middle(slides[active]) - at)) active = i;
      });
      dots.forEach((dot, i) => (i === active ? dot.setAttribute('aria-current', 'true') : dot.removeAttribute('aria-current')));
    };
    const show = (i) => {
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      strip.scrollTo({ left: middle(slides[i]) - strip.clientWidth / 2, behavior: reduce ? 'auto' : 'smooth' });
    };
    strip.addEventListener(
      'scroll',
      () => {
        if (!frame) frame = requestAnimationFrame(mark);
      },
      { passive: true }
    );
    dots.forEach((dot, i) => dot.addEventListener('click', () => show(i)));
    slides.forEach((slide, i) => slide.addEventListener('click', () => show(i)));
  }

  /**
   * The language toggle under the title (every mode): the device's choice
   * (prefs.lang) and the i18n singleton, then this screen again in the new
   * language and `bt-lang` for the shell (the tab bar's labels).
   */
  function bindLangSwitch() {
    bindBadgeFallback(root); // the badge sits in the same card head (src/art.js)
    root.querySelectorAll('.lang-switch [data-lang]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const id = btn.dataset.lang;
        if (id === getLocale()) return;
        // A flow in flight (runFlow marks its button busy) owns these nodes:
        // its error and its re-enable must land where the parent looks.
        if (root.querySelector('button[type="submit"][aria-busy]')) return;
        prefs.lang = id;
        setLocale(id);
        rerender();
        window.dispatchEvent(new Event('bt-lang'));
        const active = root.querySelector('.lang-switch .active');
        if (active) active.focus();
      })
    );
  }

  /** The current mode again (a language switch): typed values and the chosen chip survive. */
  function rerender() {
    const values = {};
    const form = root.querySelector('form');
    if (form) {
      for (const el of form.elements) {
        if (!el.name || el.readOnly || el.type === 'checkbox' || el.type === 'submit') continue;
        if (el.value !== '') values[el.name] = el.value;
      }
    }
    const chipsBefore = [...root.querySelectorAll('.chip[data-name]')];
    const chipIndex = chipsBefore.findIndex((c) => c.classList.contains('active'));
    // The field itself, not the non-empty map: a name the parent cleared
    // (to sign in as someone else) must stay cleared.
    const nameField = root.querySelector('input[name="username"]:not([readonly])');
    if (nameField) username = nameField.value.trim();
    disposeMode();
    disposeMode = () => {};
    autoFocus = false;
    try {
      render();
    } finally {
      autoFocus = true;
    }
    const next = root.querySelector('form');
    if (!next) return;
    for (const [name, value] of Object.entries(values)) {
      const el = next.elements[name];
      if (!el || el.readOnly || typeof el.value !== 'string') continue;
      el.value = value;
      // The family field's live create-or-join check starts over with its value.
      if (name === 'familyName') el.dispatchEvent(new Event('input'));
    }
    if (chipIndex >= 0) {
      const chip = root.querySelectorAll('.chip[data-name]')[chipIndex];
      if (chip) chip.classList.add('active');
    }
  }

  function takePendingError(errEl) {
    if (pendingError) errEl.textContent = pendingError;
    pendingError = '';
  }

  // --- login ---------------------------------------------------------------------

  function renderLoginMode() {
    root.innerHTML = `
    <div class="auth-card">${logoHtml()}
      <p class="hint tagline">${t('login.tagline')}<br /><span class="tagline-trust">${t('login.taglineTrust')}</span></p>
      ${pitchCueHtml()}
      <form class="auth-form" novalidate>
        <label>${t('login.field.username')}
          <input name="username" ${USERNAME_ATTRS} value="${escapeHtml(username)}" />
        </label>
        <label>${t('login.field.password')}
          <input name="password" type="password" autocomplete="current-password" required />
        </label>
        <p class="auth-error" aria-live="polite"></p>
        <button type="submit" class="btn primary big">${t('login.login.submit')}</button>
      </form>
      <button type="button" class="btn wide" data-switch="register">${t('login.login.createAccount')}</button>
      <button type="button" class="link-btn wide" data-info="reset">${t('login.login.forgotPassword')}</button>
      <button type="button" class="link-btn wide" data-switch="recovery">${t('login.login.withRecoveryCode')}</button>
      ${pitchHtml()}
    </div>`;

    const form = root.querySelector('form');
    const errEl = root.querySelector('.auth-error');
    const btn = form.querySelector('button[type="submit"]');
    bindAuthInfo(root);
    bindLangSwitch();
    bindSwitches();
    bindPitchCue();
    bindShots();
    takePendingError(errEl);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = form.username.value.trim();
      const password = form.password.value;
      if (!name) return reject(errEl, form.username, t('login.error.noUsername'));
      if (!password) return reject(errEl, form.password, t('login.error.noPassword'));
      const res = await runFlow(btn, errEl, () =>
        session.login(name, password, { onProgress: stages(btn, t('login.login.submitting')) })
      );
      if (res.ok) {
        // Whoever signs in has used the app before (or registered on another
        // phone): the how-to pointer is for a registration on THIS device.
        prefs.howtoPending = false;
        onAuthed(res.value);
      }
      return true;
    });
    focusFirstEmpty(form);
  }

  // --- unlock (cookie alive, key gone) ---------------------------------------------

  function renderUnlockMode() {
    const user = prefs.user;
    const who = user.displayName && user.displayName !== user.username
      ? `${escapeHtml(user.displayName)} (${escapeHtml(user.username)})`
      : escapeHtml(user.username);
    root.innerHTML = `
    <div class="auth-card">${logoHtml()}
      <p class="hint">${t('login.unlock.hint', { who })}
        <button type="button" class="link-btn" data-info="unlock">${t('login.unlock.why')}</button></p>
      <form class="auth-form" novalidate>
        <input name="username" type="text" autocomplete="username" value="${escapeHtml(user.username)}"
          readonly tabindex="-1" aria-hidden="true" class="visually-hidden" />
        <label>${t('login.field.password')}
          <input name="password" type="password" autocomplete="current-password" required />
        </label>
        <p class="auth-error" aria-live="polite"></p>
        <button type="submit" class="btn primary big">${t('login.unlock.submit')}</button>
      </form>
      <button type="button" class="link-btn wide" data-info="reset">${t('login.login.forgotPassword')}</button>
      <button type="button" class="link-btn wide" data-other-account>${t('login.unlock.otherAccount')}</button>
    </div>`;

    const form = root.querySelector('form');
    const errEl = root.querySelector('.auth-error');
    const btn = form.querySelector('button[type="submit"]');
    bindAuthInfo(root);
    bindLangSwitch();
    takePendingError(errEl);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = form.password.value;
      if (!password) return reject(errEl, form.password, t('login.error.noPassword'));
      const res = await runFlow(btn, errEl, () =>
        session.unlock(password, { onProgress: stages(btn, t('login.unlock.submitting')) })
      );
      if (res.ok) {
        onUnlocked();
      } else if (res.error && res.error.status === 401) {
        // The cookie died while the unlock screen was up: the shell ignores
        // 401s in auth mode, so route to the login form from here.
        prefs.authed = false;
        switchMode('login', t('login.error.sessionGone'));
      }
      return true;
    });

    // Someone else's phone, or a forgotten password: end this session
    // (server revoke + local wipe, best effort) and offer the login form.
    root.querySelector('[data-other-account]').addEventListener('click', async (e) => {
      const link = e.currentTarget;
      link.disabled = true;
      try {
        await session.logout();
      } catch {
        /* the local wipe happened regardless */
      }
      username = ''; // a different person is about to sign in
      switchMode('login');
    });
    focusField(form.password);
  }

  // --- register (create or join) ------------------------------------------------------

  function renderRegisterMode() {
    root.innerHTML = `
    <div class="auth-card">${logoHtml()}
      <p class="hint">${t('login.register.hint')}
        <button type="button" class="link-btn" data-info="howto">${t('login.register.howItWorks')}</button></p>
      <form class="auth-form" novalidate>
        <div class="notice privacy">
          <strong>${t('login.register.privacyTitle')}</strong> ${t('login.register.privacyBody')}<br />
          ${t('login.register.privacyNoReset')}
          <button type="button" class="link-btn" data-info="reset">${t('login.register.privacyForgot')}</button>
        </div>
        <div class="field">
          ${fieldHead('reg-username', t('login.field.username'), 'username')}
          <input id="reg-username" name="username" ${USERNAME_ATTRS} value="${escapeHtml(username)}" />
        </div>
        <div class="field">
          ${fieldHead('reg-password', t('login.field.password'), 'password')}
          <input id="reg-password" name="password" type="password" autocomplete="new-password" minlength="${session.PASSWORD_MIN}" required />
          <p class="hint">${passphraseHint()}</p>
        </div>
        ${whoFieldHtml('reg-name')}
        <div class="field">
          ${fieldHead('reg-family', t('login.field.family'), 'family')}
          <input id="reg-family" name="familyName" type="text" maxlength="40" required />
          <p class="hint" data-family-hint aria-live="polite">${t('login.register.familyHint')}</p>
        </div>
        <div class="field">
          ${fieldHead('reg-family-password', t('login.field.familyPassword'), 'familyPassword')}
          <input id="reg-family-password" name="familyPassword" type="password" autocomplete="off" minlength="${session.PASSWORD_MIN}" required />
        </div>
        <p class="auth-error" aria-live="polite"></p>
        <button type="submit" class="btn primary big">${t('login.register.submit')}</button>
      </form>
      <button type="button" class="btn wide" data-switch="login">${t('login.nav.backToLogin')}</button>
    </div>`;

    const form = root.querySelector('form');
    const errEl = root.querySelector('.auth-error');
    const familyInput = form.familyName;
    const familyPw = form.familyPassword;
    const familyHint = root.querySelector('[data-family-hint]');
    const submitBtn = form.querySelector('button[type="submit"]');
    bindAuthInfo(root);
    bindLangSwitch();
    bindSwitches();
    bindWhoField(root, form);
    takePendingError(errEl);

    // Live "join or create?" check on the family name. status: idle (empty)
    // | checking | exists | new | unknown (request failed → neutral hint).
    // Unlike before, the CLIENT decides the mode (the key material differs),
    // so submit waits for a settled answer (settledFamily) — the server still
    // 409s a create on a name that appeared meanwhile.
    let family = { status: 'idle', value: '', name: null };
    let checkSeq = 0;
    let checkTimer = null;

    function paintFamily() {
      const f = family;
      if (f.status === 'exists') {
        familyHint.textContent = t('login.register.familyExists', { name: f.name });
        submitBtn.textContent = t('login.register.submitJoin');
        familyPw.setAttribute('autocomplete', 'current-password');
      } else if (f.status === 'new') {
        familyHint.textContent = t('login.register.familyNew', { name: f.value });
        submitBtn.textContent = t('login.register.submitCreate');
        familyPw.setAttribute('autocomplete', 'new-password');
      } else if (f.status === 'checking') {
        // Button and autocomplete keep following the last
        // result until the new one is in — no flicker per keystroke.
        familyHint.textContent = t('login.register.familyChecking');
        return;
      } else {
        familyHint.textContent = t('login.register.familyHint');
        submitBtn.textContent = t('login.register.submit');
        familyPw.setAttribute('autocomplete', 'off');
      }
    }

    function applyCheck(value, res) {
      const exists = !!(res && res.exists);
      family = {
        status: exists ? 'exists' : 'new',
        value,
        name: exists && typeof res.name === 'string' ? res.name : value,
      };
      paintFamily();
      return family;
    }

    function fireCheck() {
      checkTimer = null;
      if (family.status !== 'checking') return;
      const value = family.value;
      const seq = ++checkSeq;
      api
        .get('api/families/check?name=' + encodeURIComponent(value))
        .then((res) => {
          if (seq !== checkSeq) return; // the field moved on — stale answer
          applyCheck(value, res);
        })
        .catch(() => {
          if (seq !== checkSeq) return;
          family = { status: 'unknown', value, name: null };
          paintFamily();
        });
    }

    /** The settled create/join decision for `value` — a fresh check unless one is in. */
    async function settledFamily(value) {
      if ((family.status === 'exists' || family.status === 'new') && family.value === value) return family;
      clearTimeout(checkTimer);
      checkTimer = null;
      checkSeq++;
      let res;
      try {
        res = await api.get('api/families/check?name=' + encodeURIComponent(value));
      } catch (err) {
        family = { status: 'unknown', value, name: null };
        paintFamily();
        throw new Error(err && err.status ? err.message : t('login.error.familyCheck'));
      }
      return applyCheck(value, res);
    }

    familyInput.addEventListener('input', () => {
      const value = familyInput.value.trim();
      if (value === family.value && family.status !== 'unknown') return; // only whitespace changed
      clearTimeout(checkTimer);
      checkTimer = null;
      checkSeq++; // any answer still on the wire is for an old value
      family = { status: value ? 'checking' : 'idle', value, name: null };
      paintFamily();
      if (value) checkTimer = setTimeout(fireCheck, CHECK_DEBOUNCE_MS);
    });
    familyInput.addEventListener('blur', () => {
      if (checkTimer) {
        // Leaving the field: don't make the user wait out the debounce.
        clearTimeout(checkTimer);
        fireCheck();
      } else if (family.status === 'unknown' && family.value) {
        family = { ...family, status: 'checking' }; // retry a failed check
        paintFamily();
        fireCheck();
      }
    });
    disposeMode = () => {
      clearTimeout(checkTimer);
      checkTimer = null;
      checkSeq++;
    };

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = form.username.value.trim();
      const password = form.password.value;
      const displayName = readDisplayName(root, form);
      const familyName = familyInput.value.trim();
      const familyPassword = familyPw.value;

      if (!name) return reject(errEl, form.username, t('login.error.chooseUsername'));
      if (tooShort(password)) {
        return reject(errEl, form.password, t('login.error.passwordShort', { min: session.PASSWORD_MIN }));
      }
      if (!displayName) return reject(errEl, form.customName, t('login.error.chooseDisplayName'));
      if (!familyName) return reject(errEl, familyInput, t('login.error.noFamilyName'));
      if (!familyPassword) return reject(errEl, familyPw, t('login.error.noFamilyPassword'));
      // Family passwords were always ≥ 8 (the old server rule) — one check for both modes.
      if (tooShort(familyPassword)) {
        return reject(errEl, familyPw, t('login.error.familyPasswordShort', { min: session.PASSWORD_MIN }));
      }

      let kind = null;
      const res = await runFlow(submitBtn, errEl, async () => {
        submitBtn.textContent = t('login.register.checkingFamily');
        const fam = await settledFamily(familyName);
        if (fam.status === 'exists') {
          kind = 'join';
          const joined = await session.registerJoin(
            { username: name, password, displayName, familyName: fam.name, familyPassword },
            { onProgress: stages(submitBtn, t('login.register.joining')) }
          );
          return { kind, ...joined };
        }
        kind = 'create';
        const created = await session.registerCreate(
          { username: name, password, displayName, familyName, familyPassword },
          { onProgress: stages(submitBtn, t('login.register.creating')) }
        );
        return { kind, ...created };
      });

      if (!res.ok) {
        paintFamily(); // the button label follows the (possibly just settled) create/join decision
        // The server's 409 for a family that appeared meanwhile carries its
        // code (api.js sets err.code); the other 409 is a taken username. The
        // text sniff stands in for a server without codes.
        const familyRace =
          res.error && res.error.status === 409 && (res.error.code ? res.error.code === 'auth.familyExists' : /famil/i.test(res.error.message || ''));
        if (kind === 'create' && familyRace) {
          // Someone created that family a moment ago: re-check, the form
          // flips to join and asks for their family password.
          family = { status: 'checking', value: familyName, name: null };
          paintFamily();
          fireCheck();
        }
        return false;
      }

      disposeMode();
      const result = res.value;
      // A first sign-up on this device: the shell points to «Mehr › Anleitung»
      // on the next app starts until the how-to was opened once.
      prefs.howtoPending = true;
      if (result.kind === 'create') {
        // The account is live from here on (cookie + key): should a reload
        // skip this screen, the shell reminds them until the code was seen
        // once more under «Mehr».
        prefs.recoveryPending = true;
        mode = 'code';
        codeResult = result;
        codeConfirmed = false;
        renderRecoveryCode(result);
        return true;
      }
      onAuthed(result.user);
      if (result.familyClosed) toast(t('login.register.joinedClosed'), 'success', { ms: 8000 });
      return true;
    });
    focusFirstEmpty(form);
  }

  // --- recovery code after a create (again under «Mehr» later) ----------------------------

  function renderRecoveryCode(result) {
    const user = result.user;
    const familyName = (user && user.familyName) || '';
    root.innerHTML = `
    <div class="auth-card">${logoHtml()}
      <h2 class="auth-subtitle">${t('login.recoveryCode.title')}</h2>
      <p class="hint">${t('login.recoveryCode.intro', { family: escapeHtml(familyName) })}
        <button type="button" class="link-btn" data-info="recovery">${t('login.recoveryCode.why')}</button></p>
      <div class="recovery-code" data-code translate="no">${escapeHtml(result.recoveryCode)}</div>
      <button type="button" class="btn wide" data-copy>${t('login.recoveryCode.copy')}</button>
      <p class="hint">${t('login.recoveryCode.warning')}</p>
      <label class="confirm-row">
        <input type="checkbox" data-confirm${codeConfirmed ? ' checked' : ''} />
        <span>${t('login.recoveryCode.confirm')}</span>
      </label>
      <button type="button" class="btn primary big wide" data-done${codeConfirmed ? '' : ' disabled'}>${t('login.recoveryCode.continue')}</button>
    </div>`;

    bindAuthInfo(root);
    bindLangSwitch();
    const codeEl = root.querySelector('[data-code]');
    const confirm = root.querySelector('[data-confirm]');
    const done = root.querySelector('[data-done]');

    root.querySelector('[data-copy]').addEventListener('click', async () => {
      const text = result.recoveryCode;
      try {
        if (!navigator.clipboard) throw new Error('no clipboard');
        await navigator.clipboard.writeText(text);
        toast(t('login.recoveryCode.copied'), 'success');
      } catch {
        // No clipboard API (older WebViews): select the code for a manual copy.
        try {
          const range = document.createRange();
          range.selectNodeContents(codeEl);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        } catch {
          /* ignore */
        }
        toast(t('login.recoveryCode.copyManually'), 'info');
      }
    });
    confirm.addEventListener('change', () => {
      done.disabled = !confirm.checked;
      codeConfirmed = confirm.checked;
    });
    done.addEventListener('click', () => {
      if (!confirm.checked) return;
      done.disabled = true;
      prefs.recoveryPending = false; // acknowledged — before the shell boots and would nag
      onAuthed(user);
      toast(t('login.recoveryCode.familyCreated', { family: familyName }), 'success');
      if (result.adoptedEntries > 0) toast(adoptedMessage(result.adoptedEntries), 'info', { ms: 6000 });
    });
  }

  // --- recovery code login (new account in an existing family) ------------------------------

  function renderRecoveryMode() {
    root.innerHTML = `
    <div class="auth-card">${logoHtml()}
      <p class="hint">${t('login.recovery.hint')}
        <button type="button" class="link-btn" data-info="recovery">${t('login.recovery.more')}</button></p>
      <form class="auth-form" novalidate>
        <div class="field">
          ${fieldHead('rec-username', t('login.field.newUsername'), 'username')}
          <input id="rec-username" name="username" ${USERNAME_ATTRS} value="${escapeHtml(username)}" />
        </div>
        <div class="field">
          ${fieldHead('rec-password', t('login.field.newPassword'), 'password')}
          <input id="rec-password" name="password" type="password" autocomplete="new-password" minlength="${session.PASSWORD_MIN}" required />
          <p class="hint">${passphraseHint()}</p>
        </div>
        ${whoFieldHtml('rec-name')}
        <div class="field">
          ${fieldHead('rec-family', t('login.field.family'), 'family')}
          <input id="rec-family" name="familyName" type="text" maxlength="40" required />
        </div>
        <div class="field">
          ${fieldHead('rec-code', t('login.field.recoveryCode'), 'recovery')}
          <textarea id="rec-code" name="recoveryCode" class="code-input" rows="2" autocomplete="off"
            autocapitalize="none" autocorrect="off" spellcheck="false" translate="no"
            placeholder="${t('login.field.recoveryCodePlaceholder')}" required></textarea>
        </div>
        <p class="auth-error" aria-live="polite"></p>
        <button type="submit" class="btn primary big">${t('login.recovery.submit')}</button>
      </form>
      <button type="button" class="btn wide" data-switch="login">${t('login.nav.backToLogin')}</button>
    </div>`;

    const form = root.querySelector('form');
    const errEl = root.querySelector('.auth-error');
    const btn = form.querySelector('button[type="submit"]');
    bindAuthInfo(root);
    bindLangSwitch();
    bindSwitches();
    bindWhoField(root, form);
    takePendingError(errEl);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = form.username.value.trim();
      const password = form.password.value;
      const displayName = readDisplayName(root, form);
      const familyName = form.familyName.value.trim();
      const recoveryCode = form.recoveryCode.value.trim();

      if (!name) return reject(errEl, form.username, t('login.error.chooseUsername'));
      if (tooShort(password)) {
        return reject(errEl, form.password, t('login.error.passwordShort', { min: session.PASSWORD_MIN }));
      }
      if (!displayName) return reject(errEl, form.customName, t('login.error.chooseDisplayName'));
      if (!familyName) return reject(errEl, form.familyName, t('login.error.noFamilyNameRecovery'));
      if (!recoveryCode) return reject(errEl, form.recoveryCode, t('login.error.noRecoveryCode'));

      const res = await runFlow(btn, errEl, () =>
        session.registerWithRecoveryCode(
          { username: name, password, displayName, familyName, recoveryCode },
          { onProgress: stages(btn, t('login.recovery.submitting')) }
        )
      );
      if (res.ok) {
        const user = res.value.user;
        prefs.howtoPending = true; // a new account on this device — see the register mode
        onAuthed(user);
        toast(t('login.recovery.welcomeBack', { family: (user && user.familyName) || familyName }), 'success');
        if (res.value.familyClosed) toast(t('login.register.joinedClosed'), 'success', { ms: 8000 });
      }
      return true;
    });
    focusFirstEmpty(form);
  }

  function render() {
    if (mode === 'register') renderRegisterMode();
    else if (mode === 'recovery') renderRecoveryMode();
    else if (mode === 'code' && codeResult) renderRecoveryCode(codeResult);
    else if (mode === 'unlock' && prefs.user) renderUnlockMode();
    else renderLoginMode();
  }

  render();
  return () => disposeMode();
}
