// The outbox: what a phone still owes the server. Every entry write becomes
// an OP — persisted (ciphertext only) and laid over the confirmed model
// before it is sent — so a tap works without network and the entry shows at
// once; the store's flusher sends the ops in order once there is network
// (src/store.js). This module is the pure half: the record's shape, how a
// new op folds into the ones already waiting for the same entry, how the
// pending ops read over the confirmed rows, how a server answer is
// classified and what to do with an op once the confirmed row is known.
// No DOM, no store, no crypto — runs under `node --test`.
//
// An op (what is persisted; `plain` lives in memory only):
//   n         order of arrival on this device (the key sorts by it)
//   key       the IndexedDB meta key, 'op:<n>:<rand>'
//   eid       the entry
//   kind      'create' | 'update' | 'remove' | 'restore'
//   blob      ciphertext of the INTENDED full entry (create/update), else null
//   baseSeq   the confirmed seq the update was made over (null for a create;
//             a placeholder seq when it was made over a pending create)
//   fields    the top-level fields this device changed ('startedAt',
//             'endedAt', 'details') — what a rebase lays over a fresh row
//   guard     'open' | 'durationless' | 'paused' | null: the state the row
//             must still be in for the op to apply (home.js's preconditions,
//             by NAME so they survive a reload)
//   sent      a request left with this exact blob: the op is frozen (a later
//             change becomes a follower) until the answer says it did not land
//   dead      a create that was undone before it was sent — a local
//             tombstone (restore revives it), never sent, dropped at boot
//   queuedAt  ISO time of the tap (the entry's own times are inside the blob)
//   tries     answers that were not final (409/404 rounds)
//   parked    {status, code, message} when the server refused it for good —
//             kept visible until the user retries or discards it
// In memory only: `plain` (the decrypted blob), `inflight` (a request is on
// the wire right now), `waiter` (the caller still waiting for the answer).

export const PENDING_SEQ_BASE = 2 ** 52;
export const isPendingSeq = (seq) => Number(seq) >= PENDING_SEQ_BASE;

/** The named preconditions (home.js): what the confirmed row must still look like. */
export const GUARDS = {
  open: (r) => r.endedAt === null,
  durationless: (r) => r.endedAt === r.startedAt,
  paused: (r) => r.endedAt !== null && !!r.details && r.details.paused === true,
};

export function guardHolds(name, entry) {
  if (name == null) return true;
  const fn = GUARDS[name];
  return typeof fn === 'function' && !!entry && fn(entry);
}

const FIELDS = ['startedAt', 'endedAt', 'details'];

function sameDetails(a, b) {
  const x = a && typeof a === 'object' ? a : {};
  const y = b && typeof b === 'object' ? b : {};
  const kx = Object.keys(x).sort();
  const ky = Object.keys(y).sort();
  if (kx.length !== ky.length) return false;
  for (let i = 0; i < kx.length; i++) {
    if (kx[i] !== ky[i]) return false;
    const v = x[kx[i]];
    const w = y[ky[i]];
    if (Array.isArray(v) || Array.isArray(w)) {
      if (!Array.isArray(v) || !Array.isArray(w) || v.length !== w.length || v.some((e, j) => e !== w[j])) return false;
    } else if (v !== w) {
      return false;
    }
  }
  return true;
}

/** The names of the top-level fields that differ between base and merged. */
export function changedFields(base, merged) {
  const out = [];
  for (const f of FIELDS) {
    const b = base ? base[f] : undefined;
    const m = merged ? merged[f] : undefined;
    const same = f === 'details' ? sameDetails(b, m) : (b === undefined ? null : b) === (m === undefined ? null : m);
    if (!same) out.push(f);
  }
  return out;
}

/** The patch a rebase lays over a fresh row: the op's values of its changed fields. */
export function fieldPatch(op) {
  const patch = {};
  for (const f of op.fields || []) {
    if (f === 'details') patch.details = { ...((op.plain && op.plain.details) || {}) };
    else patch[f] = op.plain ? op.plain[f] : undefined;
  }
  return patch;
}

const active = (op) => !op.dead && !op.parked;
const byN = (a, b) => a.n - b.n;

/**
 * Fold `incoming` (a fresh op with `plain`, without n/key) into `ops`. Returns
 * {ops, put, del}: the new list (sorted by n), the ops to persist and the keys
 * to delete. An op that already left (`sent`) is frozen: the incoming one is
 * appended as a follower. Never mutates its inputs.
 */
export function coalesce(ops, incoming, nextN, makeKey) {
  const list = [...ops].sort(byN);
  const put = [];
  const del = [];
  const same = list.filter((o) => o.eid === incoming.eid);
  const last = same.length ? same[same.length - 1] : null;
  const append = () => {
    const op = { ...incoming, n: nextN, key: makeKey(nextN), sent: false, tries: 0, parked: null, dead: false };
    put.push(op);
    return { ops: [...list, op], put, del };
  };
  const replace = (old, changes) => {
    const op = { ...old, ...changes, parked: null };
    put.push(op);
    return { ops: list.map((o) => (o === old ? op : o)), put, del };
  };
  const drop = (old) => {
    del.push(old.key);
    return { ops: list.filter((o) => o !== old), put, del };
  };
  if (!last || last.sent) return append();

  switch (incoming.kind) {
    case 'create':
      return append(); // a new eid, always
    case 'update':
      if (last.kind === 'create' && !last.dead) {
        // Start and stop offline become ONE closed row: the server never sees a phantom timer.
        return replace(last, { blob: incoming.blob, plain: incoming.plain });
      }
      if (last.kind === 'update' && last.guard === incoming.guard) {
        const fields = [...new Set([...(last.fields || []), ...(incoming.fields || [])])];
        return replace(last, { blob: incoming.blob, plain: incoming.plain, fields });
      }
      return append();
    case 'remove':
      if (last.kind === 'create') return replace(last, { dead: true }); // undone before it was sent
      if (last.kind === 'update') {
        // The edit never left (an unsent update only ever follows a SENT
        // create or a confirmed row): the delete replaces it.
        const res = drop(last);
        const op = { ...incoming, n: nextN, key: makeKey(nextN), sent: false, tries: 0, parked: null, dead: false };
        put.push(op);
        return { ops: [...res.ops, op], put, del };
      }
      if (last.kind === 'restore') return drop(last);
      return append();
    case 'restore':
      if (last.kind === 'create' && last.dead) return replace(last, { dead: false });
      if (last.kind === 'remove') return drop(last);
      return append();
    default:
      return append();
  }
}

/** What a pending op reads as in the UI: still to send, on the wire right now, or refused for good. */
export function statusOf(op) {
  if (op.parked) return 'parked';
  return op.inflight ? 'sending' : 'waiting';
}

/**
 * The confirmed rows with the pending ops laid over them: a new Map (the
 * confirmed one is never touched). A pending create gets a placeholder seq
 * (PENDING_SEQ_BASE + n: finite, sorts after every real seq, so a confirmed
 * timer keeps winning "lowest seq"); an update keeps the confirmed seq and
 * shows our plaintext; remove/restore flip deletedAt. An op whose base row
 * is gone (deleted by the partner, wiped by a reset) reads as nothing.
 */
export function overlay(confirmed, ops, today) {
  const out = new Map(confirmed);
  for (const op of [...ops].sort(byN)) {
    const base = out.get(op.eid);
    const status = statusOf(op);
    if (op.kind === 'create') {
      if (confirmed.has(op.eid)) continue; // landed: the confirmed row is the truth
      if (!op.plain) continue;
      out.set(op.eid, {
        eid: op.eid,
        seq: PENDING_SEQ_BASE + op.n,
        createdAt: null,
        updatedAt: null,
        deletedAt: op.dead ? today : null,
        rev: op.plain.rev,
        type: op.plain.type,
        startedAt: op.plain.startedAt,
        endedAt: op.plain.endedAt === undefined ? null : op.plain.endedAt,
        details: op.plain.details && typeof op.plain.details === 'object' ? op.plain.details : {},
        loggedBy: op.plain.loggedBy === undefined ? null : op.plain.loggedBy,
        pending: status,
      });
    } else if (op.kind === 'update') {
      if (!base || base.error || base.deletedAt != null || !op.plain) continue;
      out.set(op.eid, {
        ...base,
        rev: op.plain.rev,
        startedAt: op.plain.startedAt,
        endedAt: op.plain.endedAt === undefined ? null : op.plain.endedAt,
        details: op.plain.details && typeof op.plain.details === 'object' ? op.plain.details : {},
        loggedBy: op.plain.loggedBy === undefined ? null : op.plain.loggedBy,
        pending: status,
      });
    } else if (op.kind === 'remove') {
      if (!base || base.deletedAt != null) continue;
      out.set(op.eid, { ...base, deletedAt: today, pending: status });
    } else if (op.kind === 'restore') {
      if (!base || base.deletedAt == null) continue;
      out.set(op.eid, { ...base, deletedAt: null, pending: status });
    }
  }
  return out;
}

/**
 * What a failed request means for the op:
 *   transient   no answer, or one that may or may not have applied (5xx) —
 *               keep the op as it is, try later
 *   notApplied  a coded answer that says nothing was written (429, 503):
 *               keep, unfreeze
 *   auth        401: keep, wait for a login
 *   conflict    409 on an update/remove: the row moved — sync and judge again
 *   exists      409 on a create: the eid is taken — it landed
 *   gone        404: no such row for us
 *   permanent   the server refuses this request for good (400, 413, 415, 507 …)
 */
export function classify(err, kind) {
  const status = err && Number.isInteger(err.status) ? err.status : null;
  if (status === null) return 'transient';
  if (status === 401) return 'auth';
  if (status === 429 || status === 503) return 'notApplied';
  if (status === 507) return 'permanent'; // the row cap: nothing will change until rows are freed
  if (status >= 500) return 'transient';
  if (status === 409) return kind === 'create' ? 'exists' : 'conflict';
  if (status === 404) return 'gone';
  return 'permanent';
}

/**
 * Judge an op against the confirmed row it would apply to (`fresh` = the
 * confirmed entry or undefined; `seenBlob` = the blob a sync page brought
 * for that eid, if any). Returns {action, reason}:
 *   send     as it is
 *   done     already in effect (landed, or the partner did the same)
 *   rebase   the row moved: lay the op's fields over the fresh row first
 *   drop     cannot apply — reason: 'gone' | 'guard' | 'dead'
 * Whether a rebase is allowed (the caller waiting online gets today's 409
 * instead) is the store's call: it knows whose seq the fresh row carries.
 */
export function reconcile(op, fresh, seenBlob) {
  if (op.dead) return { action: 'drop', reason: 'dead' };
  switch (op.kind) {
    case 'create':
      return fresh ? { action: 'done' } : { action: 'send' };
    case 'update':
      if (!fresh || fresh.error || fresh.deletedAt != null) return { action: 'drop', reason: 'gone' };
      if (seenBlob && op.blob && seenBlob === op.blob) return { action: 'done' };
      if (!guardHolds(op.guard, fresh)) return { action: 'drop', reason: 'guard' };
      if (op.baseSeq !== fresh.seq) return { action: 'rebase' };
      return { action: 'send' };
    case 'remove':
      if (!fresh) return { action: 'drop', reason: 'gone' };
      if (fresh.deletedAt != null) return { action: 'done' };
      return { action: 'send' };
    case 'restore':
      if (!fresh) return { action: 'drop', reason: 'gone' };
      if (fresh.deletedAt == null) return { action: 'done' };
      return { action: 'send' };
    default:
      return { action: 'drop', reason: 'gone' };
  }
}

/** The next op to send: the oldest active one whose eid has no earlier op still waiting. */
export function nextOp(ops) {
  const blocked = new Set();
  for (const op of [...ops].sort(byN)) {
    if (blocked.has(op.eid)) continue;
    if (active(op)) return op;
    blocked.add(op.eid); // a parked or dead op holds its followers back
  }
  return null;
}

/** Counts for the UI: entries still to send, and entries refused for good. */
export function summary(ops) {
  const waiting = new Set();
  const parked = new Set();
  for (const op of ops) {
    if (op.dead) continue;
    if (op.parked) parked.add(op.eid);
    else waiting.add(op.eid);
  }
  return { waiting: waiting.size, parked: parked.size };
}
