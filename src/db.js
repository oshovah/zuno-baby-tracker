// IndexedDB 'bt' (version 1): the local copy of the family's sync feed.
//
//   rows  — server rows verbatim ({eid, seq, blob|null, createdAt,
//           updatedAt, deletedAt}), keyPath eid, index seq.
//   meta  — {k, v} records: cursor (last synced seq), identity (the
//           username the rows belong to), feed (the server database the
//           rows came from), the daily key under 'fdk' (see keys.js) and
//           the outbox — one 'op:<n>:<rand>' record per write still to send
//           (src/outbox.js; ciphertext only). Kept in meta on purpose: no
//           version bump, so a shell rolled back to an older release still
//           opens the database (an older shell just never reads the keys).
//
// Every function returns a promise and REJECTS when IndexedDB is missing,
// blocked, hung (openDb gives up after 3 s) or broken — callers decide what
// that means (store.js degrades to a memory-only session, keys.js to the
// unlock screen). Nothing here touches the DOM, so the module can be
// imported under node; only the calls need a browser. Error messages are
// read from the translations when they are thrown.

import { t } from './i18n/index.js';

const DB_NAME = 'bt';
const DB_VERSION = 1;
const OPEN_TIMEOUT_MS = 3000;
const ROWS = 'rows';
const META = 'meta';

let dbPromise = null;

function factory() {
  const f = globalThis.indexedDB;
  if (!f) throw new Error(t('errors.db.unavailable'));
  return f;
}

function errorOf(source, fallback) {
  const e = source && source.error;
  return e instanceof Error || (e && typeof e.message === 'string') ? e : new Error(fallback);
}

/**
 * Open (and on first use create) the database. One shared connection; a
 * connection the browser closes behind our back (Safari under storage
 * pressure, a version change) is dropped so the next call reopens it. The
 * open request is abandoned after 3 s — a hung IndexedDB must never keep the
 * app from painting or the unlock screen from appearing.
 */
export function openDb() {
  if (dbPromise) return dbPromise;
  let opened = null; // this attempt's promise (assigned right below)
  const forget = () => {
    if (dbPromise === opened) dbPromise = null;
  };
  opened = new Promise((resolve, reject) => {
    let req;
    try {
      req = factory().open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(t('errors.db.unavailable')));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(t('errors.db.timeout')));
    }, OPEN_TIMEOUT_MS);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ROWS)) {
        const rows = db.createObjectStore(ROWS, { keyPath: 'eid' });
        rows.createIndex('seq', 'seq', { unique: false });
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: 'k' });
      }
    };
    req.onsuccess = () => {
      clearTimeout(timer);
      const db = req.result;
      if (settled) {
        // Answered after the timeout: the caller already gave up.
        db.close();
        return;
      }
      settled = true;
      db.onversionchange = () => {
        db.close();
        forget();
      };
      db.onclose = forget;
      resolve(db);
    };
    req.onerror = () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(errorOf(req, t('errors.db.generic')));
    };
    // onblocked: another tab holds an old version open — the timeout covers it.
  });
  dbPromise = opened;
  opened.catch(forget); // a failed open must not poison every later call
  return opened;
}

/** Run body(tx) inside one transaction; resolves with body's value once the transaction committed. */
async function withTxn(names, mode, body) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(names, mode);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(t('errors.db.generic')));
      return;
    }
    let result;
    let failed = null;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => {
      failed = failed || errorOf(tx, t('errors.db.generic'));
    };
    tx.onabort = () => reject(failed || errorOf(tx, t('errors.db.generic')));
    try {
      result = body(tx);
    } catch (e) {
      failed = e;
      try {
        tx.abort();
      } catch {
        reject(e);
      }
    }
  });
}

function whenDone(req, onValue) {
  req.onsuccess = () => onValue(req.result);
}

/** Every stored row (unordered). */
export function getAllRows() {
  return withTxn([ROWS], 'readonly', (tx) => {
    const box = { rows: [] };
    whenDone(tx.objectStore(ROWS).getAll(), (rows) => {
      box.rows = rows || [];
    });
    return box;
  }).then((box) => box.rows);
}

/** put(row) unless the store already holds that eid at the same or a higher seq. */
function putIfNewer(store, row, onDone) {
  whenDone(store.get(row.eid), (existing) => {
    if (!existing || !(Number(existing.seq) >= Number(row.seq))) {
      store.put(row);
    }
    if (onDone) onDone();
  });
}

/**
 * Store one sync page: every row (seq-monotonic — a row already held at a
 * higher seq is left alone) and, LAST in the same transaction, meta.cursor
 * = cursor (skipped when cursor is undefined). One transaction, so a crash
 * mid-page can never leave a cursor that claims rows the store lacks.
 */
export function putRows(rows, cursor) {
  const list = Array.isArray(rows) ? rows : [];
  return withTxn([ROWS, META], 'readwrite', (tx) => {
    const store = tx.objectStore(ROWS);
    const meta = tx.objectStore(META);
    let pending = list.length;
    const writeCursor = () => {
      if (cursor !== undefined) meta.put({ k: 'cursor', v: cursor });
    };
    if (pending === 0) {
      writeCursor();
      return;
    }
    for (const row of list) {
      putIfNewer(store, row, () => {
        pending -= 1;
        if (pending === 0) writeCursor();
      });
    }
  });
}

/** Store one row (own write / seal result); never lowers an existing seq. */
export function putRow(row) {
  return withTxn([ROWS], 'readwrite', (tx) => {
    putIfNewer(tx.objectStore(ROWS), row);
  });
}

export function deleteRows(eids) {
  return withTxn([ROWS], 'readwrite', (tx) => {
    const store = tx.objectStore(ROWS);
    for (const eid of eids || []) store.delete(eid);
  });
}

/** Drop every row but keep meta (identity, key) — the sync `reset` case. */
export function clearRows() {
  return withTxn([ROWS], 'readwrite', (tx) => {
    tx.objectStore(ROWS).clear();
  });
}

/** meta value for k, undefined when absent. */
export function getMeta(k) {
  return withTxn([META], 'readonly', (tx) => {
    const box = {};
    whenDone(tx.objectStore(META).get(k), (rec) => {
      box.v = rec ? rec.v : undefined;
    });
    return box;
  }).then((box) => box.v);
}

export function setMeta(k, v) {
  return withTxn([META], 'readwrite', (tx) => {
    tx.objectStore(META).put({ k, v });
  });
}

export function deleteMeta(k) {
  return withTxn([META], 'readwrite', (tx) => {
    tx.objectStore(META).delete(k);
  });
}

const OP_PREFIX = 'op:';

/** Every outbox op ({k, v} → v with `key` = k), oldest first (the key sorts by n). */
export function getAllOps() {
  return withTxn([META], 'readonly', (tx) => {
    const box = { ops: [] };
    const range = IDBKeyRange.bound(OP_PREFIX, OP_PREFIX + '\uffff', false, true);
    whenDone(tx.objectStore(META).getAll(range), (recs) => {
      box.ops = (recs || []).map((r) => ({ ...r.v, key: r.k }));
    });
    return box;
  }).then((box) => box.ops);
}

/** Persist ops (each carries its `key`) and delete others — one transaction. */
export function putOps(ops, deleteKeys = []) {
  return withTxn([META], 'readwrite', (tx) => {
    const meta = tx.objectStore(META);
    for (const k of deleteKeys) meta.delete(k);
    for (const op of ops) {
      const { key, ...v } = op;
      meta.put({ k: key, v });
    }
  });
}

export function deleteOps(keys) {
  return putOps([], keys);
}

/** A write confirmed: the returned row into the mirror and the op out of it, in ONE transaction. */
export function confirmOp(row, key) {
  return withTxn([ROWS, META], 'readwrite', (tx) => {
    if (row) putIfNewer(tx.objectStore(ROWS), row);
    if (key) tx.objectStore(META).delete(key);
  });
}

/** Wipe rows AND meta (logout, identity change). */
export function clearAll() {
  return withTxn([ROWS, META], 'readwrite', (tx) => {
    tx.objectStore(ROWS).clear();
    tx.objectStore(META).clear();
  });
}
