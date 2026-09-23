// store.js under node: createStore() over a fake api (an in-memory port of
// api/lib/entries.php's sync / CAS semantics), a fake IndexedDB
// mirror and a fake key store — real crypto. Two instances over one server
// play the two phones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, createPrefs } from '../store.js';
import { generateFdkRaw, importFdk, encryptEntry, randomEid } from '../crypto.js';

const FAMILY = 7;
const NOW = '2026-09-01T10:00:00Z';
const NOW_MS = Date.parse(NOW);
const TODAY = '2026-09-01';
const minus = (mins) => new Date(NOW_MS - mins * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');

// --- fakes ------------------------------------------------------------------------

/** An error as src/api.js makes it from the server's envelope: status, message and the code the server named. */
function httpError(status, message, code = CODE_OF[message] || 'test.error') {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}
const CODE_OF = {
  'Eintrag nicht gefunden': 'entries.notFound',
  'Nicht gefunden': 'request.notFound',
  'Eintrag existiert bereits': 'entries.exists',
  'Der Eintrag wurde inzwischen auf einem anderen Gerät geändert': 'entries.conflict',
  '"ifSeq" fehlt': 'request.missingField',
  '"ifSeq" muss eine ganze Zahl sein': 'request.invalidField',
  'Nicht angemeldet': 'auth.notLoggedIn',
  'Zu viele Änderungen in kurzer Zeit': 'request.writeBudget',
  'Ungültiger Datensatz': 'request.badBlob',
  'Speicherlimit erreicht': 'entries.familyFull',
};

/** A settings.feed_id: the random 32-hex token that names one server database. */
const newFeed = () => randomEid();

/** The server: one family's rows with per-family seq, exactly like entries.php. */
function fakeServer() {
  const rows = new Map();
  let seq = 0;
  const next = () => ++seq;
  const calls = [];
  /** Test hook awaited at the start of every call: hold a request on the
   *  wire (a gate) or let "the partner" touch a row right before it lands. */
  const hook = async (method, path, body) => {
    if (server.hook) await server.hook(method, path, body);
  };
  const json = (r) => ({
    eid: r.eid,
    seq: r.seq,
    blob: r.blob,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    deletedAt: r.deletedAt,
    ...r.smuggled, // what a tampering server adds to the row JSON (tests only)
  });
  const live = (eid) => {
    const r = rows.get(eid);
    if (!r || r.deletedAt != null) throw httpError(404, 'Eintrag nicht gefunden');
    return r;
  };
  const server = {
    rows,
    calls,
    offline: false,
    lose: false, // the next write lands on the server, but its answer is lost on the way back
    hook: null,
    feed: newFeed(),
    get maxSeq() {
      return seq;
    },
    /** Seed an encrypted row (blob); `smuggled` = extra fields a tampering server puts into its JSON. */
    put({ eid = randomEid(), blob = null, deletedAt = null, smuggled = null }) {
      const r = { eid, seq: next(), blob, createdAt: TODAY, updatedAt: TODAY, deletedAt, smuggled };
      rows.set(eid, r);
      return r;
    },
    /** "The partner edited it": the row moves to a new seq, content unchanged. */
    touch(eid) {
      const r = rows.get(eid);
      r.seq = next();
      r.updatedAt = TODAY;
      return r;
    },
    /** Replace the database (a restored backup): rows gone, seq restarts;
     *  with newFeed the restore also re-ran the migration (a fresh feed id). */
    reset({ newFeed: fresh = false } = {}) {
      rows.clear();
      seq = 0;
      if (fresh) server.feed = newFeed();
    },
    api: {
      async get(path, opts) {
        calls.push(['GET', path, opts]);
        await hook('GET', path);
        if (server.offline) throw new Error('Keine Verbindung zum Server');
        const m = /^api\/sync\?since=(\d+)&limit=(\d+)$/.exec(path);
        if (!m) throw httpError(404, 'Nicht gefunden');
        const since = Number(m[1]);
        const limit = Math.max(1, Math.min(1000, Number(m[2])));
        const feed = server.feed === null ? {} : { feed: server.feed };
        if (since > seq) {
          return { serverNow: NOW, rows: [], next: null, reset: true, ...feed };
        }
        const page = [...rows.values()]
          .filter((r) => r.seq > since && (since !== 0 || r.deletedAt == null))
          .sort((a, b) => a.seq - b.seq)
          .slice(0, limit)
          .map(json);
        return {
          serverNow: NOW,
          rows: page,
          next: page.length === limit ? page[page.length - 1].seq : null,
          ...feed,
          ...(server.art === undefined ? {} : { art: server.art }), // members of the artwork family only
        };
      },
      async post(path, body) {
        calls.push(['POST', path, body]);
        await hook('POST', path, body);
        if (server.offline) throw new Error('Keine Verbindung zum Server');
        if (path === 'api/entries') {
          if (rows.has(body.eid)) throw httpError(409, 'Eintrag existiert bereits');
          const res = json(server.put({ eid: body.eid, blob: body.blob }));
          if (server.lose) {
            server.lose = false;
            throw new Error('Keine Verbindung zum Server');
          }
          return res;
        }
        const m = /^api\/entries\/([0-9a-f]{32})\/restore$/.exec(path);
        if (m) {
          const r = rows.get(m[1]);
          if (!r || r.deletedAt == null) throw httpError(404, 'Eintrag nicht gefunden');
          r.deletedAt = null;
          r.updatedAt = TODAY;
          r.seq = next();
          return json(r);
        }
        throw httpError(404, 'Nicht gefunden');
      },
      async patch(path, body) {
        calls.push(['PATCH', path, body]);
        await hook('PATCH', path, body);
        if (server.offline) throw new Error('Keine Verbindung zum Server');
        const m = /^api\/entries\/([0-9a-f]{32})$/.exec(path);
        const r = live(m[1]);
        if (!Number.isInteger(body.ifSeq)) throw httpError(400, '"ifSeq" fehlt');
        if (r.seq !== body.ifSeq) {
          throw httpError(409, 'Der Eintrag wurde inzwischen auf einem anderen Gerät geändert');
        }
        r.blob = body.blob;
        r.smuggled = null;
        r.seq = next();
        r.updatedAt = TODAY;
        if (server.lose) {
          server.lose = false;
          throw new Error('Keine Verbindung zum Server');
        }
        return json(r);
      },
      /** DELETE with an optional JSON body {ifSeq}: compare-and-set like PATCH. */
      async del(path, body) {
        calls.push(['DELETE', path, body]);
        await hook('DELETE', path, body);
        if (server.offline) throw new Error('Keine Verbindung zum Server');
        const m = /^api\/entries\/([0-9a-f]{32})$/.exec(path);
        const r = live(m[1]);
        if (body !== undefined && body !== null && 'ifSeq' in body) {
          if (!Number.isInteger(body.ifSeq)) throw httpError(400, '"ifSeq" muss eine ganze Zahl sein');
          if (r.seq !== body.ifSeq) {
            throw httpError(409, 'Der Eintrag wurde inzwischen auf einem anderen Gerät geändert');
          }
        }
        r.deletedAt = TODAY;
        r.updatedAt = TODAY;
        r.seq = next();
        return json(r);
      },
    },
  };
  return server;
}

/** In-memory stand-in for db.js (same seq guard, same meta semantics). */
function fakeDb() {
  const rows = new Map();
  const meta = new Map();
  const db = {
    rows,
    meta,
    broken: false,
    /** A promise putRows awaits AFTER writing: a page whose IndexedDB
     *  transaction is still committing (real IDB serialises it before a
     *  clearAll issued later, so the write itself lands first). */
    commitGate: null,
    check() {
      if (db.broken) throw new Error('Lokaler Speicher nicht verfügbar');
    },
    async getAllRows() {
      db.check();
      return [...rows.values()];
    },
    async putRows(list, cursor) {
      db.check();
      for (const r of list) db.putIfNewer(r);
      if (cursor !== undefined) meta.set('cursor', cursor);
      if (db.commitGate) await db.commitGate;
    },
    putIfNewer(r) {
      const ex = rows.get(r.eid);
      if (!ex || Number(ex.seq) < Number(r.seq)) rows.set(r.eid, { ...r });
    },
    async putRow(r) {
      db.check();
      db.putIfNewer(r);
    },
    async deleteRows(eids) {
      db.check();
      for (const e of eids) rows.delete(e);
    },
    async clearRows() {
      db.check();
      rows.clear();
    },
    async getMeta(k) {
      db.check();
      return meta.get(k);
    },
    async setMeta(k, v) {
      db.check();
      meta.set(k, v);
    },
    async deleteMeta(k) {
      db.check();
      meta.delete(k);
    },
    async clearAll() {
      db.check();
      rows.clear();
      meta.clear();
    },
    // The outbox lives in meta under 'op:…' keys (db.js).
    async getAllOps() {
      db.check();
      return [...meta.entries()]
        .filter(([k]) => typeof k === 'string' && k.startsWith('op:'))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => ({ ...v, key: k }));
    },
    async putOps(list, deleteKeys = []) {
      db.check();
      for (const k of deleteKeys) meta.delete(k);
      for (const { key, ...v } of list) meta.set(key, JSON.parse(JSON.stringify(v)));
    },
    async deleteOps(keys) {
      return db.putOps([], keys);
    },
    async confirmOp(row, key) {
      db.check();
      if (row) db.putIfNewer(row);
      if (key) meta.delete(key);
    },
    /** The outbox records as stored (tests: no plaintext in there). */
    ops() {
      return [...meta.entries()].filter(([k]) => k.startsWith('op:')).map(([k, v]) => ({ key: k, ...v }));
    },
  };
  return db;
}

function fakeKeys(initial = null) {
  let key = initial;
  const log = [];
  return {
    log,
    get key() {
      return key;
    },
    async loadFdk() {
      log.push('load');
      return key;
    },
    async storeFdk(raw) {
      key = await importFdk(raw, false);
      raw.fill(0);
      log.push('store');
      return key;
    },
    async forgetFdk() {
      key = null;
      log.push('forget');
    },
  };
}

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
  };
}

/** One phone: a store over the shared server with its own mirror, key store and prefs. */
function phone(server, opts = {}) {
  const storage = opts.storage || memStorage();
  const db = opts.db || fakeDb();
  const keys = opts.keys || fakeKeys(opts.key || null);
  const prefs = createPrefs(storage);
  prefs.user = {
    username: opts.username || 'mama',
    familyId: FAMILY,
    familyName: 'Test',
    displayName: opts.displayName || 'Mama',
    kdf: { salt: 'AAAAAAAAAAAAAAAAAAAAAA', iter: 600000 },
  };
  prefs.authed = true;
  const toasts = [];
  const skews = [];
  const events = [];
  const store = createStore({
    api: server.api,
    db,
    keys,
    prefs,
    storage,
    toast: (m) => toasts.push(m),
    setClockSkew: (ms) => skews.push(ms),
    nowMs: () => NOW_MS,
    yieldToLoop: () => Promise.resolve(),
    isOnline: () => !server.offline, // the phone's own radio, as navigator.onLine would say
    settleWaitMs: opts.settleWaitMs,
    locks: null,
  });
  store.subscribe((snap, changed) => events.push(changed));
  return { store, prefs, db, keys, storage, toasts, skews, events };
}

/** Bind the identity (as session.finishSession does), unlock with the raw key and wait for the first sync. */
async function online(p, fdkRaw) {
  await p.store.setIdentity(p.prefs.user);
  await p.store.unlockWith(new Uint8Array(fdkRaw));
  await p.store.refresh();
  return p;
}

/** Wait (up to ~1 s) for a detached follow-up (the duplicate delete). */
async function until(cond) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition never met');
}

async function rejects(promise, message, status) {
  let caught = null;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, `expected rejection "${message}"`);
  assert.equal(caught.message, message);
  if (status !== undefined) assert.equal(caught.status, status);
  return caught;
}

const entry = (over = {}) => ({
  eid: over.eid || randomEid(),
  rev: 1,
  type: 'diaper',
  startedAt: minus(30),
  endedAt: null,
  details: { kind: 'pee' },
  loggedBy: 'Mama',
  ...over,
});

let FDK_RAW;
let FDK;
test.before(async () => {
  FDK_RAW = await generateFdkRaw();
  FDK = await importFdk(FDK_RAW, false);
});

const seal = (plain) => encryptEntry(FDK, FAMILY, plain);

async function seed(server, plain) {
  return server.put({ eid: plain.eid, blob: await seal(plain) });
}

// --- boot / key state -------------------------------------------------------------------

test('boot without a stored key ends locked; unlockWith makes it ready and syncs', async () => {
  const server = fakeServer();
  await seed(server, entry({ type: 'sleep', details: {}, startedAt: minus(20), endedAt: null }));
  const p = phone(server);
  assert.equal(p.store.keyState, 'none');
  assert.equal(await p.store.boot(), 'locked');
  assert.equal(p.store.snapshot, null);
  assert.equal(await p.store.refresh(), null); // no-op while locked
  assert.equal(p.db.meta.get('identity'), 'mama');

  await online(p, FDK_RAW);
  assert.equal(p.store.keyState, 'ready');
  const snap = p.store.snapshot;
  assert.deepEqual(Object.keys(snap.data), [
    'serverNow',
    'openTimers',
    'lastByType',
    'lastFeed',
    'lastMeal',
    'lastNursingMeal',
    'familySettings',
    'reminders',
    'todos',
    'today',
    'recentMedicationNames',
  ]);
  assert.equal(snap.data.openTimers.length, 1);
  assert.equal(snap.data.openTimers[0].type, 'sleep');
  assert.equal(snap.data.today.sleepMinutes, 20);
  assert.equal(p.store.cursor, 1);
  assert.equal(p.db.meta.get('cursor'), 1);
  assert.equal(p.db.rows.size, 1);
  assert.equal(p.skews.length, 1, 'serverNow fed the clock skew once');
  assert.ok(Number.isFinite(p.skews[0]));
  assert.ok(JSON.parse(p.storage.getItem('bt.state')).data.openTimers.length === 1, 'snapshot cached');
  assert.equal(p.storage.getItem('bt.identity'), 'mama');
});

test('boot from the mirror paints before the network and survives an offline sync', async () => {
  const server = fakeServer();
  const a = await seed(server, entry({ startedAt: minus(90) }));
  const b = await seed(server, entry({ type: 'bottle', details: { amount_ml: 90 }, startedAt: minus(10) }));
  const db = fakeDb();
  const rowOf = ({ smuggled, ...r }) => r;
  await db.putRows([rowOf(a), rowOf(b)], 2);
  db.meta.set('identity', 'mama');
  server.offline = true;

  const p = phone(server, { db, key: FDK });
  const state = await p.store.boot();
  assert.equal(state, 'ready');
  await p.store.ready;
  assert.equal(p.store.snapshot.data.lastFeed.eid, b.eid);
  assert.equal(p.store.snapshot.data.lastByType.diaper.eid, a.eid);
  assert.equal(p.store.cursor, 2);
  await rejects(p.store.refresh(), 'Keine Verbindung zum Server');
  assert.equal(p.store.lastError.message, 'Keine Verbindung zum Server');
  assert.ok(p.store.snapshot, 'the local state stays');

  server.offline = false;
  await p.store.refresh();
  assert.equal(p.store.lastError, null);
  // The sync asked from the mirror's cursor, not from 0.
  assert.equal(server.calls.filter((c) => c[0] === 'GET').pop()[1], 'api/sync?since=2&limit=1000');
});

test('a stored key that decrypts nothing is dropped: locked, forgetFdk called', async () => {
  const server = fakeServer();
  const other = await importFdk(await generateFdkRaw(), false);
  const e = entry();
  const r = server.put({ eid: e.eid, blob: await encryptEntry(other, FAMILY, e) });
  const db = fakeDb();
  await db.putRows([{ ...r }], 1);
  db.meta.set('identity', 'mama');
  const keys = fakeKeys(FDK);
  const p = phone(server, { db, keys });
  assert.equal(await p.store.boot(), 'locked');
  assert.deepEqual(keys.log, ['load', 'forget']);

  // Unlocking with the (same, right for this family but wrong for the row)
  // key never locks again — the row is counted instead.
  await online(p, FDK_RAW);
  assert.equal(p.store.keyState, 'ready');
  assert.equal(p.store.decryptErrors, 1);
  assert.equal(p.store.snapshot.data.lastByType.diaper, null);
});

test('identity mismatch wipes the mirror, the key and the cached snapshot', async () => {
  const server = fakeServer();
  const db = fakeDb();
  db.rows.set('x', { eid: 'x', seq: 1 });
  db.meta.set('identity', 'papa');
  db.meta.set('cursor', 1);
  const storage = memStorage();
  storage.setItem('bt.identity', 'papa');
  storage.setItem('bt.state', JSON.stringify({ ts: 1, data: { openTimers: [{ eid: 'x' }] } }));
  const keys = fakeKeys(FDK);
  const p = phone(server, { db, keys, storage, username: 'mama' });
  assert.equal(p.store.snapshot, null, 'another account snapshot never paints');
  assert.equal(await p.store.boot(), 'locked');
  assert.equal(db.rows.size, 0);
  assert.equal(db.meta.get('cursor'), undefined);
  assert.equal(db.meta.get('identity'), 'mama');
  assert.equal(storage.getItem('bt.state'), null);
  assert.equal(storage.getItem('bt.identity'), 'mama');
});

test('a snapshot stamped by an older shell (v < SNAPSHOT_V) never paints', () => {
  // The home view reads lastMeal / today.meals / todos unguarded; the v4
  // cache of the previous shell has no todos. It is dropped, not painted.
  const storage = memStorage();
  storage.setItem('bt.identity', 'mama');
  storage.setItem(
    'bt.state',
    JSON.stringify({ v: 4, ts: 1, data: { openTimers: [], lastFeed: null, lastMeal: null, today: { feeds: 0, meals: 0 } } })
  );
  const p = phone(fakeServer(), { storage });
  assert.equal(p.store.snapshot, null);
  assert.equal(storage.getItem('bt.state'), null);
  // The current stamp paints.
  const fresh = memStorage();
  fresh.setItem('bt.identity', 'mama');
  fresh.setItem(
    'bt.state',
    JSON.stringify({ v: 5, ts: 1, data: { openTimers: [], lastFeed: null, lastMeal: null, todos: { today: [], tomorrow: [] }, today: { feeds: 0, meals: 0 } } })
  );
  assert.equal(phone(fakeServer(), { storage: fresh }).store.snapshot.data.today.meals, 0);
});

test("a mirror without an identity stamp is nobody's: wiped (key included) on the first bind", async () => {
  const server = fakeServer();
  const db = fakeDb();
  db.rows.set('x', { eid: 'x', seq: 1 });
  db.meta.set('cursor', 1);
  const keys = fakeKeys(FDK);
  const p = phone(server, { db, keys });
  assert.equal(await p.store.boot(), 'locked');
  assert.equal(db.rows.size, 0);
  assert.equal(db.meta.get('cursor'), undefined);
  assert.equal(db.meta.get('identity'), 'mama');
  assert.deepEqual(keys.log, ['forget', 'load'], 'the key went with the rows');

  // An EMPTY unstamped mirror is simply fresh: the stored key stays usable.
  const clean = phone(server, { db: fakeDb(), key: FDK });
  assert.equal(await clean.store.boot(), 'ready');
  assert.equal(clean.db.meta.get('identity'), 'mama');
});

test('setIdentity for the same user keeps everything', async () => {
  const server = fakeServer();
  await seed(server, entry());
  const p = await online(phone(server), FDK_RAW);
  await p.store.setIdentity({ username: 'Mama', familyId: FAMILY, familyName: 'Test' });
  assert.equal(p.store.keyState, 'ready');
  assert.equal(p.db.rows.size, 1);
});

// --- sync -----------------------------------------------------------------------------

test('sync pages through `next`, advances the cursor only from pages, skips known seqs', async () => {
  const server = fakeServer();
  for (let i = 0; i < 1003; i++) {
    await seed(server, entry({ startedAt: minus(2000 - i) }));
  }
  const p = await online(phone(server), FDK_RAW);
  const gets = server.calls.filter((c) => c[0] === 'GET').map((c) => c[1]);
  assert.deepEqual(gets, ['api/sync?since=0&limit=1000', 'api/sync?since=1000&limit=1000']);
  assert.equal(server.calls[0][2].timeoutMs, 60000);
  assert.equal(p.store.cursor, 1003);
  assert.equal(p.db.rows.size, 1003);
  assert.equal(p.store.snapshot.data.today.diapers, 0); // all older than today
  assert.equal(p.store.entries.range('2026-08-30', '2026-09-01').length, 1003);

  const created = await p.store.entries.create({ type: 'diaper', details: { kind: 'poop' } });
  assert.equal(created.seq, 1004);
  assert.equal(p.store.cursor, 1003, 'own writes never move the cursor');
  assert.equal(p.db.rows.get(created.eid).seq, 1004);
  p.events.length = 0;
  await p.store.refresh();
  assert.equal(p.store.cursor, 1004);
  assert.deepEqual(p.events, [false], 'the re-fetched own row changes nothing');
});

test('artVersion: unknown before the first page, the page\'s `art` after it, null without the key, junk ignored', async () => {
  const server = fakeServer();
  const p = phone(server);
  assert.equal(p.store.artVersion, undefined, 'no sync has answered yet');
  await online(p, FDK_RAW);
  assert.equal(p.store.artVersion, null, 'a page without the key: no artwork for this family');
  server.art = '0a1b2c3d4e5f';
  await p.store.refresh();
  assert.equal(p.store.artVersion, '0a1b2c3d4e5f');
  server.art = '../../etc/passwd';
  await p.store.refresh();
  assert.equal(p.store.artVersion, null, 'only a hex version counts');
});

test('tombstones arrive on later syncs; since=0 omits them', async () => {
  const server = fakeServer();
  const a = await seed(server, entry());
  const b = await seed(server, entry({ startedAt: minus(5) }));
  const p1 = await online(phone(server), FDK_RAW);
  const p2 = await online(phone(server, { username: 'papa' }), FDK_RAW);
  await p1.store.entries.remove(b.eid);
  assert.equal(p2.store.snapshot.data.lastByType.diaper.eid, b.eid);
  await p2.store.refresh();
  assert.equal(p2.store.snapshot.data.lastByType.diaper.eid, a.eid);
  assert.equal(p2.store.entries.get(b.eid).deletedAt, TODAY);

  const fresh = await online(phone(server, { username: 'oma' }), FDK_RAW);
  assert.equal(fresh.store.entries.get(b.eid), null, 'a fresh client never sees the tombstone');
  assert.equal(fresh.store.cursor, 1, 'the cursor is the last row of the page, tombstones omitted');
  await fresh.store.refresh();
  assert.equal(fresh.store.cursor, 3, 'the next sync passes the tombstone');
  assert.equal(fresh.store.entries.get(b.eid).deletedAt, TODAY);
  assert.equal(fresh.store.exportPlain().filter((e) => e.deleted).length, 1);
});

test('reset:true wipes rows + cursor and refetches', async () => {
  const server = fakeServer();
  const old = await seed(server, entry());
  await seed(server, entry({ startedAt: minus(31) }));
  await seed(server, entry({ startedAt: minus(32) }));
  const p = await online(phone(server), FDK_RAW);
  assert.equal(p.store.cursor, 3);

  // A restored backup: fewer rows, the seq counter restarted below our cursor.
  server.reset();
  const fresh = await seed(server, entry({ type: 'sleep', details: {}, startedAt: minus(3), endedAt: null }));
  await p.store.refresh();
  assert.equal(p.store.entries.get(old.eid), null);
  assert.equal(p.store.entries.get(fresh.eid).type, 'sleep');
  assert.equal(p.store.cursor, 1);
  assert.equal(p.db.rows.size, 1);
  assert.equal(p.db.meta.get('cursor'), 1);
});

test('a page from another server database (feed) wipes rows + cursor and refetches – without reset:true', async () => {
  const server = fakeServer();
  const old = await seed(server, entry());
  await seed(server, entry({ startedAt: minus(31) }));
  const p = await online(phone(server), FDK_RAW);
  assert.equal(p.store.cursor, 2);
  assert.equal(p.db.meta.get('feed'), server.feed, 'the first page stamped the mirror');

  // A restored backup that re-ran the migration and holds MORE rows than our
  // cursor: since=2 is a seq it knows, so reset:true never fires — only the
  // feed tells that our rows and cursor belong to another database.
  const oldFeed = server.feed;
  server.reset({ newFeed: true });
  assert.notEqual(server.feed, oldFeed);
  const a = await seed(server, entry({ type: 'bottle', details: { amount_ml: 50 }, startedAt: minus(9) }));
  await seed(server, entry({ type: 'bottle', details: { amount_ml: 60 }, startedAt: minus(8) }));
  const c = await seed(server, entry({ type: 'bottle', details: { amount_ml: 70 }, startedAt: minus(7) }));
  await p.store.refresh();
  assert.equal(p.store.entries.get(old.eid), null, 'the old rows are gone');
  assert.equal(p.store.entries.range(TODAY, TODAY).length, 3, 'three fresh rows');
  assert.equal(p.store.entries.get(a.eid).details.amount_ml, 50);
  assert.equal(p.store.snapshot.data.lastFeed.eid, c.eid);
  assert.equal(p.store.cursor, 3);
  assert.equal(p.db.rows.size, 3);
  assert.equal(p.db.meta.get('cursor'), 3);
  assert.equal(p.db.meta.get('feed'), server.feed, 'the mirror follows the new database');
  const gets = server.calls.filter((x) => x[0] === 'GET').map((x) => x[1]);
  assert.deepEqual(gets.slice(-2), ['api/sync?since=2&limit=1000', 'api/sync?since=0&limit=1000']);

  // The feed survives a boot from the mirror: a second change is caught too.
  const p2 = phone(server, { db: p.db, storage: p.storage, key: FDK });
  assert.equal(await p2.store.boot(), 'ready');
  await p2.store.ready;
  assert.equal(p2.store.cursor, 3);
  server.reset({ newFeed: true });
  const only = await seed(server, entry({ type: 'weight', details: { grams: 4000 }, startedAt: minus(1) }));
  await p2.store.refresh();
  assert.equal(p2.store.entries.get(c.eid), null);
  assert.equal(p2.store.entries.get(only.eid).type, 'weight');
  assert.equal(p2.store.cursor, 1);
  assert.equal(p2.db.meta.get('feed'), server.feed);

  // A server that names no feed (an older API) changes nothing.
  server.feed = null;
  await seed(server, entry({ startedAt: minus(2) }));
  await p2.store.refresh();
  assert.equal(p2.store.cursor, 2);
  assert.equal(p2.store.entries.get(only.eid).type, 'weight');
});

test('rows that fail to decrypt are counted and skipped, never fatal', async () => {
  const server = fakeServer();
  const other = await importFdk(await generateFdkRaw(), false);
  const bad = entry({ startedAt: minus(1) });
  server.put({ eid: bad.eid, blob: await encryptEntry(other, FAMILY, bad) });
  server.put({ eid: randomEid(), blob: 'AQ' }); // garbage
  const good = await seed(server, entry({ startedAt: minus(2) }));
  const p = await online(phone(server), FDK_RAW);
  assert.equal(p.store.decryptErrors, 2);
  assert.equal(p.store.snapshot.data.lastByType.diaper.eid, good.eid);
  assert.equal(p.store.entries.get(bad.eid).error, 'Entschlüsselung fehlgeschlagen');
  assert.equal(p.store.exportPlain().length, 1);
});

test('a blob with a lower rev than the known one is a rollback and rejected', async () => {
  const server = fakeServer();
  const e = entry({ rev: 3 });
  const r = await seed(server, e);
  const p = await online(phone(server), FDK_RAW);
  assert.equal(p.store.entries.get(e.eid).rev, 3);
  // The server "moves" the row to an older blob under a new seq.
  r.blob = await seal({ ...e, rev: 2 });
  r.seq = 99;
  await p.store.refresh();
  assert.equal(p.store.entries.get(e.eid).error, 'Datensatz ist älter als der bekannte Stand');
  assert.equal(p.store.decryptErrors, 1);
});

// --- writes ---------------------------------------------------------------------------

test('create validates, sets loggedBy, applies the returned seq', async () => {
  const server = fakeServer();
  const p = await online(phone(server, { displayName: 'Mami' }), FDK_RAW);
  await rejects(p.store.entries.create({ type: 'diaper', details: {} }), '"details.kind" muss "pee", "poop" oder "both" sein', 400);
  await rejects(
    p.store.entries.create({ type: 'diaper', details: { kind: 'pee' }, startedAt: '2026-09-01T10:30:00Z' }),
    'Der Zeitpunkt liegt in der Zukunft',
    400
  );
  const e = await p.store.entries.create({ type: 'bottle', details: { amount_ml: 90 } });
  assert.equal(e.loggedBy, 'Mami');
  assert.equal(e.startedAt, NOW);
  assert.equal(e.seq, 1);
  assert.equal(e.rev, 1);
  assert.match(e.eid, /^[0-9a-f]{32}$/);
  assert.equal(p.store.snapshot.data.lastFeed.eid, e.eid);
  assert.equal(p.store.snapshot.data.today.feeds, 1);
  assert.ok(server.rows.get(e.eid).blob, 'the server holds only a blob');
  assert.equal(server.calls.filter((c) => c[0] === 'POST').length, 1);
  assert.deepEqual(Object.keys(server.calls.find((c) => c[0] === 'POST')[2]), ['eid', 'blob']);
});

test('one open timer per type: create, reopen, restore', async () => {
  const server = fakeServer();
  const p = await online(phone(server), FDK_RAW);
  const s1 = await p.store.entries.create({ type: 'sleep' });
  await rejects(p.store.entries.create({ type: 'sleep' }), 'Es läuft bereits ein Schlaf-Timer', 409);
  const s0 = await p.store.entries.create({ type: 'sleep', startedAt: minus(120), endedAt: minus(60) });
  await rejects(p.store.entries.update(s0.eid, { endedAt: null }), 'Es läuft bereits ein Schlaf-Timer', 409);
  // The running one may be edited without tripping over itself.
  const moved = await p.store.entries.update(s1.eid, { startedAt: minus(2) });
  assert.equal(moved.endedAt, null);
  assert.equal(moved.rev, 2);

  await p.store.entries.remove(s1.eid);
  const s2 = await p.store.entries.create({ type: 'sleep' });
  await rejects(p.store.entries.restore(s1.eid), 'Es läuft bereits ein Schlaf-Timer', 409);
  await p.store.entries.remove(s2.eid);
  const back = await p.store.entries.restore(s1.eid);
  assert.equal(back.deletedAt, null);
  assert.equal(p.store.snapshot.data.openTimers[0].eid, s1.eid);
  assert.equal(server.calls.filter((c) => c[0] === 'POST' && c[1].endsWith('/restore')).length, 1);
});

test('stop with a precondition survives the partner editing the start (409 → sync → retry)', async () => {
  const server = fakeServer();
  const a = await online(phone(server), FDK_RAW);
  const b = await online(phone(server, { username: 'papa', displayName: 'Papa' }), FDK_RAW);
  const started = await a.store.entries.create({ type: 'breastfeed', details: { side: 'L' }, startedAt: minus(15) });
  await b.store.refresh();
  // B corrects the start time; A still holds seq 1.
  await b.store.entries.update(started.eid, { startedAt: minus(20) });
  assert.equal(a.store.entries.get(started.eid).seq, 1);

  const closed = await a.store.entries.update(
    started.eid,
    { endedAt: NOW },
    { precondition: (row) => row.endedAt === null }
  );
  assert.equal(closed.startedAt, minus(20), "B's edit is preserved");
  assert.equal(closed.endedAt, NOW);
  assert.equal(closed.rev, 3);
  assert.equal(closed.loggedBy, 'Mama', 'never re-authored');
  const patches = server.calls.filter((c) => c[0] === 'PATCH');
  assert.equal(patches.length, 3);
  assert.equal(patches[1][2].ifSeq, 1, 'first attempt with the stale seq');
  assert.equal(patches[2][2].ifSeq, 2, 'retry with the fresh seq');
  // A single retry, no more: the server row now has seq 3.
  assert.equal(server.rows.get(started.eid).seq, 3);
  assert.equal(a.store.entries.get(started.eid).seq, 3);
});

test('stop after the partner already stopped: "Der Timer wurde bereits beendet"', async () => {
  const server = fakeServer();
  const a = await online(phone(server), FDK_RAW);
  const b = await online(phone(server, { username: 'papa' }), FDK_RAW);
  const s = await a.store.entries.create({ type: 'sleep', startedAt: minus(40) });
  await b.store.refresh();
  await b.store.entries.update(s.eid, { endedAt: minus(1) });
  await rejects(
    a.store.entries.update(s.eid, { endedAt: NOW }, { precondition: (row) => row.endedAt === null }),
    'Der Timer wurde bereits beendet',
    409
  );
  assert.equal(a.store.entries.get(s.eid).endedAt, minus(1), 'the sync brought the real end');
  assert.equal(server.rows.get(s.eid).seq, 2, 'nothing was written');
});

test('a precondition is checked on the local row first: no PATCH when a sync already brought the end', async () => {
  const server = fakeServer();
  const a = await online(phone(server), FDK_RAW);
  const b = await online(phone(server, { username: 'papa' }), FDK_RAW);
  const s = await a.store.entries.create({ type: 'sleep', startedAt: minus(40) });
  await b.store.refresh();
  await b.store.entries.update(s.eid, { endedAt: minus(1) });
  await a.store.refresh(); // the partner's end lands BEFORE the tap on "Beenden"
  const before = server.calls.length;
  await rejects(
    a.store.entries.update(s.eid, { endedAt: NOW }, { precondition: (row) => row.endedAt === null }),
    'Der Timer wurde bereits beendet',
    409
  );
  assert.equal(server.calls.length, before, 'neither a PATCH nor a sync – decided locally');
  assert.equal(a.store.entries.get(s.eid).endedAt, minus(1), 'the partner\'s end stands');
  assert.equal(server.rows.get(s.eid).seq, 2);
});

test('a server 404 on update / remove / restore syncs first, so the model shows why', async () => {
  const server = fakeServer();
  const a = await online(phone(server), FDK_RAW);
  const b = await online(phone(server, { username: 'papa' }), FDK_RAW);
  const e = await a.store.entries.create({ type: 'diaper', details: { kind: 'pee' } });
  const f = await a.store.entries.create({ type: 'diaper', details: { kind: 'poop' }, startedAt: minus(1) });
  await a.store.refresh(); // A's cursor covers its own rows (a since=0 page omits tombstones)
  assert.equal(a.store.cursor, 2);
  await b.store.refresh();
  await b.store.entries.remove(e.eid);
  await b.store.entries.remove(f.eid);
  assert.equal(a.store.entries.get(e.eid).deletedAt, null, 'A still holds both live');

  await rejects(a.store.entries.update(e.eid, { details: { kind: 'both' } }), 'Eintrag nicht gefunden', 404);
  assert.equal(a.store.entries.get(e.eid).deletedAt, TODAY, 'the sync brought the tombstone');
  await rejects(a.store.entries.remove(f.eid), 'Eintrag nicht gefunden', 404);
  assert.equal(a.store.entries.get(f.eid).deletedAt, TODAY);

  // The partner restores f; our restore of the same tombstone is a 404 — and
  // the sync makes it live again here.
  await b.store.entries.restore(f.eid);
  await rejects(a.store.entries.restore(f.eid), 'Eintrag nicht gefunden', 404);
  assert.equal(a.store.entries.get(f.eid).deletedAt, null);
  assert.equal(a.store.entries.get(f.eid).seq, server.rows.get(f.eid).seq);

  // Offline during that sync: the 404 still surfaces (the sync error is swallowed).
  const g = await a.store.entries.create({ type: 'diaper', details: { kind: 'pee' }, startedAt: minus(2) });
  await a.store.refresh();
  await b.store.refresh();
  await b.store.entries.remove(g.eid);
  server.hook = async (m) => {
    if (m === 'GET') server.offline = true;
  };
  await rejects(a.store.entries.update(g.eid, { details: { kind: 'both' } }), 'Eintrag nicht gefunden', 404);
  server.hook = null;
  server.offline = false;
  assert.equal(a.store.entries.get(g.eid).deletedAt, null, 'still unknown here until the next sync');
});

test('edit form (explicit ifSeq, no precondition) gets the plain 409', async () => {
  const server = fakeServer();
  const a = await online(phone(server), FDK_RAW);
  const b = await online(phone(server, { username: 'papa' }), FDK_RAW);
  const e = await a.store.entries.create({ type: 'weight', details: { grams: 3500 } });
  await b.store.refresh();
  await b.store.entries.update(e.eid, { details: { grams: 3600 } });
  await rejects(
    a.store.entries.update(e.eid, { details: { grams: 3550 } }, { ifSeq: 1 }),
    'Der Eintrag wurde inzwischen auf einem anderen Gerät geändert',
    409
  );
  assert.equal(a.store.entries.get(e.eid).details.grams, 3600, 'the model was refreshed');
  // Reopened with the fresh seq the edit goes through.
  const ok = await a.store.entries.update(e.eid, { details: { grams: 3550 } }, { ifSeq: 2 });
  assert.equal(ok.details.grams, 3550);
});

test('update: missing/deleted rows are 404s; the type is immutable; ifOpen still works locally', async () => {
  const server = fakeServer();
  const p = await online(phone(server), FDK_RAW);
  await rejects(p.store.entries.update(randomEid(), { details: {} }), 'Eintrag nicht gefunden', 404);
  const e = await p.store.entries.create({ type: 'sleep', startedAt: minus(30), endedAt: minus(10) });
  await rejects(p.store.entries.update(e.eid, { type: 'bottle' }), 'Der Typ eines Eintrags kann nicht geändert werden', 400);
  await rejects(p.store.entries.update(e.eid, { endedAt: NOW, ifOpen: true }), 'Der Timer wurde bereits beendet', 409);
  await p.store.entries.remove(e.eid);
  await rejects(p.store.entries.update(e.eid, { details: {} }), 'Eintrag nicht gefunden', 404);
  await rejects(p.store.entries.remove(e.eid), 'Eintrag nicht gefunden', 404);
  assert.equal(server.calls.filter((c) => c[0] === 'PATCH').length, 0, 'local rejections never hit the server');
});

test('remove/restore keep the plaintext; exportPlain flags deleted rows; range hides them', async () => {
  const server = fakeServer();
  const p = await online(phone(server), FDK_RAW);
  const e = await p.store.entries.create({ type: 'medication', details: { name: 'Vitamin D' } });
  const gone = await p.store.entries.remove(e.eid);
  assert.equal(gone.deletedAt, TODAY);
  assert.equal(gone.details.name, 'Vitamin D');
  assert.equal(p.store.entries.range(TODAY, TODAY).length, 0);
  assert.deepEqual(p.store.snapshot.data.recentMedicationNames, []);
  const exp = p.store.exportPlain();
  assert.equal(exp.length, 1);
  assert.equal(exp[0].deleted, true);
  assert.equal(exp[0].details.name, 'Vitamin D');
  const back = await p.store.entries.restore(e.eid);
  assert.equal(back.deletedAt, null);
  assert.equal(back.seq, 3);
  assert.deepEqual(p.store.snapshot.data.recentMedicationNames, ['Vitamin D']);
  assert.equal(p.store.exportPlain()[0].deleted, false);
});

test('writes while locked are refused', async () => {
  const p = phone(fakeServer());
  await p.store.boot();
  await rejects(p.store.entries.create({ type: 'sleep' }), 'Bitte zuerst entsperren');
});

// --- duplicate open timers ----------------------------------------------------------------

test('two open sleeps within 15 min: the higher seq is soft-deleted with a toast, once', async () => {
  const server = fakeServer();
  const keep = await seed(server, entry({ type: 'sleep', details: {}, startedAt: minus(10), endedAt: null }));
  const dup = await seed(server, entry({ type: 'sleep', details: {}, startedAt: minus(3), endedAt: null }));
  const p = await online(phone(server), FDK_RAW);
  await until(() => server.rows.get(dup.eid).deletedAt != null);
  assert.deepEqual(p.toasts, ['Doppelter Schlaf-Timer entfernt']);
  assert.equal(p.store.notice, null);
  assert.equal(server.rows.get(keep.eid).deletedAt, null);
  await p.store.refresh();
  assert.equal(p.store.snapshot.data.openTimers.length, 1);
  assert.equal(p.store.snapshot.data.openTimers[0].eid, keep.eid);
  assert.deepEqual(p.toasts, ['Doppelter Schlaf-Timer entfernt'], 'no second toast');
});

test('the resolver deletes with the seen seq: a row the partner moved is left alone (409) and re-judged on the next sync', async () => {
  const server = fakeServer();
  const keep = await seed(server, entry({ type: 'sleep', details: {}, startedAt: minus(10), endedAt: null }));
  const dup = await seed(server, entry({ type: 'sleep', details: {}, startedAt: minus(3), endedAt: null }));
  // The partner edits the duplicate between our sync page and our DELETE.
  server.hook = async (m) => {
    if (m === 'DELETE') {
      server.hook = null;
      server.touch(dup.eid);
    }
  };
  const p = await online(phone(server), FDK_RAW);
  await until(() => server.calls.some((c) => c[0] === 'DELETE'));
  await new Promise((r) => setTimeout(r, 20));
  const first = server.calls.find((c) => c[0] === 'DELETE');
  assert.deepEqual(first[2], { ifSeq: 2 }, 'compare-and-set on the seq this phone saw');
  assert.equal(server.rows.get(dup.eid).deletedAt, null, 'not deleted blindly');
  assert.equal(server.rows.get(dup.eid).seq, 3);
  assert.deepEqual(p.toasts, []);
  assert.equal(p.store.entries.get(dup.eid).deletedAt, null);

  // The next sync brings the moved row — still an open duplicate — and the
  // resolver tries again with ITS seq.
  await p.store.refresh();
  await until(() => server.rows.get(dup.eid).deletedAt != null);
  const dels = server.calls.filter((c) => c[0] === 'DELETE');
  assert.equal(dels.length, 2);
  assert.deepEqual(dels[1][2], { ifSeq: 3 });
  assert.deepEqual(p.toasts, ['Doppelter Schlaf-Timer entfernt']);
  assert.equal(server.rows.get(keep.eid).deletedAt, null);
  await p.store.refresh();
  assert.deepEqual(p.toasts, ['Doppelter Schlaf-Timer entfernt'], 'once');
});

test('two open timers further apart: a notice, nothing deleted', async () => {
  const server = fakeServer();
  await seed(server, entry({ type: 'breastfeed', details: { side: 'L' }, startedAt: minus(60), endedAt: null }));
  const later = await seed(server, entry({ type: 'breastfeed', details: { side: 'R' }, startedAt: minus(20), endedAt: null }));
  const p = await online(phone(server), FDK_RAW);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(p.store.notice, 'Zwei Stillen-Timer offen – bitte einen im Verlauf beenden');
  assert.deepEqual(p.toasts, []);
  assert.equal(server.calls.filter((c) => c[0] === 'DELETE').length, 0);
  // Ending one clears the notice on the very next recompute.
  await p.store.entries.update(later.eid, { endedAt: NOW });
  assert.equal(p.store.notice, null);
});

// --- a server that tries to hand the phone content ---------------------------------------------

test('plaintext a server slips into the feed is never taken in: no entry, no state, nothing sent back', async () => {
  const server = fakeServer();
  const real = await seed(server, entry({ type: 'diaper', details: { kind: 'pee' }, startedAt: minus(30) }));
  const fake = { type: 'bottle', startedAt: minus(5), endedAt: null, details: { amount_ml: 500 }, loggedBy: 'Mama' };
  // A row without a blob that carries content in the clear — in every shape a client might trust.
  const bare = server.put({ smuggled: { plain: fake } });
  const flat = server.put({ smuggled: { ...fake, rev: 1 } });
  const p = await online(phone(server), FDK_RAW);

  assert.deepEqual(p.store.entries.range('2026-08-30', TODAY).map((e) => e.eid), [real.eid], 'only the decrypted entry exists');
  for (const row of [bare, flat]) {
    const held = p.store.entries.get(row.eid);
    assert.equal(held.error, 'Inhalt nicht verfügbar', 'kept as a row without content …');
    assert.deepEqual([held.type, held.startedAt, held.loggedBy, held.details], [undefined, undefined, undefined, {}], '… and with none of the smuggled fields');
  }
  assert.equal(p.store.snapshot.data.lastByType.bottle, null, 'the home screen never heard of the bottle');
  assert.equal(p.store.exportPlain().length, 1);
  assert.equal(p.store.decryptErrors, 2, 'Mehr › Konto reports two entries it could not read — the tampering shows');
  assert.deepEqual(server.calls.filter((c) => c[0] !== 'GET'), [], 'and the phone writes nothing in response');
});

// --- prefs / clear -----------------------------------------------------------------------------

test('a sync answer landing after clear() writes nothing: memory, mirror, cursor', async () => {
  const server = fakeServer();
  await seed(server, entry());
  const p = await online(phone(server), FDK_RAW);
  const late = await seed(server, entry({ startedAt: minus(5) }));

  // The page is still on the wire when the logout runs (session.logout:
  // store.clear() FIRST, then the mirror).
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  server.hook = async (m) => {
    if (m === 'GET') {
      server.hook = null;
      await gate;
    }
  };
  const pending = p.store.refresh();
  await new Promise((r) => setTimeout(r, 5));
  p.store.clear();
  await p.db.clearAll();
  release();
  await rejects(pending, 'Abgemeldet');
  assert.equal(p.store.cursor, 0);
  assert.equal(p.store.snapshot, null);
  assert.equal(p.store.entries.get(late.eid), null);
  assert.equal(p.db.rows.size, 0, 'the wiped mirror stays wiped');
  assert.equal(p.db.meta.get('cursor'), undefined);
  assert.equal(p.store.lastError, null, 'not an error of the new state');

  // Same with a page whose IndexedDB commit is still running at the logout:
  // the write lands (before the clearAll, as real IDB orders it) but the
  // cursor of the old account never becomes the new state's.
  const q = await online(phone(server, { username: 'papa' }), FDK_RAW);
  await seed(server, entry({ startedAt: minus(4) }));
  let release2;
  q.db.commitGate = new Promise((r) => {
    release2 = r;
  });
  const pending2 = q.store.refresh();
  await until(() => q.db.meta.get('cursor') === 3);
  q.db.commitGate = null;
  q.store.clear();
  await q.db.clearAll();
  release2();
  await rejects(pending2, 'Abgemeldet');
  assert.equal(q.store.cursor, 0);
  assert.equal(q.db.rows.size, 0);
  assert.equal(q.db.meta.get('cursor'), undefined);
  assert.equal(q.store.keyState, 'none');
});

test('clear() forgets memory + snapshot; a fresh boot rebuilds from the mirror', async () => {
  const server = fakeServer();
  await seed(server, entry());
  const p = await online(phone(server, { key: FDK }), FDK_RAW);
  assert.ok(p.store.snapshot);
  p.store.clear();
  assert.equal(p.store.snapshot, null);
  assert.equal(p.store.keyState, 'none');
  assert.equal(p.storage.getItem('bt.state'), null);
  assert.equal(p.store.cursor, 0);
  assert.equal(p.db.rows.size, 1, "the mirror is session.logout's to wipe");
  await rejects(p.store.entries.create({ type: 'sleep' }), 'Bitte zuerst entsperren');
  // A boot after clear() (same user) reloads the mirror with the stored key.
  assert.equal(await p.store.boot(), 'ready');
  await p.store.ready;
  assert.equal(p.store.entries.range('2026-08-30', TODAY).length, 1);
  assert.equal(p.store.cursor, 1);
});

test('createPrefs: user/authed/bottle prefs round-trip and validate', () => {
  const storage = memStorage();
  const prefs = createPrefs(storage);
  assert.equal(prefs.user, null);
  assert.equal(prefs.authed, false);
  prefs.user = { username: 'mama', familyId: 1, familyName: 'T', displayName: 'Mama', kdf: { salt: 's', iter: 600000 } };
  prefs.authed = true;
  assert.equal(prefs.user.kdf.iter, 600000);
  assert.equal(prefs.authed, true);
  assert.deepEqual(prefs.bottlePresets, [60, 90, 120]);
  prefs.bottlePresets = [1, 2];
  assert.deepEqual(prefs.bottlePresets, [60, 90, 120], 'malformed → defaults');
  prefs.bottlePresets = [50, 80, 2000];
  assert.deepEqual(prefs.bottlePresets, [60, 90, 120], 'out of range → defaults');
  prefs.bottlePresets = [50, 80, 110];
  assert.deepEqual(prefs.bottlePresets, [50, 80, 110]);
  prefs.bottlePresets = [50, 80, 110, 140];
  assert.deepEqual(prefs.bottlePresets, [50, 80, 110], 'four slots from the older version → first three');
  prefs.recommendedMl = 2000;
  assert.equal(prefs.recommendedMl, null);
  prefs.recommendedMl = 95;
  assert.equal(prefs.recommendedMl, 95);
  prefs.timerStartedAt = 123;
  assert.equal(prefs.timerStartedAt, 123);
  // Per-device switches: the home screen's fourth slot shows sleep by
  // default and the wake lock defaults on, counting «seit letzter Mahlzeit»
  // from the meal's start defaults off.
  assert.equal(prefs.homeCard, 'sleep');
  prefs.homeCard = 'reminders';
  assert.equal(prefs.homeCard, 'reminders');
  assert.equal(storage.getItem('bt.homeCard'), 'reminders');
  prefs.homeCard = 'both';
  assert.equal(prefs.homeCard, 'both');
  prefs.homeCard = 'bogus';
  assert.equal(prefs.homeCard, 'sleep');
  // The earlier on/off switch for the sleep card: off = the slot stays empty.
  storage.setItem('bt.trackSleep', '0');
  assert.equal(prefs.homeCard, 'none');
  prefs.homeCard = 'sleep';
  assert.equal(prefs.homeCard, 'sleep');
  // The charts a phone hides (Verlauf › Grafik): a list of keys, junk dropped.
  assert.deepEqual(prefs.hiddenCharts, []);
  prefs.hiddenCharts = ['sleep', 'weight', 'sleep', 7, ''];
  assert.deepEqual(prefs.hiddenCharts, ['sleep', 'weight']);
  storage.setItem('bt.hiddenCharts', '{"no":1}');
  assert.deepEqual(prefs.hiddenCharts, []);
  storage.setItem('bt.hiddenCharts', '["meals","<x>"]');
  assert.deepEqual(prefs.hiddenCharts, ['meals']);
  prefs.hiddenCharts = [];
  assert.equal(storage.getItem('bt.hiddenCharts'), null);
  assert.equal(prefs.keepAwake, true);
  assert.equal(prefs.feedFromStart, false);
  prefs.feedFromStart = true;
  assert.equal(prefs.feedFromStart, true);
  assert.equal(storage.getItem('bt.feedFromStart'), '1');
  prefs.feedFromStart = false;
  assert.equal(storage.getItem('bt.feedFromStart'), null);
  assert.equal(prefs.recoveryPending, false);
  prefs.recoveryPending = true;
  assert.equal(prefs.recoveryPending, true);
  assert.equal(storage.getItem('bt.recoveryPending'), '1');
  prefs.recoveryPending = false;
  assert.equal(prefs.recoveryPending, false);
  assert.equal(storage.getItem('bt.recoveryPending'), null);
  // The first-sign-up pointer to «Mehr › Anleitung», same shape.
  assert.equal(prefs.howtoPending, false);
  prefs.howtoPending = true;
  assert.equal(prefs.howtoPending, true);
  assert.equal(storage.getItem('bt.howtoPending'), '1');
  prefs.howtoPending = false;
  assert.equal(prefs.howtoPending, false);
  assert.equal(storage.getItem('bt.howtoPending'), null);
  prefs.user = null;
  prefs.authed = false;
  assert.equal(prefs.user, null);
  assert.equal(prefs.authed, false);
});

// --- session.js -------------------------------------------------------------------------------
//
// The real store/prefs singletons run memory-only here (no IndexedDB, no
// localStorage under node — every db.js call rejects and is tolerated), and
// api.js's `api` object is patched with an in-memory auth server that
// mirrors lib/auth.php: auth keys compared as strings instead of bcrypt.

import { api } from '../api.js';
import { store as liveStore, prefs as livePrefs } from '../store.js';
import * as session from '../session.js';
import { b64u, unb64u, randomBytes } from '../crypto.js';

function authServer(entries) {
  const users = new Map();
  const families = new Map();
  let familySeq = 0;
  const nameKey = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
  const userJson = (u) => ({ username: u.username, familyId: u.familyId, familyName: u.familyName, profileBlob: u.profileBlob });
  let current = null; // the "cookie"
  const calls = [];
  const secret = randomBytes(16);
  const requireAuth = () => {
    if (!current) throw httpError(401, 'Nicht angemeldet');
    return users.get(current);
  };
  const verifyFamily = (body) => {
    const f = families.get(nameKey(body.familyName));
    if (!f) throw httpError(404, 'Familie nicht gefunden – bitte Namen prüfen');
    if (body.familyAuthKey !== undefined) {
      if (body.familyAuthKey !== f.authKey) throw httpError(403, 'Falsches Familien-Passwort');
    } else if (body.recoveryAuthKey !== f.recoveryAuthKey) {
      throw httpError(403, 'Ungültiger Wiederherstellungscode');
    }
    return f;
  };
  const srv = {
    users,
    families,
    calls,
    get current() {
      return current;
    },
    api: {
      async get(path, opts) {
        calls.push(['GET', path]);
        let m;
        if ((m = /^api\/auth\/params\?username=(.*)$/.exec(path))) {
          const name = decodeURIComponent(m[1]).trim().toLowerCase();
          const u = users.get(name);
          if (u) return { kdf: u.kdf };
          // stable fake: derived from the name
          const fake = new Uint8Array(16);
          for (let i = 0; i < 16; i++) fake[i] = (name.charCodeAt(i % name.length) * 31 + secret[i]) & 0xff;
          return { kdf: { salt: b64u(fake), iter: 600000 } };
        }
        if ((m = /^api\/families\/check\?name=(.*)$/.exec(path))) {
          const f = families.get(nameKey(decodeURIComponent(m[1])));
          return { exists: !!f, name: f ? f.name : null, kdf: f ? f.kdf : null };
        }
        if (path === 'api/me') {
          const u = current ? users.get(current) : null;
          return { authenticated: !!u, user: u ? userJson(u) : null };
        }
        requireAuth();
        return entries.api.get(path, opts);
      },
      async post(path, body) {
        calls.push(['POST', path, body]);
        if ('password' in (body || {})) throw httpError(400, 'Neue App-Version – bitte die App schliessen und neu öffnen, dann anmelden');
        if (path === 'api/families/unlock') {
          const f = verifyFamily(body);
          return { kdf: f.kdf, fdkWrapped: f.fdkWrapped };
        }
        if (path === 'api/register') {
          const username = String(body.username).trim().toLowerCase();
          if (users.has(username)) throw httpError(409, 'Dieser Benutzername ist bereits vergeben');
          for (const k of ['authKey', 'kdf', 'profileBlob', 'familyName', 'fdkWrappedUser']) {
            if (body[k] === undefined) throw httpError(400, 'Ungültige Schlüsseldaten');
          }
          assert.equal(unb64u(body.authKey).length, 32);
          assert.equal(unb64u(body.kdf.salt).length, 16);
          assert.equal(unb64u(body.fdkWrappedUser).length, 40);
          let f;
          if (body.familyMode === 'create') {
            if (families.has(nameKey(body.familyName))) throw httpError(409, 'Familie wurde gerade angelegt – bitte nochmals versuchen');
            assert.equal(unb64u(body.fdkWrappedFamily).length, 40);
            assert.equal(unb64u(body.recoveryAuthKey).length, 32);
            f = {
              id: ++familySeq,
              name: body.familyName,
              authKey: body.familyAuthKey,
              kdf: body.familyKdf,
              fdkWrapped: body.fdkWrappedFamily,
              recoveryAuthKey: body.recoveryAuthKey,
            };
            families.set(nameKey(f.name), f);
          } else if (body.familyMode === 'join') {
            f = verifyFamily(body);
          } else {
            throw httpError(400, 'Ungültige Anfrage');
          }
          const u = {
            username,
            authKey: body.authKey,
            kdf: body.kdf,
            fdkWrapped: body.fdkWrappedUser,
            profileBlob: body.profileBlob,
            familyId: f.id,
            familyName: f.name,
          };
          users.set(username, u);
          current = username;
          return { ok: true, user: userJson(u), familyCreated: body.familyMode === 'create' };
        }
        if (path === 'api/login') {
          const u = users.get(String(body.username).trim().toLowerCase());
          if (!u || u.authKey !== body.authKey) throw httpError(401, 'Benutzername oder Passwort falsch');
          current = u.username;
          return { ok: true, user: userJson(u), kdf: u.kdf, fdkWrappedUser: srv.corruptLogin ? 'A'.repeat(54) : u.fdkWrapped };
        }
        if (path === 'api/logout') {
          current = null;
          return { ok: true };
        }
        const u = requireAuth();
        if (path === 'api/me/keys/unlock') {
          if (body.authKey !== u.authKey) throw httpError(403, 'Falsches Passwort');
          return { kdf: u.kdf, fdkWrappedUser: u.fdkWrapped };
        }
        return entries.api.post(path, body);
      },
      async patch(path, body) {
        calls.push(['PATCH', path, body]);
        const u = requireAuth();
        if (path === 'api/me') {
          u.profileBlob = body.profileBlob;
          return { ok: true, user: userJson(u) };
        }
        if (path === 'api/me/password') {
          if (body.currentAuthKey !== u.authKey) throw httpError(403, 'Falsches Passwort');
          Object.assign(u, { authKey: body.authKey, kdf: body.kdf, fdkWrapped: body.fdkWrappedUser });
          return { ok: true };
        }
        if (path === 'api/families/password') {
          if (body.currentAuthKey !== u.authKey) throw httpError(403, 'Falsches Passwort');
          const f = [...families.values()].find((x) => x.id === u.familyId);
          Object.assign(f, { authKey: body.familyAuthKey, kdf: body.familyKdf, fdkWrapped: body.fdkWrappedFamily });
          return { ok: true };
        }
        return entries.api.patch(path, body);
      },
      async del(path, body) {
        calls.push(['DELETE', path, body]);
        requireAuth();
        return entries.api.del(path, body);
      },
    },
  };
  return srv;
}

const realApi = { ...api };
function useServer(srv) {
  Object.assign(api, srv.api);
}
function resetLive() {
  liveStore.stop();
  liveStore.clear();
  livePrefs.user = null;
  livePrefs.authed = false;
}

test('session: register-create → entry → logout → login round-trips the FDK and the profile', async () => {
  const srv = authServer(fakeServer());
  useServer(srv);
  try {
    resetLive();
    const stages = [];
    const res = await session.registerCreate(
      {
        username: ' Mama ',
        password: 'korrekt-pferd',
        displayName: '  Mama  Bär ',
        familyName: 'Familie Muster',
        familyPassword: 'batterie-klammer',
      },
      { onProgress: (s) => stages.push(s) }
    );
    assert.deepEqual(stages, ['kdf', 'server']);
    assert.equal(res.user.username, 'mama');
    assert.equal(res.user.displayName, 'Mama Bär');
    assert.equal(res.user.familyName, 'Familie Muster');
    assert.deepEqual(Object.keys(res).sort(), ['recoveryCode', 'user']);
    assert.match(res.recoveryCode, /^([A-Za-z0-9_-]{4} ){10}[A-Za-z0-9_-]{3}$/, 'grouped by 4 with spaces');
    assert.equal(livePrefs.authed, true);
    assert.equal(livePrefs.user.kdf.iter, 600000);
    assert.equal(unb64u(livePrefs.user.kdf.salt).length, 16);
    assert.equal(liveStore.keyState, 'ready');
    const family = srv.families.get('familie muster');
    assert.notEqual(family.authKey, srv.users.get('mama').authKey, 'family and user auth keys differ');
    assert.notEqual(family.fdkWrapped, srv.users.get('mama').fdkWrapped, 'two wrappings');
    const reg = srv.calls.find((c) => c[1] === 'api/register')[2];
    assert.deepEqual(Object.keys(reg).sort(), [
      'authKey',
      'familyAuthKey',
      'familyKdf',
      'familyMode',
      'familyName',
      'fdkWrappedFamily',
      'fdkWrappedUser',
      'kdf',
      'profileBlob',
      'recoveryAuthKey',
      'username',
    ]);
    assert.ok(!('password' in reg) && !('familyPassword' in reg), 'no password ever leaves the phone');

    await liveStore.refresh();
    const e = await liveStore.entries.create({ type: 'diaper', details: { kind: 'poop' } });
    assert.equal(e.loggedBy, 'Mama Bär');
    const code = res.recoveryCode;

    assert.equal(await session.logout(), false);
    assert.equal(srv.current, null);
    assert.equal(livePrefs.user, null);
    assert.equal(livePrefs.authed, false);
    assert.equal(liveStore.keyState, 'none');
    assert.equal(liveStore.snapshot, null);

    await rejects(session.login('mama', 'falsch-falsch'), 'Benutzername oder Passwort falsch', 401);
    await rejects(session.login('niemand', 'korrekt-pferd'), 'Benutzername oder Passwort falsch', 401);
    const user = await session.login('MAMA', 'korrekt-pferd');
    assert.equal(user.displayName, 'Mama Bär', 'decrypted from the profile blob');
    assert.equal(liveStore.keyState, 'ready');
    await liveStore.refresh();
    assert.equal(liveStore.entries.get(e.eid).details.kind, 'poop', 'the same FDK opens the entry');

    // revealRecoveryCode reproduces the code shown at creation.
    assert.equal(await session.revealRecoveryCode('korrekt-pferd'), code);
    await rejects(session.revealRecoveryCode('falsch-falsch'), 'Falsches Passwort', 403);

    // The unlock screen: key gone, cookie alive.
    liveStore.clear();
    livePrefs.user = { ...user }; // clear() keeps prefs; logout() would not
    livePrefs.authed = true;
    assert.equal(await liveStore.boot(), 'locked');
    await rejects(session.unlock('falsch-falsch'), 'Falsches Passwort', 403);
    await session.unlock('korrekt-pferd');
    assert.equal(liveStore.keyState, 'ready');
    await liveStore.refresh();
    assert.equal(liveStore.entries.get(e.eid).type, 'diaper');
    assert.equal(srv.calls.filter((c) => c[1].startsWith('api/auth/params')).length, 3, 'unlock used the cached kdf');

    // A corrupted wrapping on login is the key-mismatch text, not a crash.
    await session.logout();
    srv.corruptLogin = true;
    await rejects(session.login('mama', 'korrekt-pferd'), 'Schlüssel passt nicht – bitte erneut anmelden');
    srv.corruptLogin = false;
  } finally {
    resetLive();
    Object.assign(api, realApi);
  }
});

test('session: join with the family password / the recovery code; rotation; password change; display name', async () => {
  const srv = authServer(fakeServer());
  useServer(srv);
  try {
    resetLive();
    const created = await session.registerCreate({
      username: 'mama',
      password: 'korrekt-pferd',
      displayName: 'Mama',
      familyName: 'Muster',
      familyPassword: 'batterie-klammer',
    });
    await liveStore.refresh();
    const e = await liveStore.entries.create({ type: 'sleep', startedAt: '2026-09-01T09:00:00Z' });
    await session.logout();

    const join = (over) =>
      session.registerJoin({
        username: 'papa',
        password: 'acht-zeichen',
        displayName: 'Papa',
        familyName: 'muster',
        familyPassword: 'batterie-klammer',
        ...over,
      });
    await rejects(join({ familyName: 'Nirgends' }), 'Familie nicht gefunden – bitte Namen prüfen');
    await rejects(join({ familyPassword: 'falsch-falsch' }), 'Falsches Familien-Passwort', 403);
    await rejects(join({ password: 'kurz' }), 'Passwort muss mindestens 8 Zeichen haben');
    await rejects(join({ displayName: '' }), 'Anzeigename: 1–40 Zeichen');
    assert.equal(srv.users.size, 1);

    const joined = await join({ familyName: 'MUSTER' });
    assert.equal(joined.user.familyName, 'Muster', 'the stored spelling');
    assert.equal(joined.user.familyId, created.user.familyId);
    const reg = srv.calls.filter((c) => c[1] === 'api/register').pop()[2];
    assert.equal(reg.familyMode, 'join');
    assert.ok(reg.familyAuthKey && !reg.recoveryAuthKey && !reg.fdkWrappedFamily);
    await liveStore.refresh();
    assert.equal(liveStore.entries.get(e.eid).type, 'sleep', 'the joiner reads the creator\'s entry');

    // Papa rotates the family password (own password confirms) and changes his own.
    await rejects(session.rotateFamilyPassword('falsch-falsch', 'neues-familien-pw'), 'Falsches Passwort', 403);
    await session.rotateFamilyPassword('acht-zeichen', 'neues-familien-pw');
    await session.changePassword('acht-zeichen', 'papas-neues-pw');
    assert.equal(livePrefs.user.kdf.salt, srv.users.get('papa').kdf.salt, 'prefs carry the new salt');
    await session.updateDisplayName('Papi');
    assert.equal(livePrefs.user.displayName, 'Papi');
    await session.logout();

    await rejects(session.login('papa', 'acht-zeichen'), 'Benutzername oder Passwort falsch', 401);
    const papa = await session.login('papa', 'papas-neues-pw');
    assert.equal(papa.displayName, 'Papi', 'the re-encrypted profile');
    await liveStore.refresh();
    assert.equal(liveStore.entries.get(e.eid).type, 'sleep', 'the FDK survived both re-wraps');
    await session.logout();

    await rejects(join({ username: 'oma', displayName: 'Oma' }), 'Falsches Familien-Passwort', 403);
    // Oma joins with the recovery code (typed as shown: groups separated by spaces).
    const recover = (recoveryCode) =>
      session.registerWithRecoveryCode({
        username: 'oma',
        password: 'acht-zeichen',
        displayName: 'Oma',
        familyName: 'Muster',
        recoveryCode,
      });
    await rejects(recover('nonsense'), 'Ungültiger Wiederherstellungscode');
    const wrong = created.recoveryCode.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
    await rejects(recover(wrong), 'Ungültiger Wiederherstellungscode', 403);
    const oma = await recover(created.recoveryCode);
    assert.equal(oma.user.familyId, created.user.familyId);
    const regOma = srv.calls.filter((c) => c[1] === 'api/register').pop()[2];
    assert.ok(regOma.recoveryAuthKey && !regOma.familyAuthKey);
    await liveStore.refresh();
    assert.equal(liveStore.entries.get(e.eid).type, 'sleep', 'the recovery code IS the FDK');
    const grandma = await liveStore.entries.create({ type: 'bottle', details: { amount_ml: 100 } });
    assert.equal(grandma.loggedBy, 'Oma');

    // Logout with the server unreachable still wipes locally.
    const post = api.post;
    api.post = async (path, body) => {
      if (path === 'api/logout') throw new Error('Keine Verbindung zum Server');
      return post(path, body);
    };
    assert.equal(await session.logout(), true);
    assert.equal(livePrefs.user, null);
    assert.equal(liveStore.keyState, 'none');
  } finally {
    resetLive();
    Object.assign(api, realApi);
  }
});

test('boot before anybody signed in is locked but not final: the stored key is tried once prefs.user exists', async () => {
  const server = fakeServer();
  await seed(server, entry());
  const p = phone(server, { key: FDK });
  p.prefs.user = null;
  assert.equal(await p.store.boot(), 'locked');
  assert.deepEqual(p.keys.log, [], 'no key lookup without an identity');
  p.prefs.user = { username: 'mama', familyId: FAMILY, familyName: 'Test', displayName: 'Mama' };
  await p.store.setIdentity(p.prefs.user);
  assert.equal(await p.store.boot(), 'ready');
  await p.store.refresh();
  assert.equal(p.store.entries.range('2026-08-30', TODAY).length, 1);
});

// --- family settings ---------------------------------------------------------------------------

test('settings.current: defaults, then this device\'s older values, then the family row', async () => {
  const server = fakeServer();
  const storage = memStorage();
  storage.setItem('bt.recommendedMl', '70'); // set per device before the sync existed
  storage.setItem('bt.feedFromStart', '1');
  const a = phone(server, { storage });
  const rest = { formulaPresets: [10, 20, 30], birthDate: null, mealsPerDay: 6, breastfeeding: true, nursingMl: null }; // newer keys: defaults until the family sets them
  assert.deepEqual(a.store.settings.current, { feedFromStart: true, recommendedMl: 70, bottlePresets: [60, 90, 120], ...rest });
  assert.equal(a.store.settings.meta, null);
  assert.deepEqual(a.store.settings.syncedKeys, []);
  await online(a, FDK_RAW);
  // The family saves the presets: the device's other values still stand in.
  await a.store.settings.save({ bottlePresets: [50, 80, 110] });
  assert.deepEqual(a.store.settings.current, { feedFromStart: true, recommendedMl: 70, bottlePresets: [50, 80, 110], ...rest });
  assert.deepEqual(a.store.settings.syncedKeys, ['bottlePresets']);
  assert.deepEqual(a.store.settings.meta, { changedAt: NOW, changedBy: 'Mama' });
  // A second phone without any per-device values sees the family value and the defaults.
  const b = await online(phone(server, { username: 'papa', displayName: 'Papa' }), FDK_RAW);
  assert.deepEqual(b.store.settings.current, { feedFromStart: false, recommendedMl: null, bottlePresets: [50, 80, 110], ...rest });
  // Saving an explicit null for the recommendation overrides A's older 70 on A too.
  await b.store.settings.save({ recommendedMl: null, feedFromStart: true });
  await a.store.refresh();
  assert.deepEqual(a.store.settings.current, { feedFromStart: true, recommendedMl: null, bottlePresets: [50, 80, 110], ...rest });
  assert.deepEqual(a.store.settings.meta, { changedAt: NOW, changedBy: 'Papa' });
  // The drinking target's keys travel the same way; null clears the birth date again.
  await b.store.settings.save({ birthDate: '2026-09-08', mealsPerDay: 7 });
  await a.store.refresh();
  assert.deepEqual(a.store.settings.current, { feedFromStart: true, recommendedMl: null, bottlePresets: [50, 80, 110], formulaPresets: [10, 20, 30], birthDate: '2026-09-08', mealsPerDay: 7, breastfeeding: true, nursingMl: null });
  await a.store.settings.save({ birthDate: null, formulaPresets: [5, 10, 20] });
  assert.deepEqual(a.store.settings.current.formulaPresets, [5, 10, 20]);
  assert.equal(a.store.settings.current.birthDate, null);
  assert.equal(a.store.settings.current.mealsPerDay, 7);
  // One row for the family, patched in place, no event in Verlauf.
  const rows = [...server.rows.values()];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].seq, 4);
  assert.deepEqual(a.store.entries.range('2026-08-01', '2026-09-30'), []);
  assert.equal(a.store.snapshot.data.familySettings.eid, rows[0].eid);
});

test('settings.save lays the change over the partner\'s fresh document after a 409, never over a stale copy', async () => {
  const server = fakeServer();
  const a = await online(phone(server), FDK_RAW);
  const b = await online(phone(server, { username: 'papa', displayName: 'Papa' }), FDK_RAW);
  await a.store.settings.save({ recommendedMl: 70 });
  await b.store.refresh();
  // B flips the interval; A (still at seq 1) changes the presets.
  await b.store.settings.save({ feedFromStart: true });
  await a.store.settings.save({ bottlePresets: [50, 80, 110] });
  assert.deepEqual(a.store.settings.current, { feedFromStart: true, recommendedMl: 70, bottlePresets: [50, 80, 110], formulaPresets: [10, 20, 30], birthDate: null, mealsPerDay: 6, breastfeeding: true, nursingMl: null });
  const patches = server.calls.filter((c) => c[0] === 'PATCH');
  assert.equal(patches.length, 3, 'B, A stale, A retry');
  assert.equal(patches[1][2].ifSeq, 1);
  assert.equal(patches[2][2].ifSeq, 2);
  await b.store.refresh();
  assert.deepEqual(b.store.settings.current, a.store.settings.current);
  // The document keeps a key it does not know (a newer shell's setting).
  const row = [...server.rows.values()][0];
  assert.equal(row.seq, 3);
});

test('settings.save: two saves at once on a family without a row make ONE row with both changes', async () => {
  const server = fakeServer();
  const a = await online(phone(server), FDK_RAW);
  // A typed amount and a switch tapped within the same second (more.js).
  await Promise.all([a.store.settings.save({ nursingMl: 50 }), a.store.settings.save({ breastfeeding: false })]);
  assert.equal(server.rows.size, 1, 'one settings document, not one per save');
  assert.equal(a.store.settings.current.nursingMl, 50);
  assert.equal(a.store.settings.current.breastfeeding, false);
  assert.deepEqual(a.store.settings.syncedKeys, ['breastfeeding', 'nursingMl']);
  // A failed save does not block the next one.
  await assert.rejects(a.store.settings.save({ mealsPerDay: 0 }), /mealsPerDay/);
  await a.store.settings.save({ mealsPerDay: 7 });
  assert.equal(a.store.settings.current.mealsPerDay, 7);
  assert.equal(server.rows.size, 1);
});

test('settings.save without a key or with bad values fails like an entry write', async () => {
  const server = fakeServer();
  const a = phone(server);
  await assert.rejects(a.store.settings.save({ feedFromStart: true }), /Bitte zuerst entsperren/);
  await online(a, FDK_RAW);
  await assert.rejects(a.store.settings.save({ recommendedMl: 5000 }), /recommendedMl/);
  await assert.rejects(a.store.settings.save({ bottlePresets: [1] }), /bottlePresets/);
  await assert.rejects(a.store.settings.save({ formulaPresets: [10, 20] }), /formulaPresets/);
  await assert.rejects(a.store.settings.save({ birthDate: '08.09.2026' }), /birthDate/);
  await assert.rejects(a.store.settings.save({ mealsPerDay: 0 }), /mealsPerDay/);
  assert.equal(server.rows.size, 0);
  // Unknown keys in the patch are ignored, known ones written.
  await a.store.settings.save({ feedFromStart: true, nightMode: 'dim' });
  assert.deepEqual(a.store.snapshot.data.familySettings.values, { feedFromStart: true });
});

// --- reminders + ticks ---------------------------------------------------------------------------

test('a reminder created on one phone is a to-do on both; a tick on the other closes the same slot', async () => {
  const server = fakeServer();
  const a = await online(phone(server), FDK_RAW);
  const b = await online(phone(server, { username: 'papa', displayName: 'Papa' }), FDK_RAW);
  // NOW = 12:00 Zurich: the 08:00 slot is overdue, 20:00 ahead.
  const r = await a.store.entries.create({
    type: 'reminder',
    details: { title: 'Vitamin D', note: '2 Tropfen', times: ['20:00', '08:00'] },
  });
  assert.deepEqual(a.store.snapshot.data.reminders.map((x) => [x.eid, x.times, x.changedBy]), [[r.eid, ['08:00', '20:00'], 'Mama']]);
  assert.deepEqual(a.store.snapshot.data.todos.today.map((o) => [o.time, o.due, o.done]), [
    ['08:00', '2026-09-01T06:00:00Z', null],
    ['20:00', '2026-09-01T18:00:00Z', null],
  ]);
  // No event: Verlauf lists nothing, the counts stay at zero.
  assert.deepEqual(a.store.entries.range('2026-08-01', TODAY), []);
  assert.equal(a.store.snapshot.data.today.feeds, 0);

  await b.store.refresh();
  const slot = b.store.snapshot.data.todos.today[0];
  assert.equal(slot.done, null);
  const tick = await b.store.entries.create({
    type: 'task',
    details: { title: slot.title, who: slot.who, reminderEid: slot.reminderEid, due: slot.due },
  });
  assert.deepEqual(b.store.snapshot.data.todos.today[0].done, { eid: tick.eid, at: NOW, by: 'Papa' });
  assert.equal(b.store.snapshot.data.todos.today[1].done, null);
  // The tick is an event of the day on both phones.
  assert.deepEqual(b.store.entries.range(TODAY, TODAY).map((e) => e.type), ['task']);
  await a.store.refresh();
  assert.deepEqual(a.store.snapshot.data.todos.today[0].done, { eid: tick.eid, at: NOW, by: 'Papa' });
  assert.equal(a.store.snapshot.data.lastByType.task.eid, tick.eid);
  // Deleting the tick reopens the slot; the reminder itself is CAS-edited like any row.
  await a.store.entries.remove(tick.eid);
  assert.equal(a.store.snapshot.data.todos.today[0].done, null);
  await b.store.entries.update(r.eid, { details: { title: 'Vitamin D', times: ['09:00'] } });
  await rejects(
    a.store.entries.update(r.eid, { details: { title: 'Vitamin D3', times: ['08:00'] } }, { ifSeq: r.seq }),
    'Der Eintrag wurde inzwischen auf einem anderen Gerät geändert',
    409
  );
  await a.store.refresh();
  assert.deepEqual(a.store.snapshot.data.reminders[0].times, ['09:00']);
  // Bad schedules never reach the server.
  await assert.rejects(a.store.entries.create({ type: 'reminder', details: { title: 'X', times: [] } }), /Uhrzeiten/);
});

// --- the outbox: writes without network -------------------------------------------------

/** The stored outbox records must never carry plaintext: only these keys, and a blob or null. */
function assertOpaque(records) {
  for (const r of records) {
    const keys = Object.keys(r).sort();
    for (const k of keys) {
      assert.ok(
        ['key', 'n', 'eid', 'kind', 'blob', 'baseSeq', 'fields', 'guard', 'sent', 'dead', 'queuedAt', 'tries', 'parked'].includes(k),
        `unexpected key in a stored op: ${k}`
      );
    }
    assert.ok(r.blob === null || /^[A-Za-z0-9_-]+$/.test(r.blob), 'blob is ciphertext (base64url) or null');
  }
}

test('outbox: a create without network is kept (ciphertext only), shown at once and sent after the next sync', async () => {
  const server = fakeServer();
  const p = await online(phone(server), FDK_RAW);
  server.offline = true;
  const e = await p.store.entries.create({ type: 'diaper', details: { kind: 'pee' } });
  assert.equal(e.pending, 'waiting');
  assert.ok(e.seq >= 2 ** 52, 'a placeholder seq');
  assert.equal(p.store.outbox.count, 1);
  assert.equal(p.store.snapshot.data.today.diapers, 1, 'the home state has it');
  assert.equal(p.store.entries.range(TODAY, TODAY)[0].eid, e.eid, 'Verlauf has it');
  assert.equal(server.rows.size, 0, 'nothing reached the server');
  assert.equal(server.calls.filter((c) => c[0] === 'POST').length, 0, 'no request was even tried');
  const records = p.db.ops();
  assert.equal(records.length, 1);
  assertOpaque(records);
  assert.equal(records[0].kind, 'create');
  assert.ok(!JSON.stringify(records).includes('pee'), 'no plaintext in the mirror');

  server.offline = false;
  await p.store.refresh(); // the poll / the online event: the sync succeeds, the flusher runs
  await p.store.outbox.idle();
  assert.equal(p.store.outbox.count, 0);
  assert.equal(server.rows.size, 1);
  const sent = p.store.entries.get(e.eid);
  assert.equal(sent.seq, 1, 'the real seq');
  assert.equal(sent.pending, undefined);
  assert.equal(p.db.ops().length, 0, 'the record is gone');
  assert.equal(server.calls.filter((c) => c[0] === 'POST').length, 1);
  assert.ok(p.toasts.includes('1 gesendet'), p.toasts.join(' | '));
});

test('outbox: a phone restarted over the same mirror shows the pending entry and sends it', async () => {
  const server = fakeServer();
  const a = await online(phone(server), FDK_RAW);
  server.offline = true;
  const e = await a.store.entries.create({ type: 'bottle', details: { amount_ml: 60 } });
  // The app is killed and reopened, still offline: the same IndexedDB, a fresh store.
  const b = phone(server, { db: a.db, storage: a.storage, key: await importFdk(new Uint8Array(FDK_RAW), false) });
  await b.store.boot();
  assert.equal(b.store.keyState, 'ready');
  assert.equal(b.store.entries.get(e.eid).details.amount_ml, 60, 'decrypted from the outbox record');
  assert.equal(b.store.entries.get(e.eid).pending, 'waiting');
  assert.equal(b.store.snapshot.data.lastFeed.eid, e.eid);
  server.offline = false;
  await b.store.refresh();
  await b.store.outbox.idle();
  assert.equal(server.rows.size, 1);
  assert.equal(b.store.entries.get(e.eid).seq, 1);
});

test('outbox: an answer lost on the way back – the create landed (409 exists) and is confirmed, one row', async () => {
  const server = fakeServer();
  const p = await online(phone(server), FDK_RAW);
  server.lose = true;
  const e = await p.store.entries.create({ type: 'diaper', details: { kind: 'poop' } });
  assert.equal(e.pending, 'waiting', 'no answer: kept, frozen, judged on the next sync');
  assert.equal(p.db.ops()[0].sent, true, 'frozen: a change would become a follower');
  assert.equal(server.rows.size, 1, 'but it landed');
  await p.store.refresh();
  await p.store.outbox.idle();
  assert.equal(p.store.outbox.count, 0);
  assert.equal(server.rows.size, 1, 'no second row');
  assert.equal(p.store.entries.get(e.eid).seq, 1);
  assert.equal(server.calls.filter((c) => c[0] === 'POST').length, 1, 'the sync brought the row: nothing to retry');

  // The same with the sync page NOT bringing it first (the flush runs before
  // the poll): the retry gets the 409 and the sync after it confirms the row.
  server.lose = true;
  const f = await p.store.entries.create({ type: 'diaper', details: { kind: 'pee' }, startedAt: minus(1) });
  await p.store.outbox.flush();
  await p.store.outbox.idle();
  assert.equal(server.rows.size, 2);
  assert.equal(p.store.entries.get(f.eid).seq, 2);
  assert.equal(server.calls.filter((c) => c[0] === 'POST').length, 3, 'one retry, answered 409');
});

test('outbox: an answer lost on an update – the blob the sync brings proves it landed', async () => {
  const server = fakeServer();
  const p = await online(phone(server), FDK_RAW);
  const e = await p.store.entries.create({ type: 'weight', details: { grams: 3500 } });
  server.lose = true;
  const u = await p.store.entries.update(e.eid, { details: { grams: 3600 } });
  assert.equal(u.pending, 'waiting');
  assert.equal(server.rows.get(e.eid).seq, 2, 'landed');
  await p.store.refresh();
  await p.store.outbox.idle();
  assert.equal(p.store.entries.get(e.eid).seq, 2);
  assert.equal(p.store.entries.get(e.eid).details.grams, 3600);
  assert.equal(server.calls.filter((c) => c[0] === 'PATCH').length, 1, 'never sent again');
});

test('outbox: start and stop offline become ONE closed row; a stop the partner already did is dropped with a notice', async () => {
  const server = fakeServer();
  const a = await online(phone(server), FDK_RAW);
  const b = await online(phone(server, { username: 'papa' }), FDK_RAW);
  server.offline = true;
  const s = await a.store.entries.create({ type: 'sleep', startedAt: minus(30) });
  assert.equal(a.store.snapshot.data.openTimers[0].eid, s.eid);
  await a.store.entries.update(s.eid, { endedAt: minus(5), ifOpen: true }, { guard: 'open' });
  assert.equal(a.store.entries.get(s.eid).endedAt, minus(5));
  assert.equal(a.db.ops().length, 1, 'folded into the create');
  server.offline = false;
  await a.store.refresh();
  await a.store.outbox.idle();
  assert.equal(server.calls.filter((c) => c[0] === 'POST').length, 1, 'one POST, no PATCH');
  assert.equal(server.calls.filter((c) => c[0] === 'PATCH').length, 0);
  assert.equal(a.store.entries.get(s.eid).endedAt, minus(5));

  // The partner stops a timer that A also stops offline: B's end stands, A hears why.
  const t2 = await a.store.entries.create({ type: 'sleep', startedAt: minus(20) });
  await b.store.refresh();
  await b.store.entries.update(t2.eid, { endedAt: minus(2) });
  server.offline = true;
  await a.store.entries.update(t2.eid, { endedAt: NOW, ifOpen: true }, { guard: 'open' });
  assert.equal(a.store.entries.get(t2.eid).endedAt, NOW, 'shown as A did it, for now');
  server.offline = false;
  await a.store.refresh();
  await a.store.outbox.idle();
  assert.equal(a.store.entries.get(t2.eid).endedAt, minus(2), "B's end");
  assert.equal(server.rows.get(t2.eid).seq, a.store.entries.get(t2.eid).seq);
  assert.ok(a.toasts.some((m) => m.startsWith('Nicht übernommen: Schlaf')), a.toasts.join(' | '));
  assert.equal(server.calls.filter((c) => c[0] === 'PATCH').length, 1, "only B's");
});

test('outbox: an offline stop survives the partner moving the start (their start, our end); an edit of a deleted row is dropped', async () => {
  const server = fakeServer();
  const a = await online(phone(server), FDK_RAW);
  const b = await online(phone(server, { username: 'papa' }), FDK_RAW);
  const s = await a.store.entries.create({ type: 'breastfeed', details: { side: 'L' }, startedAt: minus(15) });
  const w = await a.store.entries.create({ type: 'weight', details: { grams: 3500 } });
  await b.store.refresh();
  await b.store.entries.update(s.eid, { startedAt: minus(20) });
  await b.store.entries.remove(w.eid);
  server.offline = true;
  await a.store.entries.update(s.eid, { endedAt: NOW, ifOpen: true }, { guard: 'open' });
  await a.store.entries.update(w.eid, { details: { grams: 3550 } });
  server.offline = false;
  await a.store.refresh();
  await a.store.outbox.idle();
  const closed = a.store.entries.get(s.eid);
  assert.equal(closed.startedAt, minus(20));
  assert.equal(closed.endedAt, NOW);
  assert.equal(closed.rev, 3);
  assert.equal(closed.loggedBy, 'Mama');
  assert.equal(a.store.entries.get(w.eid).deletedAt, TODAY, 'the tombstone stands');
  assert.ok(a.toasts.some((m) => m === 'Nicht übernommen: Gewicht wurde auf dem anderen Handy inzwischen gelöscht'), a.toasts.join(' | '));
  assert.equal(a.store.outbox.count, 0);
});

test('outbox: delete wins over the partner\'s edit; create + undo never reaches the server; undo of a delete brings a never-sent entry back', async () => {
  const server = fakeServer();
  const a = await online(phone(server), FDK_RAW);
  const b = await online(phone(server, { username: 'papa' }), FDK_RAW);
  const w = await a.store.entries.create({ type: 'weight', details: { grams: 3500 } });
  await b.store.refresh();
  await b.store.entries.update(w.eid, { details: { grams: 3600 } });
  server.offline = true;
  await a.store.entries.remove(w.eid);
  assert.equal(a.store.entries.get(w.eid).deletedAt, TODAY);

  const d = await a.store.entries.create({ type: 'diaper', details: { kind: 'pee' } });
  await a.store.entries.remove(d.eid); // «Rückgängig» on the toast
  assert.equal(a.store.entries.get(d.eid).deletedAt, TODAY, 'a local tombstone');
  assert.equal(a.store.entries.range(TODAY, TODAY).some((e) => e.eid === d.eid), false);
  const back = await a.store.entries.restore(d.eid); // … and the delete undone
  assert.equal(back.deletedAt, null);
  assert.equal(a.db.ops().filter((o) => o.eid === d.eid).length, 1, 'still one create');
  const d2 = await a.store.entries.create({ type: 'diaper', details: { kind: 'both' } });
  await a.store.entries.remove(d2.eid);

  server.offline = false;
  await a.store.refresh();
  await a.store.outbox.idle();
  assert.equal(server.rows.get(w.eid).deletedAt, TODAY, 'the delete won');
  assert.equal(server.rows.has(d.eid), true);
  assert.equal(server.rows.has(d2.eid), false, 'undone before it was sent: never sent');
  assert.equal(server.calls.filter((c) => c[0] === 'POST').length, 2);
  assert.equal(a.store.outbox.count, 0);
  assert.equal(a.db.ops().length, 0, 'the dead create is gone too');
});

test('outbox: a pending open timer loses to the partner\'s within 15 min without a request; further apart it is sent and the notice shows', async () => {
  const server = fakeServer();
  const a = await online(phone(server), FDK_RAW);
  const b = await online(phone(server, { username: 'papa' }), FDK_RAW);
  await b.store.entries.create({ type: 'sleep', startedAt: minus(5) }); // B's phone got through …
  server.offline = true; // … A's did not, and has not synced B's yet
  const mine = await a.store.entries.create({ type: 'sleep', startedAt: minus(3) });
  server.offline = false;
  await a.store.refresh();
  await a.store.outbox.idle();
  assert.equal(server.rows.has(mine.eid), false, 'never sent');
  assert.equal(a.store.entries.get(mine.eid), null);
  assert.ok(a.toasts.includes('Doppelter Schlaf-Timer entfernt'));
  assert.equal(a.store.snapshot.data.openTimers.length, 1);

  await b.store.entries.update(a.store.snapshot.data.openTimers[0].eid, { endedAt: minus(1) });
  await a.store.refresh();
  await b.store.entries.create({ type: 'sleep', startedAt: minus(40) });
  server.offline = true;
  const far = await a.store.entries.create({ type: 'sleep', startedAt: minus(0) });
  server.offline = false;
  await a.store.refresh();
  await a.store.outbox.idle();
  assert.equal(server.rows.has(far.eid), true, 'sent: a human decides');
  assert.equal(a.store.notice, 'Zwei Schlaf-Timer offen – bitte einen im Verlauf beenden');
});

test('outbox: 429 keeps the op for later; 401 blocks until a sync succeeds; a 400 parks it – retry and discard', async () => {
  const server = fakeServer();
  const p = await online(phone(server, { settleWaitMs: 0 }), FDK_RAW);
  let answer = null;
  server.hook = async (m) => {
    if (m === 'POST' && answer) throw answer;
  };
  answer = httpError(429, 'Zu viele Änderungen in kurzer Zeit');
  const e = await p.store.entries.create({ type: 'diaper', details: { kind: 'pee' } });
  assert.equal(e.pending, 'waiting');
  await until(() => !p.store.outbox.count || p.db.ops()[0].sent === false);
  assert.equal(p.store.outbox.count, 1, 'kept');
  assert.equal(p.db.ops()[0].sent, false, 'a 429 never applied');
  answer = null;
  await p.store.refresh();
  await p.store.outbox.idle();
  assert.equal(server.rows.has(e.eid), true);

  answer = httpError(401, 'Nicht angemeldet');
  const f = await p.store.entries.create({ type: 'diaper', details: { kind: 'poop' } });
  await until(() => p.db.ops().some((o) => o.eid === f.eid && o.sent === false));
  const posts = server.calls.filter((c) => c[0] === 'POST').length;
  await p.store.outbox.flush();
  assert.equal(server.calls.filter((c) => c[0] === 'POST').length, posts, 'blocked: nothing is tried');
  answer = null;
  await p.store.refresh(); // logged in again: the sync page comes back
  await p.store.outbox.idle();
  assert.equal(server.rows.has(f.eid), true);

  answer = httpError(400, 'Ungültiger Datensatz');
  const g = await p.store.entries.create({ type: 'diaper', details: { kind: 'both' } });
  await until(() => p.store.outbox.parked === 1);
  assert.equal(p.store.outbox.count, 0);
  assert.equal(p.store.entries.get(g.eid).pending, 'parked');
  assert.ok(p.toasts.some((m) => m.startsWith('Nicht gesendet')));
  const listed = p.store.outbox.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, 'parked');
  assert.equal(listed[0].parked.status, 400);
  answer = null;
  await p.store.outbox.retry(listed[0].key);
  await p.store.outbox.idle();
  assert.equal(server.rows.has(g.eid), true, 'retried');
  assert.equal(p.store.outbox.parked, 0);

  answer = httpError(507, 'Speicherlimit erreicht');
  const h = await p.store.entries.create({ type: 'diaper', details: { kind: 'pee' }, startedAt: minus(1) });
  await until(() => p.store.outbox.parked === 1);
  await p.store.outbox.discard(p.store.outbox.list()[0].key);
  assert.equal(p.store.entries.get(h.eid), null, 'discarded');
  assert.equal(p.db.ops().length, 0);
  server.hook = null;
});

test('outbox: clear() forgets the ops, a sync reset keeps them; a broken mirror queues nothing (the write fails as before)', async () => {
  const server = fakeServer();
  const a = await online(phone(server), FDK_RAW);
  server.offline = true;
  await a.store.entries.create({ type: 'diaper', details: { kind: 'pee' } });
  assert.equal(a.store.outbox.count, 1);
  server.offline = false;
  server.reset({ newFeed: true }); // a restored backup: rows and cursor are wiped, the outbox is not
  await a.store.refresh();
  await a.store.outbox.idle();
  assert.equal(server.rows.size, 1, 'sent into the new database');

  server.offline = true;
  await a.store.entries.create({ type: 'diaper', details: { kind: 'poop' } });
  a.store.clear();
  assert.equal(a.store.outbox.count, 0);
  server.offline = false;

  const b = await online(phone(server), FDK_RAW);
  b.db.broken = true;
  server.offline = true;
  await rejects(b.store.entries.create({ type: 'diaper', details: { kind: 'pee' } }), 'Keine Verbindung zum Server');
  assert.equal(b.store.outbox.count, 0);
  assert.equal(b.store.outbox.durable, false);
  server.offline = false;
  const ok = await b.store.entries.create({ type: 'diaper', details: { kind: 'pee' } });
  assert.equal(ok.seq, server.rows.get(ok.eid).seq, 'straight to the server');
});

test('outbox: an own write landing is not "changed meanwhile" for an open form, the partner\'s edit is; settings never queue', async () => {
  const server = fakeServer();
  const a = await online(phone(server), FDK_RAW);
  const b = await online(phone(server, { username: 'papa' }), FDK_RAW);
  server.offline = true;
  const e = await a.store.entries.create({ type: 'weight', details: { grams: 3500 } });
  const opened = a.store.entries.get(e.eid); // the edit form opens on the pending entry
  server.offline = false;
  await a.store.refresh();
  await a.store.outbox.idle();
  assert.equal(a.store.entries.changedSince(e.eid, opened.seq), false, 'landed, but nobody else touched it');
  const saved = await a.store.entries.update(e.eid, { details: { grams: 3550 } }, { ifSeq: opened.seq });
  assert.equal(saved.details.grams, 3550);
  await b.store.refresh();
  await b.store.entries.update(e.eid, { details: { grams: 3700 } });
  await a.store.refresh();
  assert.equal(a.store.entries.changedSince(e.eid, saved.seq), true);
  await rejects(
    a.store.entries.update(e.eid, { details: { grams: 3560 } }, { ifSeq: saved.seq }),
    'Der Eintrag wurde inzwischen auf einem anderen Gerät geändert',
    409
  );
  assert.equal(a.store.entries.get(e.eid).details.grams, 3700, 'nothing overwritten');

  server.offline = true;
  await rejects(a.store.settings.save({ mealsPerDay: 7 }), 'Keine Verbindung zum Server');
  assert.equal(a.store.outbox.count, 0, 'settings go straight to the server');
  const plain = a.store.exportPlain();
  server.offline = false;
  assert.ok(plain.some((x) => x.eid === e.eid));
});

test('outbox: a slow server – the call resolves pending after the wait, the late answer confirms', async () => {
  const server = fakeServer();
  const p = await online(phone(server, { settleWaitMs: 20 }), FDK_RAW);
  let release;
  server.hook = async (m) => {
    if (m === 'POST') await new Promise((r) => (release = r));
  };
  const e = await p.store.entries.create({ type: 'diaper', details: { kind: 'pee' } });
  assert.equal(e.pending, 'sending');
  server.hook = null;
  release();
  await p.store.outbox.idle();
  assert.equal(p.store.entries.get(e.eid).seq, 1);
  assert.equal(p.store.entries.get(e.eid).pending, undefined);
  assert.equal(server.calls.filter((c) => c[0] === 'POST').length, 1);
  assert.ok(p.toasts.includes('1 gesendet'), 'a deferred op that drained is announced');
});

test('outbox: an answer that is not the API\'s — a challenge page, a proxy error — keeps the op and retries; a parked write tells a waiting form so', async () => {
  const server = fakeServer();
  const p = await online(phone(server, { settleWaitMs: 0 }), FDK_RAW);
  // The hoster's «Anfrage wird geprüft» page: a status, no envelope, no code
  // (src/api.js hands it on without a status; a stray status without a code
  // reads the same).
  let answer = Object.assign(new Error('Unerwartete Antwort vom Server (403) – bitte gleich nochmals versuchen'), { status: 403 });
  server.hook = async (m) => {
    if (m === 'POST' && answer) throw answer;
  };
  const e = await p.store.entries.create({ type: 'bottle', details: { colostrum_ml: 30 } });
  assert.equal(e.pending, 'waiting');
  await until(() => server.calls.some((c) => c[0] === 'POST'));
  await new Promise((r) => setTimeout(r, 30)); // the attempt's tail: persist, notify, back off
  assert.equal(p.store.outbox.parked, 0, 'not parked: the server did not judge it');
  assert.equal(p.store.outbox.count, 1);
  assert.ok(!p.toasts.some((m) => m.startsWith('Nicht gesendet')), 'no refusal announced');
  answer = null;
  await p.store.refresh();
  await p.store.outbox.idle();
  assert.equal(server.rows.has(e.eid), true, 'sent once the page is gone');
  assert.equal(server.rows.size, 1);

  // A refusal the API itself pronounced while the form waits: the promise
  // rejects with `parked` (the form closes on it — a second tap would make a
  // second entry), the op stays parked, once.
  const q = await online(phone(server, { username: 'papa' }), FDK_RAW);
  server.hook = async (m) => {
    if (m === 'POST') throw httpError(400, 'Ungültiger Datensatz');
  };
  const err = await rejects(q.store.entries.create({ type: 'bottle', details: { colostrum_ml: 30 } }), 'Nicht gesendet: der Server hat Schoppen abgelehnt – siehe «Jetzt», nicht gesendete Einträge', 400);
  assert.equal(err.parked, true);
  assert.equal(err.code, 'request.badBlob');
  assert.equal(q.store.outbox.parked, 1);
  assert.equal(q.db.ops().length, 1);
  server.hook = null;
});
