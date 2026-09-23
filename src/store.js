// Client-side state for the end-to-end encrypted model.
//
// The server is a dumb per-family sync store of opaque blobs; this module
// holds the decrypted entries in memory (a Map keyed by eid), mirrors the
// server rows verbatim in IndexedDB (db.js) and derives the home-screen
// state (model.deriveState) locally. What the views use: `snapshot {ts,
// data}` (data = model.deriveState), `isStale`, `lastError`, `subscribe`,
// `refresh`, `refreshAfterWrite`, `start/stop/clear` and `prefs`; every
// write goes through `store.entries.*` (views never call the API), and
// `store.keyState` / `store.ready` / `store.unlockWith` drive the unlock
// flow.
//
// Instant paint: the derived state is still cached in localStorage
// ('bt.state', plaintext — the same trust boundary as the daily key living
// on the device) so the app renders before IndexedDB or the network answer.
//
// Boot: identity check (meta.identity vs the signed-in username; a mismatch
// wipes rows, meta and key — the partner logged in on this phone) →
// keys.loadFdk (any failure → keyState 'locked' → unlock screen) → decrypt
// the stored rows newest-first in chunks of 256, yielding between chunks →
// recompute → `ready` → sync().
//
// Sync: GET api/sync?since=<cursor>&limit=1000 until `next` is null. The
// cursor advances ONLY from sync pages (never from own writes), rows are
// applied seq-monotonically (model.applyRow), each page plus its cursor is
// one IndexedDB transaction, `reset:true` wipes rows + cursor and starts
// over, `serverNow` feeds the clock skew. Every page also names the server
// database it came from (`feed`, settings.feed_id): the mirror remembers it
// (meta.feed) and a page from a different feed — another database file whose
// seq counter happens to be AHEAD of our cursor, so reset:true never fires —
// is treated exactly like reset:true. Polling 60 s in the foreground + refresh
// on focus.
//
// Writes: validated locally (validate.js), the one-open-timer rule via
// model.openTimer, encrypted — and then queued in the OUTBOX (src/outbox.js:
// one op per write, ciphertext only, persisted in IndexedDB meta) and laid
// over the confirmed model at once, so the entry shows before the server has
// it and a tap works without network. The flusher sends the ops in order
// whenever there is network (after every sync, on `online`, on focus, on the
// poll); a 409 means "sync and judge again" — a guarded op (the timer must
// still be open / duration-less / paused) is laid over the partner's fresh
// row and sent again, or dropped with a notice when the guard no longer
// holds; an unguarded op is laid over the fresh row too (only the fields
// this device changed) — unless the caller is still waiting for the answer,
// then it gets the plain 409 exactly as before, so a form can close on a
// row that moved. A caller waits at most SETTLE_WAIT_MS for its op's first
// attempt: online the answer normally comes in time and the returned entry
// carries the real seq; offline or on a slow network the call resolves with
// the pending entry (`pending: 'waiting' | 'sending'`) and the flusher takes
// over. A precondition is checked on the LOCAL row first, so a partner's
// end that a sync already applied is never overwritten. A 404 (the other
// phone deleted the row) surfaces to a waiting caller after one sync;
// a deferred op is dropped with a notice. The family settings document and
// the duplicate-timer resolver's compare-and-set delete never queue: they
// go straight to the server and fail as before without network.
//
// `createStore(deps)` builds an instance from injectable dependencies so the
// sync/write logic runs under `node --test` with a fake api/db; the default
// export is the real one.

import { api as realApi } from './api.js';
import * as realDb from './db.js';
import * as realKeys from './keys.js';
import { toast as realToast, setClockSkew as realSetClockSkew, nowMs as realNowMs } from './ui.js';
import { randomEid, importFdk, encryptEntry, decryptEntry } from './crypto.js';
import { t } from './i18n/index.js';
import {
  PENDING_SEQ_BASE,
  isPendingSeq,
  GUARDS,
  changedFields,
  fieldPatch,
  coalesce,
  overlay,
  classify,
  reconcile,
  nextOp,
  summary,
} from './outbox.js';
import {
  validateCreate,
  validateUpdate,
  validatePlain,
  isTimerType,
  timerRunningMessage,
  isoFromMs,
  TYPE_LABELS,
} from './validate.js';
import {
  deriveState,
  listRange,
  openTimer,
  duplicateOpenTimers,
  applyRow,
  sortNewest,
  familySettingsRow,
  effectiveFamilySettings,
  DEFAULT_FAMILY_SETTINGS,
  FAMILY_SETTING_KEYS,
} from './model.js';

const STATE_KEY = 'bt.state';
// Stamp of the cached snapshot's shape. A cache written by an older shell
// must not paint — the home view reads the newer fields unguarded: 4 = the
// state carries lastMeal + today.meals, 5 = reminders + todos.
const SNAPSHOT_V = 5;
const IDENTITY_KEY = 'bt.identity';
const POLL_MS = 60000;
export const STALE_AFTER_MS = 2 * 60000;

const SYNC_LIMIT = 1000;
const SYNC_TIMEOUT_MS = 60000;
const DECRYPT_CHUNK = 256;
const DUP_WINDOW_MS = 15 * 60000;
/** How long a write waits for its op's first answer before it resolves with the pending entry. */
export const SETTLE_WAIT_MS = 3000;
/** Pauses between flush attempts after a failed request (then the poll cadence). */
const BACKOFF_MS = [5000, 15000, 60000];
const OP_KINDS = ['create', 'update', 'remove', 'restore'];

// Error messages are read from the translations (errors.store.*) at the
// moment they are thrown, never kept in a constant.

const EID_RE = /^[0-9a-f]{32}$/;

function fail(message, status) {
  const err = new Error(message);
  if (status) err.status = status;
  return err;
}

const label = (type) => TYPE_LABELS[type] || type;

// --- storage ------------------------------------------------------------------

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
  };
}

/** window.localStorage when it exists and works, else a throwaway map. */
function browserStorage() {
  try {
    const s = globalThis.localStorage;
    if (s && typeof s.getItem === 'function') return s;
  } catch {
    /* blocked (private mode, disabled site data) */
  }
  return memoryStorage();
}

// --- per-device settings ---------------------------------------------------------

const USER_KEY = 'bt.user';
const AUTH_KEY = 'bt.authed';
const RECOVERY_PENDING_KEY = 'bt.recoveryPending';
const HOWTO_PENDING_KEY = 'bt.howtoPending';
const PRESETS_KEY = 'bt.bottlePresets';
const TIMER_KEY = 'bt.timerStartedAt';
const RECOMMENDED_KEY = 'bt.recommendedMl';
const THEME_KEY = 'bt.theme';
const SCHEME_KEY = 'bt.scheme';
const KEEP_AWAKE_KEY = 'bt.keepAwake';
const TRACK_SLEEP_KEY = 'bt.trackSleep'; // the on/off switch before HOME_CARD_KEY, read as its fallback
const HOME_CARD_KEY = 'bt.homeCard';
const FEED_FROM_START_KEY = 'bt.feedFromStart';
const LANG_KEY = 'bt.lang';
const WHATS_NEW_SEEN_KEY = 'bt.whatsNewSeen';
const HIDDEN_CHARTS_KEY = 'bt.hiddenCharts';

/** What the home screen shows next to the diaper card and in the fourth
 *  quick tile: the sleep tracker, the family's reminders, both (a row of
 *  three cards and one of three tiles), or nothing. */
export const HOME_CARDS = ['sleep', 'reminders', 'both', 'none'];

/** The three quick-pick amounts in the Schoppen form (editable under "Mehr").
 *  Three, not four: together with the ★ recommended chip four fit on one line
 *  of a phone, five wrap. */
export const DEFAULT_BOTTLE_PRESETS = [...DEFAULT_FAMILY_SETTINGS.bottlePresets];
/** The three quick-pick amounts of the formula row — small ones: the
 *  formula tops a Muttermilch bottle up. Never per device. */
export const DEFAULT_FORMULA_PRESETS = [...DEFAULT_FAMILY_SETTINGS.formulaPresets];

/**
 * Small per-device settings over a storage. Design, light/dark, the wake
 * lock and what the home screen's fourth slot shows are about the phone and
 * stay here. The Schoppen amounts and the meal interval belong to the family
 * (store.settings, an encrypted entry); their keys below are only READ, as
 * this device's fallback until the family has saved a value
 * (localFamilyValues), and never written.
 */
export function createPrefs(storage) {
  const read = (k) => {
    try {
      return storage.getItem(k);
    } catch {
      return null;
    }
  };
  const write = (k, v) => {
    try {
      if (v === null || v === undefined) storage.removeItem(k);
      else storage.setItem(k, v);
    } catch {
      /* storage full/blocked — prefs are best-effort */
    }
  };
  return {
    /** The signed-in account — { username, familyId, familyName, displayName,
     *  kdf: {salt (b64u), iter} } — or null before the first login.
     *  Deliberately kept across a 401 so the login form can prefill the
     *  username; the kdf lets the unlock screen derive without a round-trip. */
    get user() {
      try {
        const parsed = JSON.parse(read(USER_KEY) || '');
        return parsed && typeof parsed.username === 'string' ? parsed : null;
      } catch {
        return null;
      }
    },
    set user(v) {
      write(USER_KEY, v ? JSON.stringify(v) : null);
    },
    get authed() {
      return read(AUTH_KEY) === '1';
    },
    set authed(v) {
      write(AUTH_KEY, v ? '1' : null);
    },
    /** The family was created on this device and its recovery code has not
     *  been acknowledged yet (login.js sets it before the code screen, clears
     *  it on "done"; a reveal under «Mehr» clears it too). The shell nags
     *  with a toast on every app start while it is set. */
    get recoveryPending() {
      return read(RECOVERY_PENDING_KEY) === '1';
    },
    set recoveryPending(v) {
      write(RECOVERY_PENDING_KEY, v ? '1' : null);
    },
    /** An account was just registered on this device (any of the three
     *  registration paths) and «Mehr › Anleitung» has not been opened yet:
     *  the shell points to the how-to with a toast on every app start until
     *  then. A plain login and a logout clear it — whoever signs in has
     *  used the app before, or registered on another phone. */
    get howtoPending() {
      return read(HOWTO_PENDING_KEY) === '1';
    },
    set howtoPending(v) {
      write(HOWTO_PENDING_KEY, v ? '1' : null);
    },
    /** The local stopwatch (timer chip on the home hero): start instant in ms,
     *  or null when idle. Per device on purpose — never synced, never logged. */
    get timerStartedAt() {
      const n = Number(read(TIMER_KEY));
      return Number.isFinite(n) && n > 0 ? n : null;
    },
    set timerStartedAt(v) {
      write(TIMER_KEY, v ? String(v) : null);
    },
    /** The calculated recommended feed amount (e.g. from the midwife's formula);
     *  shown as the first, highlighted chip in the Schoppen form. Null = none. */
    get recommendedMl() {
      const n = Number(read(RECOMMENDED_KEY));
      return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : null;
    },
    set recommendedMl(v) {
      write(RECOMMENDED_KEY, v ? String(v) : null);
    },
    /** Three ml amounts within the 1–1000 range; falls back to the defaults on
     *  anything malformed. A longer list (the four slots of an earlier
     *  version) keeps its first entries. Set null to reset. */
    get bottlePresets() {
      try {
        const parsed = JSON.parse(read(PRESETS_KEY) || '');
        if (
          Array.isArray(parsed) &&
          parsed.length >= DEFAULT_BOTTLE_PRESETS.length &&
          parsed.every((n) => Number.isInteger(n) && n >= 1 && n <= 1000)
        ) {
          return parsed.slice(0, DEFAULT_BOTTLE_PRESETS.length);
        }
      } catch {
        /* fall through to defaults */
      }
      return DEFAULT_BOTTLE_PRESETS;
    },
    set bottlePresets(v) {
      write(PRESETS_KEY, v ? JSON.stringify(v) : null);
    },
    /** The design id (src/themes) for this device; null = default. Validated
     *  by themes/index.js, not here — the store knows no design names. */
    get theme() {
      const v = read(THEME_KEY);
      return typeof v === 'string' && /^[a-z][a-z0-9-]{0,30}$/.test(v) ? v : null;
    },
    set theme(v) {
      write(THEME_KEY, v || null);
    },
    /** 'light' | 'dark' to override the phone's setting; null = follow it. */
    get scheme() {
      const v = read(SCHEME_KEY);
      return v === 'light' || v === 'dark' ? v : null;
    },
    set scheme(v) {
      write(SCHEME_KEY, v === 'light' || v === 'dark' ? v : null);
    },
    /** Keep the screen on while feeding (Screen Wake Lock). Default on. */
    get keepAwake() {
      return read(KEEP_AWAKE_KEY) !== '0';
    },
    set keepAwake(v) {
      write(KEEP_AWAKE_KEY, v ? null : '0');
    },
    /** The home screen's fourth slot (HOME_CARDS): 'sleep' = the sleep card
     *  and «Schlaf starten» (default), 'reminders' = the next to-do and the
     *  checklist of the family's reminders, 'both' = the two side by side,
     *  'none' = neither (Verlauf and Nachtragen keep every type). A device
     *  that switched the earlier sleep on/off switch off keeps its empty
     *  slot. */
    get homeCard() {
      const v = read(HOME_CARD_KEY);
      if (HOME_CARDS.includes(v)) return v;
      return read(TRACK_SLEEP_KEY) === '0' ? 'none' : 'sleep';
    },
    set homeCard(v) {
      write(HOME_CARD_KEY, HOME_CARDS.includes(v) ? v : null);
    },
    /** «Seit letzter Mahlzeit» counts from the meal's START instead of its
     *  end — the way many midwives count feeds («alle drei Stunden»).
     *  Default off (from the end). Per device, like every pref. */
    get feedFromStart() {
      return read(FEED_FROM_START_KEY) === '1';
    },
    set feedFromStart(v) {
      write(FEED_FROM_START_KEY, v ? '1' : null);
    },
    /** The UI language for this device (src/i18n): a locale id, or null =
     *  follow the phone (i18n.detectLocale). Validated by i18n, not here. */
    get lang() {
      const v = read(LANG_KEY);
      return typeof v === 'string' && /^[a-z]{2,3}(-[a-zA-Z0-9]{2,8})?$/.test(v) ? v : null;
    },
    set lang(v) {
      write(LANG_KEY, v || null);
    },
    /** The newest «Was ist neu» entry id this device has shown (src/whats-new.js);
     *  null = never shown any — the shell then shows the newest ones once. */
    get whatsNewSeen() {
      const v = read(WHATS_NEW_SEEN_KEY);
      return typeof v === 'string' && v !== '' ? v : null;
    },
    set whatsNewSeen(v) {
      write(WHATS_NEW_SEEN_KEY, v || null);
    },
    /** The charts this phone hides under Verlauf › Grafik (their keys,
     *  history.js CHART_KEYS); [] = every one shown. Per device, like the
     *  design — the family's data is the same, what each parent looks at is
     *  not. Unknown or malformed keys are dropped on read. */
    get hiddenCharts() {
      try {
        const parsed = JSON.parse(read(HIDDEN_CHARTS_KEY) || '[]');
        return Array.isArray(parsed) ? parsed.filter((k) => typeof k === 'string' && /^[a-z][a-zA-Z0-9]{0,30}$/.test(k)) : [];
      } catch {
        return [];
      }
    },
    set hiddenCharts(v) {
      const list = Array.isArray(v) ? [...new Set(v.filter((k) => typeof k === 'string' && k !== ''))] : [];
      write(HIDDEN_CHARTS_KEY, list.length ? JSON.stringify(list) : null);
    },
    /** The family settings this device stored per device before they were
     *  synced — only the keys it actually set. They stand in until the
     *  family saves each one (model.effectiveFamilySettings). */
    get localFamilyValues() {
      const out = {};
      if (read(FEED_FROM_START_KEY) !== null) out.feedFromStart = this.feedFromStart;
      if (read(RECOMMENDED_KEY) !== null) out.recommendedMl = this.recommendedMl;
      if (read(PRESETS_KEY) !== null) out.bottlePresets = this.bottlePresets;
      return out;
    },
  };
}

// --- the store ---------------------------------------------------------------------

function loadSnapshot(storage) {
  try {
    const raw = storage.getItem(STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.ts !== 'number' || !parsed.data || parsed.v !== SNAPSHOT_V) {
      // Unreadable, or the previous shell's cache: drop it (see SNAPSHOT_V).
      storage.removeItem(STATE_KEY);
      return null;
    }
    return { ts: parsed.ts, data: parsed.data };
  } catch {
    return null;
  }
}

const toInt = (v) => (Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : 0);

const usernameKey = (user) =>
  user && typeof user.username === 'string' ? user.username.trim().toLowerCase() : '';

/** The plaintext of a model entry in envelope order (for re-encryption). */
function plainOf(e) {
  return {
    eid: e.eid,
    rev: e.rev,
    type: e.type,
    startedAt: e.startedAt,
    endedAt: e.endedAt === undefined ? null : e.endedAt,
    details: e.details || {},
    loggedBy: e.loggedBy === undefined ? null : e.loggedBy,
  };
}

/** The derived state minus serverNow (which changes every recompute). */
function dataKey(data) {
  if (!data) return null;
  const { serverNow, ...rest } = data;
  return JSON.stringify(rest);
}

/**
 * Build a store over injectable dependencies:
 *   api          {get(path, opts), post, patch, del}   (api.js)
 *   db           db.js                                  (IndexedDB mirror)
 *   keys         keys.js                                (daily key)
 *   prefs        createPrefs(storage)
 *   storage      localStorage-like (getItem/setItem/removeItem)
 *   toast        ui.toast
 *   setClockSkew ui.setClockSkew
 *   nowMs        ui.nowMs (skew-corrected clock)
 *   yieldToLoop  optional: awaited between decrypt chunks
 *   settleWaitMs optional: SETTLE_WAIT_MS (0 = never wait for the server)
 *   isOnline     optional: () => boolean (navigator.onLine !== false)
 *   locks        optional: navigator.locks (one flusher across tabs)
 */
export function createStore(deps) {
  const { api, db, keys, prefs, storage, toast, setClockSkew, nowMs } = deps;
  const yieldToLoop = deps.yieldToLoop || (() => new Promise((r) => setTimeout(r, 0)));
  const settleWaitMs = Number.isFinite(deps.settleWaitMs) ? deps.settleWaitMs : SETTLE_WAIT_MS;
  const isOnline = deps.isOnline || (() => typeof navigator === 'undefined' || navigator.onLine !== false);
  const locks = deps.locks !== undefined ? deps.locks : typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null;
  const hasDom = typeof document !== 'undefined' && typeof window !== 'undefined';

  const listeners = new Set();
  const model = new Map(); // eid -> entry (see model.js)
  const dupHandled = new Set(); // eids this device already tried to delete as duplicate timers

  let snapshot = loadSnapshot(storage); // { ts, data } | null
  let lastSyncTs = snapshot ? snapshot.ts : 0;
  let lastDataKey = snapshot ? dataKey(snapshot.data) : null;
  let lastError = null;
  let keyState = 'none'; // 'none' | 'locked' | 'ready'
  let fdk = null; // CryptoKey while 'ready'
  let familyId = null;
  let cursor = 0;
  let feed = null; // the server database (settings.feed_id) the mirror + cursor belong to
  let decryptErrors = 0;
  let noticeType = null; // the entry type with two open timers too far apart (store.notice)
  let artVersion; // private artwork (src/art.js): undefined = no sync heard yet, null = none for us
  let artKey = null; // … and the installation's capability key for the install icon (members only)

  // The outbox (src/outbox.js): ops still to send, oldest first, `plain`
  // decrypted in memory. Bookkeeping for judging them against the confirmed
  // rows: seqs this device's own writes produced, the blob a sync page last
  // brought for an eid with an op (a lost answer: the blob proves it landed),
  // the highest seq a sync brought that was NOT ours (a form's "changed
  // meanwhile"), and where a pending create's placeholder seq landed.
  let ops = [];
  let opsDurable = true;
  let nextN = 1;
  let flushing = null; // the running flush
  let backoffUntil = 0;
  let backoffStep = 0;
  let backoffTimer = null;
  let authBlocked = false; // a 401: nothing is sent until a sync succeeds again
  const ownSeqs = new Set();
  const seenBlob = new Map();
  const foreignSeq = new Map();
  const landed = new Map();
  const idleWaiters = [];
  let drained = 0; // ops confirmed in the running flush that nobody was waiting for (the «n gesendet» toast)

  let pollTimer = null;
  let inFlight = null; // the running sync
  let booting = null; // the running boot
  let booted = false;
  let generation = 0; // bumped by every reset: a sync from before it must not write into the new state
  let readyResolve = null;
  let readyDone = false;
  let ready = new Promise((r) => {
    readyResolve = r;
  });

  // A snapshot cached for another account must never paint for this one.
  try {
    const owner = storage.getItem(IDENTITY_KEY);
    const mine = usernameKey(prefs.user);
    if (snapshot && owner && mine && owner !== mine) {
      snapshot = null;
      lastSyncTs = 0;
      lastDataKey = null;
      storage.removeItem(STATE_KEY);
    }
  } catch {
    /* ignore */
  }

  /** changed = the derived state differs from the previous one; views can
   *  skip full re-renders (which destroy buttons under an in-flight tap). */
  function notify(changed) {
    for (const fn of [...listeners]) {
      try {
        fn(snapshot, changed);
      } catch {
        /* a broken listener must not stop the others */
      }
    }
  }

  function markReady() {
    if (readyDone) return;
    readyDone = true;
    readyResolve();
  }

  function renewReady() {
    readyDone = false;
    ready = new Promise((r) => {
      readyResolve = r;
    });
  }

  function persist() {
    try {
      if (snapshot) storage.setItem(STATE_KEY, JSON.stringify({ v: SNAPSHOT_V, ...snapshot }));
    } catch {
      /* storage full/blocked — the cache is best-effort */
    }
  }

  /**
   * Derive the home state from the model. Returns whether it changed. Only
   * while the key is ready and there is something to show (local rows or a
   * completed sync) — before that the cached snapshot keeps painting.
   */
  /** The confirmed rows with the pending ops laid over them — what every
   *  reader sees (the model itself while nothing is pending). */
  function effective() {
    if (ops.length === 0) return model;
    return overlay(model, ops, isoFromMs(nowMs()).slice(0, 10));
  }

  function recompute(opts = {}) {
    if (keyState !== 'ready') return false;
    const eff = effective();
    if (eff.size === 0 && !lastSyncTs) return false;
    const data = deriveState(eff, isoFromMs(nowMs()));
    const key = dataKey(data);
    const changed = key !== lastDataKey;
    lastDataKey = key;
    snapshot = { ts: lastSyncTs || Date.now(), data };

    let errors = 0;
    for (const e of model.values()) {
      if (e.error && e.deletedAt == null) errors += 1;
    }
    decryptErrors = errors;

    // Two open timers of one type further apart than the auto-resolver
    // handles (see resolveDuplicates): a persistent notice for the home view.
    noticeType = null;
    for (const { type, keep, others } of duplicateOpenTimers(eff)) {
      if (others.some((o) => !withinDupWindow(o, keep))) {
        noticeType = type;
      }
    }

    if (changed || opts.persist) persist();
    return changed;
  }

  const withinDupWindow = (a, b) =>
    Math.abs(Date.parse(a.startedAt) - Date.parse(b.startedAt)) <= DUP_WINDOW_MS;

  // --- decrypt + apply ---------------------------------------------------------

  /**
   * The plaintext (or {error}) for one server row. Content is only ever
   * taken from a blob this family's key opens — whatever else a row
   * carries is ignored, so the server cannot hand the phone an entry. A row
   * without a blob has no content (a tombstone). A blob whose rev is lower
   * than the rev already known for that eid is a rollback and rejected.
   */
  async function decryptRow(row, existing) {
    if (row.blob == null) return { src: { error: t('errors.store.noContent') } };
    try {
      const plain = await decryptEntry(fdk, familyId, row.eid, row.blob);
      validatePlain(plain);
      if (existing && !existing.error && Number.isInteger(existing.rev) && plain.rev < existing.rev) {
        return { src: { error: t('errors.store.rollback') } };
      }
      return { src: plain };
    } catch (e) {
      return { src: { error: (e && e.message) || t('errors.crypto.decrypt') } };
    }
  }

  /**
   * Decrypt and apply rows (seq-monotonic; rows the model already holds at
   * the same or a higher seq are not even decrypted), yielding to the event
   * loop every DECRYPT_CHUNK rows so a 5000-row boot never blocks paint.
   */
  async function ingest(rows) {
    let changed = false;
    let errors = 0;
    let withBlob = 0;
    for (let i = 0; i < rows.length; i++) {
      if (i > 0 && i % DECRYPT_CHUNK === 0) await yieldToLoop();
      const row = rows[i];
      // The eid ends up in DOM attributes and URLs: only the 32-hex shape
      // the client generates is ever taken in.
      if (!row || typeof row.eid !== 'string' || !EID_RE.test(row.eid)) continue;
      const existing = model.get(row.eid);
      if (existing && Number(existing.seq) >= Number(row.seq)) continue;
      const seq = Number(row.seq);
      if (!ownSeqs.has(seq) && seq > (foreignSeq.get(row.eid) || 0)) foreignSeq.set(row.eid, seq);
      if (ops.some((o) => o.eid === row.eid)) seenBlob.set(row.eid, row.blob == null ? null : row.blob);
      const { src } = await decryptRow(row, existing);
      if (row.blob != null) {
        withBlob += 1;
        if (src.error) errors += 1;
      }
      if (applyRow(model, row, src)) changed = true;
    }
    return { changed, errors, withBlob };
  }

  /** Apply the row a write returned (with the plaintext we sent) — never the cursor. */
  function applyLocal(row, src) {
    if (!row || typeof row.eid !== 'string') return;
    applyRow(model, row, src);
    db.putRow(row).catch(() => {});
    notify(recompute({ persist: true }));
  }

  // --- local rows / identity ---------------------------------------------------------

  function resetMemory() {
    generation += 1;
    model.clear();
    dupHandled.clear();
    for (const op of ops) settleWaiter(op, null, fail(t('errors.store.aborted')));
    ops = [];
    ownSeqs.clear();
    seenBlob.clear();
    foreignSeq.clear();
    landed.clear();
    clearBackoff();
    authBlocked = false;
    cursor = 0;
    feed = null;
    decryptErrors = 0;
    noticeType = null;
    artVersion = undefined;
    artKey = null;
    snapshot = null;
    lastSyncTs = 0;
    lastDataKey = null;
    lastError = null;
    fdk = null;
    keyState = 'none';
    booted = false;
    renewReady();
  }

  /** Everything local: memory, the cached snapshot, rows, meta and the key. */
  async function wipeLocal() {
    resetMemory();
    try {
      storage.removeItem(STATE_KEY);
      storage.removeItem(IDENTITY_KEY);
    } catch {
      /* ignore */
    }
    try {
      await keys.forgetFdk();
    } catch {
      /* IndexedDB unusable — nothing there to wipe */
    }
    try {
      await db.clearAll();
    } catch {
      /* same */
    }
  }

  /** Rows + cursor only (sync `reset`, feed change): the key and identity stay. */
  async function wipeRows() {
    model.clear();
    dupHandled.clear();
    seenBlob.clear();
    foreignSeq.clear();
    cursor = 0;
    try {
      await db.clearRows();
      await db.putRows([], 0);
    } catch {
      /* ignore */
    }
  }

  /** Remember which server database the mirror follows (best effort). */
  async function rememberFeed(id) {
    feed = id;
    try {
      await db.setMeta('feed', id);
    } catch {
      /* the next page stores it again */
    }
  }

  /**
   * Bind the local data to `user`: when IndexedDB or the snapshot cache
   * belong to another account (the partner logged in on this phone) wipe
   * rows, meta, key and snapshot first, then stamp the identity. Rows with
   * NO identity stamp at all (a mirror left by a shell that did not stamp,
   * or a meta wipe that never finished) are nobody's — wiped as well.
   */
  async function ensureIdentity(user) {
    const mine = usernameKey(user);
    familyId = user.familyId;
    let prevDb;
    try {
      prevDb = await db.getMeta('identity');
    } catch {
      prevDb = undefined;
    }
    let prevLs = null;
    try {
      prevLs = storage.getItem(IDENTITY_KEY);
    } catch {
      /* ignore */
    }
    let orphanRows = false;
    if (prevDb === undefined) {
      try {
        orphanRows = (await db.getAllRows()).length > 0;
      } catch {
        /* IndexedDB unusable — nothing there to wipe either */
      }
    }
    if ((prevDb !== undefined && prevDb !== mine) || (prevLs && prevLs !== mine) || orphanRows) {
      await wipeLocal();
      familyId = user.familyId;
    }
    try {
      await db.setMeta('identity', mine);
    } catch {
      /* ignore */
    }
    try {
      storage.setItem(IDENTITY_KEY, mine);
    } catch {
      /* ignore */
    }
  }

  /**
   * Load the IndexedDB mirror into the model. Returns false when every
   * encrypted row failed with the current key (a stale key from a wiped
   * family) — the boot path treats that as "locked".
   */
  async function loadLocal() {
    model.clear();
    dupHandled.clear();
    let rows = [];
    let rowsOk = true;
    try {
      rows = await db.getAllRows();
    } catch {
      rowsOk = false;
      rows = [];
    }
    try {
      cursor = rowsOk ? toInt(await db.getMeta('cursor')) : 0;
    } catch {
      cursor = 0;
    }
    try {
      const f = rowsOk ? await db.getMeta('feed') : undefined;
      feed = typeof f === 'string' && f !== '' ? f : null;
    } catch {
      feed = null;
    }
    rows.sort((a, b) => Number(b.seq) - Number(a.seq)); // newest first
    const res = await ingest(rows);
    return !(res.withBlob > 0 && res.errors === res.withBlob);
  }

  /** The persisted outbox into memory: blobs decrypted, junk and dead
   *  creates (undone before they were sent) dropped. */
  async function loadOutbox() {
    ops = [];
    let records = [];
    try {
      records = await db.getAllOps();
      opsDurable = true;
    } catch {
      opsDurable = false;
      return; // no mirror, no outbox: writes go straight to the server
    }
    const keep = [];
    const del = [];
    for (const o of records) {
      const shape =
        o && typeof o.key === 'string' && typeof o.eid === 'string' && EID_RE.test(o.eid) && OP_KINDS.includes(o.kind) && Number.isInteger(o.n);
      if (!shape) {
        if (o && typeof o.key === 'string') del.push(o.key);
        continue;
      }
      if (o.dead) {
        del.push(o.key);
        continue;
      }
      let plain = null;
      if (o.blob != null) {
        try {
          plain = await decryptEntry(fdk, familyId, o.eid, o.blob);
          validatePlain(plain);
        } catch {
          del.push(o.key);
          continue;
        }
      }
      keep.push({ ...o, plain, waiter: null, check: null });
    }
    ops = keep.sort((a, b) => a.n - b.n);
    for (const o of ops) nextN = Math.max(nextN, o.n + 1);
    if (del.length) db.deleteOps(del).catch(() => {});
  }

  /** Take `key` into use: load local rows, mark ready, sync. */
  async function activate(key, { fromPassword = false } = {}) {
    if (inFlight) await inFlight.catch(() => {});
    const gen = generation;
    fdk = key;
    keyState = 'ready';
    const ok = await loadLocal();
    if (gen !== generation) return; // wiped (logout) while the rows were loading
    if (ok) await loadOutbox();
    if (gen !== generation) return;
    if (!ok && !fromPassword) {
      // Nothing decrypts with the stored key: treat it as wrong, drop it
      // and ask for the password (a fresh unlock never locks again on the
      // same rows — they are then counted as undecryptable instead).
      fdk = null;
      keyState = 'locked';
      model.clear();
      try {
        await keys.forgetFdk();
      } catch {
        /* ignore */
      }
      booted = true;
      notify(false);
      return;
    }
    booted = true;
    markReady();
    notify(recompute());
    sync().catch(() => {});
  }

  function boot() {
    if (booted) return Promise.resolve(keyState);
    if (booting) return booting;
    booting = (async () => {
      const user = prefs.user;
      if (!user) {
        // Nobody signed in yet (cookie-only boot before api/me answered):
        // locked for now, but not booted — a later boot() with prefs.user
        // set still gets to try the stored key.
        keyState = 'locked';
        notify(false);
        return keyState;
      }
      await ensureIdentity(user);
      let key = null;
      try {
        key = await keys.loadFdk();
      } catch {
        key = null;
      }
      if (!key) {
        keyState = 'locked';
        booted = true;
        notify(false);
        return keyState;
      }
      await activate(key);
      return keyState;
    })().finally(() => {
      booting = null;
    });
    return booting;
  }

  // --- sync --------------------------------------------------------------------------

  function sync() {
    if (inFlight) return inFlight;
    if (keyState !== 'ready') return Promise.resolve(snapshot);
    inFlight = runSync().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  /** A sync guaranteed to start AFTER any request already in flight. */
  function syncFresh() {
    const stale = inFlight;
    if (!stale) return sync();
    return stale.catch(() => {}).then(() => sync());
  }

  async function runSync() {
    const gen = generation;
    // A logout (or identity wipe) while a page is on the wire: the answer
    // belongs to the previous account and must not land in memory or IndexedDB.
    const assertCurrent = () => {
      if (gen !== generation) throw fail(t('errors.store.aborted'));
    };
    try {
      let since = cursor;
      let resets = 0;
      let changed = false;
      for (;;) {
        const page = await api.get(`api/sync?since=${since}&limit=${SYNC_LIMIT}`, {
          timeoutMs: SYNC_TIMEOUT_MS,
        });
        assertCurrent();
        if (!page || typeof page !== 'object') throw fail(t('errors.store.badPage'), 502);
        if (typeof page.serverNow === 'string') {
          // All elapsed displays run on server time; the phone clock may drift.
          const skew = Date.parse(page.serverNow) - Date.now();
          if (Number.isFinite(skew)) setClockSkew(skew);
        }
        // Members of the installation's artwork family get the version of
        // their pictures with every page; everyone else gets no key at all.
        artVersion = typeof page.art === 'string' && /^[0-9a-f]{6,64}$/.test(page.art) ? page.art : null;
        artKey = artVersion && typeof page.artKey === 'string' && /^[0-9a-f]{32}$/.test(page.artKey) ? page.artKey : null;
        const pageFeed = typeof page.feed === 'string' && page.feed !== '' ? page.feed : null;
        if (pageFeed && feed && pageFeed !== feed) {
          // Another database behind the same URL (restored backup, re-run
          // migration): our rows and cursor mean nothing there — exactly
          // the reset case, even when its seq counter is past our cursor.
          if (resets++ > 0) throw fail(t('errors.store.badPage'), 502);
          await wipeRows();
          assertCurrent();
          await rememberFeed(pageFeed);
          assertCurrent();
          changed = true;
          since = 0;
          continue;
        }
        if (page.reset) {
          // A cursor this database never issued (restored backup, wiped
          // family): start over from nothing.
          if (resets++ > 0) throw fail(t('errors.store.badPage'), 502);
          await wipeRows();
          assertCurrent();
          changed = true;
          since = 0;
          continue;
        }
        if (!Array.isArray(page.rows)) throw fail(t('errors.store.badPage'), 502);
        if (pageFeed && !feed) {
          // First page from a server that names its database: stamp the
          // mirror BEFORE its rows, so a mirror that carries rows always
          // carries the feed they came from.
          await rememberFeed(pageFeed);
          assertCurrent();
        }
        const res = await ingest(page.rows);
        assertCurrent();
        changed = changed || res.changed;
        // Rows come seq-ascending; the server's snapshot holds every lower
        // seq, so the last row's seq is an exact cursor.
        const last = page.rows.length ? Number(page.rows[page.rows.length - 1].seq) : since;
        const nextCursor = Math.max(since, Number.isFinite(last) ? last : since);
        try {
          await db.putRows(page.rows, nextCursor);
        } catch {
          /* memory stays right; the mirror catches up on a later page */
        }
        // A logout while the transaction committed: the mirror is wiped (or
        // about to be) — the cursor of the old account must not survive it.
        assertCurrent();
        cursor = nextCursor;
        if (page.next == null) break;
        since = Number(page.next);
        if (!Number.isFinite(since)) throw fail(t('errors.store.badPage'), 502);
      }
      lastSyncTs = Date.now();
      lastError = null;
      authBlocked = false; // a page came back: logged in
      clearBackoff(); // … and the network is there
      const c = recompute({ persist: true });
      notify(c || changed);
      kickFlush();
      resolveDuplicates();
      return snapshot;
    } catch (err) {
      if (gen !== generation) throw err; // the state it failed for is gone — leave the new one alone
      lastError = err;
      notify(false);
      throw err;
    }
  }

  /**
   * Two-phone race: both started a Schlaf within the poll interval. Keep the
   * one with the LOWER seq (the one the server committed first);
   * when the starts lie within 15 min the other is a duplicate and is
   * soft-deleted (toast, once per eid). Further apart, recompute() shows
   * the notice instead — a human has to decide. The DELETE presents the seq
   * this device saw (compare-and-set): a row the partner touched meanwhile
   * (stopped it, moved its start) is NOT deleted blindly — the 409 forgets
   * the eid, and the next sync judges the fresh row again.
   */
  function resolveDuplicates() {
    for (const { type, keep, others } of duplicateOpenTimers(effective())) {
      if (isPendingSeq(keep.seq)) continue;
      for (const o of others) {
        // A pending timer of ours is judged by the flusher before it is sent.
        if (isPendingSeq(o.seq) || !withinDupWindow(o, keep) || dupHandled.has(o.eid)) continue;
        dupHandled.add(o.eid);
        store.entries
          .remove(o.eid, { ifSeq: o.seq })
          .then(() => toast(t('errors.store.duplicateRemoved', { type: label(type) }), 'success'))
          .catch((e) => {
            // 404 = the other phone got there first; a 409 (the row moved)
            // and anything else (offline) may be retried on a later sync.
            if (!e || e.status !== 404) dupHandled.delete(o.eid);
          });
      }
    }
  }

  // --- writes -------------------------------------------------------------------------

  function requireKey() {
    if (keyState !== 'ready' || !fdk) throw fail(t('errors.store.locked'));
  }

  function liveLocal(eid) {
    const e = effective().get(eid);
    if (!e || e.deletedAt != null || e.error) throw fail(t('errors.store.notFound'), 404);
    return e;
  }

  const entryCopy = (eid) => {
    const e = effective().get(eid);
    return e ? { ...e, details: { ...(e.details || {}) } } : null;
  };

  /** Has `eid` been changed by SOMEONE ELSE since `seq` (the seq a form was
   *  opened with)? This device's own confirmed writes do not count, nor does
   *  a pending create landing — a form open over one is not stale. */
  function changedSince(eid, seq) {
    const cur = effective().get(eid);
    if (!cur) return true;
    let base = Number(seq);
    if (isPendingSeq(base)) {
      const real = landed.get(base);
      if (real === undefined) return false; // still ours alone
      base = real;
    }
    return (foreignSeq.get(eid) || 0) > base;
  }

  /**
   * Mark an error as the server's answer (only those may trigger the 409
   * retry); an answer arriving after a logout/wipe is dropped (never applied
   * to the new state). With opts.syncOn404 a 404 — the row is gone on the
   * server while the model still holds it live — first syncs once (best
   * effort) so the tombstone (or the reset) lands before the caller reacts.
   */
  async function serverCall(fn, opts = {}) {
    const gen = generation;
    let res;
    try {
      res = await fn();
    } catch (e) {
      if (e && typeof e === 'object') e.server = true;
      if (opts.syncOn404 && e && e.status === 404 && gen === generation) {
        try {
          await syncFresh();
        } catch {
          /* the 404 is the answer either way */
        }
      }
      throw e;
    }
    if (gen !== generation) throw fail(t('errors.store.aborted'));
    return res;
  }

  const ON_404 = { syncOn404: true };

  /** The display name new entries are signed with. */
  function authorName() {
    const user = prefs.user;
    return user && typeof user.displayName === 'string' ? user.displayName : null;
  }

  /** One PATCH attempt against `local` (the row the merge is based on) with
   *  `ifSeq`. An event keeps its author; the family settings document is
   *  signed by whoever changed it last (opts.reauthor). */
  async function patchAttempt(local, patch, ifSeq, opts = {}) {
    const merged = validateUpdate(local, patch, isoFromMs(nowMs()));
    const reopens = isTimerType(merged.type) && merged.endedAt === null && local.endedAt !== null;
    if (reopens && openTimer(effective(), merged.type, local.eid)) {
      throw fail(timerRunningMessage(merged.type), 409);
    }
    const plain = {
      eid: local.eid,
      rev: (Number.isInteger(local.rev) ? local.rev : 0) + 1,
      type: merged.type,
      startedAt: merged.startedAt,
      endedAt: merged.endedAt,
      details: merged.details,
      loggedBy: opts.reauthor ? authorName() : local.loggedBy === undefined ? null : local.loggedBy,
    };
    const blob = await encryptEntry(fdk, familyId, plain);
    const row = await serverCall(() => api.patch(`api/entries/${local.eid}`, { blob, ifSeq }), ON_404);
    applyLocal(row, plain);
    return entryCopy(local.eid);
  }

  // --- the outbox ---------------------------------------------------------------------

  const opKey = (n) => `op:${String(n).padStart(14, '0')}:${randomEid().slice(0, 8)}`;
  const stored = ({ plain, waiter, check, inflight, done, ...rest }) => rest; // what goes into IndexedDB: no plaintext, no closures, no in-memory state
  const activeOp = (o) => !o.dead && !o.parked;
  const copyOf = (eid) => entryCopy(eid);

  async function persistOps(put, del = []) {
    try {
      await db.putOps(put.map(stored), del);
      opsDurable = true;
      return true;
    } catch {
      opsDurable = false;
      return false;
    }
  }

  function settleWaiter(op, value, err) {
    const w = op.waiter;
    op.waiter = null;
    if (!w) return;
    if (err) w.reject(err);
    else w.resolve(value);
  }

  function settleIdle() {
    if (flushing || ops.some(activeOp)) return;
    while (idleWaiters.length) idleWaiters.shift()();
  }

  function clearBackoff() {
    backoffUntil = 0;
    backoffStep = 0;
    if (backoffTimer) {
      clearTimeout(backoffTimer);
      backoffTimer = null;
    }
  }

  function backoff(ms) {
    const wait = ms || BACKOFF_MS[Math.min(backoffStep, BACKOFF_MS.length - 1)];
    backoffStep += 1;
    backoffUntil = Date.now() + wait;
    if (backoffTimer) clearTimeout(backoffTimer);
    backoffTimer = setTimeout(() => {
      backoffTimer = null;
      kickFlush();
    }, wait);
    if (backoffTimer && typeof backoffTimer.unref === 'function') backoffTimer.unref();
  }

  /** The error a dropped op answers with (the caller's promise, or a toast). */
  function dropError(reason, err) {
    if (err) return err;
    if (reason === 'guard' || reason === 'invalid') return fail(t('errors.validate.timerAlreadyEnded'), 409);
    if (reason === 'gone') return fail(t('errors.store.notFound'), 404);
    if (reason === 'conflict') return fail(t('api.entries.conflict'), 409);
    return fail(t('errors.store.aborted'));
  }

  /** Take `op` (and the ops that followed it on the same eid) out of the
   *  outbox: never sent. A waiting caller gets the error; a deferred op
   *  tells the parent why in a toast. */
  async function dropOp(op, reason, err) {
    const gone = ops.filter((o) => o.eid === op.eid && o.n >= op.n);
    ops = ops.filter((o) => !gone.includes(o));
    await persistOps([], gone.map((o) => o.key));
    notify(recompute({ persist: true }));
    const error = dropError(reason, err);
    let told = false;
    for (const o of gone) {
      if (o.waiter) told = true;
      settleWaiter(o, null, error);
    }
    if (!told && reason !== 'dead' && reason !== 'exists' && reason !== 'duplicate') {
      const type = label(op.plain ? op.plain.type : (model.get(op.eid) || {}).type);
      toast(t(reason === 'gone' ? 'errors.store.outboxGone' : 'errors.store.outboxDropped', { type }));
    }
    settleIdle();
  }

  /** The op landed (`row` = the server's answer) or was already in effect
   *  (row = null): confirm it — mirror + outbox in one transaction. */
  async function finishOp(op, row) {
    if (row && typeof row.eid === 'string') {
      const fresh = model.get(op.eid);
      const src =
        op.kind === 'create' || op.kind === 'update'
          ? op.plain
          : fresh && fresh.error
            ? { error: fresh.error }
            : fresh
              ? plainOf(fresh)
              : op.plain;
      applyRow(model, row, src);
      ownSeqs.add(Number(row.seq));
      if (op.kind === 'create') landed.set(PENDING_SEQ_BASE + op.n, Number(row.seq));
    }
    ops = ops.filter((o) => o !== op);
    op.done = true;
    if (!op.waiter) drained += 1;
    try {
      await db.confirmOp(row && typeof row.eid === 'string' ? row : null, op.key);
    } catch {
      /* the mirror catches up on the next sync page; the op is gone from memory */
    }
    notify(recompute({ persist: true }));
    settleWaiter(op, copyOf(op.eid), null);
    settleIdle();
  }

  /** The request for one op. */
  function sendOp(op) {
    switch (op.kind) {
      case 'create':
        return api.post('api/entries', { eid: op.eid, blob: op.blob });
      case 'update':
        return api.patch(`api/entries/${op.eid}`, { blob: op.blob, ifSeq: op.baseSeq });
      case 'remove':
        return api.del(`api/entries/${op.eid}`);
      case 'restore':
        return api.post(`api/entries/${op.eid}/restore`);
      default:
        return Promise.reject(fail(t('errors.store.aborted')));
    }
  }

  /** Lay the op's own fields over the fresh confirmed row and seal it again. */
  async function rebaseOp(op, fresh) {
    const merged = validateUpdate(fresh, fieldPatch(op), isoFromMs(nowMs()));
    const reopens = isTimerType(merged.type) && merged.endedAt === null && fresh.endedAt !== null;
    if (reopens && openTimer(model, merged.type, fresh.eid)) throw fail(timerRunningMessage(merged.type), 409);
    op.plain = {
      eid: fresh.eid,
      rev: (Number.isInteger(fresh.rev) ? fresh.rev : 0) + 1,
      type: merged.type,
      startedAt: merged.startedAt,
      endedAt: merged.endedAt,
      details: merged.details,
      loggedBy: fresh.loggedBy === undefined ? null : fresh.loggedBy,
    };
    op.blob = await encryptEntry(fdk, familyId, op.plain);
    op.baseSeq = fresh.seq;
  }

  /**
   * One attempt at the oldest op: judge it against the confirmed row, send
   * it, act on the answer. Returns 'next' (go on with the next op), 'again'
   * (judge the same op again after a sync) or 'stop' (no network, wait).
   */
  async function attemptOp(op) {
    const gen = generation;
    op.sent = true; // frozen from here on: a change arriving meanwhile becomes a follower
    const fresh = model.get(op.eid);
    let verdict = reconcile(op, fresh, seenBlob.get(op.eid));
    // A precondition handed in as a function (not persisted) counts like a named guard.
    if (verdict.action !== 'drop' && verdict.action !== 'done' && op.kind === 'update' && op.check && !op.check({ ...fresh })) {
      verdict = { action: 'drop', reason: 'guard' };
    }
    if (verdict.action === 'drop') {
      await dropOp(op, verdict.reason);
      return 'next';
    }
    if (verdict.action === 'done') {
      await finishOp(op, null);
      return 'next';
    }
    if (op.kind === 'create' && op.plain && isTimerType(op.plain.type) && op.plain.endedAt === null) {
      // The two-phone race, judged before a request is spent: a confirmed
      // timer of the type started within the window wins, ours is a duplicate.
      const keep = openTimer(model, op.plain.type);
      if (keep && withinDupWindow(keep, op.plain)) {
        await dropOp(op, 'duplicate');
        toast(t('errors.store.duplicateRemoved', { type: label(op.plain.type) }), 'success');
        return 'next';
      }
    }
    if (verdict.action === 'rebase') {
      const guarded = !!(op.guard || op.check);
      const ownBase = isPendingSeq(op.baseSeq) || ownSeqs.has(fresh.seq);
      if (op.waiter && !guarded && !ownBase) {
        // The caller is still waiting: the row moved under a plain edit — the
        // 409 it would have got, so the form can close on the fresh row.
        await dropOp(op, 'conflict');
        return 'next';
      }
      try {
        await rebaseOp(op, fresh);
      } catch (e) {
        await dropOp(op, 'invalid', op.waiter ? e : null);
        return 'next';
      }
      if (gen !== generation) return 'stop';
    }
    op.sent = true;
    await persistOps([op]);
    if (gen !== generation) return 'stop';
    let row;
    op.inflight = true;
    notify(recompute({ persist: true }));
    try {
      row = await sendOp(op);
    } catch (err) {
      op.inflight = false;
      if (gen !== generation) return 'stop';
      const cls = classify(err, op.kind);
      if (cls === 'exists') {
        // Our eid on the server: the create landed and the answer got lost.
        try {
          await syncFresh();
        } catch {
          /* judged on what we have */
        }
        if (gen !== generation) return 'stop';
        if (model.has(op.eid)) await finishOp(op, null);
        else await dropOp(op, 'exists'); // a tombstone a since=0 page omits: nothing to show
        return 'next';
      }
      if (cls === 'conflict' || cls === 'gone') {
        op.sent = false;
        op.tries += 1;
        let synced = true;
        try {
          await syncFresh();
        } catch {
          synced = false;
        }
        if (gen !== generation) return 'stop';
        if (cls === 'gone' && op.waiter) {
          await dropOp(op, 'gone', err);
          return 'next';
        }
        if (!synced) {
          await persistOps([op]);
          settleWaiter(op, copyOf(op.eid), null);
          backoff();
          return 'stop';
        }
        if (op.tries > 3) {
          await persistOps([op]);
          settleWaiter(op, null, err);
          return 'stop';
        }
        return 'again';
      }
      if (cls === 'permanent') {
        op.sent = false;
        op.parked = { status: err.status, code: err.code || null, message: err.message || '' };
        await persistOps([op]);
        notify(recompute({ persist: true }));
        if (op.waiter) settleWaiter(op, null, err);
        else toast(t('errors.store.outboxParked', { type: label(op.plain ? op.plain.type : (fresh || {}).type) }));
        return 'next';
      }
      // No answer, or one that says nothing was written: keep the op.
      if (cls !== 'transient') op.sent = false; // 429/503/401 never applied — a change may fold in again
      await persistOps([op]);
      if (cls === 'auth') authBlocked = true;
      else backoff(err.status === 429 ? BACKOFF_MS[BACKOFF_MS.length - 1] : null);
      notify(recompute({ persist: true }));
      settleWaiter(op, copyOf(op.eid), null);
      return 'stop';
    }
    op.inflight = false;
    if (gen !== generation) return 'stop';
    clearBackoff();
    await finishOp(op, row);
    return 'next';
  }

  async function runFlush() {
    const gen = generation;
    let rounds = 0;
    drained = 0;
    for (;;) {
      if (gen !== generation || !isOnline() || authBlocked) break;
      const dead = ops.find((o) => o.dead);
      if (dead) {
        // Undone before it was sent, its undo toast long gone: nothing to send.
        await dropOp(dead, 'dead');
        continue;
      }
      const op = nextOp(ops);
      if (!op) break;
      const outcome = await attemptOp(op);
      if (outcome === 'stop') break;
      if (outcome === 'again' && ++rounds > 8) break;
    }
    if (drained > 0 && gen === generation) toast(t('errors.store.outboxSent', { n: drained }), 'success');
  }

  /** Send what is waiting, one op at a time, one flusher per browser (Web Locks). */
  function kickFlush() {
    if (flushing || keyState !== 'ready' || !ops.some(activeOp)) return flushing || Promise.resolve();
    if (authBlocked || !isOnline()) return Promise.resolve();
    if (Date.now() < backoffUntil) {
      if (!backoffTimer) backoff(backoffUntil - Date.now());
      return Promise.resolve();
    }
    const run = locks
      ? new Promise((resolve) => {
          let taken = false;
          Promise.resolve(
            locks.request('bt-outbox', { ifAvailable: true }, async (lock) => {
              if (!lock) return;
              taken = true;
              await runFlush();
            })
          )
            .catch(() => (taken ? null : runFlush()))
            .then(resolve, resolve);
        })
      : runFlush();
    flushing = run.finally(() => {
      flushing = null;
      settleIdle();
      // Something was queued while this run was busy, or a follower is due.
      if (ops.some(activeOp) && isOnline() && !authBlocked && Date.now() >= backoffUntil) kickFlush();
    });
    return flushing;
  }

  /**
   * Put a write into the outbox (folded into an earlier op on the same
   * entry when possible), show it, kick the flusher and wait — at most
   * settleWaitMs, only with network — for the op's first answer. Resolves
   * with the entry as the app now holds it: confirmed (a real seq) when the
   * answer came in time, else pending. Rejects with what the server or the
   * rules said when the op could not apply. When the outbox cannot be
   * persisted (no IndexedDB) the write goes straight to the server instead:
   * nothing is ever left waiting in memory alone.
   */
  async function enqueue(incoming) {
    const gen = generation;
    const n = Math.max(nextN, Date.now());
    const res = coalesce(ops, { ...incoming, queuedAt: isoFromMs(nowMs()) }, n, opKey);
    nextN = n + 1;
    const durable = await persistOps(res.put, res.del);
    if (gen !== generation) throw fail(t('errors.store.aborted'));
    if (!durable) return sendDirect(incoming);
    ops = res.ops;
    notify(recompute({ persist: true }));
    const op = res.put.find((o) => o.eid === incoming.eid && activeOp(o)) || null;
    if (!op || op.dead) {
      settleIdle();
      return copyOf(incoming.eid);
    }
    if (incoming.check) op.check = incoming.check;
    const canWait = settleWaitMs > 0 && isOnline() && !authBlocked && Date.now() >= backoffUntil;
    if (!canWait) {
      kickFlush();
      return copyOf(incoming.eid);
    }
    const answer = new Promise((resolve, reject) => {
      op.waiter = { resolve, reject };
    });
    let timer = null;
    const patience = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), settleWaitMs);
    });
    kickFlush();
    const result = await Promise.race([answer.then((v) => ({ v }), (e) => ({ e })), patience]);
    if (timer) clearTimeout(timer);
    if (result === null) {
      op.waiter = null; // the flusher goes on without us
      return copyOf(incoming.eid);
    }
    if (result.e) throw result.e;
    return result.v;
  }

  /** The direct path: no outbox (settings, the resolver's compare-and-set
   *  delete, a phone without IndexedDB) — the answer or the error, as they come. */
  async function sendDirect(incoming) {
    const local = model.get(incoming.eid);
    const op = { ...incoming, tries: 0 };
    const row = await serverCall(() => sendOp(op), incoming.kind === 'create' ? {} : ON_404);
    applyLocal(row, op.plain || (local && local.error ? { error: local.error } : local ? plainOf(local) : null));
    return entryCopy(incoming.eid);
  }

  const entries = {
    /** The entry as the app holds it (live, deleted, pending or {error}), or null. */
    get(eid) {
      return entryCopy(eid);
    },

    /** Live entries whose start falls in [fromLocal, toLocal] (Zurich days), newest first. */
    range(fromLocal, toLocal) {
      return listRange(effective(), fromLocal, toLocal).map((e) => ({ ...e }));
    },

    /** Has the entry been changed by the OTHER phone since `seq` (a form's
     *  ifSeq)? This device's own writes landing do not count. */
    changedSince,

    /**
     * Create from {type, startedAt?, endedAt?, details?}: validated
     * (validate.validateCreate), loggedBy from the account's display name,
     * one open timer per type, rev 1. Returns the entry as the app holds
     * it (see enqueue). opts.defer === false sends straight away (settings).
     */
    async create(input, opts = {}) {
      requireKey();
      const v = validateCreate(input, isoFromMs(nowMs()));
      if (isTimerType(v.type) && v.endedAt === null && openTimer(effective(), v.type)) {
        throw fail(timerRunningMessage(v.type), 409);
      }
      const plain = {
        eid: randomEid(),
        rev: 1,
        type: v.type,
        startedAt: v.startedAt,
        endedAt: v.endedAt,
        details: v.details,
        loggedBy: authorName(),
      };
      const blob = await encryptEntry(fdk, familyId, plain);
      const incoming = { eid: plain.eid, kind: 'create', blob, baseSeq: null, fields: [], guard: null, plain };
      if (opts.defer === false) return sendDirect(incoming);
      return enqueue(incoming);
    },

    /**
     * Field-level update {startedAt?, endedAt?, details?} merged onto the
     * entry as the app holds it. opts.guard ('open' | 'durationless' |
     * 'paused') names the state the row must still be in — checked on the
     * local row FIRST (a partner's end that a sync already applied is never
     * overwritten: "Der Timer wurde bereits beendet") and again on the fresh
     * row when the server says the row moved; opts.precondition(row) is the
     * same as a function (not persisted). opts.ifSeq — the seq an edit form
     * rendered from — refuses the write when the OTHER phone changed the row
     * since (409, the form reloads); the store's own writes landing meanwhile
     * do not count.
     */
    async update(eid, patch, opts = {}) {
      requireKey();
      const local = liveLocal(eid);
      const guard = typeof opts.guard === 'string' && GUARDS[opts.guard] ? opts.guard : null;
      const check = typeof opts.precondition === 'function' ? opts.precondition : guard ? GUARDS[guard] : null;
      if (check && !check({ ...local })) throw fail(t('errors.validate.timerAlreadyEnded'), 409);
      if (Number.isInteger(opts.ifSeq) && changedSince(eid, opts.ifSeq)) throw fail(t('api.entries.conflict'), 409);
      const merged = validateUpdate(local, patch, isoFromMs(nowMs()));
      const reopens = isTimerType(merged.type) && merged.endedAt === null && local.endedAt !== null;
      if (reopens && openTimer(effective(), merged.type, eid)) throw fail(timerRunningMessage(merged.type), 409);
      const plain = {
        eid,
        rev: (Number.isInteger(local.rev) ? local.rev : 0) + 1,
        type: merged.type,
        startedAt: merged.startedAt,
        endedAt: merged.endedAt,
        details: merged.details,
        loggedBy: local.loggedBy === undefined ? null : local.loggedBy,
      };
      const blob = await encryptEntry(fdk, familyId, plain);
      return enqueue({
        eid,
        kind: 'update',
        blob,
        baseSeq: local.seq,
        fields: changedFields(local, merged),
        guard,
        plain,
        check: guard ? null : check,
      });
    },

    /**
     * Soft delete; the tombstone keeps its plaintext locally so restore can
     * check the timer rule. opts.ifSeq (the duplicate-timer resolver) is a
     * compare-and-set that goes straight to the server: the server 409s
     * when the row moved meanwhile.
     */
    async remove(eid, opts = {}) {
      requireKey();
      const local = effective().get(eid);
      if (!local || local.deletedAt != null) throw fail(t('errors.store.notFound'), 404);
      if (Number.isInteger(opts.ifSeq)) {
        const row = await serverCall(() => api.del(`api/entries/${eid}`, { ifSeq: opts.ifSeq }), ON_404);
        applyLocal(row, local.error ? { error: local.error } : plainOf(local));
        return entryCopy(eid);
      }
      return enqueue({ eid, kind: 'remove', blob: null, baseSeq: local.seq, fields: [], guard: null, plain: null });
    },

    /** Undo a soft delete; an open timer may only come back when no other of its type runs. */
    async restore(eid) {
      requireKey();
      const local = effective().get(eid);
      if (!local || local.deletedAt == null) throw fail(t('errors.store.notFound'), 404);
      if (!local.error && isTimerType(local.type) && local.endedAt === null && openTimer(effective(), local.type, eid)) {
        throw fail(timerRunningMessage(local.type), 409);
      }
      return enqueue({ eid, kind: 'restore', blob: null, baseSeq: local.seq, fields: [], guard: null, plain: null });
    },
  };

  // --- family settings -----------------------------------------------------------------
  // One `settings` entry per family (validate.js SETTINGS_TYPE), read from
  // the derived state like everything else and written like an entry: a
  // save lays only the changed keys over the current document, with the
  // row's seq as compare-and-set — when the partner saved meanwhile, the
  // fresh document is fetched and the change laid over THAT, never over a
  // stale copy (a plain update would replay the stale merge).

  const settings = {
    /** The values that apply on this phone: family row over this device's
     *  older per-device values over the defaults. Works from the cached
     *  snapshot too, so the first paint has them. */
    get current() {
      const row = snapshot && snapshot.data ? snapshot.data.familySettings || null : null;
      return effectiveFamilySettings(row, prefs.localFamilyValues);
    },

    /** {changedAt, changedBy} of the family's row, or null while the family
     *  has not saved a setting yet. */
    get meta() {
      const row = snapshot && snapshot.data ? snapshot.data.familySettings || null : null;
      return row ? { changedAt: row.changedAt, changedBy: row.changedBy } : null;
    },

    /** Which keys the family row carries (the rest still come from this
     *  phone's older values or the defaults). */
    get syncedKeys() {
      const row = snapshot && snapshot.data ? snapshot.data.familySettings || null : null;
      return row ? FAMILY_SETTING_KEYS.filter((k) => row.values[k] !== undefined) : [];
    },

    /** Save {feedFromStart?, recommendedMl?, bottlePresets?, formulaPresets?,
     *  birthDate?, mealsPerDay?, breastfeeding?, nursingMl?} for the family
     *  (model.FAMILY_SETTING_KEYS). Saves run one after the other: the CAS
     *  on the row's seq protects an EXISTING document, but two saves racing
     *  on a family without one (a typed amount and a switch tapped within
     *  the same second) would each create a row, and the lower seq's change
     *  would be lost. */
    async save(patch) {
      requireKey();
      const run = settingsQueue.then(() => saveSettings(patch));
      settingsQueue = run.catch(() => {});
      return run;
    },
  };

  let settingsQueue = Promise.resolve();

  /** One settings save: create the family's document or lay the change over
   *  the current one (CAS on its seq; on a 409 over the partner's fresh
   *  document, re-authored). */
  async function saveSettings(patch) {
    const change = {};
    for (const k of FAMILY_SETTING_KEYS) {
      if (patch && patch[k] !== undefined) change[k] = Array.isArray(patch[k]) ? [...patch[k]] : patch[k];
    }
    let base = familySettingsRow(model);
    for (let attempt = 0; ; attempt++) {
      if (!base) {
        await entries.create({ type: 'settings', details: change }, { defer: false });
        return settings.current;
      }
      try {
        await patchAttempt(
          base,
          { startedAt: isoFromMs(nowMs()), details: { ...(base.details || {}), ...change } },
          base.seq,
          { reauthor: true }
        );
        return settings.current;
      } catch (err) {
        if (!err || !err.server || err.status !== 409 || attempt >= 2) throw err;
        try {
          await syncFresh();
        } catch {
          throw err;
        }
        base = familySettingsRow(model);
      }
    }
  }

  // --- polling -------------------------------------------------------------------------

  function onVisible() {
    if (!hasDom || document.visibilityState === 'visible') {
      tickRecompute();
      store.refresh().catch(() => {});
    }
  }

  /** The network is back: forget the pause, send what is waiting. */
  function onOnline() {
    clearBackoff();
    store.refresh().catch(() => {});
    kickFlush();
  }

  /** "Today" rolls over even without the network: re-derive and notify on change. */
  function tickRecompute() {
    if (recompute()) notify(true);
  }

  const store = {
    /** { ts, data } | null — data = model.deriveState(); ts = last successful sync. */
    get snapshot() {
      return snapshot;
    },

    isStale() {
      return !snapshot || Date.now() - snapshot.ts > STALE_AFTER_MS;
    },

    /** The error of the last failed sync, or null after a success. */
    get lastError() {
      return lastError;
    },

    /** Resolves once the local rows are decrypted (before the first sync). */
    get ready() {
      return ready;
    },

    /** 'none' (not booted) | 'locked' (no usable key — unlock screen) | 'ready'. */
    get keyState() {
      return keyState;
    },

    /** The daily key (non-extractable AES-GCM CryptoKey) while ready, else null. */
    get fdk() {
      return fdk;
    },

    /** Rows that could not be decrypted or validated (shown under Mehr). */
    get decryptErrors() {
      return decryptErrors;
    },

    /** Persistent home-screen notice ("Zwei Schlaf-Timer offen …") or null —
     *  worded in the language of the moment it is read. */
    get notice() {
      return noticeType ? t('errors.store.duplicateTimers', { type: label(noticeType) }) : null;
    },

    /** The last synced seq (tests/debugging). */
    get cursor() {
      return cursor;
    },

    /** Version of the private artwork the server holds for this family
     *  (api/lib/art.php): a string, null = none, undefined = no sync has
     *  answered yet on this start. main.js hands it to src/art.js. */
    get artVersion() {
      return artVersion;
    },

    /** The key of the capability link the install icon comes through
     *  (api/lib/art.php), or null — only ever set together with artVersion. */
    get artKey() {
      return artKey;
    },

    entries,

    settings,

    /** fn(snapshot, changed) after every sync attempt and local write. Returns unsubscribe. */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /**
     * Boot once (identity check, stored key, local rows, first sync).
     * Resolves with the keyState it ended in ('locked' | 'ready').
     */
    boot,

    /** Sync now; concurrent calls share one run. Resolves with the snapshot
     *  (untouched while locked); rejects on failure after notifying. */
    refresh() {
      if (!booted) return boot().then(() => inFlight || snapshot);
      if (keyState !== 'ready') return Promise.resolve(snapshot);
      return sync();
    },

    /** A refresh guaranteed to run AFTER a write that just completed (a sync
     *  already in flight may have been computed before the write). */
    refreshAfterWrite() {
      const stale = inFlight;
      if (!stale) return this.refresh();
      return stale.catch(() => {}).then(() => this.refresh());
    },

    /** Begin polling (foreground only) + refresh-on-focus; boots if needed. */
    start() {
      this.stop();
      if (hasDom) {
        document.addEventListener('visibilitychange', onVisible);
        window.addEventListener('focus', onVisible);
        window.addEventListener('online', onOnline);
      }
      pollTimer = setInterval(() => {
        if (!hasDom || document.visibilityState === 'visible') {
          tickRecompute();
          this.refresh().catch(() => {});
        }
      }, POLL_MS);
      this.refresh().catch(() => {});
    },

    stop() {
      if (hasDom) {
        document.removeEventListener('visibilitychange', onVisible);
        window.removeEventListener('focus', onVisible);
        window.removeEventListener('online', onOnline);
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      clearBackoff();
    },

    /** The outbox as the views see it: counts, the list, and the controls of the sheet. */
    outbox: {
      /** Entries still to send (pending creates, edits, deletes). */
      get count() {
        return summary(ops).waiting;
      },
      /** Entries the server refused for good — waiting for a retry or a discard. */
      get parked() {
        return summary(ops).parked;
      },
      /** Whether the outbox is persisted (false = no IndexedDB: writes go straight to the server). */
      get durable() {
        return opsDurable;
      },
      /** The ops, oldest first: {key, eid, kind, status, queuedAt, type, parked}. */
      list() {
        return ops
          .filter((o) => !o.dead)
          .map((o) => {
            const e = effective().get(o.eid) || model.get(o.eid) || null;
            return {
              key: o.key,
              eid: o.eid,
              kind: o.kind,
              status: o.parked ? 'parked' : o.inflight ? 'sending' : 'waiting',
              queuedAt: o.queuedAt,
              type: o.plain ? o.plain.type : e ? e.type : null,
              parked: o.parked ? { ...o.parked } : null,
            };
          });
      },
      /** Send now (a tap on «Jetzt senden»): resolves when the run is over. */
      flush() {
        clearBackoff();
        return kickFlush();
      },
      /** Resolves once nothing is left to send (tests, the screenshot script). */
      idle() {
        return new Promise((resolve) => {
          idleWaiters.push(resolve);
          settleIdle();
        });
      },
      /** Try a parked op again. */
      async retry(key) {
        const op = ops.find((o) => o.key === key);
        if (!op || !op.parked) return;
        op.parked = null;
        await persistOps([op]);
        notify(recompute({ persist: true }));
        clearBackoff();
        await kickFlush();
      },
      /** Give a parked op up: what it would have written is gone. */
      async discard(key) {
        const op = ops.find((o) => o.key === key);
        if (!op) return;
        await dropOp(op, 'dead');
      },
    },

    /**
     * Bind the store to the signed-in user (login, registration, cookie-only
     * boot): another account's local data is wiped first. Safe to call
     * repeatedly for the same user.
     */
    async setIdentity(user) {
      if (!user || typeof user.username !== 'string') throw fail(t('errors.store.invalidUser'));
      await ensureIdentity(user);
    },

    /**
     * Take a freshly unwrapped FDK (32 raw bytes, or an AES-GCM CryptoKey)
     * into use: decrypt local rows, resolve `ready`, sync. Does not persist
     * the key — that is keys.storeFdk (session.js).
     */
    async unlockWith(fdkRaw) {
      const key = fdkRaw instanceof Uint8Array ? await importFdk(fdkRaw, false) : fdkRaw;
      if (!key || typeof key !== 'object') throw fail(t('errors.crypto.keyData'));
      if (booting) await booting.catch(() => {});
      const user = prefs.user;
      if (user) familyId = user.familyId;
      await activate(key, { fromPassword: true });
    },

    /** Every decrypted entry (deleted ones flagged), newest first — the export. */
    exportPlain() {
      return [...effective().values()]
        .filter((e) => !e.error)
        .sort(sortNewest)
        .map((e) => ({
          eid: e.eid,
          type: e.type,
          startedAt: e.startedAt,
          endedAt: e.endedAt,
          details: { ...(e.details || {}) },
          loggedBy: e.loggedBy,
          createdAt: e.createdAt,
          updatedAt: e.updatedAt,
          deletedAt: e.deletedAt,
          deleted: e.deletedAt != null,
        }));
    },

    /** Forget everything in memory and the cached snapshot (logout). IndexedDB
     *  and the stored key are the caller's (session.logout) to wipe — AFTER
     *  this call: the generation bump here is what makes a sync or write
     *  still on the wire drop its answer instead of re-filling the mirror. */
    clear() {
      resetMemory();
      try {
        storage.removeItem(STATE_KEY);
        storage.removeItem(IDENTITY_KEY);
      } catch {
        /* ignore */
      }
    },
  };

  return store;
}

// --- the real instance -------------------------------------------------------------------

const defaultStorage = browserStorage();

export const prefs = createPrefs(defaultStorage);

export const store = createStore({
  api: realApi,
  db: realDb,
  keys: realKeys,
  prefs,
  storage: defaultStorage,
  toast: realToast,
  setClockSkew: realSetClockSkew,
  nowMs: realNowMs,
});
