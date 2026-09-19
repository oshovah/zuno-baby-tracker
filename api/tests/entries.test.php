<?php
/**
 * Entries store tests: the opaque per-family sync feed, CAS writes, soft
 * delete/restore and the row caps.
 *
 * Every test opens its OWN scratch file with the entries + settings
 * tables created here verbatim (no db.php: the store is exercised against
 * the DDL it is contracted to, independent of migration code), in WAL mode
 * with PRAGMA secure_delete = ON — exactly as bt_db opens production.
 * Families are plain integers (the store never joins the families table).
 * Mutators get a fixed $today and sync a fixed $nowIso so dates are
 * deterministic. Eids and blobs come from the shared fake_* helpers of
 * api.test.php; the helpers here carry an et_ prefix so they never collide
 * with that harness (run.php loads every test file into one process).
 */

require_once __DIR__ . '/../lib/http.php';
require_once __DIR__ . '/../lib/entries.php';

const ET_TODAY = '2026-09-06';
const ET_NOW = '2026-09-06T10:00:00Z';
const ET_FAM_A = 1;
const ET_FAM_B = 2;
const ET_ROW_KEYS = ['eid', 'seq', 'blob', 'createdAt', 'updatedAt', 'deletedAt'];
const ET_CONFLICT = 'Der Eintrag wurde inzwischen auf einem anderen Gerät geändert';

$GLOBALS['__et_files'] = [];
register_shutdown_function(function () {
    foreach ($GLOBALS['__et_files'] as $file) {
        foreach (['', '-wal', '-shm', '-journal'] as $suffix) {
            @unlink($file . $suffix);
        }
    }
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** The entries + settings DDL, column for column what lib/db.php creates (bt_entries_columns_sql). */
function et_ddl(): string
{
    return <<<'SQL'
CREATE TABLE IF NOT EXISTS entries (
  eid TEXT PRIMARY KEY,
  family_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  blob TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_entries_family_seq ON entries (family_id, seq);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
INSERT OR IGNORE INTO settings (key, value) VALUES ('schema_version', '4');
INSERT OR IGNORE INTO settings (key, value) VALUES ('feed_id', lower(hex(randomblob(16))));
SQL;
}

/** A fresh scratch file path (created empty by tempnam), unlinked at shutdown. */
function et_path(): string
{
    $file = tempnam(sys_get_temp_dir(), 'baby-entries-');
    $GLOBALS['__et_files'][] = $file;
    return $file;
}

/** Open a scratch file the way bt_db does (WAL, secure_delete) and create the tables. */
function et_open(string $file): PDO
{
    $pdo = new PDO('sqlite:' . $file);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->exec('PRAGMA busy_timeout = 5000');
    $pdo->exec('PRAGMA secure_delete = ON');
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec(et_ddl());
    return $pdo;
}

/** A fresh, empty scratch database. */
function et_db(): PDO
{
    return et_open(et_path());
}

/** Create an encrypted entry (fixed today); returns [eid, blob, row JSON]. */
function et_create(PDO $pdo, int $familyId, ?string $eid = null, ?string $blob = null): array
{
    $eid = $eid ?? fake_eid();
    $blob = $blob ?? fake_blob();
    $row = bt_create_entry($pdo, $familyId, ['eid' => $eid, 'blob' => $blob], ET_TODAY);
    return [$eid, $blob, $row];
}

/** The raw DB row (SELECT *) of an eid, regardless of family; null when absent. */
function et_raw(PDO $pdo, string $eid): ?array
{
    $stmt = $pdo->prepare('SELECT * FROM entries WHERE eid = ?');
    $stmt->execute([$eid]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row === false ? null : $row;
}

/** Strict shape check of one row JSON (the sync row contract). */
function et_assert_row(array $row, string $msg = ''): void
{
    $p = $msg !== '' ? $msg . ': ' : '';
    assert_eq(array_keys($row), ET_ROW_KEYS, $p . 'row keys');
    assert_true(is_string($row['eid']) && preg_match('/^[0-9a-f]{32}$/D', $row['eid']) === 1, $p . 'eid');
    assert_true(is_int($row['seq']) && $row['seq'] >= 1, $p . 'seq');
    assert_true($row['blob'] === null || is_string($row['blob']), $p . 'blob');
    foreach (['createdAt', 'updatedAt'] as $k) {
        assert_true(is_string($row[$k]) && preg_match('/^\d{4}-\d{2}-\d{2}$/D', $row[$k]) === 1, $p . $k);
    }
    assert_true(
        $row['deletedAt'] === null || preg_match('/^\d{4}-\d{2}-\d{2}$/D', $row['deletedAt']) === 1,
        $p . 'deletedAt'
    );
    assert_false(array_key_exists('familyId', $row), $p . 'family id is never exposed');
}

/** bt_sync_entries with the fixed now, response + every row shape-checked. */
function et_sync(PDO $pdo, int $familyId, int $since = 0, int $limit = 1000): array
{
    $res = bt_sync_entries($pdo, $familyId, $since, $limit, ET_NOW);
    $keys = array_keys($res);
    $expected = ['serverNow', 'feed', 'rows', 'next'];
    if (isset($res['reset'])) {
        $expected[] = 'reset';
        assert_eq($res['reset'], true, 'reset is only ever true');
    }
    assert_eq($keys, $expected, 'sync response keys');
    assert_eq($res['serverNow'], ET_NOW);
    assert_eq($res['feed'], bt_feed_id($pdo), 'feed is settings.feed_id on every page');
    assert_true(preg_match('/^[0-9a-f]{32}$/D', $res['feed']) === 1, 'feed is 32 hex');
    assert_true($res['next'] === null || is_int($res['next']), 'next');
    foreach ($res['rows'] as $i => $row) {
        et_assert_row($row, "row $i");
    }
    return $res;
}

/** The seqs of a sync page, in order. */
function et_seqs(array $res): array
{
    return array_map(function ($r) {
        return $r['seq'];
    }, $res['rows']);
}

/** Assert that $fn throws HttpError($status) with exactly $message (and, when given, $code; a code is always required). */
function et_assert_error(callable $fn, int $status, string $message, string $msg = '', ?string $code = null): void
{
    try {
        $fn();
    } catch (HttpError $e) {
        assert_eq($e->status, $status, ($msg !== '' ? $msg . ' – ' : '') . 'status');
        assert_eq($e->getMessage(), $message, ($msg !== '' ? $msg . ' – ' : '') . 'message');
        assert_true(is_string($e->code) && $e->code !== '', ($msg !== '' ? $msg . ' – ' : '') . 'carries a code');
        if ($code !== null) {
            assert_eq($e->code, $code, ($msg !== '' ? $msg . ' – ' : '') . 'code');
        }
        return;
    }
    throw new BtAssertionError(($msg !== '' ? $msg . ' – ' : '') . "expected HttpError($status), nothing thrown");
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

bt_test('bt_valid_eid: exactly 32 lowercase hex', function () {
    $eid = fake_eid();
    assert_eq(bt_valid_eid($eid), $eid);
    foreach ([strtoupper($eid), substr($eid, 1), $eid . 'a', str_repeat('g', 32), 42, null, ['x'], ''] as $bad) {
        et_assert_error(function () use ($bad) {
            bt_valid_eid($bad);
        }, 400, 'Ungültiger Eintrag', bt_format($bad));
    }
});

bt_test('bt_valid_blob: canonical base64url, 29..4096 decoded bytes, returned verbatim', function () {
    $min = fake_blob(29);
    $max = fake_blob(4096);
    assert_eq(bt_valid_blob($min), $min);
    assert_eq(bt_valid_blob($max), $max);
    assert_eq(strlen($max), 5462, 'the longest valid encoding');
    // 31 bytes end in a 2-char group whose 4 trailing bits must be zero.
    $ok = fake_b64u(random_bytes(31));
    assert_eq(bt_valid_blob($ok), $ok);

    $bad = [
        'too short (28 bytes)' => fake_blob(28),
        'too long (4097 bytes)' => fake_blob(4097),
        'padding' => fake_b64u(random_bytes(64)) . '==',
        'standard alphabet +' => str_replace(['-', '_'], '+', fake_blob(64)) . '+',
        'standard alphabet /' => fake_blob(63) . '/',
        'whitespace' => ' ' . fake_blob(64),
        'length 1 mod 4' => fake_blob(30) . 'A',
        'non-canonical trailing bits' => substr(fake_blob(31), 0, -1) . 'B', // 'B' = 000001: stray bits
        'empty' => '',
        'not a string' => 12345,
        'null' => null,
        'array' => [fake_blob()],
    ];
    foreach ($bad as $label => $value) {
        et_assert_error(function () use ($value) {
            bt_valid_blob($value);
        }, 400, 'Ungültiger Datensatz', $label);
    }
});

bt_test('bt_today is the UTC day, bt_now_iso the canonical instant', function () {
    assert_eq(bt_today(), gmdate('Y-m-d'));
    assert_true(preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/D', bt_now_iso()) === 1);
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

bt_test('create stores the blob verbatim with seq 1, 2, 3 per family (families interleaved)', function () {
    $pdo = et_db();
    list($a1, $blobA1, $rowA1) = et_create($pdo, ET_FAM_A);
    list($b1, , $rowB1) = et_create($pdo, ET_FAM_B);
    list($a2, , $rowA2) = et_create($pdo, ET_FAM_A);
    list($b2, , $rowB2) = et_create($pdo, ET_FAM_B);
    list($a3, , $rowA3) = et_create($pdo, ET_FAM_A);

    foreach ([$rowA1, $rowB1, $rowA2, $rowB2, $rowA3] as $row) {
        et_assert_row($row, 'create response');
    }
    assert_eq([$rowA1['seq'], $rowA2['seq'], $rowA3['seq']], [1, 2, 3], 'family A seqs');
    assert_eq([$rowB1['seq'], $rowB2['seq']], [1, 2], 'family B seqs are independent');

    assert_eq($rowA1, [
        'eid' => $a1,
        'seq' => 1,
        'blob' => $blobA1,
        'createdAt' => ET_TODAY,
        'updatedAt' => ET_TODAY,
        'deletedAt' => null,
    ], 'full create shape');

    $raw = et_raw($pdo, $a1);
    assert_eq($raw['blob'], $blobA1, 'stored verbatim');
    assert_eq((int) $raw['family_id'], ET_FAM_A);
    assert_eq(array_keys($raw), ['eid', 'family_id', 'seq', 'blob', 'created_at', 'updated_at', 'deleted_at'], 'no column for content');
    assert_eq(bt_next_seq($pdo, ET_FAM_A), 4);
    assert_eq(bt_next_seq($pdo, ET_FAM_B), 3);
    assert_eq(bt_next_seq($pdo, 99), 1, 'an unknown family starts at 1');
    assert_eq((int) $pdo->query('SELECT COUNT(*) FROM entries')->fetchColumn(), 5);
});

bt_test('create: 400 for a bad eid or a bad blob (plaintext fields are no substitute); 409 on a duplicate eid', function () {
    $pdo = et_db();
    et_assert_error(function () use ($pdo) {
        bt_create_entry($pdo, ET_FAM_A, ['eid' => strtoupper(fake_eid()), 'blob' => fake_blob()], ET_TODAY);
    }, 400, 'Ungültiger Eintrag', 'uppercase eid');
    et_assert_error(function () use ($pdo) {
        bt_create_entry($pdo, ET_FAM_A, ['blob' => fake_blob()], ET_TODAY);
    }, 400, 'Ungültiger Eintrag', 'missing eid');
    et_assert_error(function () use ($pdo) {
        bt_create_entry($pdo, ET_FAM_A, ['eid' => fake_eid(), 'blob' => fake_blob(10)], ET_TODAY);
    }, 400, 'Ungültiger Datensatz', 'short blob');
    et_assert_error(function () use ($pdo) {
        bt_create_entry($pdo, ET_FAM_A, ['eid' => fake_eid()], ET_TODAY);
    }, 400, 'Ungültiger Datensatz', 'missing blob');
    // Plaintext fields are never accepted in place of a blob.
    et_assert_error(function () use ($pdo) {
        bt_create_entry($pdo, ET_FAM_A, [
            'eid' => fake_eid(), 'type' => 'diaper', 'startedAt' => ET_NOW, 'details' => ['kind' => 'pee'],
        ], ET_TODAY);
    }, 400, 'Ungültiger Datensatz', 'plaintext fields, no blob');
    assert_eq((int) $pdo->query('SELECT COUNT(*) FROM entries')->fetchColumn(), 0, 'nothing written');

    list($eid, $blob) = et_create($pdo, ET_FAM_A);
    et_assert_error(function () use ($pdo, $eid) {
        bt_create_entry($pdo, ET_FAM_A, ['eid' => $eid, 'blob' => fake_blob()], ET_TODAY);
    }, 409, 'Eintrag existiert bereits', 'same family');
    et_assert_error(function () use ($pdo, $eid) {
        bt_create_entry($pdo, ET_FAM_B, ['eid' => $eid, 'blob' => fake_blob()], ET_TODAY);
    }, 409, 'Eintrag existiert bereits', 'eid is global (primary key)');
    assert_eq(et_raw($pdo, $eid)['blob'], $blob, 'the original blob survives the conflicts');
    assert_eq(bt_next_seq($pdo, ET_FAM_A), 2, 'a rejected create burns no seq');
});

bt_test('create: row caps – 507 at the family cap and at the total cap; edits, deletes and restores stay possible', function () {
    $pdo = et_db();
    // The check itself, with small caps (the constants are the production values).
    list($a1) = et_create($pdo, ET_FAM_A);
    et_create($pdo, ET_FAM_A);
    et_create($pdo, ET_FAM_B);
    bt_assert_row_budget($pdo, ET_FAM_A, 3, 10);
    et_assert_error(function () use ($pdo) {
        bt_assert_row_budget($pdo, ET_FAM_A, 2, 10);
    }, 507, 'Speicherlimit der Familie erreicht – keine neuen Einträge möglich', 'family at its cap', 'entries.familyFull');
    bt_assert_row_budget($pdo, ET_FAM_B, 2, 10);
    et_assert_error(function () use ($pdo) {
        bt_assert_row_budget($pdo, ET_FAM_B, 2, 3);
    }, 507, 'Der Speicher des Servers ist voll – keine neuen Einträge möglich', 'database at its cap', 'entries.serverFull');
    assert_true(BT_FAMILY_MAX_ROWS >= 20000 && BT_TOTAL_MAX_ROWS > BT_FAMILY_MAX_ROWS, 'sane production caps');

    // Wired into create: fill family A to the real cap in one statement
    // (tombstones count – rows are never purged), then the next create is a
    // 507 that burns no seq, while family B and every other mutation go on.
    // (Integers bound as such: execute() would bind strings, and an INTEGER
    // is always < a TEXT in SQLite – the recursion would never stop.)
    $fill = $pdo->prepare(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < :n)
         INSERT INTO entries (eid, family_id, seq, blob, created_at, updated_at, deleted_at)
         SELECT lower(hex(randomblob(16))), :fam, 1000 + i, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', :d1, :d2,
                CASE WHEN i % 2 = 0 THEN :d3 ELSE NULL END FROM n"
    );
    $fill->bindValue(':n', BT_FAMILY_MAX_ROWS - 2, PDO::PARAM_INT);
    $fill->bindValue(':fam', ET_FAM_A, PDO::PARAM_INT);
    foreach ([':d1', ':d2', ':d3'] as $name) {
        $fill->bindValue($name, ET_TODAY);
    }
    $fill->execute();
    assert_eq((int) $pdo->query('SELECT COUNT(*) FROM entries WHERE family_id = ' . ET_FAM_A)->fetchColumn(), BT_FAMILY_MAX_ROWS);
    $next = bt_next_seq($pdo, ET_FAM_A);
    et_assert_error(function () use ($pdo) {
        bt_create_entry($pdo, ET_FAM_A, ['eid' => fake_eid(), 'blob' => fake_blob()], ET_TODAY);
    }, 507, 'Speicherlimit der Familie erreicht – keine neuen Einträge möglich', 'create at the cap');
    assert_eq((int) $pdo->query('SELECT COUNT(*) FROM entries WHERE family_id = ' . ET_FAM_A)->fetchColumn(), BT_FAMILY_MAX_ROWS, 'nothing written');
    assert_eq(bt_next_seq($pdo, ET_FAM_A), $next, 'no seq burned');
    et_create($pdo, ET_FAM_B); // another family is unaffected
    $edited = bt_update_entry($pdo, ET_FAM_A, $a1, ['blob' => fake_blob(), 'ifSeq' => 1], ET_TODAY);
    assert_eq($edited['seq'], $next, 'an edit adds no row and goes through');
    $deleted = bt_delete_entry($pdo, ET_FAM_A, $a1, ET_TODAY);
    assert_eq($deleted['deletedAt'], ET_TODAY);
    assert_eq(bt_restore_entry($pdo, ET_FAM_A, $a1, ET_TODAY)['deletedAt'], null);
    $pdo->exec('DELETE FROM entries');
});

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

bt_test('sync: ascending by seq from the cursor, next only on a full page, limit clamped 1..1000', function () {
    $pdo = et_db();
    $eids = [];
    for ($i = 0; $i < 3; $i++) {
        list($eids[]) = et_create($pdo, ET_FAM_A);
    }

    $all = et_sync($pdo, ET_FAM_A, 0, 1000);
    assert_eq(et_seqs($all), [1, 2, 3]);
    assert_eq(array_column($all['rows'], 'eid'), $eids, 'rows in write order');
    assert_eq($all['next'], null, 'page not full');
    assert_false(array_key_exists('reset', $all));

    $page = et_sync($pdo, ET_FAM_A, 0, 2);
    assert_eq(et_seqs($page), [1, 2]);
    assert_eq($page['next'], 2, 'full page: next = last seq');
    $rest = et_sync($pdo, ET_FAM_A, $page['next'], 2);
    assert_eq(et_seqs($rest), [3]);
    assert_eq($rest['next'], null);

    // limit 0 / negative -> 1; a negative cursor is a fresh client.
    $one = et_sync($pdo, ET_FAM_A, 0, 0);
    assert_eq(et_seqs($one), [1]);
    assert_eq($one['next'], 1);
    assert_eq(et_seqs(et_sync($pdo, ET_FAM_A, -5, -1)), [1]);

    // limit > 1000 -> 1000: 1001 rows in total (direct inserts, no crypto needed).
    $pdo->exec('BEGIN IMMEDIATE');
    $ins = $pdo->prepare(
        "INSERT INTO entries (eid, family_id, seq, blob, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for ($seq = 4; $seq <= 1001; $seq++) {
        $ins->execute([fake_eid(), ET_FAM_A, $seq, fake_blob(29), ET_TODAY, ET_TODAY]);
    }
    $pdo->exec('COMMIT');
    $big = et_sync($pdo, ET_FAM_A, 0, 99999);
    assert_eq(count($big['rows']), 1000);
    assert_eq($big['rows'][0]['seq'], 1);
    assert_eq($big['rows'][999]['seq'], 1000);
    assert_eq($big['next'], 1000);
    $tail = et_sync($pdo, ET_FAM_A, 1000, 99999);
    assert_eq(et_seqs($tail), [1001]);
    assert_eq($tail['next'], null);
});

bt_test('sync: tombstones omitted at since=0, delivered to a cursor; reset beyond MAX(seq)', function () {
    $pdo = et_db();
    list($a) = et_create($pdo, ET_FAM_A); // seq 1
    list($b) = et_create($pdo, ET_FAM_A); // seq 2
    list($c) = et_create($pdo, ET_FAM_A); // seq 3
    $deleted = bt_delete_entry($pdo, ET_FAM_A, $b, ET_TODAY); // seq 4
    et_assert_row($deleted, 'delete response');
    assert_eq($deleted['seq'], 4);
    assert_eq($deleted['deletedAt'], ET_TODAY);

    $fresh = et_sync($pdo, ET_FAM_A, 0);
    assert_eq(array_column($fresh['rows'], 'eid'), [$a, $c], 'fresh client never sees the tombstone');
    assert_eq(et_seqs($fresh), [1, 3]);

    $cursor = et_sync($pdo, ET_FAM_A, 3);
    assert_eq(count($cursor['rows']), 1);
    assert_eq($cursor['rows'][0]['eid'], $b);
    assert_eq($cursor['rows'][0]['seq'], 4);
    assert_eq($cursor['rows'][0]['deletedAt'], ET_TODAY, 'the cursor client gets the tombstone');

    $caught = et_sync($pdo, ET_FAM_A, 4);
    assert_eq($caught['rows'], []);
    assert_eq($caught['next'], null);
    assert_false(array_key_exists('reset', $caught), 'cursor == MAX(seq) is up to date, not reset');

    $ahead = et_sync($pdo, ET_FAM_A, 5);
    assert_eq($ahead['reset'] ?? null, true, 'cursor beyond MAX(seq): reset');
    assert_eq($ahead['rows'], []);
    assert_eq($ahead['next'], null);
    assert_eq($ahead['serverNow'], ET_NOW);

    // An empty family: since=0 is simply empty, any cursor is a reset.
    $empty = et_sync($pdo, ET_FAM_B, 0);
    assert_eq($empty['rows'], []);
    assert_false(array_key_exists('reset', $empty));
    assert_eq(et_sync($pdo, ET_FAM_B, 1)['reset'] ?? null, true);
});

bt_test('sync: cursor chaining – writes n, n+1; since=n-1 limit=1 twice yields both', function () {
    $pdo = et_db();
    list($e1) = et_create($pdo, ET_FAM_A); // seq 1 (n-1)
    list($e2) = et_create($pdo, ET_FAM_A); // seq 2 (n)
    list($e3) = et_create($pdo, ET_FAM_A); // seq 3 (n+1)

    $first = et_sync($pdo, ET_FAM_A, 1, 1);
    assert_eq(array_column($first['rows'], 'eid'), [$e2]);
    assert_eq($first['next'], 2);
    $second = et_sync($pdo, ET_FAM_A, $first['next'], 1);
    assert_eq(array_column($second['rows'], 'eid'), [$e3]);
    assert_eq($second['next'], 3);
    $third = et_sync($pdo, ET_FAM_A, $second['next'], 1);
    assert_eq($third['rows'], []);
    assert_eq($third['next'], null);
    assert_false(array_key_exists('reset', $third));

    // A write bumps the changed row past the cursor: seq is per row, so the
    // feed carries the latest state exactly once.
    bt_update_entry($pdo, ET_FAM_A, $e1, ['blob' => fake_blob(), 'ifSeq' => 1], ET_TODAY); // seq 4
    $after = et_sync($pdo, ET_FAM_A, 3, 1);
    assert_eq(array_column($after['rows'], 'eid'), [$e1]);
    assert_eq($after['rows'][0]['seq'], 4);
    assert_eq(et_seqs(et_sync($pdo, ET_FAM_A, 0)), [2, 3, 4], 'the old seq 1 is gone from the feed');
});

// ---------------------------------------------------------------------------
// Update (compare-and-set)
// ---------------------------------------------------------------------------

bt_test('update: CAS on ifSeq – new seq + blob, 409 when stale, 404 for missing/foreign/deleted, ifSeq required', function () {
    $pdo = et_db();
    list($a, $blobA) = et_create($pdo, ET_FAM_A); // seq 1
    list($b, $blobB) = et_create($pdo, ET_FAM_A); // seq 2

    $new = fake_blob();
    $u = bt_update_entry($pdo, ET_FAM_A, $a, ['blob' => $new, 'ifSeq' => 1], ET_TODAY);
    et_assert_row($u, 'update response');
    assert_eq($u['eid'], $a);
    assert_eq($u['seq'], 3, 'the edit takes the family\'s next seq');
    assert_eq($u['blob'], $new);
    assert_eq($u['updatedAt'], ET_TODAY);
    assert_eq($u['deletedAt'], null);
    assert_eq(et_raw($pdo, $a)['blob'], $new);

    // The other phone rendered seq 1: its edit must not silently win.
    et_assert_error(function () use ($pdo, $a) {
        bt_update_entry($pdo, ET_FAM_A, $a, ['blob' => fake_blob(), 'ifSeq' => 1], ET_TODAY);
    }, 409, ET_CONFLICT, 'stale ifSeq', 'entries.conflict');
    et_assert_error(function () use ($pdo, $a) {
        bt_update_entry($pdo, ET_FAM_A, $a, ['blob' => fake_blob(), 'ifSeq' => 99], ET_TODAY);
    }, 409, ET_CONFLICT, 'never-existed ifSeq');
    $raw = et_raw($pdo, $a);
    assert_eq([$raw['blob'], (int) $raw['seq']], [$new, 3], 'a conflict changes nothing');
    assert_eq(bt_next_seq($pdo, ET_FAM_A), 4, 'a conflict burns no seq');

    // With the fresh seq the retry succeeds.
    $again = bt_update_entry($pdo, ET_FAM_A, $a, ['blob' => fake_blob(), 'ifSeq' => 3], ET_TODAY);
    assert_eq($again['seq'], 4);

    // ifSeq required (and an int).
    et_assert_error(function () use ($pdo, $a) {
        bt_update_entry($pdo, ET_FAM_A, $a, ['blob' => fake_blob()], ET_TODAY);
    }, 400, '"ifSeq" fehlt', 'missing', 'request.missingField');
    et_assert_error(function () use ($pdo, $a) {
        bt_update_entry($pdo, ET_FAM_A, $a, ['blob' => fake_blob(), 'ifSeq' => null], ET_TODAY);
    }, 400, '"ifSeq" fehlt', 'null');
    et_assert_error(function () use ($pdo, $a) {
        bt_update_entry($pdo, ET_FAM_A, $a, ['blob' => fake_blob(), 'ifSeq' => '4'], ET_TODAY);
    }, 400, '"ifSeq" fehlt', 'string');
    et_assert_error(function () use ($pdo, $a) {
        bt_update_entry($pdo, ET_FAM_A, $a, ['blob' => 'nope', 'ifSeq' => 4], ET_TODAY);
    }, 400, 'Ungültiger Datensatz', 'bad blob', 'request.badBlob');
    et_assert_error(function () use ($pdo, $a) {
        bt_update_entry($pdo, ET_FAM_A, 'not-an-eid', ['blob' => fake_blob(), 'ifSeq' => 4], ET_TODAY);
    }, 400, 'Ungültiger Eintrag', 'bad eid', 'entries.badId');
    // Plaintext fields are no substitute for a blob.
    et_assert_error(function () use ($pdo, $a) {
        bt_update_entry($pdo, ET_FAM_A, $a, ['endedAt' => ET_NOW, 'ifSeq' => 4], ET_TODAY);
    }, 400, 'Ungültiger Datensatz', 'plaintext fields, no blob', 'request.badBlob');

    // 404s: unknown, foreign, deleted — never a 409 and never a 403.
    et_assert_error(function () use ($pdo) {
        bt_update_entry($pdo, ET_FAM_A, fake_eid(), ['blob' => fake_blob(), 'ifSeq' => 1], ET_TODAY);
    }, 404, 'Eintrag nicht gefunden', 'unknown', 'entries.notFound');
    et_assert_error(function () use ($pdo, $b) {
        bt_update_entry($pdo, ET_FAM_B, $b, ['blob' => fake_blob(), 'ifSeq' => 2], ET_TODAY);
    }, 404, 'Eintrag nicht gefunden', 'foreign with the right seq');
    assert_eq(et_raw($pdo, $b)['blob'], $blobB, 'foreign row untouched');
    $del = bt_delete_entry($pdo, ET_FAM_A, $b, ET_TODAY); // seq 5
    et_assert_error(function () use ($pdo, $b, $del) {
        bt_update_entry($pdo, ET_FAM_A, $b, ['blob' => fake_blob(), 'ifSeq' => $del['seq']], ET_TODAY);
    }, 404, 'Eintrag nicht gefunden', 'deleted with the right seq');
    et_assert_error(function () use ($pdo, $b) {
        bt_update_entry($pdo, ET_FAM_A, $b, ['blob' => fake_blob(), 'ifSeq' => 2], ET_TODAY);
    }, 404, 'Eintrag nicht gefunden', 'deleted with a stale seq');
    assert_eq(bt_next_seq($pdo, ET_FAM_A), 6);
});

// ---------------------------------------------------------------------------
// Delete + restore
// ---------------------------------------------------------------------------

bt_test('delete + restore: each bumps seq and returns the row; 404 for missing/foreign/wrong state', function () {
    $pdo = et_db();
    list($a, $blobA) = et_create($pdo, ET_FAM_A); // seq 1
    list($b) = et_create($pdo, ET_FAM_A);         // seq 2

    $d = bt_delete_entry($pdo, ET_FAM_A, $a, ET_TODAY);
    et_assert_row($d, 'delete response');
    assert_eq([$d['eid'], $d['seq'], $d['deletedAt'], $d['updatedAt']], [$a, 3, ET_TODAY, ET_TODAY]);
    assert_eq($d['blob'], $blobA, 'row JSON keeps the blob');
    assert_eq((int) $pdo->query('SELECT COUNT(*) FROM entries')->fetchColumn(), 2, 'soft delete');

    et_assert_error(function () use ($pdo, $a) {
        bt_delete_entry($pdo, ET_FAM_A, $a, ET_TODAY);
    }, 404, 'Eintrag nicht gefunden', 'second delete');
    et_assert_error(function () use ($pdo, $b) {
        bt_delete_entry($pdo, ET_FAM_B, $b, ET_TODAY);
    }, 404, 'Eintrag nicht gefunden', 'foreign delete');
    et_assert_error(function () use ($pdo) {
        bt_delete_entry($pdo, ET_FAM_A, fake_eid(), ET_TODAY);
    }, 404, 'Eintrag nicht gefunden', 'unknown delete');
    et_assert_error(function () use ($pdo) {
        bt_delete_entry($pdo, ET_FAM_A, 'x', ET_TODAY);
    }, 400, 'Ungültiger Eintrag', 'bad eid on delete');
    assert_eq(et_raw($pdo, $b)['deleted_at'], null, 'b is still live');

    et_assert_error(function () use ($pdo, $b) {
        bt_restore_entry($pdo, ET_FAM_A, $b, ET_TODAY);
    }, 404, 'Eintrag nicht gefunden', 'restore of a live entry');
    et_assert_error(function () use ($pdo, $a) {
        bt_restore_entry($pdo, ET_FAM_B, $a, ET_TODAY);
    }, 404, 'Eintrag nicht gefunden', 'restore of a foreign tombstone');
    et_assert_error(function () use ($pdo) {
        bt_restore_entry($pdo, ET_FAM_A, fake_eid(), ET_TODAY);
    }, 404, 'Eintrag nicht gefunden', 'restore of an unknown eid');
    et_assert_error(function () use ($pdo) {
        bt_restore_entry($pdo, ET_FAM_A, '', ET_TODAY);
    }, 400, 'Ungültiger Eintrag', 'bad eid on restore');
    assert_eq(bt_next_seq($pdo, ET_FAM_A), 4, '404s burn no seq');

    $r = bt_restore_entry($pdo, ET_FAM_A, $a, ET_TODAY);
    et_assert_row($r, 'restore response');
    assert_eq([$r['eid'], $r['seq'], $r['deletedAt']], [$a, 4, null]);
    assert_eq($r['blob'], $blobA, 'restore returns the blob');
    assert_eq(et_raw($pdo, $a)['deleted_at'], null);

    // The feed reflects every step: a fresh client sees both live rows, a
    // cursor client sees the restore as the latest state of a.
    assert_eq(array_column(et_sync($pdo, ET_FAM_A, 0)['rows'], 'eid'), [$b, $a]);
    $cursor = et_sync($pdo, ET_FAM_A, 3);
    assert_eq(array_column($cursor['rows'], 'eid'), [$a]);
    assert_eq($cursor['rows'][0]['deletedAt'], null);
    // Delete b: the cursor client gets the tombstone, a fresh one nothing.
    bt_delete_entry($pdo, ET_FAM_A, $b, ET_TODAY); // seq 5
    $t = et_sync($pdo, ET_FAM_A, 4);
    assert_eq([$t['rows'][0]['eid'], $t['rows'][0]['deletedAt']], [$b, ET_TODAY]);
    assert_eq(array_column(et_sync($pdo, ET_FAM_A, 0)['rows'], 'eid'), [$a]);

    // A deleted eid stays taken.
    et_assert_error(function () use ($pdo, $b) {
        bt_create_entry($pdo, ET_FAM_A, ['eid' => $b, 'blob' => fake_blob()], ET_TODAY);
    }, 409, 'Eintrag existiert bereits');
});

bt_test('delete with ifSeq: CAS – 409 when the seq moved (row untouched), 404 for missing/foreign/deleted, 400 for a non-int', function () {
    $pdo = et_db();
    list($a, $blobA) = et_create($pdo, ET_FAM_A); // seq 1
    list($b) = et_create($pdo, ET_FAM_A);         // seq 2
    bt_update_entry($pdo, ET_FAM_A, $a, ['blob' => fake_blob(), 'ifSeq' => 1], ET_TODAY); // a: seq 3

    // The resolver judged a at seq 1; the other phone edited it since.
    et_assert_error(function () use ($pdo, $a) {
        bt_delete_entry($pdo, ET_FAM_A, $a, ET_TODAY, ['ifSeq' => 1]);
    }, 409, ET_CONFLICT, 'stale ifSeq');
    et_assert_error(function () use ($pdo, $a) {
        bt_delete_entry($pdo, ET_FAM_A, $a, ET_TODAY, ['ifSeq' => 99]);
    }, 409, ET_CONFLICT, 'never-existed ifSeq');
    $raw = et_raw($pdo, $a);
    assert_eq([$raw['deleted_at'], (int) $raw['seq']], [null, 3], 'a conflict changes nothing');
    assert_eq(bt_next_seq($pdo, ET_FAM_A), 4, 'a conflict burns no seq');

    // Validation: present but not an int -> 400 (null = absent = unconditional).
    foreach (['3', 3.0, true, [3], ''] as $bad) {
        et_assert_error(function () use ($pdo, $a, $bad) {
            bt_delete_entry($pdo, ET_FAM_A, $a, ET_TODAY, ['ifSeq' => $bad]);
        }, 400, '"ifSeq" ungültig', bt_format($bad));
    }
    assert_eq(et_raw($pdo, $a)['deleted_at'], null, 'nothing deleted by the 400s');

    // 404s win over 409: unknown, foreign, already deleted — with or without the right seq.
    et_assert_error(function () use ($pdo) {
        bt_delete_entry($pdo, ET_FAM_A, fake_eid(), ET_TODAY, ['ifSeq' => 1]);
    }, 404, 'Eintrag nicht gefunden', 'unknown');
    et_assert_error(function () use ($pdo, $b) {
        bt_delete_entry($pdo, ET_FAM_B, $b, ET_TODAY, ['ifSeq' => 2]);
    }, 404, 'Eintrag nicht gefunden', 'foreign with the right seq');
    assert_eq(et_raw($pdo, $b)['deleted_at'], null, 'foreign row untouched');

    // The fresh seq deletes; the row JSON is the tombstone.
    $d = bt_delete_entry($pdo, ET_FAM_A, $a, ET_TODAY, ['ifSeq' => 3]);
    et_assert_row($d, 'conditional delete response');
    assert_eq([$d['eid'], $d['seq'], $d['deletedAt']], [$a, 4, ET_TODAY]);
    et_assert_error(function () use ($pdo, $a) {
        bt_delete_entry($pdo, ET_FAM_A, $a, ET_TODAY, ['ifSeq' => 4]);
    }, 404, 'Eintrag nicht gefunden', 'deleted with the right seq is a 404, not a 409');
    et_assert_error(function () use ($pdo, $a) {
        bt_delete_entry($pdo, ET_FAM_A, $a, ET_TODAY, ['ifSeq' => 3]);
    }, 404, 'Eintrag nicht gefunden', 'deleted with a stale seq');

    // No body / null ifSeq: the unconditional delete of the history sheet.
    assert_eq(bt_delete_entry($pdo, ET_FAM_A, $b, ET_TODAY, [])['seq'], 5, 'empty body');
    bt_restore_entry($pdo, ET_FAM_A, $b, ET_TODAY); // seq 6
    assert_eq(bt_delete_entry($pdo, ET_FAM_A, $b, ET_TODAY, ['ifSeq' => null])['seq'], 7, 'null ifSeq');
    assert_eq(bt_next_seq($pdo, ET_FAM_A), 8);
});

bt_test('sync: feed is settings.feed_id on every page (reset pages too) and follows the setting', function () {
    $pdo = et_db();
    $feed = bt_feed_id($pdo);
    assert_true(preg_match('/^[0-9a-f]{32}$/D', $feed) === 1, 'the DDL seeds a 32-hex feed_id');
    for ($i = 0; $i < 3; $i++) {
        et_create($pdo, ET_FAM_A);
    }
    $page = et_sync($pdo, ET_FAM_A, 0, 2);
    assert_eq($page['feed'], $feed);
    $rest = et_sync($pdo, ET_FAM_A, $page['next'], 2);
    assert_eq($rest['feed'], $feed, 'stable across pages');
    assert_eq(et_sync($pdo, ET_FAM_A, 3)['feed'], $feed, 'up-to-date page');
    $reset = et_sync($pdo, ET_FAM_A, 99);
    assert_eq([$reset['reset'] ?? null, $reset['feed']], [true, $feed], 'reset page carries it too');
    assert_eq(et_sync($pdo, ET_FAM_B, 0)['feed'], $feed, 'per install, not per family');

    // A replaced value (another file put in this one's place) is served at once.
    $pdo->exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('feed_id', '" . str_repeat('ab', 16) . "')");
    assert_eq(bt_feed_id($pdo), str_repeat('ab', 16));
    assert_eq(bt_sync_entries($pdo, ET_FAM_A, 0, 1000, ET_NOW)['feed'], str_repeat('ab', 16));
    // Without the row (a scratch file): '' rather than an error.
    $pdo->exec("DELETE FROM settings WHERE key = 'feed_id'");
    assert_eq(bt_feed_id($pdo), '');
    assert_eq(bt_sync_entries($pdo, ET_FAM_A, 0, 1000, ET_NOW)['feed'], '');
});

// ---------------------------------------------------------------------------
// Seal
// ---------------------------------------------------------------------------

