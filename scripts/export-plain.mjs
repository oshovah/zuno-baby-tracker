#!/usr/bin/env node
/**
 * export-plain.mjs — decrypt a baby-tracker database OFFLINE.
 *
 * The last-resort recovery path ("all phones gone, but I have the database
 * file and the family password or the recovery code"): reads the SQLite file
 * with the `sqlite3` CLI, derives the family wrap key from the family
 * password (or takes the raw key from the recovery code), unwraps the family
 * data key and prints every live entry of that family as plain JSON — using
 * the very same src/crypto.js the app runs in the browser.
 *
 * Usage:
 *   node scripts/export-plain.mjs data/baby.db [--family <name>] [--recovery-code] > export.json
 *
 * Prompts for the secret on the terminal (input hidden; a piped stdin works
 * too). Nothing is written anywhere; the JSON goes to stdout, progress to
 * stderr. Soft-deleted entries (tombstones) are left out. Needs Node >= 20
 * and the `sqlite3` command line tool in PATH. No npm dependencies.
 *
 * Output: {family, exportedAt, users: [{username, displayName}], entries:
 * [{eid, seq, createdAt, updatedAt, type, startedAt, endedAt, details,
 * loggedBy[, legacy: true]}], errors: [{eid, error}]} — entries newest first;
 * a row that will not open (wrong key, tampering) lands in errors.
 *
 * askHidden() is exported for the unit test (src/tests/export-plain.test.mjs);
 * the command itself runs only when this file is the entry point.
 */

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  deriveKeys,
  unwrapFdk,
  importFdk,
  unb64u,
  decryptEntry,
  decryptProfile,
  rawFromRecoveryCode,
} from '../src/crypto.js';

/**
 * Read one line without echoing it. The prompt goes to `output` from here;
 * readline's own writes are silenced entirely by making its _writeToOutput
 * a no-op — in terminal mode readline re-renders "prompt + everything typed
 * so far" on every cursor movement or backspace, so filtering by "contains
 * the prompt" (the previous approach) let the whole secret through on the
 * first corrected typo. Only cursor escape codes still reach the output.
 * terminal:true also puts a real TTY into raw mode (no kernel echo); a pipe
 * simply has no setRawMode and works as is. Resolves with the line; when the
 * input ends first, with whatever was typed (a missing secret fails later,
 * loudly, at the unwrap). Ctrl-C rejects.
 */
export function askHidden(question, { input = process.stdin, output = process.stderr } = {}) {
  return new Promise((resolve, reject) => {
    output.write(question);
    const rl = readline.createInterface({ input, output, terminal: true });
    rl._writeToOutput = () => {};
    let settled = false;
    const finish = (answer, error) => {
      if (settled) return;
      settled = true;
      output.write('\n');
      if (error) reject(error);
      else resolve(answer);
    };
    rl.question('', (answer) => {
      finish(answer);
      rl.close();
    });
    rl.on('SIGINT', () => {
      finish(null, new Error('aborted'));
      rl.close();
    });
    rl.on('close', () => finish(rl.line));
  });
}

function nameKey(s) {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function makeSql(dbFile) {
  return (query) => {
    const res = spawnSync('sqlite3', ['-json', dbFile, query], { encoding: 'utf8' });
    if (res.error) throw new Error(`could not run sqlite3: ${res.error.message}`);
    if (res.status !== 0) throw new Error(`sqlite3 failed: ${res.stderr.trim()}`);
    return res.stdout.trim() === '' ? [] : JSON.parse(res.stdout);
  };
}

async function main(args) {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.error('Usage: node scripts/export-plain.mjs <baby.db> [--family <name>] [--recovery-code]');
    return args.length === 0 ? 2 : 0;
  }
  const dbFile = args[0];
  const familyArg = args.includes('--family') ? args[args.indexOf('--family') + 1] : null;
  const useRecovery = args.includes('--recovery-code');
  if (!fs.existsSync(dbFile)) {
    console.error(`No such file: ${dbFile}`);
    return 1;
  }
  const sql = makeSql(dbFile);

  const families = sql('SELECT id, name, name_key, kdf_salt, kdf_iter, fdk_wrapped FROM families ORDER BY id');
  if (families.length === 0) {
    console.error('No families in this database (still the pre-accounts schema? then the entries are plaintext — use sqlite3 directly).');
    return 1;
  }
  let family;
  if (familyArg) {
    family = families.find((f) => f.name_key === nameKey(familyArg));
    if (!family) {
      console.error(`Family "${familyArg}" not found. Known: ${families.map((f) => f.name).join(', ')}`);
      return 1;
    }
  } else if (families.length === 1) {
    family = families[0];
  } else {
    console.error(`Several families — pick one with --family: ${families.map((f) => f.name).join(', ')}`);
    return 1;
  }
  console.error(`Family: ${family.name} (id ${family.id})`);

  let fdkRaw;
  if (useRecovery) {
    const code = await askHidden('Recovery code: ');
    try {
      fdkRaw = rawFromRecoveryCode(code);
    } catch (e) {
      console.error(`Not a recovery code (43 characters, shown under «Mehr»): ${e.message}`);
      return 1;
    }
  } else {
    const password = await askHidden('Family password: ');
    console.error('Deriving the key (PBKDF2, a moment) …');
    let kek;
    try {
      ({ kek } = await deriveKeys(password, unb64u(family.kdf_salt), Number(family.kdf_iter), 'family'));
    } catch (e) {
      console.error(`Cannot derive the key: ${e.message}`);
      return 1;
    }
    try {
      fdkRaw = await unwrapFdk(family.fdk_wrapped, kek);
    } catch (e) {
      console.error('Wrong family password (the wrapped key did not unwrap).');
      return 1;
    }
  }
  const fdk = await importFdk(fdkRaw, false);

  // Tombstones stay out: a soft-deleted entry was deleted on purpose (or its
  // legacy plaintext was scrubbed at the seal); the count goes to stderr.
  const fid = Number(family.id);
  const rows = sql(
    `SELECT eid, seq, blob, legacy_type, legacy_started_at, legacy_ended_at, legacy_details, legacy_logged_by,
            created_at, updated_at
       FROM entries WHERE family_id = ${fid} AND deleted_at IS NULL ORDER BY seq`
  );
  const deleted = sql(`SELECT COUNT(*) AS n FROM entries WHERE family_id = ${fid} AND deleted_at IS NOT NULL`)[0].n;
  const users = sql(`SELECT username, profile_blob FROM users WHERE family_id = ${fid} ORDER BY id`);

  const out = { family: family.name, exportedAt: new Date().toISOString(), users: [], entries: [], errors: [] };
  for (const u of users) {
    try {
      const p = u.profile_blob ? await decryptProfile(fdk, u.username, u.profile_blob) : null;
      out.users.push({ username: u.username, displayName: p ? p.displayName : null });
    } catch (e) {
      out.users.push({ username: u.username, displayName: null, error: e.message });
    }
  }
  for (const r of rows) {
    const meta = { eid: r.eid, seq: r.seq, createdAt: r.created_at, updatedAt: r.updated_at };
    if (r.blob === null) {
      if (r.legacy_type) {
        out.entries.push({
          ...meta,
          legacy: true,
          type: r.legacy_type,
          startedAt: r.legacy_started_at,
          endedAt: r.legacy_ended_at,
          details: r.legacy_details ? JSON.parse(r.legacy_details) : {},
          loggedBy: r.legacy_logged_by,
        });
      }
      continue;
    }
    try {
      const plain = await decryptEntry(fdk, fid, r.eid, r.blob);
      out.entries.push({
        ...meta,
        type: plain.type,
        startedAt: plain.startedAt,
        endedAt: plain.endedAt,
        details: plain.details,
        loggedBy: plain.loggedBy,
      });
    } catch (e) {
      out.errors.push({ eid: r.eid, error: e.message });
    }
  }
  out.entries.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  console.error(
    `Exported ${out.entries.length} entries (${out.errors.length} failed to decrypt, ${deleted} deleted left out).`
  );
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  return 0;
}

// Run only as the entry point (the test imports askHidden). realpath on both
// sides so a symlinked checkout compares equal.
const isEntryPoint =
  process.argv[1] !== undefined && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isEntryPoint) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`export-plain: ${err && err.message ? err.message : err}`);
      process.exitCode = 1;
    }
  );
}
