// node --test src/tests/*.test.mjs  (Node >= 20; `npm test` runs it after the PHP suite)
//
// Tests for scripts/export-plain.mjs, the offline recovery tool:
//   - askHidden() never lets a typed character reach its output stream (a
//     backspace made the previous version re-render the whole secret), on
//     PassThrough streams — no pty needed;
//   - the command itself, run against a fixture database built with the
//     sqlite3 CLI and real key material from src/crypto.js: family password
//     and recovery code both decrypt the two encrypted rows, the tombstones
//     (one of them without any content) stay out, a wrong password
//     and an ambiguous family fail cleanly, and the secret never shows up on
//     stderr. Skipped when sqlite3 is not in PATH (the tool needs it anyway).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { askHidden } from '../../scripts/export-plain.mjs';
import {
  b64u,
  randomBytes,
  randomEid,
  deriveKeys,
  generateFdkRaw,
  wrapFdk,
  importFdk,
  recoveryCode,
  encryptEntry,
  encryptProfile,
} from '../crypto.js';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/export-plain.mjs');
const FAMILY_ID = 1;
const PASSWORD = 'Familien-Passwort Zx9';
const DISPLAY_NAME = 'Mamä';

// ---------------------------------------------------------------------------
// askHidden

/** Run askHidden on PassThrough streams; feed the input in chunks; return {answer, output}. */
async function drive(question, chunks, { endInput = false } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const written = [];
  output.on('data', (c) => written.push(c.toString()));
  const pending = askHidden(question, { input, output });
  for (const chunk of chunks) input.write(chunk);
  if (endInput) input.end();
  const answer = await pending;
  await new Promise((r) => setImmediate(r)); // let the trailing "\n" land
  return { answer, output: written };
}

test('askHidden: the answer comes back, the output never carries a typed character', async () => {
  const question = 'Family password: ';
  // None of these characters occur in the prompt, and none is a digit or a
  // CSI final byte (a cursor escape like "\x1b[9G" legitimately carries those).
  const secret = 'Zx!Qq-Ü';
  // A typo corrected with backspace forces readline's full-line re-render.
  const { answer, output } = await drive(question, [...'Zx!Qq-ÜX', '\x7f', '\n']);
  assert.equal(answer, secret);
  assert.equal(output[0], question, 'the prompt is written first, by us');
  assert.equal(output[output.length - 1], '\n', 'a newline closes the hidden line');
  const rest = output.slice(1, -1);
  // Only cursor escape sequences may follow the prompt — chunk by chunk.
  for (const chunk of rest) {
    assert.match(chunk, /^(\x1b\[[0-9;]*[A-Za-z])+$/, `unexpected output chunk: ${JSON.stringify(chunk)}`);
  }
  for (const ch of secret + 'X') {
    assert.ok(!rest.join('').includes(ch), `typed character ${JSON.stringify(ch)} reached the output`);
  }
});

test('askHidden: a pasted line, and an input that ends without a newline', async () => {
  const pasted = await drive('Code: ', ['abc-def\n']);
  assert.equal(pasted.answer, 'abc-def');
  const cut = await drive('Code: ', ['partial'], { endInput: true });
  assert.equal(cut.answer, 'partial');
  assert.equal(cut.output.join('').replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''), 'Code: \n');
});

// ---------------------------------------------------------------------------
// The command against a fixture database

const sqlite3 = spawnSync('sqlite3', ['--version'], { encoding: 'utf8' });
const haveSqlite3 = !sqlite3.error && sqlite3.status === 0;

function q(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/** The tables the tool reads (as api/lib/db.php creates them). */
const DDL = `
CREATE TABLE families (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
  auth_hash TEXT NOT NULL, kdf_salt TEXT NOT NULL, kdf_iter INTEGER NOT NULL, fdk_wrapped TEXT NOT NULL,
  recovery_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d','now'))
);
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, family_id INTEGER NOT NULL, username TEXT NOT NULL UNIQUE,
  auth_hash TEXT NOT NULL, kdf_salt TEXT NOT NULL, kdf_iter INTEGER NOT NULL, fdk_wrapped TEXT NOT NULL,
  profile_blob TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d','now'))
);
CREATE TABLE entries (
  eid TEXT PRIMARY KEY, family_id INTEGER NOT NULL, seq INTEGER NOT NULL, blob TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
INSERT INTO settings (key, value) VALUES ('schema_version', '4'),
  ('salt_secret', lower(hex(randomblob(32)))), ('feed_id', lower(hex(randomblob(16))));
`;

/**
 * Build the fixture: family 1 (Testfamilie) with a real wrapped FDK under
 * PASSWORD, user mama with an encrypted profile, two encrypted entries, one
 * encrypted tombstone and one without content; family 2 (Andere) with its
 * own key and one row that must never show up. Returns what the assertions
 * need.
 */
async function buildFixture(dir) {
  const dbFile = path.join(dir, 'fixture.db');
  const salt = randomBytes(16);
  const { kek } = await deriveKeys(PASSWORD, salt, 600000, 'family');
  const fdkRaw = await generateFdkRaw();
  const wrapped = await wrapFdk(fdkRaw, kek);
  const fdk = await importFdk(fdkRaw, false);

  const plain = {
    breastfeed: {
      eid: randomEid(),
      rev: 1,
      type: 'breastfeed',
      startedAt: '2026-09-05T03:12:00Z',
      endedAt: '2026-09-05T03:31:00Z',
      details: { side: 'L' },
      loggedBy: 'Mamä',
    },
    diaper: {
      eid: randomEid(),
      rev: 1,
      type: 'diaper',
      startedAt: '2026-09-06T07:02:00Z',
      endedAt: null,
      details: { kind: 'both' },
      loggedBy: 'Papa',
    },
    tombstone: {
      eid: randomEid(),
      rev: 2,
      type: 'sleep',
      startedAt: '2026-09-06T09:00:00Z',
      endedAt: '2026-09-06T10:00:00Z',
      details: {},
      loggedBy: 'Papa',
    },
  };
  const emptyEid = randomEid();
  const otherFdk = await importFdk(await generateFdkRaw(), false);
  const otherEid = randomEid();
  const otherBlob = await encryptEntry(otherFdk, 2, {
    eid: otherEid,
    rev: 1,
    type: 'bottle',
    startedAt: '2026-09-06T05:00:00Z',
    endedAt: null,
    details: { amount_ml: 70 },
    loggedBy: 'Oma',
  });

  const sql = [
    DDL,
    `INSERT INTO families (id, name, name_key, auth_hash, kdf_salt, kdf_iter, fdk_wrapped, recovery_hash)
       VALUES (1, 'Testfamilie', 'testfamilie', 'x', ${q(b64u(salt))}, 600000, ${q(wrapped)}, 'x');`,
    `INSERT INTO families (id, name, name_key, auth_hash, kdf_salt, kdf_iter, fdk_wrapped, recovery_hash)
       VALUES (2, 'Andere', 'andere', 'x', ${q(b64u(randomBytes(16)))}, 600000, ${q(b64u(randomBytes(40)))}, 'x');`,
    `INSERT INTO users (id, family_id, username, auth_hash, kdf_salt, kdf_iter, fdk_wrapped, profile_blob)
       VALUES (1, 1, 'mama', 'x', 's', 600000, 'w', ${q(await encryptProfile(fdk, 'mama', { displayName: DISPLAY_NAME }))});`,
    `INSERT INTO users (id, family_id, username, auth_hash, kdf_salt, kdf_iter, fdk_wrapped, profile_blob)
       VALUES (2, 1, 'papa', 'x', 's', 600000, 'w', NULL);`,
    `INSERT INTO entries (eid, family_id, seq, blob, created_at, updated_at, deleted_at)
       VALUES (${q(emptyEid)}, 1, 1, NULL, '2026-08-30', '2026-08-31', '2026-08-31');`,
    `INSERT INTO entries (eid, family_id, seq, blob, created_at, updated_at, deleted_at)
       VALUES (${q(plain.breastfeed.eid)}, 1, 2, ${q(await encryptEntry(fdk, FAMILY_ID, plain.breastfeed))}, '2026-09-05', '2026-09-05', NULL);`,
    `INSERT INTO entries (eid, family_id, seq, blob, created_at, updated_at, deleted_at)
       VALUES (${q(plain.diaper.eid)}, 1, 3, ${q(await encryptEntry(fdk, FAMILY_ID, plain.diaper))}, '2026-09-06', '2026-09-06', NULL);`,
    `INSERT INTO entries (eid, family_id, seq, blob, created_at, updated_at, deleted_at)
       VALUES (${q(plain.tombstone.eid)}, 1, 5, ${q(await encryptEntry(fdk, FAMILY_ID, plain.tombstone))}, '2026-09-06', '2026-09-06', '2026-09-06');`,
    `INSERT INTO entries (eid, family_id, seq, blob, created_at, updated_at, deleted_at)
       VALUES (${q(otherEid)}, 2, 1, ${q(otherBlob)}, '2026-09-06', '2026-09-06', NULL);`,
  ].join('\n');
  const res = spawnSync('sqlite3', [dbFile], { input: sql, encoding: 'utf8' });
  assert.equal(res.status, 0, `sqlite3 failed to build the fixture: ${res.stderr}`);
  return { dbFile, plain, emptyEid, otherEid, recoveryCode: recoveryCode(fdkRaw) };
}

function runTool(args, stdin) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { input: stdin, encoding: 'utf8', timeout: 60000 });
}

function assertExport(res, fixture, secret) {
  assert.equal(res.status, 0, `exit ${res.status}, stderr: ${res.stderr}`);
  assert.ok(!res.stderr.includes(secret), `the secret was echoed: ${JSON.stringify(res.stderr)}`);
  assert.ok(!res.stdout.includes(secret), 'the secret is not in the export');
  const out = JSON.parse(res.stdout);
  assert.deepEqual(Object.keys(out), ['family', 'exportedAt', 'users', 'entries', 'errors']);
  assert.equal(out.family, 'Testfamilie');
  assert.ok(!Number.isNaN(Date.parse(out.exportedAt)));
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.users, [
    { username: 'mama', displayName: DISPLAY_NAME },
    { username: 'papa', displayName: null },
  ]);

  const { plain } = fixture;
  assert.equal(out.entries.length, 2);
  assert.deepEqual(
    out.entries.map((e) => e.eid),
    [plain.diaper.eid, plain.breastfeed.eid],
    'newest first'
  );
  assert.ok(!res.stdout.includes(plain.tombstone.eid), 'the tombstone is absent');
  assert.ok(!res.stdout.includes(fixture.emptyEid), 'so is the tombstone without content');
  assert.ok(!res.stdout.includes(fixture.otherEid), 'the other family is absent');

  assert.deepEqual(out.entries[0], {
    eid: plain.diaper.eid,
    seq: 3,
    createdAt: '2026-09-06',
    updatedAt: '2026-09-06',
    type: 'diaper',
    startedAt: '2026-09-06T07:02:00Z',
    endedAt: null,
    details: { kind: 'both' },
    loggedBy: 'Papa',
  });
  assert.deepEqual(out.entries[1], {
    eid: plain.breastfeed.eid,
    seq: 2,
    createdAt: '2026-09-05',
    updatedAt: '2026-09-05',
    type: 'breastfeed',
    startedAt: '2026-09-05T03:12:00Z',
    endedAt: '2026-09-05T03:31:00Z',
    details: { side: 'L' },
    loggedBy: 'Mamä',
  });
  assert.match(res.stderr, /Exported 2 entries \(0 failed to decrypt, 2 deleted left out\)/);
  return out;
}

test('export-plain.mjs decrypts a database with the family password and with the recovery code', { skip: haveSqlite3 ? false : 'sqlite3 CLI not in PATH' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-export-'));
  try {
    const fixture = await buildFixture(dir);

    // Family password (PBKDF2 at 600k, once).
    const byPassword = runTool([fixture.dbFile, '--family', 'Testfamilie'], PASSWORD + '\n');
    assertExport(byPassword, fixture, PASSWORD);
    assert.ok(byPassword.stderr.includes('Family password: '), 'prompt on stderr');
    assert.ok(byPassword.stderr.includes('Family: Testfamilie (id 1)'));

    // Recovery code, family name folded like the server folds it.
    const byCode = runTool([fixture.dbFile, '--recovery-code', '--family', '  TESTFAMILIE '], fixture.recoveryCode + '\n');
    assertExport(byCode, fixture, fixture.recoveryCode);
    assert.ok(byCode.stderr.includes('Recovery code: '));
    assert.ok(!byCode.stderr.includes('PBKDF2'), 'no derivation with the code');

    // Failure modes: wrong password, bad code, ambiguous / unknown family, no such file.
    const wrong = runTool([fixture.dbFile, '--family', 'Testfamilie'], 'not the password\n');
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /Wrong family password/);
    assert.equal(wrong.stdout, '', 'nothing exported');
    const badCode = runTool([fixture.dbFile, '--recovery-code', '--family', 'Testfamilie'], 'abc\n');
    assert.equal(badCode.status, 1);
    assert.match(badCode.stderr, /Not a recovery code/);
    const ambiguous = runTool([fixture.dbFile], PASSWORD + '\n');
    assert.equal(ambiguous.status, 1);
    assert.match(ambiguous.stderr, /Several families — pick one with --family: Testfamilie, Andere/);
    const unknown = runTool([fixture.dbFile, '--family', 'Niemand'], PASSWORD + '\n');
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Family "Niemand" not found/);
    const missing = runTool([path.join(dir, 'nope.db')], PASSWORD + '\n');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /No such file/);
    const usage = runTool([], '');
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /^Usage:/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
