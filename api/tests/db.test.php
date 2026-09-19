<?php
/**
 * Schema tests for api/lib/db.php: fresh v4 creation, the v3 -> v4 migration
 * (the legacy_* columns go, every row of a family stays), its refusal of a
 * file that still holds live plaintext, structural detection, the write-once
 * .v3.bak, the read-only fast path and the all-or-nothing transaction.
 *
 * Every test opens its OWN scratch file through raw PDO (bt_db memoizes one
 * static handle, which api.test.php holds on its shared file); the files are
 * unlinked at shutdown. The v3 fixture and the schema helpers live here — no
 * other test file needs them.
 */

require_once __DIR__ . '/../lib/http.php';
require_once __DIR__ . '/../lib/db.php';

$GLOBALS['__bt_scratch_files'] = [];
register_shutdown_function(function () {
    foreach ($GLOBALS['__bt_scratch_files'] as $file) {
        foreach (['', '-wal', '-shm', '.v3.bak'] as $suffix) {
            @unlink($file . $suffix);
        }
    }
});

// ---------------------------------------------------------------------------
// Harness (scratch files, the v3 fixture, schema assertions)
// ---------------------------------------------------------------------------

/** A fresh scratch file path (created empty by tempnam). */
function scratch_path(): string
{
    return tempnam(sys_get_temp_dir(), 'baby-mig-');
}

/** Raw PDO on a scratch file (no bt_db memoization, no schema work). */
function open_scratch_db(string $file): PDO
{
    $GLOBALS['__bt_scratch_files'][] = $file;
    $pdo = new PDO('sqlite:' . $file);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->exec('PRAGMA busy_timeout = 5000');
    return $pdo;
}

const V3_EID_LIVE_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01';
const V3_EID_LIVE_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const V3_EID_DELETED = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa02';
const V3_EID_EMPTY_TOMB = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa03';
const V3_EID_PLAIN_TOMB = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa04';
const V3_EID_ORPHAN_TOMB = 'cccccccccccccccccccccccccccccc01';
const V3_FEED = '0123456789abcdef0123456789abcdef';
const V3_MARKER = 'MARKER-PLAINTEXT-7f3a';

/**
 * Verbatim v3 schema as the first public release created it, with two
 * families, a member with a session, and every kind of row a v3 file can
 * hold once its phones have encrypted everything:
 *   - live encrypted rows of both families, and a deleted encrypted one
 *   - a tombstone without any content (deleted before it was encrypted, its
 *     plaintext already scrubbed)
 *   - a tombstone that still carries plaintext (its family never ran the
 *     last encryption pass) — the marker must not survive the migration
 *   - a deleted row of no family at all
 */
function seed_v3_db(PDO $pdo): void
{
    $pdo->exec(<<<'SQL'
CREATE TABLE families (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  auth_hash TEXT NOT NULL,
  kdf_salt TEXT NOT NULL,
  kdf_iter INTEGER NOT NULL,
  fdk_wrapped TEXT NOT NULL,
  recovery_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d','now'))
);
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id INTEGER NOT NULL,
  username TEXT NOT NULL UNIQUE,
  auth_hash TEXT NOT NULL,
  kdf_salt TEXT NOT NULL,
  kdf_iter INTEGER NOT NULL,
  fdk_wrapped TEXT NOT NULL,
  profile_blob TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d','now'))
);
CREATE TABLE entries (
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
CREATE INDEX idx_entries_family_seq ON entries (family_id, seq);
CREATE INDEX idx_entries_legacy ON entries (family_id) WHERE blob IS NULL;
CREATE TABLE auth_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d','now')),
  expires_at TEXT NOT NULL
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE login_attempts (
  ip TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES
  ('schema_version', '3'),
  ('salt_secret', 'ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12'),
  ('legacy_max_seq', '4'),
  ('feed_id', '0123456789abcdef0123456789abcdef');
INSERT INTO families (id, name, name_key, auth_hash, kdf_salt, kdf_iter, fdk_wrapped, recovery_hash, created_at) VALUES
  (1, 'Testfamilie', 'testfamilie', 'fh1', 'fs1', 600000, 'fw1', 'fr1', '2026-09-06'),
  (2, 'Andere', 'andere', 'fh2', 'fs2', 600000, 'fw2', 'fr2', '2026-09-07');
INSERT INTO users (id, family_id, username, auth_hash, kdf_salt, kdf_iter, fdk_wrapped, profile_blob, created_at) VALUES
  (1, 1, 'mama', 'uh1', 'us1', 600000, 'uw1', 'up1', '2026-09-06');
INSERT INTO auth_tokens (user_id, token_hash, created_at, expires_at) VALUES
  (1, 'v3-token', '2026-09-06', '2027-03-05');
INSERT INTO login_attempts (ip, fails, window_start) VALUES ('user:mama', 2, '2026-09-06T10:00:00Z');
INSERT INTO entries (eid, family_id, seq, blob, legacy_type, legacy_started_at, legacy_ended_at,
                     legacy_details, legacy_logged_by, created_at, updated_at, deleted_at) VALUES
  ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01', 1, 7, 'BLOB-A1', NULL, NULL, NULL, NULL, NULL, '2026-09-06', '2026-09-08', NULL),
  ('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01', 2, 1, 'BLOB-B1', NULL, NULL, NULL, NULL, NULL, '2026-09-07', '2026-09-07', NULL),
  ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa02', 1, 6, 'BLOB-A2', NULL, NULL, NULL, NULL, NULL, '2026-09-06', '2026-09-07', '2026-09-07'),
  ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa03', 1, 2, NULL, NULL, NULL, NULL, NULL, NULL, '2026-08-30', '2026-08-31', '2026-08-31'),
  ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa04', 1, 3, NULL, 'medication', '2026-08-30T09:00:00Z', NULL,
     '{"name":"MARKER-PLAINTEXT-7f3a"}', 'Mama', '2026-08-30', '2026-08-31', '2026-08-31'),
  ('cccccccccccccccccccccccccccccc01', NULL, 4, NULL, 'diaper', '2026-08-29T09:00:00Z', NULL,
     '{"kind":"pee"}', 'Papa', '2026-08-29', '2026-08-31', '2026-08-31');
SQL);
}

function index_exists(PDO $pdo, string $name): bool
{
    $stmt = $pdo->prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?");
    $stmt->execute([$name]);
    return $stmt->fetch(PDO::FETCH_ASSOC) !== false;
}

function table_exists(PDO $pdo, string $name): bool
{
    $stmt = $pdo->prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
    $stmt->execute([$name]);
    return $stmt->fetch(PDO::FETCH_ASSOC) !== false;
}

function count_rows(PDO $pdo, string $sql): int
{
    return (int) $pdo->query($sql)->fetchColumn();
}

/** Column names of a table in declaration order. */
function db_columns(PDO $pdo, string $table): array
{
    return array_map(function ($col) {
        return $col['name'];
    }, $pdo->query("PRAGMA table_info($table)")->fetchAll(PDO::FETCH_ASSOC));
}

/** Everything sqlite_master knows, in a stable order (auto-indexes included). */
function db_schema_dump(PDO $pdo): array
{
    return $pdo->query('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name')
        ->fetchAll(PDO::FETCH_ASSOC);
}

/** Non-automatic index names. */
function db_index_names(PDO $pdo): array
{
    return $pdo->query(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name"
    )->fetchAll(PDO::FETCH_COLUMN);
}

/** A settings value or null. */
function db_setting(PDO $pdo, string $key)
{
    $stmt = $pdo->prepare('SELECT value FROM settings WHERE key = ?');
    $stmt->execute([$key]);
    $value = $stmt->fetchColumn();
    return $value === false ? null : $value;
}

/** Every table's rows, for "nothing changed" comparisons. */
function db_content_dump(PDO $pdo): array
{
    $dump = [];
    foreach ($pdo->query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")->fetchAll(PDO::FETCH_COLUMN) as $table) {
        $dump[$table] = $pdo->query("SELECT * FROM \"$table\" ORDER BY 1")->fetchAll(PDO::FETCH_ASSOC);
    }
    return $dump;
}

const V4_ENTRY_COLUMNS = ['eid', 'family_id', 'seq', 'blob', 'created_at', 'updated_at', 'deleted_at'];

/** The assertions every migrated or created file must satisfy. */
function assert_v4_schema(PDO $pdo, string $label = ''): void
{
    $p = $label !== '' ? $label . ': ' : '';
    assert_eq(bt_schema_version($pdo), 4, $p . 'stamp');
    assert_eq(BT_SCHEMA_VERSION, 4);
    assert_eq(db_columns($pdo, 'entries'), V4_ENTRY_COLUMNS, $p . 'entries columns: no column for content');
    assert_false(bt_entries_is_v3(bt_entries_columns($pdo)), $p . 'not detected as v3');
    foreach (['families', 'users', 'entries', 'auth_tokens', 'settings', 'login_attempts'] as $table) {
        assert_true(table_exists($pdo, $table), $p . "table $table");
    }
    assert_false(table_exists($pdo, 'entries_v4'), $p . 'no working table left');
    assert_eq(db_index_names($pdo), ['idx_entries_family_seq'], $p . 'indexes');
    $salt = db_setting($pdo, 'salt_secret');
    assert_true(is_string($salt) && preg_match('/^[0-9a-f]{64}$/', $salt) === 1, $p . 'salt_secret is 32 random bytes as hex');
    $feed = db_setting($pdo, 'feed_id');
    assert_true(is_string($feed) && preg_match('/^[0-9a-f]{32}$/', $feed) === 1, $p . 'feed_id is 16 random bytes as hex');
    assert_eq(db_setting($pdo, 'legacy_max_seq'), null, $p . 'no legacy setting');
    assert_eq(
        array_column($pdo->query('SELECT key FROM settings ORDER BY key')->fetchAll(PDO::FETCH_ASSOC), 'key'),
        ['feed_id', 'salt_secret', 'schema_version'],
        $p . 'settings keys'
    );
}

/** A second run must be a pure read: schema, settings and change counter untouched. */
function assert_second_run_noop(PDO $pdo, string $file, string $label = ''): void
{
    $p = $label !== '' ? $label . ': ' : '';
    $schema = db_schema_dump($pdo);
    $settings = $pdo->query('SELECT key, value FROM settings ORDER BY key')->fetchAll(PDO::FETCH_ASSOC);
    $changes = (int) $pdo->query('SELECT total_changes()')->fetchColumn();
    bt_create_or_migrate($pdo, $file);
    assert_eq(db_schema_dump($pdo), $schema, $p . 'sqlite_master unchanged');
    assert_eq($pdo->query('SELECT key, value FROM settings ORDER BY key')->fetchAll(PDO::FETCH_ASSOC), $settings, $p . 'settings unchanged');
    assert_eq((int) $pdo->query('SELECT total_changes()')->fetchColumn(), $changes, $p . 'no row written');
}

/** Run $fn and return the RuntimeException it must throw. */
function db_expect_refusal(callable $fn, string $label): RuntimeException
{
    try {
        $fn();
    } catch (RuntimeException $e) {
        if (!($e instanceof PDOException)) {
            return $e;
        }
        throw new BtAssertionError("$label: expected a refusal, got a PDOException: " . $e->getMessage());
    }
    throw new BtAssertionError("$label: expected a refusal, nothing thrown");
}

// ---------------------------------------------------------------------------
// Fresh files
// ---------------------------------------------------------------------------

bt_test('schema: a fresh file gets v4 directly, without a backup; the second run is a pure read', function () {
    $file = scratch_path();
    @unlink($file); // truly fresh: bt_create_or_migrate sees no file at all
    $pdo = open_scratch_db($file);
    assert_eq(bt_entries_columns($pdo), [], 'no entries table yet');

    bt_create_or_migrate($pdo, $file);

    assert_v4_schema($pdo, 'fresh');
    assert_eq(count_rows($pdo, 'SELECT COUNT(*) FROM entries'), 0);
    assert_false(is_file($file . '.v3.bak'), 'nothing to back up');
    assert_second_run_noop($pdo, $file, 'fresh, second run');

    // Two fresh files never share a feed or a salt.
    $other = scratch_path();
    @unlink($other);
    $opdo = open_scratch_db($other);
    bt_create_or_migrate($opdo, $other);
    assert_true(db_setting($opdo, 'feed_id') !== db_setting($pdo, 'feed_id'), 'feed_id is per file');
    assert_true(db_setting($opdo, 'salt_secret') !== db_setting($pdo, 'salt_secret'), 'salt_secret is per file');

    // The entries table refuses a row without a family.
    try {
        $pdo->exec("INSERT INTO entries (eid, seq, blob, created_at, updated_at)
            VALUES ('0123456789abcdef0123456789abcdef', 1, 'AQ', '2026-09-01', '2026-09-01')");
        throw new BtAssertionError('a row without a family must be refused');
    } catch (PDOException $e) {
        assert_true(strpos($e->getMessage(), 'NOT NULL') !== false);
    }
});

// ---------------------------------------------------------------------------
// v3 -> v4
// ---------------------------------------------------------------------------

bt_test('migration v3 -> v4: rows of a family carried over verbatim, the legacy columns and their plaintext gone, accounts untouched, write-once .v3.bak', function () {
    $file = scratch_path();
    $pdo = open_scratch_db($file);
    seed_v3_db($pdo);
    assert_true(bt_entries_is_v3(bt_entries_columns($pdo)), 'fixture detected as v3');
    $accounts = [
        'families' => $pdo->query('SELECT * FROM families ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
        'users' => $pdo->query('SELECT * FROM users ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
        'auth_tokens' => $pdo->query('SELECT * FROM auth_tokens ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
        'login_attempts' => $pdo->query('SELECT * FROM login_attempts ORDER BY ip')->fetchAll(PDO::FETCH_ASSOC),
    ];

    bt_create_or_migrate($pdo, $file);

    assert_v4_schema($pdo, 'v3 -> v4');
    // (PDO hands integers back as strings before PHP 8.1.)
    $rows = array_map(function ($row) {
        return ['family_id' => (int) $row['family_id'], 'seq' => (int) $row['seq']] + $row;
    }, $pdo->query('SELECT * FROM entries ORDER BY family_id, seq')->fetchAll(PDO::FETCH_ASSOC));
    $sorted = function (array $row) {
        ksort($row);
        return $row;
    };
    assert_eq(array_map($sorted, $rows), array_map($sorted, [
        ['eid' => V3_EID_EMPTY_TOMB, 'family_id' => 1, 'seq' => 2, 'blob' => null,
            'created_at' => '2026-08-30', 'updated_at' => '2026-08-31', 'deleted_at' => '2026-08-31'],
        ['eid' => V3_EID_PLAIN_TOMB, 'family_id' => 1, 'seq' => 3, 'blob' => null,
            'created_at' => '2026-08-30', 'updated_at' => '2026-08-31', 'deleted_at' => '2026-08-31'],
        ['eid' => V3_EID_DELETED, 'family_id' => 1, 'seq' => 6, 'blob' => 'BLOB-A2',
            'created_at' => '2026-09-06', 'updated_at' => '2026-09-07', 'deleted_at' => '2026-09-07'],
        ['eid' => V3_EID_LIVE_A, 'family_id' => 1, 'seq' => 7, 'blob' => 'BLOB-A1',
            'created_at' => '2026-09-06', 'updated_at' => '2026-09-08', 'deleted_at' => null],
        ['eid' => V3_EID_LIVE_B, 'family_id' => 2, 'seq' => 1, 'blob' => 'BLOB-B1',
            'created_at' => '2026-09-07', 'updated_at' => '2026-09-07', 'deleted_at' => null],
    ]), 'eid, seq, blob and dates unchanged; the deleted row of no family is not carried over');

    // Phones keep their mirrors: same feed, same salt, same sessions.
    assert_eq(db_setting($pdo, 'feed_id'), V3_FEED, 'feed_id kept — no phone resyncs');
    assert_eq(db_setting($pdo, 'salt_secret'), str_repeat('ab12', 16), 'salt_secret kept');
    foreach ($accounts as $table => $before) {
        assert_eq($pdo->query("SELECT * FROM $table ORDER BY 1")->fetchAll(PDO::FETCH_ASSOC), $before, "$table untouched");
    }

    // The tombstone's plaintext is in no table any more.
    foreach (db_content_dump($pdo) as $table => $content) {
        assert_true(strpos(json_encode($content), V3_MARKER) === false, "marker gone from $table");
    }

    // The backup is the untouched v3 file.
    $bak = $file . '.v3.bak';
    assert_true(is_file($bak), '.v3.bak written');
    $bpdo = new PDO('sqlite:' . $bak);
    $bpdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    assert_eq(count_rows($bpdo, 'SELECT COUNT(*) FROM entries'), 6);
    assert_true(in_array('legacy_type', db_columns($bpdo, 'entries'), true));
    assert_eq(db_setting($bpdo, 'schema_version'), '3');
    $bpdo = null;

    // A second run is a no-op (fast path) and the backup is write-once.
    assert_second_run_noop($pdo, $file, 'second run');
    bt_backup_db_file($pdo, $file, 'v3');
    $bpdo = new PDO('sqlite:' . $bak);
    assert_true(in_array('legacy_type', db_columns($bpdo, 'entries'), true), 'backup not overwritten by the v4 file');
    $bpdo = null;
});

bt_test('migration v3 -> v4: a migrated file and a fresh file have the identical schema', function () {
    $v3File = scratch_path();
    $v3 = open_scratch_db($v3File);
    seed_v3_db($v3);
    bt_create_or_migrate($v3, $v3File);

    $freshFile = scratch_path();
    @unlink($freshFile);
    $fresh = open_scratch_db($freshFile);
    bt_create_or_migrate($fresh, $freshFile);

    // ALTER TABLE … RENAME stores the new name quoted ("entries"); nothing else may differ.
    $unquoted = function (array $dump) {
        return array_map(function ($object) {
            $object['sql'] = $object['sql'] === null ? null : str_replace('CREATE TABLE "entries"', 'CREATE TABLE entries', $object['sql']);
            return $object;
        }, $dump);
    };
    assert_eq($unquoted(db_schema_dump($v3)), db_schema_dump($fresh), 'same sqlite_master, statement for statement');
    assert_eq(
        $v3->query('PRAGMA table_info(entries)')->fetchAll(PDO::FETCH_ASSOC),
        $fresh->query('PRAGMA table_info(entries)')->fetchAll(PDO::FETCH_ASSOC),
        'same entries declaration'
    );
});

bt_test('migration v3 -> v4: REFUSED while a live row is still plaintext or has no family — file untouched, no backup; passes once it is encrypted', function () {
    foreach ([
        'live plaintext row' => "INSERT INTO entries (eid, family_id, seq, blob, legacy_type, legacy_started_at, legacy_details, created_at, updated_at)
            VALUES ('dddddddddddddddddddddddddddddd01', 1, 5, NULL, 'bottle', '2026-08-30T08:00:00Z', '{\"amount_ml\":90}', '2026-08-30', '2026-08-30')",
        'live row of no family' => "INSERT INTO entries (eid, family_id, seq, blob, legacy_type, legacy_started_at, legacy_details, created_at, updated_at)
            VALUES ('dddddddddddddddddddddddddddddd01', NULL, 5, NULL, 'bottle', '2026-08-30T08:00:00Z', '{\"amount_ml\":90}', '2026-08-30', '2026-08-30')",
        'encrypted live row with a plaintext leftover' => "INSERT INTO entries (eid, family_id, seq, blob, legacy_logged_by, created_at, updated_at)
            VALUES ('dddddddddddddddddddddddddddddd01', 1, 5, 'BLOB-D1', 'Mama', '2026-08-30', '2026-08-30')",
    ] as $label => $insert) {
        $file = scratch_path();
        $pdo = open_scratch_db($file);
        seed_v3_db($pdo);
        $pdo->exec($insert);
        $schema = db_schema_dump($pdo);
        $content = db_content_dump($pdo);

        $e = db_expect_refusal(function () use ($pdo, $file) {
            bt_create_or_migrate($pdo, $file);
        }, $label);
        assert_true(strpos($e->getMessage(), 'schema v3 -> v4 refused: 1 live entries') === 0, "$label: says what and how many");
        assert_true(strpos($e->getMessage(), 'left untouched') !== false, "$label: says the file is intact");

        assert_eq(db_schema_dump($pdo), $schema, "$label: schema untouched");
        assert_eq(db_content_dump($pdo), $content, "$label: every row untouched");
        assert_false(is_file($file . '.v3.bak'), "$label: a refused file gets no backup");
        assert_true($pdo->query('SELECT 1')->fetchColumn() !== false, "$label: connection still usable");

        // What the last v3 release does when a phone encrypts the row.
        $pdo->exec("UPDATE entries SET family_id = 1, blob = 'BLOB-D1', legacy_type = NULL, legacy_started_at = NULL,
            legacy_ended_at = NULL, legacy_details = NULL, legacy_logged_by = NULL WHERE eid = 'dddddddddddddddddddddddddddddd01'");
        bt_create_or_migrate($pdo, $file);
        assert_v4_schema($pdo, "$label, encrypted");
        assert_eq(count_rows($pdo, "SELECT COUNT(*) FROM entries WHERE eid = 'dddddddddddddddddddddddddddddd01' AND blob = 'BLOB-D1'"), 1);
        assert_eq(count_rows($pdo, 'SELECT COUNT(*) FROM entries'), 6);
    }
});

bt_test('migration: the structure decides, not the stamp — a v3 file stamped 4 is migrated, a v4 file with a stale stamp is only re-stamped', function () {
    $file = scratch_path();
    $pdo = open_scratch_db($file);
    seed_v3_db($pdo);
    $pdo->exec("UPDATE settings SET value = '4' WHERE key = 'schema_version'");
    bt_create_or_migrate($pdo, $file);
    assert_v4_schema($pdo, 'v3 structure, stamp 4');
    assert_eq(count_rows($pdo, 'SELECT COUNT(*) FROM entries'), 5);

    $content = db_content_dump($pdo);
    $pdo->exec("UPDATE settings SET value = '3' WHERE key = 'schema_version'");
    bt_create_or_migrate($pdo, $file);
    assert_v4_schema($pdo, 'v4 structure, stamp 3');
    assert_eq(db_content_dump($pdo), $content, 'nothing but the stamp moved');

    $pdo->exec("DELETE FROM settings WHERE key = 'schema_version'");
    bt_create_or_migrate($pdo, $file);
    assert_v4_schema($pdo, 'v4 structure, no stamp');
    assert_eq(db_content_dump($pdo), $content);
});

bt_test('migration: an entries table without a blob column (older than v3) is refused untouched', function () {
    $file = scratch_path();
    $pdo = open_scratch_db($file);
    $pdo->exec(<<<'SQL'
CREATE TABLE entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  logged_by TEXT
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
INSERT INTO settings (key, value) VALUES ('schema_version', '1');
INSERT INTO entries (type, started_at, details, logged_by) VALUES ('bottle', '2026-08-30T08:00:00Z', '{"amount_ml":90}', 'Mama');
SQL);
    $schema = db_schema_dump($pdo);
    $content = db_content_dump($pdo);

    $e = db_expect_refusal(function () use ($pdo, $file) {
        bt_create_or_migrate($pdo, $file);
    }, 'pre-v3');
    assert_true(strpos($e->getMessage(), 'predates schema v3') !== false);
    assert_eq(db_schema_dump($pdo), $schema, 'schema untouched');
    assert_eq(db_content_dump($pdo), $content, 'rows untouched');
    assert_false(is_file($file . '.v3.bak'));

    // The stamp does not talk it into anything either.
    $pdo->exec("UPDATE settings SET value = '4' WHERE key = 'schema_version'");
    db_expect_refusal(function () use ($pdo, $file) {
        bt_create_or_migrate($pdo, $file);
    }, 'pre-v3 stamped 4');
    assert_eq(db_content_dump($pdo)['entries'], $content['entries']);
});

// ---------------------------------------------------------------------------
// Transaction safety
// ---------------------------------------------------------------------------

bt_test('migration v3 -> v4: a failing step rolls everything back and leaves the v3 file untouched', function () {
    $file = scratch_path();
    $pdo = open_scratch_db($file);
    seed_v3_db($pdo);
    // A stray table with the rebuild's working name makes CREATE TABLE fail
    // inside the transaction.
    $pdo->exec('CREATE TABLE entries_v4 (x)');
    $schema = db_schema_dump($pdo);
    $content = db_content_dump($pdo);

    try {
        bt_create_or_migrate($pdo, $file);
        throw new BtAssertionError('expected the migration to fail');
    } catch (PDOException $e) {
        assert_true(strpos($e->getMessage(), 'entries_v4') !== false, 'the failing statement');
    }

    assert_eq(bt_schema_version($pdo), 3, 'stamp untouched');
    assert_eq(db_schema_dump($pdo), $schema, 'schema untouched');
    assert_eq(db_content_dump($pdo), $content, 'every row untouched, the plaintext tombstone included');
    assert_eq(db_setting($pdo, 'legacy_max_seq'), '4', 'setting back');
    assert_true(is_file($file . '.v3.bak'), 'the backup (taken before the lock) stays');
    assert_true($pdo->query('SELECT 1')->fetchColumn() !== false, 'connection still usable');

    // Once the obstacle is gone the next request migrates normally.
    $pdo->exec('DROP TABLE entries_v4');
    bt_create_or_migrate($pdo, $file);
    assert_v4_schema($pdo, 'retry');
    assert_eq(count_rows($pdo, 'SELECT COUNT(*) FROM entries'), 5);
});

// ---------------------------------------------------------------------------
// bt_db
// ---------------------------------------------------------------------------

bt_test('bt_db: secure_delete is on and the handle is a v4 database', function () {
    // bt_db memoizes one static handle per process; api.test.php normally
    // opened it on its shared scratch file. Without that file, use our own —
    // never the default data/baby.db.
    $file = $GLOBALS['__bt_db_file'] ?? null;
    if (!is_string($file) || $file === '') {
        $file = scratch_path();
        $GLOBALS['__bt_scratch_files'][] = $file;
    }
    $pdo = bt_db(['db_path' => $file]);
    assert_eq((int) $pdo->query('PRAGMA secure_delete')->fetchColumn(), 1, 'secure_delete on');
    assert_eq((int) $pdo->query('PRAGMA busy_timeout')->fetchColumn(), 5000);
    assert_eq(bt_schema_version($pdo), 4);
    assert_eq(db_columns($pdo, 'entries'), V4_ENTRY_COLUMNS);
    assert_true(bt_db(['db_path' => '/nonexistent/other.db']) === $pdo, 'memoized handle');
});
