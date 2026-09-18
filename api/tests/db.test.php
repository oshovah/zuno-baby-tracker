<?php
/**
 * Schema tests for api/lib/db.php: fresh v3 creation, the v1 -> v2 -> v3
 * migration chain (production runs v1; v2 existed only in dev), structural
 * detection, the write-once .v1.bak, the read-only fast path and the
 * all-or-nothing transaction.
 *
 * Every test opens its OWN scratch file through raw PDO (bt_db memoizes one
 * static handle, which api.test.php holds on its shared file); the files are
 * unlinked at shutdown. The v1/v2 fixtures and the schema helpers live here —
 * no other test file needs them.
 */

require_once __DIR__ . '/../lib/http.php';
require_once __DIR__ . '/../lib/db.php';

$GLOBALS['__bt_scratch_files'] = [];
register_shutdown_function(function () {
    foreach ($GLOBALS['__bt_scratch_files'] as $file) {
        foreach (['', '-wal', '-shm', '.v1.bak'] as $suffix) {
            @unlink($file . $suffix);
        }
    }
});

// ---------------------------------------------------------------------------
// Harness (scratch files + the v1/v2 fixtures)
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

/**
 * Verbatim v1 schema (single shared password, no users) as the previous
 * release wrote it, plus 3 entries (one open sleep) and 2 tokens.
 */
function seed_v1_db(PDO $pdo): void
{
    $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  logged_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_entries_started_at ON entries (started_at);
CREATE INDEX IF NOT EXISTS idx_entries_type_started ON entries (type, started_at);
CREATE TABLE IF NOT EXISTS auth_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_one_open
  ON entries (type)
  WHERE ended_at IS NULL AND deleted_at IS NULL
    AND type IN ('breastfeed', 'sleep');
INSERT INTO settings (key, value) VALUES ('schema_version', '1');
INSERT INTO entries (type, started_at, ended_at, details, logged_by) VALUES
  ('bottle', '2026-08-30T08:00:00Z', NULL, '{"amount_ml":90}', 'Mama'),
  ('diaper', '2026-08-30T09:00:00Z', NULL, '{"kind":"pee"}', 'Papa'),
  ('sleep', '2026-08-30T10:00:00Z', NULL, '{}', 'Mama');
INSERT INTO auth_tokens (token_hash, expires_at) VALUES
  ('v1-token-a', datetime('now', '+10 days')),
  ('v1-token-b', datetime('now', '+10 days'));
SQL);
}

function index_exists(PDO $pdo, string $name): bool
{
    $stmt = $pdo->prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?");
    $stmt->execute([$name]);
    return $stmt->fetch(PDO::FETCH_ASSOC) !== false;
}

function column_exists(PDO $pdo, string $table, string $column): bool
{
    foreach ($pdo->query("PRAGMA table_info($table)")->fetchAll(PDO::FETCH_ASSOC) as $col) {
        if (($col['name'] ?? '') === $column) {
            return true;
        }
    }
    return false;
}

function count_rows(PDO $pdo, string $sql): int
{
    return (int) $pdo->query($sql)->fetchColumn();
}

// ---------------------------------------------------------------------------
// Harness (v2 fixture + schema assertions)
// ---------------------------------------------------------------------------

/**
 * Verbatim v2 schema as the v2-accounts tag wrote it (bt_create_schema of
 * `git show v2-accounts:api/lib/db.php`), plus one family with one member
 * and a session, two adopted entries (one open sleep) and one unadopted,
 * soft-deleted legacy row.
 */
function seed_v2_db(PDO $pdo): void
{
    $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS families (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id INTEGER NOT NULL,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id INTEGER,
  type TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  logged_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_entries_started_at ON entries (started_at);
CREATE INDEX IF NOT EXISTS idx_entries_type_started ON entries (type, started_at);
CREATE INDEX IF NOT EXISTS idx_entries_family_started ON entries (family_id, started_at);
CREATE TABLE IF NOT EXISTS auth_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL
);
DROP INDEX IF EXISTS idx_entries_one_open;
CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_one_open_family
  ON entries (family_id, type)
  WHERE ended_at IS NULL AND deleted_at IS NULL AND type IN ('breastfeed', 'sleep');
INSERT INTO settings (key, value) VALUES ('schema_version', '2')
  ON CONFLICT(key) DO UPDATE SET value = '2';
INSERT INTO families (id, name, name_key, password_hash) VALUES
  (1, 'Testfamilie', 'testfamilie', '$2y$04$v2-family-hash-placeholder');
INSERT INTO users (id, family_id, username, display_name, password_hash) VALUES
  (1, 1, 'mama', 'Mama', '$2y$04$v2-user-hash-placeholder');
INSERT INTO auth_tokens (user_id, token_hash, expires_at) VALUES
  (1, 'v2-token', datetime('now', '+10 days'));
INSERT INTO entries (family_id, type, started_at, ended_at, details, logged_by, created_at, updated_at, deleted_at) VALUES
  (1, 'bottle', '2026-08-30T08:00:00Z', NULL, '{"amount_ml":90}', 'Mama',
     '2026-08-30T08:01:02Z', '2026-08-30T08:01:02Z', NULL),
  (1, 'sleep', '2026-08-30T10:00:00Z', NULL, '{}', 'Mama',
     '2026-08-30T10:00:05Z', '2026-08-30T10:00:05Z', NULL),
  (NULL, 'diaper', '2026-08-29T09:00:00Z', NULL, '{"kind":"pee"}', 'Papa',
     '2026-08-29T09:00:30Z', '2026-08-31T05:06:07Z', '2026-08-31T05:06:07Z');
SQL);
}

/** Column names of a table in declaration order. */
function db_columns(PDO $pdo, string $table): array
{
    return array_map(function ($col) {
        return $col['name'];
    }, $pdo->query("PRAGMA table_info($table)")->fetchAll(PDO::FETCH_ASSOC));
}

/** Full column declarations (name, type, notnull, default, pk) of a table. */
function db_table_info(PDO $pdo, string $table): array
{
    return array_map(function ($col) {
        unset($col['cid']);
        return $col;
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

const V3_ENTRY_COLUMNS = [
    'eid', 'family_id', 'seq', 'blob',
    'legacy_type', 'legacy_started_at', 'legacy_ended_at', 'legacy_details', 'legacy_logged_by',
    'created_at', 'updated_at', 'deleted_at',
];
const OLD_ENTRY_INDEXES = [
    'idx_entries_one_open', 'idx_entries_one_open_family',
    'idx_entries_started_at', 'idx_entries_type_started', 'idx_entries_family_started',
];

/** The assertions every migrated or created file must satisfy. */
function assert_v3_schema(PDO $pdo, string $label = ''): void
{
    $p = $label !== '' ? $label . ': ' : '';
    assert_eq(bt_schema_version($pdo), 3, $p . 'stamp');
    assert_true(bt_entries_has_family_id($pdo), $p . 'family_id');
    assert_true(bt_entries_has_blob($pdo), $p . 'blob');
    assert_eq(db_columns($pdo, 'entries'), V3_ENTRY_COLUMNS, $p . 'entries columns');
    foreach (['families', 'users', 'entries', 'auth_tokens', 'settings', 'login_attempts'] as $table) {
        assert_true(bt_table_exists($pdo, $table), $p . "table $table");
    }
    foreach (['auth_hash', 'kdf_salt', 'kdf_iter', 'fdk_wrapped', 'recovery_hash', 'name_key'] as $column) {
        assert_true(column_exists($pdo, 'families', $column), $p . "families.$column");
    }
    foreach (['auth_hash', 'kdf_salt', 'kdf_iter', 'fdk_wrapped', 'profile_blob', 'family_id'] as $column) {
        assert_true(column_exists($pdo, 'users', $column), $p . "users.$column");
    }
    assert_false(column_exists($pdo, 'families', 'password_hash'), $p . 'v2 families column gone');
    assert_false(column_exists($pdo, 'users', 'password_hash'), $p . 'v2 users column gone');
    assert_false(column_exists($pdo, 'users', 'display_name'), $p . 'display name lives in the profile blob');
    assert_true(column_exists($pdo, 'auth_tokens', 'user_id'), $p . 'auth_tokens.user_id');
    foreach (OLD_ENTRY_INDEXES as $index) {
        assert_false(index_exists($pdo, $index), $p . "old index $index gone");
    }
    assert_eq(db_index_names($pdo), ['idx_entries_family_seq', 'idx_entries_legacy'], $p . 'v3 indexes');
    $salt = db_setting($pdo, 'salt_secret');
    assert_true(is_string($salt) && preg_match('/^[0-9a-f]{64}$/', $salt) === 1, $p . 'salt_secret is 32 random bytes as hex');
    $feed = db_setting($pdo, 'feed_id');
    assert_true(is_string($feed) && preg_match('/^[0-9a-f]{32}$/', $feed) === 1, $p . 'feed_id is 16 random bytes as hex');
    assert_true(bt_has_feed_id($pdo), $p . 'feed_id detected');
    // Exact value is pinned per test (it is frozen at migration time, later
    // encrypted writes move MAX(seq) past it).
    assert_true(preg_match('/^\d+$/', (string) db_setting($pdo, 'legacy_max_seq')) === 1, $p . 'legacy_max_seq present');
}

/** The migrated entries (legacy rows) must satisfy these regardless of origin. */
function assert_legacy_rows(PDO $pdo, int $expected, string $label = ''): array
{
    $p = $label !== '' ? $label . ': ' : '';
    $rows = $pdo->query('SELECT * FROM entries ORDER BY seq')->fetchAll(PDO::FETCH_ASSOC);
    assert_eq(count($rows), $expected, $p . 'row count');
    assert_eq(count_rows($pdo, 'SELECT COUNT(DISTINCT eid) FROM entries'), $expected, $p . 'eids unique');
    foreach ($rows as $row) {
        assert_true(preg_match('/^[0-9a-f]{32}$/', $row['eid']) === 1, $p . 'eid is 32 lowercase hex');
        assert_eq($row['family_id'], null, $p . 'legacy rows are unadopted');
        assert_eq($row['blob'], null, $p . 'blob NULL until sealed');
        assert_true(is_string($row['legacy_type']) && $row['legacy_type'] !== '', $p . 'legacy_type filled');
        assert_true(is_string($row['legacy_started_at']), $p . 'legacy_started_at filled');
        assert_true(is_string($row['legacy_details']), $p . 'legacy_details filled');
        assert_true(preg_match('/^\d{4}-\d{2}-\d{2}$/', $row['created_at']) === 1, $p . 'created_at is a day');
        assert_true(preg_match('/^\d{4}-\d{2}-\d{2}$/', $row['updated_at']) === 1, $p . 'updated_at is a day');
        assert_true($row['deleted_at'] === null || preg_match('/^\d{4}-\d{2}-\d{2}$/', $row['deleted_at']) === 1, $p . 'deleted_at is a day or NULL');
    }
    return $rows;
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

// ---------------------------------------------------------------------------
// v1 -> v3 (the production path)
// ---------------------------------------------------------------------------

bt_test('migration: a v1 file is backed up once and migrated v1 -> v2 -> v3 in a single run', function () {
    $file = scratch_path();
    $pdo = open_scratch_db($file);
    seed_v1_db($pdo);
    // Pin the timestamps so the day coarsening is deterministic; soft-delete one row.
    $pdo->exec("UPDATE entries SET created_at = '2026-08-30T08:01:02Z', updated_at = '2026-08-30T09:03:04Z'");
    $pdo->exec("UPDATE entries SET deleted_at = '2026-08-31T05:06:07Z', updated_at = '2026-08-31T05:06:07Z' WHERE id = 2");
    assert_eq(bt_schema_version($pdo), 1);
    assert_false(bt_entries_has_family_id($pdo));
    assert_false(bt_entries_has_blob($pdo));
    assert_false(bt_table_exists($pdo, 'users'), 'v1 has no accounts (the chain must cope)');

    bt_create_or_migrate($pdo, $file);

    assert_v3_schema($pdo, 'v1 -> v3');
    $rows = assert_legacy_rows($pdo, 3, 'v1 -> v3');
    assert_eq(array_column($rows, 'seq'), [1, 2, 3], 'seq = old id');
    assert_eq(array_column($rows, 'legacy_type'), ['bottle', 'diaper', 'sleep']);
    assert_eq(array_column($rows, 'legacy_started_at'), ['2026-08-30T08:00:00Z', '2026-08-30T09:00:00Z', '2026-08-30T10:00:00Z']);
    assert_eq(array_column($rows, 'legacy_ended_at'), [null, null, null], 'the open sleep stays open');
    assert_eq(array_column($rows, 'legacy_details'), ['{"amount_ml":90}', '{"kind":"pee"}', '{}']);
    assert_eq(array_column($rows, 'legacy_logged_by'), ['Mama', 'Papa', 'Mama']);
    assert_eq(array_column($rows, 'created_at'), ['2026-08-30', '2026-08-30', '2026-08-30'], 'created_at coarsened');
    assert_eq(array_column($rows, 'updated_at'), ['2026-08-30', '2026-08-31', '2026-08-30'], 'updated_at coarsened');
    assert_eq(array_column($rows, 'deleted_at'), [null, '2026-08-31', null], 'deleted_at coarsened, NULL kept');
    assert_eq(db_setting($pdo, 'legacy_max_seq'), '3', 'legacy_max_seq = highest migrated seq');

    // Accounts and sessions: tables exist in their v3 shape and are empty.
    assert_eq(count_rows($pdo, 'SELECT COUNT(*) FROM families'), 0);
    assert_eq(count_rows($pdo, 'SELECT COUNT(*) FROM users'), 0);
    assert_eq(count_rows($pdo, 'SELECT COUNT(*) FROM auth_tokens'), 0, 'v1 sessions are gone');
    assert_eq(count_rows($pdo, 'SELECT COUNT(*) FROM login_attempts'), 0);

    // The backup is the untouched v1 file.
    $bak = $file . '.v1.bak';
    assert_true(is_file($bak), '.v1.bak written');
    $bpdo = new PDO('sqlite:' . $bak);
    $bpdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    assert_eq(count_rows($bpdo, 'SELECT COUNT(*) FROM entries'), 3);
    assert_false(column_exists($bpdo, 'entries', 'family_id'));
    assert_true(column_exists($bpdo, 'entries', 'type'));
    assert_true(index_exists($bpdo, 'idx_entries_one_open'));
    assert_eq(count_rows($bpdo, 'SELECT COUNT(*) FROM auth_tokens'), 2);
    assert_eq(db_setting($bpdo, 'schema_version'), '1');
    $bpdo = null;

    // A second run is a no-op (fast path) and the backup is write-once.
    $pdo->exec("INSERT INTO auth_tokens (user_id, token_hash, expires_at) VALUES (1, 'v3-token', date('now', '+1 day'))");
    assert_second_run_noop($pdo, $file, 'second run');
    bt_backup_v1_file($pdo, $file);
    assert_eq(count_rows($pdo, 'SELECT COUNT(*) FROM auth_tokens'), 1, 'v3 token kept');
    assert_eq(count_rows($pdo, 'SELECT COUNT(*) FROM entries'), 3);
    $bpdo = new PDO('sqlite:' . $bak);
    assert_false(column_exists($bpdo, 'entries', 'family_id'), 'backup not overwritten by the v3 file');
    $bpdo = null;
});

bt_test('migration: a v1 file without the version stamp is detected structurally', function () {
    $file = scratch_path();
    $pdo = open_scratch_db($file);
    seed_v1_db($pdo);
    $pdo->exec('DELETE FROM settings');
    assert_eq(bt_schema_version($pdo), 0);

    bt_create_or_migrate($pdo, $file);

    assert_v3_schema($pdo, 'unstamped v1');
    assert_legacy_rows($pdo, 3, 'unstamped v1');
    assert_eq(db_setting($pdo, 'legacy_max_seq'), '3');
    assert_true(is_file($file . '.v1.bak'));
});

bt_test('migration: legacy plaintext (incl. a marker string) is carried verbatim into legacy_*', function () {
    $file = scratch_path();
    $pdo = open_scratch_db($file);
    seed_v1_db($pdo);
    $marker = 'MARKER-plaintext-7f3a9c';
    $details = '{"name":"Vitamin D ' . $marker . '","note":"Ümläute & \"quotes\""}';
    $stmt = $pdo->prepare(
        "INSERT INTO entries (type, started_at, ended_at, details, logged_by, deleted_at)
         VALUES ('medication', '2026-08-30T11:00:00Z', NULL, ?, 'Oma Käthi', NULL)"
    );
    $stmt->execute([$details]);
    $pdo->exec("INSERT INTO entries (type, started_at, ended_at, details, logged_by)
        VALUES ('breastfeed', '2026-08-30T12:00:00Z', '2026-08-30T12:20:00Z', '{\"side\":\"L\"}', NULL)");

    bt_create_or_migrate($pdo, $file);

    $rows = assert_legacy_rows($pdo, 5, 'marker');
    assert_eq(db_setting($pdo, 'legacy_max_seq'), '5');
    $med = $rows[3];
    assert_eq($med['seq'], 4);
    assert_eq($med['legacy_type'], 'medication');
    assert_eq($med['legacy_details'], $details, 'details byte-for-byte');
    assert_true(strpos($med['legacy_details'], $marker) !== false, 'marker still readable (sealed later by the client)');
    assert_eq($med['legacy_logged_by'], 'Oma Käthi');
    $feed = $rows[4];
    assert_eq($feed['legacy_ended_at'], '2026-08-30T12:20:00Z', 'closed timer keeps its end');
    assert_eq($feed['legacy_logged_by'], null, 'NULL logger stays NULL');
    // The plaintext is still in the file: sealing + VACUUM is the client's
    // job, the migration only relocates the columns.
    assert_true(strpos((string) file_get_contents($file), $marker) !== false, 'marker in the db bytes');
});

// ---------------------------------------------------------------------------
// v2 -> v3 (dev files only)
// ---------------------------------------------------------------------------

bt_test('migration: a v2 file loses accounts + sessions, entries return to the pool, no backup', function () {
    $file = scratch_path();
    $pdo = open_scratch_db($file);
    seed_v2_db($pdo);
    assert_eq(bt_schema_version($pdo), 2);
    assert_true(bt_entries_has_family_id($pdo));
    assert_false(bt_entries_has_blob($pdo));
    assert_eq(count_rows($pdo, 'SELECT COUNT(*) FROM entries WHERE family_id = 1'), 2, 'fixture: two adopted rows');
    assert_true(index_exists($pdo, 'idx_entries_one_open_family'));
    assert_true(index_exists($pdo, 'idx_entries_family_started'));

    bt_create_or_migrate($pdo, $file);

    assert_v3_schema($pdo, 'v2 -> v3');
    assert_eq(count_rows($pdo, 'SELECT COUNT(*) FROM families'), 0, 'v2 family dropped');
    assert_eq(count_rows($pdo, 'SELECT COUNT(*) FROM users'), 0, 'v2 user dropped');
    assert_eq(count_rows($pdo, 'SELECT COUNT(*) FROM auth_tokens'), 0, 'v2 session dropped');

    $rows = assert_legacy_rows($pdo, 3, 'v2 -> v3');
    assert_eq(array_column($rows, 'seq'), [1, 2, 3]);
    assert_eq(array_column($rows, 'legacy_type'), ['bottle', 'sleep', 'diaper']);
    assert_eq(array_column($rows, 'legacy_details'), ['{"amount_ml":90}', '{}', '{"kind":"pee"}']);
    assert_eq(array_column($rows, 'created_at'), ['2026-08-30', '2026-08-30', '2026-08-29']);
    assert_eq(array_column($rows, 'updated_at'), ['2026-08-30', '2026-08-30', '2026-08-31']);
    assert_eq(array_column($rows, 'deleted_at'), [null, null, '2026-08-31']);
    assert_eq(count_rows($pdo, 'SELECT COUNT(*) FROM entries WHERE family_id IS NULL'), 3, 'adopted rows are unadopted again');
    assert_eq(db_setting($pdo, 'legacy_max_seq'), '3');

    // The recreated families table restarts at id 1: a new family must not
    // inherit rows by id coincidence (hence the NULLing above).
    $pdo->exec("INSERT INTO families (name, name_key, auth_hash, kdf_salt, kdf_iter, fdk_wrapped, recovery_hash)
        VALUES ('Neu', 'neu', 'h', 's', 600000, 'w', 'r')");
    assert_eq((int) $pdo->query('SELECT id FROM families')->fetchColumn(), 1);
    assert_eq(count_rows($pdo, 'SELECT COUNT(*) FROM entries WHERE family_id = 1'), 0, 'nothing inherited');

    assert_false(is_file($file . '.v1.bak'), 'v2 files get no backup');
    assert_second_run_noop($pdo, $file, 'second run');
});

// ---------------------------------------------------------------------------
// Fresh files, fast path, schema equality
// ---------------------------------------------------------------------------

bt_test('migration: a fresh file gets v3 directly, without a backup', function () {
    $file = scratch_path();
    @unlink($file); // as in production: the file does not exist yet
    $pdo = open_scratch_db($file);
    assert_eq(bt_schema_version($pdo), 0);

    bt_create_or_migrate($pdo, $file);

    assert_v3_schema($pdo, 'fresh');
    assert_eq(count_rows($pdo, 'SELECT COUNT(*) FROM entries'), 0);
    assert_eq(db_setting($pdo, 'legacy_max_seq'), '0', 'no legacy rows on a fresh install');
    assert_false(is_file($file . '.v1.bak'), 'nothing to back up');

    // Second run: fast path, still v3, still no backup, still the same salt and feed.
    $salt = db_setting($pdo, 'salt_secret');
    $feed = db_setting($pdo, 'feed_id');
    assert_second_run_noop($pdo, $file, 'second run');
    assert_eq(db_setting($pdo, 'salt_secret'), $salt, 'salt_secret is generated once');
    assert_eq(db_setting($pdo, 'feed_id'), $feed, 'feed_id is generated once');
    assert_false(is_file($file . '.v1.bak'));
});

bt_test('migration: feed_id – fresh files differ, the v2 -> v3 step always writes a fresh one, a v3 file without it is healed', function () {
    // Two fresh installs never share a feed (random per file).
    $files = [];
    $feeds = [];
    for ($i = 0; $i < 2; $i++) {
        $files[$i] = scratch_path();
        @unlink($files[$i]);
        $pdo = open_scratch_db($files[$i]);
        bt_create_or_migrate($pdo, $files[$i]);
        $feeds[$i] = db_setting($pdo, 'feed_id');
        assert_true(preg_match('/^[0-9a-f]{32}$/', (string) $feeds[$i]) === 1, "fresh file $i");
    }
    assert_true($feeds[0] !== $feeds[1], 'two fresh files have different feeds');

    // The same v1 file migrated twice (restored from the backup in between —
    // what a rollback + retry does in production) yields two different
    // feeds: the phones that synced against the first life must start over.
    $file = scratch_path();
    $pdo = open_scratch_db($file);
    seed_v1_db($pdo);
    bt_create_or_migrate($pdo, $file);
    $first = db_setting($pdo, 'feed_id');
    assert_true(preg_match('/^[0-9a-f]{32}$/', (string) $first) === 1, 'v1 -> v3 stamps a feed');
    $pdo = null;
    copy($file . '.v1.bak', $file);
    foreach (['-wal', '-shm'] as $suffix) {
        @unlink($file . $suffix);
    }
    $pdo = open_scratch_db($file);
    assert_eq(bt_schema_version($pdo), 1, 'the backup is v1 again');
    bt_create_or_migrate($pdo, $file);
    $second = db_setting($pdo, 'feed_id');
    assert_true(preg_match('/^[0-9a-f]{32}$/', (string) $second) === 1, 'migrated again');
    assert_true($second !== $first, 'a re-migrated file changes its feed');

    // The v2 -> v3 step REPLACES an existing row (INSERT OR IGNORE would keep
    // it): a v2 fixture that already carries one comes out with a new value.
    $file = scratch_path();
    $pdo = open_scratch_db($file);
    seed_v2_db($pdo);
    $stale = str_repeat('0f', 16);
    $pdo->exec("INSERT INTO settings (key, value) VALUES ('feed_id', '$stale')");
    $salt = 'deadbeef' . str_repeat('00', 28);
    $pdo->exec("INSERT INTO settings (key, value) VALUES ('salt_secret', '$salt')");
    bt_create_or_migrate($pdo, $file);
    assert_v3_schema($pdo, 'v2 with feed');
    assert_true(db_setting($pdo, 'feed_id') !== $stale, 'feed_id replaced by the v2 -> v3 step');
    assert_eq(db_setting($pdo, 'salt_secret'), $salt, 'salt_secret is kept (INSERT OR IGNORE) – only the feed changes');
    $migrated = db_setting($pdo, 'feed_id');
    assert_second_run_noop($pdo, $file, 'second run');
    assert_eq(db_setting($pdo, 'feed_id'), $migrated, 'the fast path never rewrites it');

    // A v3 file written before feed_id existed: healed on the next request,
    // accounts, entries and the other settings untouched; then a pure read.
    $file = scratch_path();
    @unlink($file);
    $pdo = open_scratch_db($file);
    bt_create_or_migrate($pdo, $file);
    $pdo->exec("INSERT INTO families (name, name_key, auth_hash, kdf_salt, kdf_iter, fdk_wrapped, recovery_hash)
        VALUES ('Testfamilie', 'testfamilie', 'h', 's', 600000, 'w', 'r')");
    $pdo->exec("INSERT INTO entries (eid, family_id, seq, blob, created_at, updated_at)
        VALUES ('0123456789abcdef0123456789abcdef', 1, 1, 'AQ', '2026-09-01', '2026-09-01')");
    $pdo->exec("DELETE FROM settings WHERE key = 'feed_id'");
    assert_false(bt_has_feed_id($pdo));
    $salt = db_setting($pdo, 'salt_secret');
    $schema = db_schema_dump($pdo);
    bt_create_or_migrate($pdo, $file);
    assert_true(bt_has_feed_id($pdo), 'healed');
    assert_true(preg_match('/^[0-9a-f]{32}$/', (string) db_setting($pdo, 'feed_id')) === 1);
    assert_eq(db_schema_dump($pdo), $schema, 'no DDL ran');
    assert_eq(db_setting($pdo, 'salt_secret'), $salt);
    assert_eq(db_setting($pdo, 'legacy_max_seq'), '0');
    assert_eq(count_rows($pdo, 'SELECT COUNT(*) FROM families'), 1, 'family survives');
    assert_eq($pdo->query('SELECT blob FROM entries')->fetchColumn(), 'AQ', 'entry survives');
    assert_false(is_file($file . '.v1.bak'));
    assert_second_run_noop($pdo, $file, 'after the heal');
});

bt_test('migration: a migrated v1 file and a fresh file have the identical v3 schema', function () {
    $v1File = scratch_path();
    $v1 = open_scratch_db($v1File);
    seed_v1_db($v1);
    bt_create_or_migrate($v1, $v1File);

    $freshFile = scratch_path();
    @unlink($freshFile);
    $fresh = open_scratch_db($freshFile);
    bt_create_or_migrate($fresh, $freshFile);

    foreach (['entries', 'families', 'users', 'auth_tokens', 'settings', 'login_attempts'] as $table) {
        assert_eq(db_table_info($v1, $table), db_table_info($fresh, $table), "table_info($table)");
    }
    assert_eq(db_index_names($v1), db_index_names($fresh), 'indexes');
    // The rebuilt table's automatic PK index followed the rename (no stray
    // sqlite_autoindex_entries_v3_*), and no entries_v3 table is left behind.
    $names = array_column(db_schema_dump($v1), 'name');
    assert_eq(array_column(db_schema_dump($fresh), 'name'), $names, 'same sqlite_master objects');
    assert_false(bt_table_exists($v1, 'entries_v3'));
});

bt_test('migration: a stale stamp on a v3 file is healed without touching accounts or entries', function () {
    $file = scratch_path();
    @unlink($file);
    $pdo = open_scratch_db($file);
    bt_create_or_migrate($pdo, $file);
    $pdo->exec("INSERT INTO families (name, name_key, auth_hash, kdf_salt, kdf_iter, fdk_wrapped, recovery_hash)
        VALUES ('Testfamilie', 'testfamilie', 'h', 's', 600000, 'w', 'r')");
    $pdo->exec("INSERT INTO users (family_id, username, auth_hash, kdf_salt, kdf_iter, fdk_wrapped, profile_blob)
        VALUES (1, 'mama', 'h', 's', 600000, 'w', 'p')");
    $pdo->exec("INSERT INTO entries (eid, family_id, seq, blob, created_at, updated_at)
        VALUES ('0123456789abcdef0123456789abcdef', 1, 1, 'AQ', '2026-09-01', '2026-09-01')");
    $salt = db_setting($pdo, 'salt_secret');

    // Only the stamp regressed (structure is v3): must NOT run the v2 -> v3 drops.
    $pdo->exec("UPDATE settings SET value = '2' WHERE key = 'schema_version'");
    bt_create_or_migrate($pdo, $file);

    assert_v3_schema($pdo, 'healed');
    assert_eq(count_rows($pdo, 'SELECT COUNT(*) FROM families'), 1, 'family survives');
    assert_eq(count_rows($pdo, 'SELECT COUNT(*) FROM users'), 1, 'user survives');
    $row = $pdo->query('SELECT * FROM entries')->fetch(PDO::FETCH_ASSOC);
    assert_eq($row['eid'], '0123456789abcdef0123456789abcdef');
    assert_eq((int) $row['family_id'], 1, 'adoption survives');
    assert_eq($row['blob'], 'AQ');
    assert_eq(db_setting($pdo, 'salt_secret'), $salt, 'salt_secret untouched');
    assert_eq(db_setting($pdo, 'legacy_max_seq'), '0', 'legacy_max_seq untouched');
    assert_false(is_file($file . '.v1.bak'));
});

// ---------------------------------------------------------------------------
// Transaction safety
// ---------------------------------------------------------------------------

bt_test('migration: a failing step rolls the whole chain back and leaves the v1 file untouched', function () {
    $file = scratch_path();
    $pdo = open_scratch_db($file);
    seed_v1_db($pdo);
    // A stray table with the rebuild's working name makes CREATE TABLE fail
    // after the v1 -> v2 steps already ran inside the transaction.
    $pdo->exec('CREATE TABLE entries_v3 (x)');

    try {
        bt_create_or_migrate($pdo, $file);
        throw new BtAssertionError('expected the migration to fail');
    } catch (PDOException $e) {
        assert_true(strpos($e->getMessage(), 'entries_v3') !== false, 'the failing statement');
    }

    assert_eq(bt_schema_version($pdo), 1, 'stamp untouched');
    assert_false(bt_entries_has_family_id($pdo), 'v1 -> v2 column add rolled back');
    assert_true(index_exists($pdo, 'idx_entries_one_open'), 'v1 index back');
    assert_true(index_exists($pdo, 'idx_entries_started_at'));
    assert_true(column_exists($pdo, 'entries', 'type'), 'v1 entries table intact');
    assert_eq(count_rows($pdo, 'SELECT COUNT(*) FROM auth_tokens'), 2, 'v1 sessions back');
    assert_false(bt_table_exists($pdo, 'users'), 'nothing created');
    assert_eq(db_setting($pdo, 'salt_secret'), null, 'no settings written');
    assert_true(is_file($file . '.v1.bak'), 'the backup (taken before the lock) stays');
    assert_true($pdo->query('SELECT 1')->fetchColumn() !== false, 'connection still usable');

    // Once the obstacle is gone the next request migrates normally.
    $pdo->exec('DROP TABLE entries_v3');
    bt_create_or_migrate($pdo, $file);
    assert_v3_schema($pdo, 'retry');
    assert_legacy_rows($pdo, 3, 'retry');
});

// ---------------------------------------------------------------------------
// bt_db
// ---------------------------------------------------------------------------

bt_test('bt_db: secure_delete is on and the handle is a migrated v3 database', function () {
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
    assert_eq(bt_schema_version($pdo), 3);
    assert_true(bt_entries_has_blob($pdo));
    assert_eq(db_columns($pdo, 'entries'), V3_ENTRY_COLUMNS);
    assert_true(bt_db(['db_path' => '/nonexistent/other.db']) === $pdo, 'memoized handle');
});
