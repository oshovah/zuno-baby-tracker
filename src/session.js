// Auth and key flows: login, register (create / join /
// recovery code), unlock, password change, family password rotation,
// recovery code reveal, display name, logout. UI-free: every failure is an
// Error whose text the views show verbatim — read from the translations at
// the moment it is thrown (server errors pass through from api.js with
// their status).
//
// The server only ever sees password-DERIVED auth keys (crypto.deriveKeys);
// the KEK from the same derivation unwraps the Family Data Key locally.
// Whoever needs the raw FDK (join, rotation, password change, recovery
// code) derives from the password typed at that moment and unwraps the
// server copy — the daily key in IndexedDB (keys.js) is never re-wrapped.
//
// PBKDF2 at 600k iterations is the one slow step (~0.1–0.3 s on a phone):
// every flow that runs it accepts opts.onProgress(stage) with stage 'kdf'
// right before the derivation and 'server' before the following request, so
// a view can show "Schlüssel wird berechnet …" on its button.

import { api } from './api.js';
import * as keys from './keys.js';
import * as db from './db.js';
import { store, prefs } from './store.js';
import { t } from './i18n/index.js';
import {
  KDF_ITER,
  b64u,
  unb64u,
  randomBytes,
  deriveKeys,
  randomFamilyKeys,
  generateFdkRaw,
  wrapFdk,
  unwrapFdk,
  importFdk,
  recoveryAuthKey,
  recoveryCode,
  rawFromRecoveryCode,
  encryptProfile,
  decryptProfile,
} from './crypto.js';

export const PASSWORD_MIN = 8;
const NAME_MAX = 40;

// The messages with a number in them, read when needed (never at load).
const passwordMinMessage = () => t('errors.session.passwordMin', { min: PASSWORD_MIN });
const familyPasswordMinMessage = () => t('errors.session.familyPasswordMin', { min: PASSWORD_MIN });

// --- helpers ---------------------------------------------------------------------

const progress = (opts, stage) => {
  if (opts && typeof opts.onProgress === 'function') {
    try {
      opts.onProgress(stage);
    } catch {
      /* a view's progress hook must not break the flow */
    }
  }
};

/** {salt: Uint8Array(16), iter} from a wire {salt (b64u), iter}. */
function parseKdf(kdf) {
  try {
    const salt = unb64u(kdf && kdf.salt);
    const iter = Number(kdf.iter);
    if (salt.length !== 16 || !Number.isSafeInteger(iter)) throw new Error(t('errors.crypto.kdf'));
    return { salt, iter };
  } catch {
    throw new Error(t('errors.crypto.kdf'));
  }
}

const wireKdf = (salt, iter = KDF_ITER) => ({ salt: b64u(salt), iter });

const cleanName = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

function requirePassword(pw, message = passwordMinMessage()) {
  if (typeof pw !== 'string' || pw === '') throw new Error(message);
}

function requireNewPassword(pw, message = passwordMinMessage()) {
  if (typeof pw !== 'string' || [...pw].length < PASSWORD_MIN) throw new Error(message);
}

function requireDisplayName(name) {
  const n = cleanName(name);
  if (n === '' || [...n].length > NAME_MAX) throw new Error(t('errors.session.displayName', { max: NAME_MAX }));
  return n;
}

function requireFamilyName(name) {
  const n = cleanName(name);
  if (n === '' || [...n].length > NAME_MAX) throw new Error(t('errors.session.familyName', { max: NAME_MAX }));
  return n;
}

function requireUsername(name) {
  const n = typeof name === 'string' ? name.trim() : '';
  if (n === '') throw new Error(t('errors.session.credentials'));
  return n;
}

/** unwrapFdk that turns the wrong-key OperationError into a readable message. */
async function unwrapOrThrow(wrapped, kek) {
  try {
    return await unwrapFdk(wrapped, kek);
  } catch (e) {
    if (e && e.name === 'OperationError') throw new Error(t('errors.session.keyMismatch'));
    throw e;
  }
}

/** The recovery code as the user reads it: blocks of 4 separated by SPACES
 *  ('-' is part of the alphabet, so it must never be the separator). */
export function groupCode(code) {
  return (String(code).match(/.{1,4}/g) || []).join(' ');
}

/** The display name inside a user's profile blob; the username when there is none or it fails. */
async function profileName(fdk, user) {
  if (!user || !user.profileBlob) return user ? user.username : '';
  try {
    return (await decryptProfile(fdk, user.username, user.profileBlob)).displayName;
  } catch {
    return user.username;
  }
}

/** The signed-in user's KDF parameters: from prefs (no round-trip) or the server. */
async function ownKdf(user) {
  if (user && user.kdf) {
    try {
      return parseKdf(user.kdf);
    } catch {
      /* stale prefs — ask the server */
    }
  }
  return fetchAuthParams(user.username);
}

function requireSignedIn() {
  const user = prefs.user;
  if (!user) throw new Error(t('errors.session.signInAgain'));
  return user;
}

/**
 * Derive the own auth key + KEK and fetch the member-wrapped FDK with it
 * (POST api/me/keys/unlock, 403 'Falsches Passwort'). Every flow that needs
 * the raw FDK or the confirming auth key starts here.
 */
async function unlockOwnKeys(password, opts) {
  const user = requireSignedIn();
  requirePassword(password);
  const kdf = await ownKdf(user);
  progress(opts, 'kdf');
  const { authKey, kek } = await deriveKeys(password, kdf.salt, kdf.iter, 'user');
  progress(opts, 'server');
  const res = await api.post('api/me/keys/unlock', { authKey });
  const raw = await unwrapOrThrow(res && res.fdkWrappedUser, kek);
  if (res && res.kdf) rememberKdf(res.kdf);
  return { raw, authKey, user };
}

function rememberKdf(kdf) {
  try {
    parseKdf(kdf);
  } catch {
    return;
  }
  const user = prefs.user;
  if (user) prefs.user = { ...user, kdf: { salt: kdf.salt, iter: Number(kdf.iter) } };
}

/** Persist the daily key; failure only means the next boot asks for the password. */
async function persistKey(raw) {
  try {
    await keys.storeFdk(raw);
  } catch {
    if (raw instanceof Uint8Array) raw.fill(0);
  }
}

/**
 * Common tail of login / register / unlock: prefs.user, identity, the store
 * key, persistence. `raw` is consumed (zeroed by persistKey).
 */
async function finishSession(user, raw, kdf, displayName) {
  const fdk = await importFdk(raw, false);
  const name = displayName !== undefined ? displayName : await profileName(fdk, user);
  prefs.user = {
    username: user.username,
    familyId: user.familyId,
    familyName: user.familyName,
    displayName: name,
    kdf: { salt: kdf.salt, iter: Number(kdf.iter) },
  };
  prefs.authed = true;
  await store.setIdentity(user);
  await store.unlockWith(fdk);
  await persistKey(raw);
  return prefs.user;
}

// --- public flows ----------------------------------------------------------------

/** GET api/auth/params → {salt: Uint8Array(16), iter} (a stable fake for unknown names). */
export async function fetchAuthParams(username) {
  const name = requireUsername(username);
  const res = await api.get(`api/auth/params?username=${encodeURIComponent(name)}`);
  return parseKdf(res && res.kdf);
}

/**
 * Sign in: params → deriveKeys → POST api/login → unwrap the member-wrapped
 * FDK → store the key → decrypt the profile. A wrong password surfaces the
 * server's 401 text. Resolves with prefs.user.
 */
export async function login(username, password, opts = {}) {
  const name = requireUsername(username);
  requirePassword(password, t('errors.session.credentials'));
  const params = await fetchAuthParams(name);
  progress(opts, 'kdf');
  const { authKey, kek } = await deriveKeys(password, params.salt, params.iter, 'user');
  progress(opts, 'server');
  const res = await api.post('api/login', { username: name, authKey });
  if (!res || !res.user) throw new Error(t('errors.crypto.kdf'));
  const raw = await unwrapOrThrow(res.fdkWrappedUser, kek);
  const kdf = res.kdf && res.kdf.salt ? res.kdf : wireKdf(params.salt, params.iter);
  const user = await finishSession(res.user, raw, kdf);
  return user;
}

/**
 * Create a family: client-generated salts + FDK, both wrappings, profile
 * blob, recovery auth value → POST api/register familyMode 'create'.
 * Resolves with {user, recoveryCode (grouped)}; the recovery code is shown
 * once — the FDK is never shown again without the own password
 * (revealRecoveryCode).
 */
export async function registerCreate(input, opts = {}) {
  const { username, password, displayName, familyName, familyPassword } = input || {};
  const name = requireUsername(username);
  requireNewPassword(password);
  const display = requireDisplayName(displayName);
  const family = requireFamilyName(familyName);
  requireNewPassword(familyPassword, familyPasswordMinMessage());

  const userSalt = randomBytes(16);
  const familySalt = randomBytes(16);
  const fdkRaw = await generateFdkRaw();

  progress(opts, 'kdf');
  const own = await deriveKeys(password, userSalt, KDF_ITER, 'user');
  const fam = await deriveKeys(familyPassword, familySalt, KDF_ITER, 'family');
  const fdkWrappedUser = await wrapFdk(fdkRaw, own.kek);
  const fdkWrappedFamily = await wrapFdk(fdkRaw, fam.kek);
  const fdk = await importFdk(fdkRaw, false);
  const profileBlob = await encryptProfile(fdk, name, { displayName: display });
  const recovery = await recoveryAuthKey(fdkRaw);
  const code = recoveryCode(fdkRaw);

  const body = {
    username: name,
    authKey: own.authKey,
    kdf: wireKdf(userSalt),
    profileBlob,
    familyName: family,
    familyMode: 'create',
    familyAuthKey: fam.authKey,
    familyKdf: wireKdf(familySalt),
    fdkWrappedFamily,
    fdkWrappedUser,
    recoveryAuthKey: recovery,
  };

  progress(opts, 'server');
  const res = await api.post('api/register', body);
  if (!res || !res.user) throw new Error(t('errors.crypto.kdf'));

  const user = await finishSession(res.user, fdkRaw, body.kdf, display);
  return { user, recoveryCode: groupCode(code) };
}

/**
 * Join an existing family with its password: GET api/families/check (the
 * family salt) → deriveKeys(family) → POST api/families/unlock → unwrap the
 * family-wrapped FDK → wrap it under the new member's own KEK → POST
 * api/register familyMode 'join'. Resolves with {user}.
 */
export async function registerJoin(input, opts = {}) {
  const { username, password, displayName, familyName, familyPassword } = input || {};
  const name = requireUsername(username);
  requireNewPassword(password);
  const display = requireDisplayName(displayName);
  const family = requireFamilyName(familyName);
  requirePassword(familyPassword, familyPasswordMinMessage());

  const check = await api.get(`api/families/check?name=${encodeURIComponent(family)}`);
  if (!check || !check.exists || !check.kdf) throw new Error(t('errors.session.familyUnknown'));
  const familyKdf = parseKdf(check.kdf);
  const canonical = typeof check.name === 'string' && check.name !== '' ? check.name : family;

  progress(opts, 'kdf');
  const fam = await deriveKeys(familyPassword, familyKdf.salt, familyKdf.iter, 'family');
  progress(opts, 'server');
  const unlocked = await api.post('api/families/unlock', { familyName: canonical, familyAuthKey: fam.authKey });
  const raw = await unwrapOrThrow(unlocked && unlocked.fdkWrapped, fam.kek);

  return joinWith(name, password, display, canonical, raw, { familyAuthKey: fam.authKey }, opts);
}

/**
 * Join with the recovery code (the raw FDK itself): the server verifies its
 * auth value (POST api/families/unlock {recoveryAuthKey}) before the
 * expensive own derivation, then register join with recoveryAuthKey.
 */
export async function registerWithRecoveryCode(input, opts = {}) {
  const { username, password, displayName, familyName, recoveryCode: code } = input || {};
  const name = requireUsername(username);
  requireNewPassword(password);
  const display = requireDisplayName(displayName);
  const family = requireFamilyName(familyName);

  const raw = rawFromRecoveryCode(code);
  try {
    const recovery = await recoveryAuthKey(raw);
    progress(opts, 'server');
    await api.post('api/families/unlock', { familyName: family, recoveryAuthKey: recovery });
    return await joinWith(name, password, display, family, raw, { recoveryAuthKey: recovery }, opts);
  } finally {
    raw.fill(0); // a no-op after joinWith consumed it
  }
}

/**
 * Common join tail: own salt + keys, wrap, profile, register, session.
 * `raw` is consumed. The join also closes the door behind the new member:
 * `rotateFamily` carries the FDK wrapped under a random family KEK plus a
 * random auth key (crypto.randomFamilyKeys), which the server swaps in
 * within the join transaction — the family password that let this phone in
 * is dead from then on (the recovery code is untouched: it derives from the
 * FDK). Resolves with {user, familyClosed}.
 */
async function joinWith(name, password, display, family, raw, credential, opts) {
  const userSalt = randomBytes(16);
  progress(opts, 'kdf');
  const own = await deriveKeys(password, userSalt, KDF_ITER, 'user');
  const fdkWrappedUser = await wrapFdk(raw, own.kek);
  const fdk = await importFdk(raw, false);
  const profileBlob = await encryptProfile(fdk, name, { displayName: display });
  const next = await randomFamilyKeys();
  const rotateFamily = {
    familyAuthKey: next.authKey,
    familyKdf: wireKdf(next.salt),
    fdkWrappedFamily: await wrapFdk(raw, next.kek),
  };

  const body = {
    username: name,
    authKey: own.authKey,
    kdf: wireKdf(userSalt),
    profileBlob,
    familyName: family,
    familyMode: 'join',
    fdkWrappedUser,
    rotateFamily,
    ...credential,
  };
  progress(opts, 'server');
  const res = await api.post('api/register', body);
  if (!res || !res.user) throw new Error(t('errors.crypto.kdf'));
  const user = await finishSession(res.user, raw, body.kdf, display);
  return { user, familyClosed: res.familyClosed === true };
}

/**
 * The cookie is alive but the device lost its key (IndexedDB evicted,
 * "Clear website data", another key store): own password → POST
 * api/me/keys/unlock → unwrap → store the key → the store continues.
 */
export async function unlock(password, opts = {}) {
  const { raw } = await unlockOwnKeys(password, opts);
  const current = prefs.user; // unlockOwnKeys refreshed its kdf from the server's answer
  let kdf = current.kdf;
  if (!kdf) {
    const k = await ownKdf(current);
    kdf = wireKdf(k.salt, k.iter);
  }
  const displayName =
    typeof current.displayName === 'string' && current.displayName !== '' ? current.displayName : undefined;
  let profileBlob = current.profileBlob;
  if (displayName === undefined && !profileBlob) {
    // prefs came from a cookie-only boot without the profile: ask once.
    try {
      const me = await api.get('api/me');
      profileBlob = me && me.user ? me.user.profileBlob : null;
    } catch {
      profileBlob = null; // the username stands in until the next login
    }
  }
  await finishSession(
    {
      username: current.username,
      familyId: current.familyId,
      familyName: current.familyName,
      profileBlob,
    },
    raw,
    kdf,
    displayName
  );
}

/**
 * Own password change: the current password unlocks the wrapped FDK, the
 * new one gets a fresh salt, derivation and wrapping → PATCH
 * api/me/password. Entries are untouched; other sessions are revoked
 * server-side.
 */
export async function changePassword(currentPassword, newPassword, opts = {}) {
  requireNewPassword(newPassword);
  const { raw, authKey: currentAuthKey } = await unlockOwnKeys(currentPassword, opts);
  try {
    const salt = randomBytes(16);
    progress(opts, 'kdf');
    const next = await deriveKeys(newPassword, salt, KDF_ITER, 'user');
    const fdkWrappedUser = await wrapFdk(raw, next.kek);
    const kdf = wireKdf(salt);
    progress(opts, 'server');
    await api.patch('api/me/password', { currentAuthKey, authKey: next.authKey, kdf, fdkWrappedUser });
    rememberKdf(kdf);
  } finally {
    raw.fill(0);
  }
}

/**
 * Family password rotation (needed only to JOIN): the own password confirms
 * and yields the raw FDK, which is wrapped under the new family KEK →
 * PATCH api/families/password. Members already in the family are unaffected.
 */
export async function rotateFamilyPassword(currentPassword, newFamilyPassword, opts = {}) {
  requireNewPassword(newFamilyPassword, familyPasswordMinMessage());
  const { raw, authKey: currentAuthKey } = await unlockOwnKeys(currentPassword, opts);
  try {
    const salt = randomBytes(16);
    progress(opts, 'kdf');
    const fam = await deriveKeys(newFamilyPassword, salt, KDF_ITER, 'family');
    const fdkWrappedFamily = await wrapFdk(raw, fam.kek);
    progress(opts, 'server');
    await api.patch('api/families/password', {
      currentAuthKey,
      familyAuthKey: fam.authKey,
      familyKdf: wireKdf(salt),
      fdkWrappedFamily,
    });
  } finally {
    raw.fill(0);
  }
}

/** The recovery code (= the raw FDK, grouped in blocks of 4) after the own password verified. */
export async function revealRecoveryCode(currentPassword, opts = {}) {
  const { raw } = await unlockOwnKeys(currentPassword, opts);
  try {
    return groupCode(recoveryCode(raw));
  } finally {
    raw.fill(0);
  }
}

/** Re-encrypt the profile with the new display name → PATCH api/me. */
export async function updateDisplayName(name) {
  const user = requireSignedIn();
  const display = requireDisplayName(name);
  const fdk = store.fdk;
  if (!fdk) throw new Error(t('errors.store.locked'));
  const profileBlob = await encryptProfile(fdk, user.username, { displayName: display });
  await api.patch('api/me', { profileBlob });
  prefs.user = { ...(prefs.user || user), displayName: display };
  return prefs.user;
}

/**
 * Sign out: POST api/logout (best effort) and ALWAYS the local wipe —
 * store memory + snapshot FIRST (its generation bump makes a sync or write
 * still on the wire drop its answer), then the stored key and IndexedDB,
 * then prefs.user, prefs.authed. The other order would let a sync page that
 * lands between clearAll and clear() re-fill the wiped mirror.
 * Resolves with true when the server call failed (the cookie may still be
 * valid elsewhere) and false when it succeeded.
 */
export async function logout() {
  let serverFailed = false;
  try {
    await api.post('api/logout');
  } catch {
    serverFailed = true;
  }
  store.stop();
  store.clear();
  try {
    await keys.forgetFdk();
  } catch {
    /* IndexedDB unusable — clearAll below is the same story */
  }
  try {
    await db.clearAll();
  } catch {
    /* ignore */
  }
  prefs.user = null;
  prefs.authed = false;
  prefs.howtoPending = false; // the pointer to the how-to was for this account
  return serverFailed;
}
