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
// model.openTimer, encrypted, sent, and the
// returned row applied locally with its seq. A PATCH carries ifSeq; on 409
// the store syncs, re-reads and retries ONCE when the caller's precondition
// still holds on the fresh row (e.g. "the timer is still open"), otherwise
// the 409 surfaces. A precondition is checked on the LOCAL row first, so a
// partner's end that a sync already applied is never overwritten. A server
// 404 on update/remove/restore syncs once (best effort) before it surfaces,
// so the model reflects why (the other phone deleted it).
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
 */
export function createStore(deps) {
  const { api, db, keys, prefs, storage, toast, setClockSkew, nowMs } = deps;
  const yieldToLoop = deps.yieldToLoop || (() => new Promise((r) => setTimeout(r, 0)));
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
  function recompute(opts = {}) {
    if (keyState !== 'ready') return false;
    if (model.size === 0 && !lastSyncTs) return false;
    const data = deriveState(model, isoFromMs(nowMs()));
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
    for (const { type, keep, others } of duplicateOpenTimers(model)) {
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

  /** Take `key` into use: load local rows, mark ready, sync. */
  async function activate(key, { fromPassword = false } = {}) {
    if (inFlight) await inFlight.catch(() => {});
    const gen = generation;
    fdk = key;
    keyState = 'ready';
    const ok = await loadLocal();
    if (gen !== generation) return; // wiped (logout) while the rows were loading
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
      const c = recompute({ persist: true });
      notify(c || changed);
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
    for (const { type, keep, others } of duplicateOpenTimers(model)) {
      for (const o of others) {
        if (!withinDupWindow(o, keep) || dupHandled.has(o.eid)) continue;
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
    const e = model.get(eid);
    if (!e || e.deletedAt != null || e.error) throw fail(t('errors.store.notFound'), 404);
    return e;
  }

  const entryCopy = (eid) => {
    const e = model.get(eid);
    return e ? { ...e, details: { ...(e.details || {}) } } : null;
  };

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
    if (reopens && openTimer(model, merged.type, local.eid)) {
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

  const entries = {
    /** The entry as the model holds it (live, deleted or {error}), or null. */
    get(eid) {
      return entryCopy(eid);
    },

    /** Live entries whose start falls in [fromLocal, toLocal] (Zurich days), newest first. */
    range(fromLocal, toLocal) {
      return listRange(model, fromLocal, toLocal).map((e) => ({ ...e }));
    },

    /**
     * Create from {type, startedAt?, endedAt?, details?}: validated
     * (validate.validateCreate), loggedBy from the account's display name,
     * one open timer per type, rev 1. Returns the entry as the model holds
     * it.
     */
    async create(input) {
      requireKey();
      const v = validateCreate(input, isoFromMs(nowMs()));
      if (isTimerType(v.type) && v.endedAt === null && openTimer(model, v.type)) {
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
      const row = await serverCall(() => api.post('api/entries', { eid: plain.eid, blob }));
      applyLocal(row, plain);
      return entryCopy(plain.eid);
    },

    /**
     * Field-level update {startedAt?, endedAt?, details?} merged onto the
     * CURRENT local row, sent with ifSeq (opts.ifSeq — the seq an edit form
     * rendered from — or the local seq). opts.precondition(row) is checked
     * on the local row FIRST — a partner's end that a sync already applied
     * is never overwritten ("Der Timer wurde bereits beendet"). On 409:
     * sync, re-read, and when the precondition holds on the fresh row retry
     * ONCE; otherwise "Der Timer wurde bereits beendet" (with a
     * precondition) or the server's 409 text (without one — the edit form
     * reloads).
     */
    async update(eid, patch, opts = {}) {
      requireKey();
      const local = liveLocal(eid);
      const guarded = typeof opts.precondition === 'function';
      if (guarded && !opts.precondition({ ...local })) throw fail(t('errors.validate.timerAlreadyEnded'), 409);
      const ifSeq = Number.isInteger(opts.ifSeq) ? opts.ifSeq : local.seq;
      try {
        return await patchAttempt(local, patch, ifSeq);
      } catch (err) {
        if (!err || !err.server || err.status !== 409) throw err;
        try {
          await syncFresh();
        } catch {
          throw err;
        }
        const fresh = model.get(eid);
        if (!fresh || fresh.deletedAt != null || fresh.error) throw fail(t('errors.store.notFound'), 404);
        if (!guarded) throw err;
        if (!opts.precondition({ ...fresh })) throw fail(t('errors.validate.timerAlreadyEnded'), 409);
        return await patchAttempt(fresh, patch, fresh.seq);
      }
    },

    /**
     * Soft delete; the tombstone keeps its plaintext locally so restore can
     * check the timer rule. opts.ifSeq (the duplicate-timer resolver) is a
     * compare-and-set: the server 409s when the row moved meanwhile.
     */
    async remove(eid, opts = {}) {
      requireKey();
      const local = model.get(eid);
      if (!local || local.deletedAt != null) throw fail(t('errors.store.notFound'), 404);
      const ifSeq = Number.isInteger(opts.ifSeq) ? opts.ifSeq : null;
      const row = await serverCall(
        () => api.del(`api/entries/${eid}`, ifSeq === null ? undefined : { ifSeq }),
        ON_404
      );
      applyLocal(row, local.error ? { error: local.error } : plainOf(local));
      return entryCopy(eid);
    },

    /** Undo a soft delete; an open timer may only come back when no other of its type runs. */
    async restore(eid) {
      requireKey();
      const local = model.get(eid);
      if (!local || local.deletedAt == null) throw fail(t('errors.store.notFound'), 404);
      if (!local.error && isTimerType(local.type) && local.endedAt === null && openTimer(model, local.type, eid)) {
        throw fail(timerRunningMessage(local.type), 409);
      }
      const row = await serverCall(() => api.post(`api/entries/${eid}/restore`), ON_404);
      applyLocal(row, local.error ? { error: local.error } : plainOf(local));
      return entryCopy(eid);
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
        await entries.create({ type: 'settings', details: change });
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
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
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
      return [...model.values()]
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
