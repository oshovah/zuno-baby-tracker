// Entry point: instant-open boot (cached state renders before the network
// answers), hash router, bottom tab nav, service worker registration, and
// the auth/key state machine of the shell:
//   mode 'auth'  the login screen (login / register / recovery / unlock)
//   mode 'app'   the tab views over the store
// The store owns the key: store.keyState 'locked' (cookie alive, no usable
// key on this device) routes to the unlock screen; a 401 anywhere routes to
// the login screen. Local data is wiped only when the identity changes
// (store.setIdentity), never on a plain re-login of the same account.

import './style.css';
import { applyTheme, applyScheme } from './themes/index.js';
import { api, authEvents } from './api.js';
import { store, prefs } from './store.js';
import { t, setLocale, detectLocale } from './i18n/index.js';

// The design and the language first: the module runs before the first
// render, so the stored choices paint from the start (per-device
// preferences; the language falls back to the phone's, then to German).
applyTheme(prefs.theme);
applyScheme(prefs.scheme);
setLocale(detectLocale(prefs.lang, navigator.languages || [navigator.language]));
import { decryptProfile } from './crypto.js';
import { toast, isFeedingNow } from './ui.js';
import { closeActiveSheet } from './sheet.js';
import { renderLogin } from './views/login.js';
import { renderHome } from './views/home.js';
import { renderBackfill } from './views/backfill.js';
import { renderHistory } from './views/history.js';
import { renderMore } from './views/more.js';
import { WHATS_NEW, unseenWhatsNew, newestWhatsNewId } from './whats-new.js';
import { openWhatsNewSheet } from './whats-new-sheet.js';
import { applyKeptArt, syncArt, clearArt } from './art.js';

const app = document.getElementById('app');
const tabbar = document.getElementById('tabbar');

// The tab bar is static markup in index.html (German, the pre-JS default):
// label it in the active language, again after every switch.
const TAB_KEYS = { jetzt: 'shell.tab.now', nachtragen: 'shell.tab.backfill', verlauf: 'shell.tab.history', mehr: 'shell.tab.more' };
function labelShell() {
  tabbar.setAttribute('aria-label', t('shell.nav.label'));
  const meta = document.querySelector('meta[name="description"]');
  if (meta) meta.content = t('shell.meta.description');
  tabbar.querySelectorAll('a[data-tab]').forEach((a) => {
    const span = a.querySelector('span');
    if (span && TAB_KEYS[a.dataset.tab]) span.textContent = t(TAB_KEYS[a.dataset.tab]);
  });
}
labelShell();

// Private artwork (src/art.js): a member's phone shows its kept pictures at
// once; every sync page then says which version the server holds.
applyKeptArt();
store.subscribe(() => syncArt(store.artVersion, store.artKey));

let cleanup = null;
let mode = 'boot'; // 'boot' | 'auth' | 'app'

const routes = [
  { pattern: /^#\/?$/, tab: 'jetzt', render: (el) => renderHome(el) },
  { pattern: /^#\/nachtragen\/?$/, tab: 'nachtragen', render: (el) => renderBackfill(el) },
  { pattern: /^#\/verlauf\/?$/, tab: 'verlauf', render: (el) => renderHistory(el) },
  // `familie` is the deep link into the family half of the «Konto» pane (the
  // recovery toast below, older links) — the sub tab itself writes `konto`.
  { pattern: /^#\/mehr(\/(einstellungen|konto|familie|anleitung))?\/?$/, tab: 'mehr', render: (el) => renderMore(el) },
];

function runCleanup() {
  if (cleanup) {
    try {
      cleanup();
    } catch {
      /* ignore */
    }
    cleanup = null;
  }
}

function route() {
  if (mode !== 'app') return;
  const hash = location.hash || '#/';

  let def = null;
  for (const r of routes) {
    if (hash.match(r.pattern)) {
      def = r;
      break;
    }
  }
  if (!def) {
    // replace, not push: keep the bad hash out of history so Back still works.
    location.replace('#/');
    return;
  }

  runCleanup();

  tabbar.querySelectorAll('a').forEach((a) => {
    const active = a.dataset.tab === def.tab;
    a.classList.toggle('active', active);
    if (active) {
      a.setAttribute('aria-current', 'page');
    } else {
      a.removeAttribute('aria-current');
    }
  });

  // Fresh container per navigation: a stale in-flight view keeps writing into
  // its own (now detached) node instead of clobbering the new one.
  const view = document.createElement('div');
  view.className = 'view';
  app.replaceChildren(view);
  window.scrollTo(0, 0);

  try {
    const ret = def.render(view);
    if (typeof ret === 'function') cleanup = ret;
  } catch (err) {
    toast(err && err.message ? err.message : t('common.error.generic'));
    view.innerHTML = `<div class="empty"><p>${t('shell.view.failed')}</p></div>`;
  }
}

/**
 * Swap to the auth screen. opts.mode: 'login' (default), 'unlock' (the
 * cookie is alive but the device has no key — password only), 'register',
 * 'recovery'.
 */
function showLogin(opts = {}) {
  mode = 'auth';
  runCleanup();
  // A sheet lives on document.body, not in #app — without this, a 401 while
  // editing leaves the edit form floating over the login screen.
  closeActiveSheet();
  store.stop();
  tabbar.hidden = true;
  const view = document.createElement('div');
  view.className = 'view';
  app.replaceChildren(view);
  const ret = renderLogin(view, { mode: opts.mode || 'login', onAuthed, onUnlocked });
  if (typeof ret === 'function') cleanup = ret;
}

function startApp() {
  mode = 'app';
  tabbar.hidden = false;
  store.start();
  // The store can lock SYNCHRONOUSLY inside start() (the "logged in" flag is
  // set but there is no account data on this device); the subscriber below
  // then already swapped to the login screen. Painting the home view over it
  // would strand the phone on "Laden …".
  if (mode !== 'app') return;
  route();
  // The family was created on this phone and the recovery code screen was
  // left without "notiert": nag on every app start until it is revealed
  // under «Mehr» (which clears the flag) — the code is the only way back
  // into the entries once both passwords are forgotten.
  if (prefs.recoveryPending) {
    toast(t('shell.recovery.pending'), 'info', {
      ms: 12000,
      action: {
        label: t('common.action.show'),
        onClick: () => {
          location.hash = '#/mehr/familie';
        },
      },
    });
  }
  // A first sign-up on this phone (login.js sets the flag on every
  // registration path): point to the how-to until it was opened once —
  // «Mehr › Anleitung» clears the flag. Below the recovery nag when both
  // show, that one matters more.
  if (prefs.howtoPending) {
    toast(t('shell.howto.pending'), 'info', {
      ms: 12000,
      action: {
        label: t('common.action.show'),
        onClick: () => {
          location.hash = '#/mehr/anleitung';
        },
      },
    });
  }
  showWhatsNewOnce();
}

// «Was ist neu» after an update: the entries newer than the newest one this
// device has shown (src/whats-new.js), once per boot, a moment after the
// home screen painted. A phone that never saw any (the feature is new to it)
// gets the newest ones — unless the account was just signed in here
// (onAuthed marks them seen first: whoever signs in fresh is not "updating").
let whatsNewShown = false;
function showWhatsNewOnce() {
  if (whatsNewShown) return;
  const unseen = unseenWhatsNew(WHATS_NEW, prefs.whatsNewSeen);
  if (unseen.length === 0) return;
  setTimeout(() => {
    // Left the app meanwhile (a 401, a lock) or already shown: next boot then.
    if (mode !== 'app' || whatsNewShown) return;
    whatsNewShown = true;
    prefs.whatsNewSeen = newestWhatsNewId(WHATS_NEW);
    openWhatsNewSheet(unseen);
  }, 600);
}

const sameUser = (a, b) =>
  !!a && !!b && String(a.username).trim().toLowerCase() === String(b.username).trim().toLowerCase();

/**
 * Remember the signed-in account. A user JSON from api/me carries no
 * display name or KDF parameters (they only exist client-side): merge it
 * over what prefs already know about the SAME account, replace otherwise.
 */
function rememberUser(user) {
  const prev = prefs.user;
  prefs.user = sameUser(prev, user) ? { ...prev, ...user } : { ...user };
  prefs.authed = true;
  return prefs.user;
}

/**
 * A cookie-only boot knows the profile blob but not the name inside it:
 * decrypt it once the key is ready, so new entries carry the right name.
 */
async function fillDisplayName() {
  const u = prefs.user;
  if (!u || (typeof u.displayName === 'string' && u.displayName !== '')) return;
  if (store.keyState !== 'ready' || !store.fdk || !u.profileBlob) return;
  try {
    const { displayName } = await decryptProfile(store.fdk, u.username, u.profileBlob);
    if (typeof displayName === 'string' && displayName !== '') {
      prefs.user = { ...(prefs.user || u), displayName };
    }
  } catch {
    /* the username stands in until the next login */
  }
}

/**
 * Every successful authentication lands here: login, registration (both
 * modes, recovery code), or a cookie-only boot whose key turned out to be
 * present. session.* flows have already bound the store to the account;
 * store.setIdentity is idempotent for the same user and wipes the local
 * rows, key and cached snapshot only when ANOTHER account was here before
 * (the partner logged in on this phone) — a plain re-login keeps the
 * decrypted mirror, so the app is back instantly.
 */
async function onAuthed(user) {
  // A fresh sign-in on this phone is not an update: nothing to catch up on.
  // The same account signing in again (after a 401) still is one.
  if (!prefs.whatsNewSeen && !sameUser(prefs.user, user)) prefs.whatsNewSeen = newestWhatsNewId(WHATS_NEW);
  const u = rememberUser(user);
  try {
    await store.setIdentity(u);
  } catch {
    /* IndexedDB unusable — the store still runs in memory */
  }
  await fillDisplayName();
  startApp();
}

/** session.unlock succeeded: the store has its key again and is syncing. */
function onUnlocked() {
  prefs.authed = true;
  startApp();
}

/**
 * The device lost prefs (or never had them) but may still hold the valid
 * HttpOnly cookie — re-typing the password at 3am would be pointless. Ask
 * the server; when it knows us, check the KEY before opening the app: the
 * stored key present → app, absent → unlock screen (password only).
 */
function probeCookie() {
  api
    .get('api/me')
    .then((d) => {
      if (d && d.authenticated && d.user && mode === 'auth') return resumeFromCookie(d.user);
      return undefined;
    })
    .catch(() => {});
}

async function resumeFromCookie(user) {
  rememberUser(user);
  let state = 'locked';
  try {
    state = await store.boot();
  } catch {
    state = 'locked';
  }
  // The user signed in (or registered) by hand meanwhile: their flow wins.
  if (mode !== 'auth' || !sameUser(prefs.user, user)) return;
  if (state === 'ready') await onAuthed(prefs.user);
  else showLogin({ mode: 'unlock' });
}

// Any 401 means the token expired or was revoked — drop to the login screen
// (ignored while the login screen itself is up, so a wrong password just
// shows its inline error). prefs.user is kept on purpose: the login form
// prefills the username from it.
authEvents.onUnauthorized = () => {
  if (mode !== 'auth') {
    prefs.authed = false;
    clearArt(); // on a login screen nobody is a member
    showLogin();
  }
};

window.addEventListener('bt-logout', () => {
  clearArt();
  showLogin();
});

// The store found no usable key on this device (evicted IndexedDB, "Clear
// website data", a stale key after a family wipe): the cookie is still
// valid, so ask for the password only. Without a known account there is
// nothing to unlock — fall back to the login screen + cookie probe.
store.subscribe(() => {
  if (mode !== 'app' || store.keyState !== 'locked') return;
  if (prefs.user) {
    showLogin({ mode: 'unlock' });
  } else {
    showLogin();
    probeCookie();
  }
});

// Keep the phone screen on while FEEDING (a running Stillen timer, or a
// quick-logged feed in its live window) — and only then: a Schlaf timer runs
// for hours and would light the nightstand all night, and an unconditional
// lock would do the same after a quick glance at the app. Per-device switch
// under Mehr › Einstellungen (prefs.keepAwake). The system drops the lock
// whenever the app is hidden; visibilitychange takes it again. A quick feed
// ages out of its live window without any store event, so a minute-timer
// re-checks while the lock is held.
let wakeSentinel = null;
let wakeRecheck = null;
async function syncWakeLock() {
  if (!('wakeLock' in navigator)) return;
  const feeding = mode === 'app' && prefs.keepAwake && isFeedingNow(store.snapshot && store.snapshot.data);
  const want = feeding && document.visibilityState === 'visible';
  if (want && !wakeRecheck) wakeRecheck = setInterval(syncWakeLock, 60000);
  if (!want && wakeRecheck) {
    clearInterval(wakeRecheck);
    wakeRecheck = null;
  }
  if (want && !wakeSentinel) {
    try {
      wakeSentinel = await navigator.wakeLock.request('screen');
      wakeSentinel.addEventListener('release', () => {
        wakeSentinel = null;
      });
    } catch {
      /* denied (e.g. low battery) — not worth surfacing */
    }
  } else if (!want && wakeSentinel) {
    try {
      await wakeSentinel.release();
    } catch {
      /* already released */
    }
    wakeSentinel = null;
  }
}

store.subscribe(syncWakeLock);
document.addEventListener('visibilitychange', () => {
  syncWakeLock();
});
window.addEventListener('bt-prefs', syncWakeLock); // the Einstellungen switch
syncWakeLock();

window.addEventListener('hashchange', () => {
  if (mode === 'app') route();
});

// The language switched (Mehr › Einstellungen, or the login screen's
// toggle): relabel the tab bar and rebuild the current view — the login
// screen re-renders itself, the app views come back through the router
// (the pane of «Mehr» lives in the hash, so it survives).
window.addEventListener('bt-lang', () => {
  labelShell();
  if (mode === 'app') route();
});

// Shell caching + updates: the SW precaches the shell so repeat opens are
// instant and offline-safe (see public/sw.js). A new deploy activates a new
// worker; offer a one-tap reload instead of letting a resident standalone app
// run the old shell for days. Dev stays SW-free so Vite HMR is undisturbed.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('sw.js')
    .then((reg) => {
      // iOS keeps the standalone app resident for days — check for a new
      // version on every return to the foreground.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    })
    .catch(() => {
      /* the app works without it — just without instant offline opens */
    });

  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) {
      // First-ever controller: the initial install, not an update.
      hadController = true;
      return;
    }
    // After the reload the shell shows «Was ist neu» when the release
    // carries notes (showWhatsNewOnce) — the toast itself stays short.
    toast(t('shell.update.available'), 'success', {
      action: { label: t('shell.update.reload'), onClick: () => location.reload() },
      ms: 10000,
    });
  });
}

// Boot: no server round-trip. If this device ever logged in, show the app
// immediately: the cached snapshot paints at once, store.start() boots the
// key (locked → the subscriber above swaps to the unlock screen) and syncs
// (a 401 drops to login). Otherwise show the login screen — and ask the
// server whether the cookie is still good (probeCookie).
// prefs.user is required next to the flag: without an account there is no
// key to boot with.
if (prefs.authed && prefs.user) {
  startApp();
} else {
  prefs.authed = false;
  showLogin();
  probeCookie();
}
