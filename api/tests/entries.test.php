<?php
/**
 * Entries store tests (schema v3): the opaque per-family sync feed, CAS
 * writes, soft delete/restore, the legacy seal, and the plaintext-residue
 * guarantee.
 *
 * Every test opens its OWN scratch file with the v3 entries + settings
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
const ET_ROW_KEYS = ['eid', 'seq', 'blob', 'plain', 'createdAt', 'updatedAt', 'deletedAt'];
const ET_PLAIN_KEYS = ['type', 'startedAt', 'endedAt', 'details', 'loggedBy'];
const ET_OLD_SHELL = 'Neue App-Version – bitte die App schliessen und neu öffnen';
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

/** The v3 entries + settings DDL, verbatim from the plan (§3). */
function et_ddl(): string
{
    return <<<'SQL'
CREATE TABLE IF NOT EXISTS entries (
  eid TEXT PRIMARY KEY,
  family_id INTEGER,
  seq INTEGER NOT NULL,
  blob TEXT,
  legacy_type TEXT,
  legacy_started_at TEXT,
  legacy_ended_at TEXT,
  legacy_details TEXT,
  legacy_logged_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_entries_family_seq ON entries (family_id, seq);
CREATE INDEX IF NOT EXISTS idx_entries_legacy ON entries (family_id) WHERE blob IS NULL;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
INSERT OR IGNORE INTO settings (key, value) VALUES ('schema_version', '3');
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

/** Open a scratch file the way bt_db does (WAL, secure_delete) and create the v3 tables. */
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

/** A fresh, empty v3 scratch database. */
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

function et_set_legacy_max(PDO $pdo, int $max): void
{
    $pdo->prepare(
        "INSERT INTO settings (key, value) VALUES ('legacy_max_seq', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )->execute([(string) $max]);
}

/**
 * Insert legacy (plaintext, blob NULL) rows the way the v2 -> v3 migration
 * leaves them and stamp legacy_max_seq with the highest seq. $rows: list of
 * [seq, type, startedAt, endedAt, details JSON, loggedBy, deletedAt|null].
 * Returns the eids in the given order.
 */
function et_seed_legacy(PDO $pdo, int $familyId, array $rows): array
{
    $stmt = $pdo->prepare(
        'INSERT INTO entries (eid, family_id, seq, blob, legacy_type, legacy_started_at, legacy_ended_at,
                              legacy_details, legacy_logged_by, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    $eids = [];
    $max = 0;
    foreach ($rows as $r) {
        $eid = fake_eid();
        $stmt->execute([$eid, $familyId, $r[0], $r[1], $r[2], $r[3], $r[4], $r[5], '2026-08-30', '2026-08-30', $r[6]]);
        $eids[] = $eid;
        $max = max($max, $r[0]);
    }
    $current = (int) $pdo->query("SELECT COALESCE((SELECT value FROM settings WHERE key = 'legacy_max_seq'), 0)")->fetchColumn();
    et_set_legacy_max($pdo, max($max, $current));
    return $eids;
}

/** Strict shape check of one row JSON (the §10 contract), plain included. */
function et_assert_row(array $row, string $msg = ''): void
{
    $p = $msg !== '' ? $msg . ': ' : '';
    assert_eq(array_keys($row), ET_ROW_KEYS, $p . 'row keys');
    assert_true(is_string($row['eid']) && preg_match('/^[0-9a-f]{32}$/D', $row['eid']) === 1, $p . 'eid');
    assert_true(is_int($row['seq']) && $row['seq'] >= 1, $p . 'seq');
    assert_true($row['blob'] === null || is_string($row['blob']), $p . 'blob');
    assert_true($row['plain'] === null || is_array($row['plain']), $p . 'plain');
    if ($row['plain'] !== null) {
        assert_eq(array_keys($row['plain']), ET_PLAIN_KEYS, $p . 'plain keys');
        assert_eq($row['blob'], null, $p . 'plain never together with a blob');
        assert_true(is_array($row['plain']['details']) || $row['plain']['details'] instanceof stdClass, $p . 'details');
    }
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
    $expected = ['serverNow', 'feed', 'rows', 'next', 'legacyRemaining'];
    if (isset($res['reset'])) {
        $expected[] = 'reset';
        assert_eq($res['reset'], true, 'reset is only ever true');
    }
    assert_eq($keys, $expected, 'sync response keys');
    assert_eq($res['serverNow'], ET_NOW);
    assert_eq($res['feed'], bt_feed_id($pdo), 'feed is settings.feed_id on every page');
    assert_true(preg_match('/^[0-9a-f]{32}$/D', $res['feed']) === 1, 'feed is 32 hex');
    assert_true(is_int($res['legacyRemaining']));
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
        'plain' => null,
        'createdAt' => ET_TODAY,
        'updatedAt' => ET_TODAY,
        'deletedAt' => null,
    ], 'full create shape');

    $raw = et_raw($pdo, $a1);
    assert_eq($raw['blob'], $blobA1, 'stored verbatim');
    assert_eq((int) $raw['family_id'], ET_FAM_A);
    assert_eq($raw['legacy_type'], null);
    assert_eq($raw['legacy_details'], null);
    assert_eq(bt_next_seq($pdo, ET_FAM_A), 4);
    assert_eq(bt_next_seq($pdo, ET_FAM_B), 3);
    assert_eq(bt_next_seq($pdo, 99), 1, 'an unknown family starts at 1');
    assert_eq((int) $pdo->query('SELECT COUNT(*) FROM entries')->fetchColumn(), 5);
});

bt_test('create: 400 for a bad eid, a bad blob or an old-shell body; 409 on a duplicate eid', function () {
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
    // A pre-encryption shell posts plaintext fields and no blob.
    et_assert_error(function () use ($pdo) {
        bt_create_entry($pdo, ET_FAM_A, [
            'type' => 'diaper', 'startedAt' => ET_NOW, 'details' => ['kind' => 'pee'],
        ], ET_TODAY);
    }, 400, ET_OLD_SHELL, 'old shell');
    et_assert_error(function () use ($pdo) {
        bt_create_entry($pdo, ET_FAM_A, ['type' => 'sleep'], ET_TODAY);
    }, 400, ET_OLD_SHELL, 'old shell, type only');
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

bt_test('create: row caps – 507 at the family cap and at the total cap; edits, deletes, restores and seals stay possible', function () {
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
    assert_eq($all['legacyRemaining'], 0);
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
    assert_eq($cursor['rows'][0]['plain'], null);

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

bt_test('sync: plain only for legacy rows up to legacy_max_seq, never for encrypted rows; scoping', function () {
    $pdo = et_db();
    list($leg1, $leg2, $leg3) = et_seed_legacy($pdo, ET_FAM_A, [
        [1, 'bottle', '2026-08-30T08:00:00Z', null, '{"amount_ml":90}', 'Mama', null],
        [2, 'diaper', '2026-08-30T09:00:00Z', null, '{"kind":"pee"}', 'Papa', '2026-08-31'], // tombstone
        [3, 'sleep', '2026-08-30T10:00:00Z', '2026-08-30T11:30:00Z', '{}', null, null],
    ]);
    assert_eq(bt_legacy_max_seq($pdo), 3);
    list($enc, $blob, $encRow) = et_create($pdo, ET_FAM_A); // seq 4, encrypted
    assert_eq($encRow['plain'], null, 'create response of an encrypted row');
    // A plaintext row that appears AFTER the migration (seq beyond the stamp)
    // is never served as plain, whoever wrote it into the file.
    $late = fake_eid();
    $pdo->prepare(
        "INSERT INTO entries (eid, family_id, seq, blob, legacy_type, legacy_started_at, legacy_details, created_at, updated_at)
         VALUES (?, ?, 10, NULL, 'bottle', '2026-09-05T08:00:00Z', '{\"amount_ml\":999}', ?, ?)"
    )->execute([$late, ET_FAM_A, ET_TODAY, ET_TODAY]);

    assert_eq(bt_count_legacy($pdo, ET_FAM_A), 2, 'live legacy rows below the stamp');
    $res = et_sync($pdo, ET_FAM_A, 0);
    assert_eq($res['legacyRemaining'], 2);
    assert_eq(array_column($res['rows'], 'eid'), [$leg1, $leg3, $enc, $late]);

    $r1 = $res['rows'][0];
    assert_eq($r1['blob'], null);
    assert_eq($r1['plain'], [
        'type' => 'bottle',
        'startedAt' => '2026-08-30T08:00:00Z',
        'endedAt' => null,
        'details' => ['amount_ml' => 90],
        'loggedBy' => 'Mama',
    ]);
    assert_eq($r1['createdAt'], '2026-08-30');
    assert_eq($r1['deletedAt'], null);

    $r3 = $res['rows'][1];
    assert_eq($r3['plain']['type'], 'sleep');
    assert_eq($r3['plain']['endedAt'], '2026-08-30T11:30:00Z');
    assert_true($r3['plain']['details'] instanceof stdClass, 'empty details encode as {}');
    assert_eq($r3['plain']['loggedBy'], null);
    assert_true(strpos(json_encode($r3, JSON_UNESCAPED_UNICODE), '"details":{}') !== false);

    assert_eq($res['rows'][2]['blob'], $blob);
    assert_eq($res['rows'][2]['plain'], null, 'encrypted rows never carry plain');
    assert_true(strpos(json_encode($res['rows'][2]), '"plain":null') !== false);

    assert_eq($res['rows'][3]['eid'], $late);
    assert_eq($res['rows'][3]['blob'], null);
    assert_eq($res['rows'][3]['plain'], null, 'plaintext beyond legacy_max_seq is withheld');

    // The tombstoned legacy row reaches a cursor client as a bare tombstone.
    $tomb = et_sync($pdo, ET_FAM_A, 1);
    assert_eq($tomb['rows'][0]['eid'], $leg2);
    assert_eq($tomb['rows'][0]['deletedAt'], '2026-08-31');
    assert_eq($tomb['rows'][0]['plain'], null, 'no content on tombstones');

    // Another family sees nothing of it.
    $other = et_sync($pdo, ET_FAM_B, 0);
    assert_eq($other['rows'], []);
    assert_eq($other['legacyRemaining'], 0);
    assert_eq(bt_count_legacy($pdo, ET_FAM_B), 0);
    list(, , $bRow) = et_create($pdo, ET_FAM_B);
    assert_eq($bRow['seq'], 1, 'family B has its own seq space');
    assert_eq(count(et_sync($pdo, ET_FAM_B, 0)['rows']), 1);
    assert_eq(count(et_sync($pdo, ET_FAM_A, 0)['rows']), 4, 'family A unchanged');

    // Without the stamp (a file that never migrated) nothing is ever plain.
    $pdo->exec("DELETE FROM settings WHERE key = 'legacy_max_seq'");
    assert_eq(bt_legacy_max_seq($pdo), 0);
    $none = et_sync($pdo, ET_FAM_A, 0);
    assert_eq($none['legacyRemaining'], 0);
    foreach ($none['rows'] as $row) {
        assert_eq($row['plain'], null, 'no plain without legacy_max_seq');
    }
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
    assert_eq($u['plain'], null);
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
    // The old shell's stop button: {endedAt, ifOpen} and no blob.
    et_assert_error(function () use ($pdo, $a) {
        bt_update_entry($pdo, ET_FAM_A, $a, ['endedAt' => ET_NOW, 'ifOpen' => true], ET_TODAY);
    }, 400, ET_OLD_SHELL, 'old shell');

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

bt_test('update: editing a legacy row seals it (blob set, legacy columns nulled)', function () {
    $pdo = et_db();
    list($leg1, $leg2) = et_seed_legacy($pdo, ET_FAM_A, [
        [1, 'bottle', '2026-08-30T08:00:00Z', null, '{"amount_ml":90}', 'Mama', null],
        [2, 'diaper', '2026-08-30T09:00:00Z', null, '{"kind":"pee"}', 'Papa', null],
    ]);
    assert_eq(bt_count_legacy($pdo, ET_FAM_A), 2);
    assert_eq(et_sync($pdo, ET_FAM_A, 0)['rows'][0]['plain']['type'], 'bottle');

    $blob = fake_blob();
    $u = bt_update_entry($pdo, ET_FAM_A, $leg1, ['blob' => $blob, 'ifSeq' => 1], ET_TODAY);
    assert_eq($u['seq'], 3);
    assert_eq($u['blob'], $blob);
    assert_eq($u['plain'], null);
    $raw = et_raw($pdo, $leg1);
    foreach (['legacy_type', 'legacy_started_at', 'legacy_ended_at', 'legacy_details', 'legacy_logged_by'] as $col) {
        assert_eq($raw[$col], null, $col);
    }
    assert_eq($raw['created_at'], '2026-08-30', 'created_at is history');
    assert_eq($raw['updated_at'], ET_TODAY);
    assert_eq(bt_count_legacy($pdo, ET_FAM_A), 1);

    $res = et_sync($pdo, ET_FAM_A, 0);
    assert_eq($res['legacyRemaining'], 1);
    assert_eq(array_column($res['rows'], 'eid'), [$leg2, $leg1]);
    assert_eq($res['rows'][0]['plain']['type'], 'diaper');
    assert_eq($res['rows'][1]['plain'], null);
    assert_eq($res['rows'][1]['blob'], $blob);
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
    assert_eq($d['plain'], null);
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
    assert_eq($r['plain'], null);
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

    // A replaced value (what the v2 -> v3 migration does) is served at once.
    $pdo->exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('feed_id', '" . str_repeat('ab', 16) . "')");
    assert_eq(bt_feed_id($pdo), str_repeat('ab', 16));
    assert_eq(bt_sync_entries($pdo, ET_FAM_A, 0, 1000, ET_NOW)['feed'], str_repeat('ab', 16));
    // Without the row (a scratch file): '' rather than an error.
    $pdo->exec("DELETE FROM settings WHERE key = 'feed_id'");
    assert_eq(bt_feed_id($pdo), '');
    assert_eq(bt_sync_entries($pdo, ET_FAM_A, 0, 1000, ET_NOW)['feed'], '');
});

bt_test('delete + restore of a legacy row: seq moves past the stamp, so it is no longer served plain', function () {
    $pdo = et_db();
    list($leg) = et_seed_legacy($pdo, ET_FAM_A, [
        [1, 'bottle', '2026-08-30T08:00:00Z', null, '{"amount_ml":90}', 'Mama', null],
    ]);
    $d = bt_delete_entry($pdo, ET_FAM_A, $leg, ET_TODAY);
    assert_eq([$d['seq'], $d['blob'], $d['plain'], $d['deletedAt']], [2, null, null, ET_TODAY]);
    assert_eq(bt_count_legacy($pdo, ET_FAM_A), 0, 'a tombstone is nothing to seal');
    assert_eq(et_sync($pdo, ET_FAM_A, 0)['rows'], []);
    $r = bt_restore_entry($pdo, ET_FAM_A, $leg, ET_TODAY);
    assert_eq([$r['seq'], $r['blob'], $r['plain'], $r['deletedAt']], [3, null, null, null]);
    assert_eq(et_sync($pdo, ET_FAM_A, 0)['rows'][0]['plain'], null, 'beyond legacy_max_seq: withheld');
    assert_eq(bt_count_legacy($pdo, ET_FAM_A), 0);
});

// ---------------------------------------------------------------------------
// Seal
// ---------------------------------------------------------------------------

bt_test('seal: done/skipped/remaining, idempotent, tombstones scrubbed at the end, validation is atomic', function () {
    $pdo = et_db();
    list($l1, $l2, $l3, $l4) = et_seed_legacy($pdo, ET_FAM_A, [
        [1, 'bottle', '2026-08-30T08:00:00Z', null, '{"amount_ml":90}', 'Mama', null],
        [2, 'diaper', '2026-08-30T09:00:00Z', null, '{"kind":"pee"}', 'Papa', null],
        [3, 'sleep', '2026-08-30T10:00:00Z', null, '{}', 'Mama', '2026-08-31'], // tombstone
        [4, 'medication', '2026-08-30T11:00:00Z', null, '{"name":"Vitamin D"}', 'Mama', null],
    ]);
    list($foreign) = et_seed_legacy($pdo, ET_FAM_B, [
        [1, 'bottle', '2026-08-30T08:00:00Z', null, '{"amount_ml":50}', 'Oma', null],
    ]);
    assert_eq(bt_legacy_max_seq($pdo), 4);
    assert_eq(bt_count_legacy($pdo, ET_FAM_A), 3);
    assert_eq(bt_count_legacy($pdo, ET_FAM_B), 1);

    // Validation happens before any write (400, nothing sealed).
    et_assert_error(function () use ($pdo, $l1) {
        bt_seal_legacy($pdo, ET_FAM_A, [
            ['eid' => $l1, 'seq' => 1, 'blob' => fake_blob()],
            ['eid' => 'bad', 'seq' => 2, 'blob' => fake_blob()],
        ], ET_TODAY);
    }, 400, 'Ungültiger Eintrag', 'bad eid');
    et_assert_error(function () use ($pdo, $l1) {
        bt_seal_legacy($pdo, ET_FAM_A, [['eid' => $l1, 'seq' => 1, 'blob' => 'x']], ET_TODAY);
    }, 400, 'Ungültiger Datensatz', 'bad blob');
    et_assert_error(function () use ($pdo, $l1) {
        bt_seal_legacy($pdo, ET_FAM_A, [['eid' => $l1, 'blob' => fake_blob()]], ET_TODAY);
    }, 400, '"seq" fehlt', 'missing seq');
    et_assert_error(function () use ($pdo) {
        bt_seal_legacy($pdo, ET_FAM_A, ['nope'], ET_TODAY);
    }, 400, 'Ungültiger Eintrag', 'item not an object');
    $tooMany = [];
    for ($i = 0; $i < 201; $i++) {
        $tooMany[] = ['eid' => fake_eid(), 'seq' => 1, 'blob' => fake_blob()];
    }
    et_assert_error(function () use ($pdo, $tooMany) {
        bt_seal_legacy($pdo, ET_FAM_A, $tooMany, ET_TODAY);
    }, 400, 'Höchstens 200 Einträge pro Anfrage', '201 items');
    assert_eq(et_raw($pdo, $l1)['blob'], null, 'nothing sealed by a rejected batch');
    assert_eq(bt_next_seq($pdo, ET_FAM_A), 5);

    // Empty batch: a no-op with the current count.
    assert_eq(bt_seal_legacy($pdo, ET_FAM_A, [], ET_TODAY), ['done' => [], 'skipped' => [], 'remaining' => 3]);

    // First batch: one hit, three misses (stale seq, unknown, foreign).
    $blob1 = fake_blob();
    $unknown = fake_eid();
    $res = bt_seal_legacy($pdo, ET_FAM_A, [
        ['eid' => $l1, 'seq' => 1, 'blob' => $blob1],
        ['eid' => $l2, 'seq' => 99, 'blob' => fake_blob()],
        ['eid' => $unknown, 'seq' => 1, 'blob' => fake_blob()],
        ['eid' => $foreign, 'seq' => 1, 'blob' => fake_blob()],
    ], ET_TODAY);
    assert_eq(array_keys($res), ['done', 'skipped', 'remaining']);
    assert_eq($res['done'], [['eid' => $l1, 'seq' => 5, 'updatedAt' => ET_TODAY]]);
    assert_eq($res['skipped'], [$l2, $unknown, $foreign]);
    assert_eq($res['remaining'], 2);
    $raw1 = et_raw($pdo, $l1);
    assert_eq([$raw1['blob'], (int) $raw1['seq'], $raw1['updated_at']], [$blob1, 5, ET_TODAY]);
    foreach (['legacy_type', 'legacy_started_at', 'legacy_ended_at', 'legacy_details', 'legacy_logged_by'] as $col) {
        assert_eq($raw1[$col], null, $col);
    }
    assert_eq(et_raw($pdo, $l2)['legacy_type'], 'diaper', 'stale item untouched');
    assert_eq(et_raw($pdo, $foreign)['blob'], null, 'foreign row untouched');
    assert_eq(bt_count_legacy($pdo, ET_FAM_B), 1);
    assert_eq(et_raw($pdo, $l3)['legacy_type'], 'sleep', 'tombstone content still there mid-migration');

    // The sealed row now syncs as an encrypted row.
    $sync = et_sync($pdo, ET_FAM_A, 0);
    assert_eq($sync['legacyRemaining'], 2);
    assert_eq(array_column($sync['rows'], 'eid'), [$l2, $l4, $l1]);
    assert_eq($sync['rows'][2]['blob'], $blob1);
    assert_eq($sync['rows'][2]['plain'], null);

    // Second batch finishes the family: consecutive seqs, the already-sealed
    // row is skipped, and the tombstone's plaintext is scrubbed with it.
    $res2 = bt_seal_legacy($pdo, ET_FAM_A, [
        ['eid' => $l4, 'seq' => 4, 'blob' => fake_blob()],
        ['eid' => $l1, 'seq' => 5, 'blob' => fake_blob()],
        ['eid' => $l2, 'seq' => 2, 'blob' => fake_blob()],
    ], ET_TODAY);
    assert_eq(array_column($res2['done'], 'eid'), [$l4, $l2]);
    assert_eq(array_column($res2['done'], 'seq'), [6, 7]);
    assert_eq($res2['skipped'], [$l1]);
    assert_eq($res2['remaining'], 0);
    assert_eq(et_raw($pdo, $l1)['blob'], $blob1, 'a sealed row is never re-sealed');
    $tomb = et_raw($pdo, $l3);
    assert_eq($tomb['blob'], null);
    assert_eq($tomb['deleted_at'], '2026-08-31');
    foreach (['legacy_type', 'legacy_started_at', 'legacy_ended_at', 'legacy_details', 'legacy_logged_by'] as $col) {
        assert_eq($tomb[$col], null, "tombstone $col scrubbed");
    }
    assert_eq(
        (int) $pdo->query('SELECT COUNT(*) FROM entries WHERE family_id = 1 AND legacy_type IS NOT NULL')->fetchColumn(),
        0,
        'no plaintext left in family A'
    );
    assert_eq(et_raw($pdo, $foreign)['legacy_type'], 'bottle', 'family B is not touched');
    assert_eq(bt_count_legacy($pdo, ET_FAM_B), 1);
    assert_eq(et_sync($pdo, ET_FAM_A, 0)['legacyRemaining'], 0);

    // Idempotent: the same batch again is all skips.
    $res3 = bt_seal_legacy($pdo, ET_FAM_A, [
        ['eid' => $l4, 'seq' => 4, 'blob' => fake_blob()],
        ['eid' => $l2, 'seq' => 2, 'blob' => fake_blob()],
    ], ET_TODAY);
    assert_eq($res3, ['done' => [], 'skipped' => [$l4, $l2], 'remaining' => 0]);
    assert_eq(bt_next_seq($pdo, ET_FAM_A), 8, 'skips burn no seq');

    // Everything encrypted, every write serialised: the feed is the final state.
    $final = et_sync($pdo, ET_FAM_A, 0);
    assert_eq(et_seqs($final), [5, 6, 7]);
    foreach ($final['rows'] as $row) {
        assert_true(is_string($row['blob']), 'blob');
        assert_eq($row['plain'], null);
    }
});

bt_test('seal + VACUUM: no legacy plaintext survives in the .db or -wal bytes (secure_delete)', function () {
    $file = et_path();
    $pdo = et_open($file);
    // A realistic legacy pool: 40 short rows (freed cells get fragmented, not
    // simply overwritten in place), one value long enough for an overflow
    // page (a freed page, not just a freed cell), a logger name, and a
    // tombstone the client can never seal. Every marker is unique; a
    // deliberately weakened store (secure_delete off AND no VACUUM) keeps
    // dozens of them in the file, which this test must notice.
    $rows = [];
    for ($i = 1; $i <= 40; $i++) {
        $rows[] = [$i, 'medication', '2026-08-30T08:00:00Z', null, '{"name":"MARKER-LIVE-' . $i . '"}', 'Mama', null];
    }
    $rows[] = [41, 'medication', '2026-08-30T09:00:00Z', null, '{"name":"MARKER-LONG-' . str_repeat('x', 3000) . '"}', 'MARKER-NAME-2b8e', null];
    $rows[] = [42, 'medication', '2026-08-30T10:00:00Z', null, '{"name":"MARKER-TOMB-9c1d"}', 'MARKER-WHO-4e7b', '2026-08-31'];
    $eids = et_seed_legacy($pdo, ET_FAM_A, $rows);
    $tombEid = $eids[41];
    // Some ordinary traffic around it, as on a real phone.
    list($enc) = et_create($pdo, ET_FAM_A); // seq 43
    bt_update_entry($pdo, ET_FAM_A, $enc, ['blob' => fake_blob(), 'ifSeq' => 43], ET_TODAY); // seq 44

    $bytes = function () use ($file): string {
        $data = (string) @file_get_contents($file);
        if (is_file($file . '-wal')) {
            $data .= (string) @file_get_contents($file . '-wal');
        }
        return $data;
    };
    $count = function (string $data): int {
        return preg_match_all('/MARKER-(LIVE|LONG|TOMB|NAME|WHO)-/', $data);
    };
    assert_true($count($bytes()) >= 44, 'sanity: the markers are in the file before the seal');

    // The client seals the 41 live rows in one batch, newest first.
    $items = [];
    for ($i = 41; $i >= 1; $i--) {
        $items[] = ['eid' => $eids[$i - 1], 'seq' => $i, 'blob' => fake_blob(256)];
    }
    $res = bt_seal_legacy($pdo, ET_FAM_A, $items, ET_TODAY);
    assert_eq(count($res['done']), 41);
    assert_eq($res['done'][0]['seq'], 45);
    assert_eq($res['skipped'], []);
    assert_eq($res['remaining'], 0);

    // Read the files with the connection still open (production never closes
    // it before the response goes out) ...
    assert_eq($count($bytes()), 0, 'no marker may survive in the .db/-wal bytes');
    assert_eq((int) $pdo->query('SELECT COUNT(*) FROM entries WHERE legacy_type IS NOT NULL')->fetchColumn(), 0);
    assert_eq((int) $pdo->query('SELECT COUNT(*) FROM entries WHERE legacy_details IS NOT NULL OR legacy_logged_by IS NOT NULL')->fetchColumn(), 0);
    assert_eq((int) $pdo->query('SELECT COUNT(*) FROM entries WHERE blob IS NULL AND deleted_at IS NULL')->fetchColumn(), 0);
    assert_eq((int) $pdo->query('PRAGMA freelist_count')->fetchColumn(), 0, 'VACUUM ran: no free pages');
    clearstatcache();
    assert_true(!is_file($file . '-wal') || filesize($file . '-wal') === 0, 'WAL truncated after the checkpoint');
    $tomb = et_raw($pdo, $tombEid);
    assert_eq([$tomb['deleted_at'], $tomb['blob'], $tomb['legacy_details'], $tomb['legacy_logged_by']], ['2026-08-31', null, null, null], 'tombstone kept, content scrubbed');

    // ... and again after closing it (the last connection folds the WAL away).
    $pdo = null;
    clearstatcache();
    $closed = $bytes();
    assert_true(strlen($closed) > 0);
    assert_eq($count($closed), 0, 'no marker may survive after close');
    assert_false(is_file($file . '-journal'));

    // The store is intact: 42 live rows (41 sealed + 1 encrypted), the tombstone still a tombstone.
    $pdo = et_open($file);
    $final = et_sync($pdo, ET_FAM_A, 0);
    assert_eq(count($final['rows']), 42);
    assert_eq($final['rows'][0]['eid'], $enc);
    assert_eq($final['rows'][1]['eid'], $eids[40], 'newest legacy row sealed first');
    assert_eq($final['legacyRemaining'], 0);
    foreach ($final['rows'] as $row) {
        assert_true(is_string($row['blob']));
        assert_eq($row['plain'], null);
    }
    $cursor = et_sync($pdo, ET_FAM_A, 41);
    assert_eq(count($cursor['rows']), 43, 'the tombstone reaches a cursor client');
    assert_eq([$cursor['rows'][0]['eid'], $cursor['rows'][0]['deletedAt'], $cursor['rows'][0]['plain']], [$tombEid, '2026-08-31', null]);
});
