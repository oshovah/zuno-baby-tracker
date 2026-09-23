// The pure half of the outbox (src/outbox.js): how a write folds into the
// ops already waiting for the same entry, how the pending ops read over the
// confirmed rows, how a server answer is classified and what to do with an op
// once the confirmed row is known.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PENDING_SEQ_BASE,
  isPendingSeq,
  GUARDS,
  guardHolds,
  changedFields,
  fieldPatch,
  coalesce,
  overlay,
  statusOf,
  classify,
  reconcile,
  nextOp,
  summary,
} from '../outbox.js';

const EID = 'a'.repeat(32);
const EID2 = 'b'.repeat(32);
const key = (n) => `op:${n}`;
const T0 = '2026-09-01T09:00:00Z';
const T1 = '2026-09-01T09:20:00Z';
const TODAY = '2026-09-01';

const plain = (over = {}) => ({ eid: EID, rev: 1, type: 'sleep', startedAt: T0, endedAt: null, details: {}, loggedBy: 'Mama', ...over });
const op = (over = {}) => ({ n: 1, key: key(1), eid: EID, kind: 'create', blob: 'AAA', baseSeq: null, fields: [], guard: null, sent: false, dead: false, tries: 0, parked: null, plain: plain(), ...over });
const incoming = (over = {}) => ({ eid: EID, kind: 'update', blob: 'BBB', baseSeq: 5, fields: ['endedAt'], guard: null, plain: plain({ rev: 2, endedAt: T1 }), ...over });
const confirmed = (over = {}) => ({ eid: EID, seq: 5, createdAt: TODAY, updatedAt: TODAY, deletedAt: null, ...plain(), ...over });

test('placeholder seqs sort after every real seq and are recognised', () => {
  assert.equal(PENDING_SEQ_BASE, 2 ** 52);
  assert.ok(Number.isSafeInteger(PENDING_SEQ_BASE + 10 ** 13), 'room for Date.now()-sized n');
  assert.equal(isPendingSeq(PENDING_SEQ_BASE + 1), true);
  assert.equal(isPendingSeq(123456), false);
  assert.equal(isPendingSeq('7'), false);
});

test('guards: the three named states of home.js, and no guard always holds', () => {
  const open = confirmed();
  const closed = confirmed({ endedAt: T1 });
  const quick = confirmed({ endedAt: T0 });
  const paused = confirmed({ type: 'breastfeed', endedAt: T1, details: { side: 'L', paused: true } });
  assert.deepEqual(Object.keys(GUARDS).sort(), ['durationless', 'open', 'paused']);
  assert.equal(guardHolds('open', open), true);
  assert.equal(guardHolds('open', closed), false);
  assert.equal(guardHolds('durationless', quick), true);
  assert.equal(guardHolds('durationless', closed), false);
  assert.equal(guardHolds('paused', paused), true);
  assert.equal(guardHolds('paused', closed), false);
  assert.equal(guardHolds(null, closed), true);
  assert.equal(guardHolds(undefined, closed), true);
  assert.equal(guardHolds('open', null), false, 'no row: nothing holds');
  assert.equal(guardHolds('nonsense', open), false, 'an unknown name never holds');
});

test('changedFields: only what really differs, details compared by content', () => {
  const base = confirmed({ details: { side: 'L', paused: true } });
  assert.deepEqual(changedFields(base, { ...base }), []);
  assert.deepEqual(changedFields(base, { ...base, endedAt: T1 }), ['endedAt']);
  assert.deepEqual(changedFields(base, { ...base, details: { paused: true, side: 'L' } }), [], 'same keys, other order');
  assert.deepEqual(changedFields(base, { ...base, details: { side: 'R', paused: true } }), ['details']);
  assert.deepEqual(changedFields(base, { ...base, details: { side: 'L' } }), ['details'], 'a key removed');
  assert.deepEqual(changedFields(base, { ...base, startedAt: T1, endedAt: T1, details: {} }), ['startedAt', 'endedAt', 'details']);
  assert.deepEqual(changedFields({ ...base, details: { presets: [60, 90] } }, { ...base, details: { presets: [60, 90] } }), []);
  assert.deepEqual(changedFields({ ...base, details: { presets: [60, 90] } }, { ...base, details: { presets: [60, 120] } }), ['details']);
  assert.deepEqual(changedFields({ ...base, endedAt: undefined }, { ...base, endedAt: null }), [], 'undefined reads as null');
  const o = op({ kind: 'update', fields: ['endedAt', 'details'], plain: plain({ endedAt: T1, details: { side: 'R' } }) });
  assert.deepEqual(fieldPatch(o), { endedAt: T1, details: { side: 'R' } });
  assert.deepEqual(fieldPatch(op({ fields: [] })), {});
});

test('coalesce: a first op is appended with n, key and the flags; inputs are never mutated', () => {
  const inc = incoming({ kind: 'create', baseSeq: null, fields: [] });
  const res = coalesce([], inc, 7, key);
  assert.equal(res.ops.length, 1);
  assert.equal(res.put.length, 1);
  assert.deepEqual(res.del, []);
  const o = res.ops[0];
  assert.equal(o.n, 7);
  assert.equal(o.key, 'op:7');
  assert.equal(o.sent, false);
  assert.equal(o.dead, false);
  assert.equal(o.tries, 0);
  assert.equal(o.parked, null);
  assert.equal(o.plain.rev, 2);
  assert.equal(Object.hasOwn(inc, 'n'), false, 'the incoming op is untouched');
});

test('coalesce: create + update → one create with the new blob; update + update (same guard) merge fields', () => {
  const c = op();
  let res = coalesce([c], incoming({ fields: ['endedAt'] }), 2, key);
  assert.equal(res.ops.length, 1);
  assert.equal(res.ops[0].kind, 'create');
  assert.equal(res.ops[0].blob, 'BBB');
  assert.equal(res.ops[0].plain.endedAt, T1);
  assert.equal(res.ops[0].n, 1, 'the create keeps its place');
  assert.equal(res.put.length, 1);
  assert.deepEqual(res.del, []);
  assert.equal(c.blob, 'AAA', 'the old op object is untouched');

  const u = op({ kind: 'update', blob: 'U1', baseSeq: 5, fields: ['startedAt'], guard: null });
  res = coalesce([u], incoming({ blob: 'U2', fields: ['endedAt'] }), 2, key);
  assert.equal(res.ops.length, 1);
  assert.equal(res.ops[0].blob, 'U2');
  assert.deepEqual(res.ops[0].fields, ['startedAt', 'endedAt']);
  assert.equal(res.ops[0].baseSeq, 5, 'the first base stays: that is the row the server holds');

  // A different guard is a different promise about the row: a follower.
  res = coalesce([u], incoming({ blob: 'U3', guard: 'open' }), 2, key);
  assert.equal(res.ops.length, 2);
  assert.equal(res.ops[1].guard, 'open');
});

test('coalesce: a sent op is frozen — anything after it is a follower', () => {
  const sent = op({ sent: true });
  const res = coalesce([sent], incoming(), 2, key);
  assert.equal(res.ops.length, 2);
  assert.equal(res.ops[0], sent);
  assert.equal(res.ops[1].kind, 'update');
  assert.equal(res.ops[1].n, 2);
  const rm = coalesce([sent], incoming({ kind: 'remove', blob: null, fields: [], plain: null }), 2, key);
  assert.equal(rm.ops.length, 2, 'a sent create cannot be undone locally');
  assert.equal(rm.ops[1].kind, 'remove');
});

test('coalesce: create + remove → dead (a local tombstone, never sent); restore revives it; a dead create + update stays dead', () => {
  const c = op();
  const dead = coalesce([c], incoming({ kind: 'remove', blob: null, fields: [], plain: null }), 2, key);
  assert.equal(dead.ops.length, 1);
  assert.equal(dead.ops[0].dead, true);
  assert.equal(dead.ops[0].kind, 'create');
  const back = coalesce(dead.ops, incoming({ kind: 'restore', blob: null, fields: [], plain: null }), 3, key);
  assert.equal(back.ops.length, 1);
  assert.equal(back.ops[0].dead, false);
  assert.equal(back.put[0].key, key(1), 'the same record, revived');
  const edit = coalesce(dead.ops, incoming(), 3, key);
  assert.equal(edit.ops.length, 2, 'an edit of a dead entry is a follower — it cannot apply and will be dropped');
});

test('coalesce: update + remove → remove replaces the edit; remove + restore cancel out; restore + remove cancel out', () => {
  const u = op({ kind: 'update', baseSeq: 5, fields: ['details'] });
  const res = coalesce([u], incoming({ kind: 'remove', blob: null, fields: [], plain: null }), 2, key);
  assert.equal(res.ops.length, 1);
  assert.equal(res.ops[0].kind, 'remove');
  assert.deepEqual(res.del, [key(1)]);
  const r = op({ kind: 'remove', blob: null });
  const undone = coalesce([r], incoming({ kind: 'restore', blob: null, fields: [], plain: null }), 2, key);
  assert.deepEqual(undone.ops, []);
  assert.deepEqual(undone.del, [key(1)]);
  const rs = op({ kind: 'restore', blob: null });
  const again = coalesce([rs], incoming({ kind: 'remove', blob: null, fields: [], plain: null }), 2, key);
  assert.deepEqual(again.ops, []);
});

test('coalesce: a parked op is unparked by a change; other eids are left alone', () => {
  const parked = op({ parked: { status: 400, code: 'x', message: 'y' } });
  const res = coalesce([parked, op({ n: 2, key: key(2), eid: EID2 })], incoming(), 3, key);
  const mine = res.ops.find((o) => o.eid === EID);
  assert.equal(mine.parked, null);
  assert.equal(mine.blob, 'BBB');
  assert.equal(res.ops.find((o) => o.eid === EID2).blob, 'AAA');
});

test('overlay: a pending create shows with a placeholder seq, an update keeps the confirmed seq, remove/restore flip deletedAt; the confirmed map is untouched', () => {
  const conf = new Map([[EID2, confirmed({ eid: EID2, seq: 3, type: 'diaper', details: { kind: 'pee' } })]]);
  const before = JSON.stringify([...conf]);
  const eff = overlay(conf, [op()], TODAY);
  assert.equal(JSON.stringify([...conf]), before, 'never mutated');
  const e = eff.get(EID);
  assert.equal(e.seq, PENDING_SEQ_BASE + 1);
  assert.equal(e.pending, 'waiting');
  assert.equal(e.type, 'sleep');
  assert.equal(e.deletedAt, null);
  assert.equal(e.createdAt, null);
  assert.equal(eff.get(EID2).pending, undefined);

  const upd = overlay(new Map([[EID, confirmed()]]), [op({ kind: 'update', baseSeq: 5, fields: ['endedAt'], plain: plain({ rev: 2, endedAt: T1 }), sent: true, inflight: true })], TODAY);
  assert.equal(upd.get(EID).seq, 5, 'the confirmed seq: a form opened on it sends a real ifSeq');
  assert.equal(upd.get(EID).endedAt, T1);
  assert.equal(upd.get(EID).rev, 2);
  assert.equal(upd.get(EID).pending, 'sending');

  const rm = overlay(new Map([[EID, confirmed()]]), [op({ kind: 'remove', blob: null, plain: null })], TODAY);
  assert.equal(rm.get(EID).deletedAt, TODAY);
  const rs = overlay(new Map([[EID, confirmed({ deletedAt: TODAY })]]), [op({ kind: 'restore', blob: null, plain: null })], TODAY);
  assert.equal(rs.get(EID).deletedAt, null);
  const dead = overlay(new Map(), [op({ dead: true })], TODAY);
  assert.equal(dead.get(EID).deletedAt, TODAY, 'a dead create is a tombstone');
});

test('overlay: a create that already landed reads as the confirmed row; ops over a missing or deleted base read as nothing; a parked op reads as parked', () => {
  const conf = new Map([[EID, confirmed({ seq: 9 })]]);
  const eff = overlay(conf, [op()], TODAY);
  assert.equal(eff.get(EID).seq, 9);
  assert.equal(eff.get(EID).pending, undefined);
  const none = overlay(new Map(), [op({ kind: 'update', baseSeq: 5 })], TODAY);
  assert.equal(none.has(EID), false);
  const del = overlay(new Map([[EID, confirmed({ deletedAt: TODAY })]]), [op({ kind: 'update', baseSeq: 5 })], TODAY);
  assert.equal(del.get(EID).deletedAt, TODAY, 'the partner deleted it: our edit shows nothing');
  const parked = overlay(new Map(), [op({ parked: { status: 400 } })], TODAY);
  assert.equal(parked.get(EID).pending, 'parked');
  assert.equal(statusOf(op({ parked: { status: 400 }, sent: true, inflight: true })), 'parked');
  assert.equal(statusOf(op({ sent: true, inflight: true })), 'sending');
  assert.equal(statusOf(op({ sent: true })), 'waiting', 'frozen but not on the wire: still waiting');
  assert.equal(statusOf(op()), 'waiting');
});

test('overlay: ops fold in order — a follower sees its predecessor', () => {
  const create = op();
  const follow = op({ n: 2, key: key(2), kind: 'update', baseSeq: PENDING_SEQ_BASE + 1, fields: ['endedAt'], plain: plain({ rev: 2, endedAt: T1 }) });
  const eff = overlay(new Map(), [follow, create], TODAY);
  assert.equal(eff.get(EID).endedAt, T1);
  assert.equal(eff.get(EID).seq, PENDING_SEQ_BASE + 1);
});

test('classify: what an answer means for the op — only the API\'s own (a status WITH a code) is a verdict', () => {
  const e = (status, code) => Object.assign(new Error('x'), status === null ? {} : { status, code });
  assert.equal(classify(e(null), 'create'), 'transient', 'no answer at all');
  assert.equal(classify(new Error('x'), 'update'), 'transient');
  // A status without the API's code: a challenge page, a proxy's error page
  // — something in between answered, not the API. Whatever it says: try later.
  for (const s of [403, 404, 409, 400, 401, 429, 503, 507]) assert.equal(classify(e(s), 'create'), 'transient', `${s} without a code`);
  assert.equal(classify(e(500, 'server.internal'), 'create'), 'transient', 'may or may not have applied');
  assert.equal(classify(e(502, 'x.y'), 'create'), 'transient');
  assert.equal(classify(e(503, 'server.busy'), 'create'), 'notApplied');
  assert.equal(classify(e(429, 'request.writeBudget'), 'create'), 'notApplied');
  assert.equal(classify(e(401, 'auth.notLoggedIn'), 'create'), 'auth');
  assert.equal(classify(e(409, 'entries.exists'), 'create'), 'exists');
  assert.equal(classify(e(409, 'entries.conflict'), 'update'), 'conflict');
  assert.equal(classify(e(409, 'entries.conflict'), 'remove'), 'conflict');
  assert.equal(classify(e(404, 'entries.notFound'), 'update'), 'gone');
  assert.equal(classify(e(404, 'entries.notFound'), 'restore'), 'gone');
  for (const s of [400, 413, 415, 405, 507]) assert.equal(classify(e(s, 'request.x'), 'create'), 'permanent', String(s));
});

test('reconcile: a create sends unless the eid is already confirmed; a dead op drops', () => {
  assert.deepEqual(reconcile(op(), undefined, undefined), { action: 'send' });
  assert.deepEqual(reconcile(op(), confirmed(), undefined), { action: 'done' });
  assert.deepEqual(reconcile(op({ dead: true }), undefined, undefined), { action: 'drop', reason: 'dead' });
});

test('reconcile: an update over a gone row drops, over our own landed blob is done, rebases when the row moved, drops when the guard fails', () => {
  const u = op({ kind: 'update', blob: 'BBB', baseSeq: 5, fields: ['endedAt'], guard: 'open', plain: plain({ rev: 2, endedAt: T1 }) });
  assert.deepEqual(reconcile(u, undefined, undefined), { action: 'drop', reason: 'gone' });
  assert.deepEqual(reconcile(u, confirmed({ deletedAt: TODAY }), undefined), { action: 'drop', reason: 'gone' });
  assert.deepEqual(reconcile(u, confirmed({ error: 'kaputt' }), undefined), { action: 'drop', reason: 'gone' });
  assert.deepEqual(reconcile(u, confirmed({ seq: 6, endedAt: T1 }), 'BBB'), { action: 'done' }, 'the answer was lost: the blob proves it');
  assert.deepEqual(reconcile(u, confirmed({ seq: 5 }), undefined), { action: 'send' }, 'the base is untouched');
  assert.deepEqual(reconcile(u, confirmed({ seq: 6, startedAt: T1 }), 'CCC'), { action: 'rebase' }, 'the partner moved the start');
  assert.deepEqual(reconcile(u, confirmed({ seq: 6, endedAt: T1 }), 'CCC'), { action: 'drop', reason: 'guard' }, 'the partner ended it');
  const plainEdit = op({ ...u, guard: null });
  assert.deepEqual(reconcile(plainEdit, confirmed({ seq: 6, endedAt: T1 }), 'CCC'), { action: 'rebase' }, 'no guard: lay our fields over theirs');
});

test('reconcile: remove and restore are done when already in effect, dropped when the row is gone', () => {
  const rm = op({ kind: 'remove', blob: null, plain: null });
  assert.deepEqual(reconcile(rm, undefined, undefined), { action: 'drop', reason: 'gone' });
  assert.deepEqual(reconcile(rm, confirmed({ deletedAt: TODAY }), undefined), { action: 'done' });
  assert.deepEqual(reconcile(rm, confirmed({ seq: 8 }), undefined), { action: 'send' }, 'the row moved: the delete still wins');
  const rs = op({ kind: 'restore', blob: null, plain: null });
  assert.deepEqual(reconcile(rs, undefined, undefined), { action: 'drop', reason: 'gone' });
  assert.deepEqual(reconcile(rs, confirmed(), undefined), { action: 'done' });
  assert.deepEqual(reconcile(rs, confirmed({ deletedAt: TODAY }), undefined), { action: 'send' });
  assert.deepEqual(reconcile(op({ kind: 'nonsense' }), confirmed(), undefined), { action: 'drop', reason: 'gone' });
});

test('nextOp: oldest first; a parked or dead op holds its own followers back, not other entries', () => {
  const a1 = op({ n: 1, key: key(1), parked: { status: 400 } });
  const a2 = op({ n: 2, key: key(2), kind: 'update' });
  const b3 = op({ n: 3, key: key(3), eid: EID2 });
  assert.equal(nextOp([b3, a2, a1]), b3);
  assert.equal(nextOp([a1, a2]), null);
  assert.equal(nextOp([op({ dead: true }), b3]), b3);
  assert.equal(nextOp([]), null);
  assert.equal(nextOp([a2, b3]), a2);
});

test('summary: entries (not ops) still to send, and entries refused for good; dead ones do not count', () => {
  assert.deepEqual(summary([]), { waiting: 0, parked: 0 });
  assert.deepEqual(summary([op(), op({ n: 2, key: key(2), kind: 'update', sent: true })]), { waiting: 1, parked: 0 }, 'two ops, one entry');
  assert.deepEqual(summary([op({ parked: { status: 400 } }), op({ n: 2, key: key(2), eid: EID2 })]), { waiting: 1, parked: 1 });
  assert.deepEqual(summary([op({ dead: true })]), { waiting: 0, parked: 0 });
});
