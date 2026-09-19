<?php
/**
 * Database setup: opens data/baby.db (WAL when the host allows it), creates
 * the schema and migrates an older file in place.
 *
 * Schema v4 — nothing here describes the baby:
 *   families, users  bcrypt of client-derived auth values, the KDF parameters
 *                and the wrapped Family Data Key (plus a recovery hash per
 *                family and an encrypted profile per user).
 *   entries      opaque per-family AES-GCM blobs keyed by a client-generated
 *                eid (32 hex), with a per-family seq (sync cursor AND
 *                concurrency token) and day-granular created/updated/deleted
 *                dates. No column for a type, a time or an amount.
 *   auth_tokens  hashed session tokens bound to a user, created to the day.
 *   settings     schema_version, salt_secret (stable fake KDF salts for
 *                unknown usernames) and feed_id (a random token every sync
 *                page carries: a phone that synced against another life of
 *                the file notices and wipes its mirror).
 *   login_attempts  the throttle counters.
 * One open timer per type is a client rule: no partial unique index.
 *
 * Migration (bt_create_or_migrate): the version is detected STRUCTURALLY,
 * never by the settings stamp alone. A v3 entries table still has the five
 * legacy_* columns, which held the plaintext of rows written before the app
 * encrypted, until a phone of the family had encrypted them. v3 -> v4 drops
 * those columns: the file is copied write-once to <db>.v3.bak (outside the
 * lock), then the table is rebuilt inside ONE BEGIN IMMEDIATE, so a failed
 * step leaves the file untouched (SQLite DDL is transactional). A v3 file
 * whose LIVE rows still hold such plaintext, or belong to no family, is
 * REFUSED untouched — that content would be lost (bt_assert_v3_encrypted
 * says what to do). So is a file without a blob column: it predates v3, and
 * no public release can read it. Up-to-date databases take a fast path of two
 * reads and never write per request.
 *
 * Future DDL changes (v5): bump the stamp in bt_create_schema, add a
 * bt_migrate_v4_to_v5() with idempotent steps, detect v4 structurally (a
 * column or table that v5 introduces) in BOTH the pre-check and the re-check
 * under the lock in bt_create_or_migrate, and call it after
 * bt_migrate_v3_to_v4, before bt_create_schema.
 *
 * The db path defaults to <app root>/data/baby.db (app root = parent of api/)
 * and can be overridden via config.php 'db_path' (absolute, or relative to the
 * app root). On first touch the data directory is created AND self-protected
 * with a deny-all .htaccess so the SQLite file is never downloadable on shared
 * hosting.
 *
 * Target: PHP 7.4+ with pdo_sqlite.
 */

require_once __DIR__ . '/http.php';

const BT_SCHEMA_VERSION = 4;

/** App root = parent directory of api/. */
function bt_app_root(): string
{
    return dirname(__DIR__, 2);
}

/** Resolve the database file path from config (see file docblock). */
function bt_resolve_db_path(array $config): string
{
    $path = 'data/baby.db';
    if (isset($config['db_path']) && is_string($config['db_path']) && $config['db_path'] !== '') {
        $path = $config['db_path'];
    }
    if ($path[0] === '/' || preg_match('#^[A-Za-z]:[\\\\/]#', $path)) {
        return $path; // absolute (unix or windows)
    }
    return bt_app_root() . '/' . $path;
}

/** Write a deny-all .htaccess into the data dir if missing (belt and braces). */
function bt_protect_data_dir(string $dir): void
{
    $htaccess = $dir . '/.htaccess';
    if (is_file($htaccess)) {
        return;
    }
    $content = "# Deny all web access to the SQLite database directory.\n"
        . "<IfModule mod_authz_core.c>\n"
        . "  Require all denied\n"
        . "</IfModule>\n"
        . "<IfModule !mod_authz_core.c>\n"
        . "  Order allow,deny\n"
        . "  Deny from all\n"
        . "</IfModule>\n";
    @file_put_contents($htaccess, $content);
}

/** Open (once per request) the PDO handle; creates/migrates the schema. */
function bt_db(array $config): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $dbPath = bt_resolve_db_path($config);
    $dir = dirname($dbPath);
    if (!is_dir($dir)) {
        if (!@mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new RuntimeException("Cannot create data directory: $dir");
        }
    }
    bt_protect_data_dir($dir);

    $handle = new PDO('sqlite:' . $dbPath);
    $handle->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $handle->exec('PRAGMA busy_timeout = 5000');
    // Overwrite freed cells and pages with zeros: a superseded blob version
    // must not linger in the file. Per-connection setting, hence on every open.
    $handle->exec('PRAGMA secure_delete = ON');
    try {
        $handle->exec('PRAGMA journal_mode = WAL');
    } catch (Throwable $e) {
        // Some shared hosts forbid WAL; fall back silently.
    }

    bt_create_or_migrate($handle, $dbPath);
    // Memoize only a migrated handle: a failed migration is retried on the
    // next call instead of handing out a half-checked connection.
    $pdo = $handle;
    return $pdo;
}

// ---------------------------------------------------------------------------
// Schema + migration
// ---------------------------------------------------------------------------

/** Column names of the entries table; [] when the table is missing. */
function bt_entries_columns(PDO $pdo): array
{
    $names = [];
    foreach ($pdo->query('PRAGMA table_info(entries)')->fetchAll(PDO::FETCH_ASSOC) as $col) {
        $names[] = (string) ($col['name'] ?? '');
    }
    return $names;
}

/** Structural v3 marker: only a v3 entries table has the legacy_* columns. */
function bt_entries_is_v3(array $columns): bool
{
    return in_array('blob', $columns, true) && in_array('legacy_type', $columns, true);
}

/** settings.schema_version as int; 0 when the table or the row is missing. */
function bt_schema_version(PDO $pdo): int
{
    try {
        $value = $pdo->query("SELECT value FROM settings WHERE key = 'schema_version'")->fetchColumn();
        return $value === false ? 0 : (int) $value;
    } catch (Throwable $e) {
        return 0; // fresh file: no settings table yet
    }
}

/**
 * Ensure the v4 schema exists, migrating a v3 database in place first.
 * Up-to-date databases return after two cheap reads (no write per request).
 */
function bt_create_or_migrate(PDO $pdo, string $dbPath): void
{
    // Structural detection — never trust the version stamp alone.
    $columns = bt_entries_columns($pdo);
    bt_assert_not_pre_v3($columns);
    $isV3 = bt_entries_is_v3($columns);
    if ($columns !== [] && !$isV3 && bt_schema_version($pdo) >= BT_SCHEMA_VERSION) {
        return;
    }
    if ($isV3) {
        bt_assert_v3_encrypted($pdo); // before the backup: a refused file gets none
        bt_backup_db_file($pdo, $dbPath, 'v3'); // outside the lock
    }

    $pdo->exec('BEGIN IMMEDIATE');
    try {
        // Re-check under the lock: a concurrent request may have migrated already.
        $columns = bt_entries_columns($pdo);
        bt_assert_not_pre_v3($columns);
        if (bt_entries_is_v3($columns)) {
            bt_migrate_v3_to_v4($pdo);
        }
        bt_create_schema($pdo);
        $pdo->exec('COMMIT');
    } catch (Throwable $e) {
        try {
            $pdo->exec('ROLLBACK');
        } catch (Throwable $ignored) {
            // Nothing to roll back.
        }
        throw $e;
    }
}

/**
 * Refuse an entries table without a blob column: it holds plaintext rows of
 * a version from before the first public release, which only that version's
 * own upgrade path could encrypt. Nothing is touched.
 */
function bt_assert_not_pre_v3(array $columns): void
{
    if ($columns !== [] && !in_array('blob', $columns, true)) {
        throw new RuntimeException(
            'database refused: its entries table predates schema v3 (no blob column). '
            . 'This release cannot read or migrate it; the file was left untouched.'
        );
    }
}

/**
 * Refuse a v3 file that v4 would lose content of: a LIVE row that still has
 * plaintext in a legacy_* column (no phone has encrypted it yet) or that
 * belongs to no family. Nothing is touched; the message names the way out.
 * Deleted rows do not count — nobody can read a tombstone's content, and
 * dropping it is what the last encryption pass of a family did anyway.
 */
function bt_assert_v3_encrypted(PDO $pdo): void
{
    $open = (int) $pdo->query(
        'SELECT COUNT(*) FROM entries
         WHERE deleted_at IS NULL
           AND (family_id IS NULL
             OR legacy_type IS NOT NULL OR legacy_started_at IS NOT NULL OR legacy_ended_at IS NOT NULL
             OR legacy_details IS NOT NULL OR legacy_logged_by IS NOT NULL)'
    )->fetchColumn();
    if ($open > 0) {
        throw new RuntimeException(
            "schema v3 -> v4 refused: $open live entries are still plaintext (legacy_* columns) or belong to no family. "
            . 'Deploy the last release with schema v3 again, let a phone of the family finish encrypting them '
            . '(Mehr › Konto shows the progress), then deploy this one. The file was left untouched.'
        );
    }
}

/**
 * One-time file copy of a database before an in-place migration, as
 * <db>.<tag>.bak next to the db (inside the .htaccess-protected data dir).
 * Write-once: the copy goes to a temp file first and is then link()ed into
 * place — an atomic "create only if absent", so a losing concurrent request
 * never overwrites the copy with an already-migrated file. Never fatal.
 */
function bt_backup_db_file(PDO $pdo, string $dbPath, string $tag): void
{
    $backup = $dbPath . '.' . $tag . '.bak';
    if (is_file($backup) || !is_file($dbPath)) {
        return;
    }
    try {
        $tmp = $backup . '.' . getmypid() . '.' . bin2hex(random_bytes(4)) . '.tmp';
        $copied = false;
        try {
            // SQLite's own consistent snapshot: includes un-checkpointed WAL
            // frames and needs no write lock (SQLite >= 3.27, 2019).
            $pdo->exec('VACUUM INTO ' . $pdo->quote($tmp));
            $copied = is_file($tmp);
        } catch (Throwable $e) {
            // Older SQLite: fold the WAL into the main file, then copy it. A
            // busy checkpoint (some reader holding a snapshot) leaves the WAL
            // tail out of the copy — say so in the log instead of hiding it.
            try {
                $row = $pdo->query('PRAGMA wal_checkpoint(TRUNCATE)')->fetch(PDO::FETCH_ASSOC);
                if (is_array($row) && (int) ($row['busy'] ?? 0) === 1) {
                    error_log("[baby-tracker] $tag backup: checkpoint busy – WAL tail may be missing from $backup");
                }
            } catch (Throwable $e2) {
                // Best effort.
            }
            $copied = @copy($dbPath, $tmp);
        }
        if ($copied) {
            @link($tmp, $backup);
        }
        @unlink($tmp);
        if (!is_file($backup)) {
            error_log("[baby-tracker] $tag backup could not be written: $backup");
        }
    } catch (Throwable $e) {
        // A missing backup must never block the migration.
        error_log("[baby-tracker] $tag backup failed: " . $e->getMessage());
    }
}

/**
 * Column list of the entries table — one definition shared by
 * bt_create_schema and the v3 -> v4 rebuild so both paths yield the identical
 * table. Dates are 'YYYY-MM-DD'. blob is nullable for one case only: a
 * tombstone whose row was deleted before it was ever encrypted (a migrated
 * v3 file) has no content at all.
 */
function bt_entries_columns_sql(): string
{
    return <<<'SQL'
  eid TEXT PRIMARY KEY,
  family_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  blob TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
SQL;
}

/**
 * v3 -> v4: rebuild entries without the legacy_* columns (their index goes
 * with the old table) and drop the setting that bounded them. Every row that
 * has a family is copied verbatim — eid, seq and blob are unchanged, so the
 * phones' mirrors and cursors stay valid and feed_id is kept. Not copied: a
 * deleted row without a family, which no account could ever see.
 *
 * Call ONLY for a structurally-v3 file. Runs inside the caller's BEGIN
 * IMMEDIATE, re-checks bt_assert_v3_encrypted under the lock, and throws —
 * rolling everything back — when the copy is not complete.
 */
function bt_migrate_v3_to_v4(PDO $pdo): void
{
    bt_assert_v3_encrypted($pdo);
    $expected = (int) $pdo->query('SELECT COUNT(*) FROM entries WHERE family_id IS NOT NULL')->fetchColumn();

    $pdo->exec("CREATE TABLE entries_v4 (\n" . bt_entries_columns_sql() . "\n)");
    $pdo->exec(<<<'SQL'
INSERT INTO entries_v4 (eid, family_id, seq, blob, created_at, updated_at, deleted_at)
  SELECT eid, family_id, seq, blob, created_at, updated_at, deleted_at
  FROM entries WHERE family_id IS NOT NULL;
SQL);
    $copied = (int) $pdo->query('SELECT COUNT(*) FROM entries_v4')->fetchColumn();
    if ($copied !== $expected) {
        throw new RuntimeException("schema v3 -> v4 aborted: copied $copied of $expected entries");
    }

    $pdo->exec(<<<'SQL'
DROP TABLE entries;
ALTER TABLE entries_v4 RENAME TO entries;
DELETE FROM settings WHERE key = 'legacy_max_seq';
SQL);
    error_log("[baby-tracker] schema v3 -> v4: $copied entries carried over");
}

/**
 * The schema (CREATE IF NOT EXISTS — also fills in the index on a migrated
 * DB), the per-install settings rows (INSERT OR IGNORE) and the version
 * stamp. Runs inside the caller's transaction.
 */
function bt_create_schema(PDO $pdo): void
{
    $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS families (
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
CREATE TABLE IF NOT EXISTS users (
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
SQL);
    $pdo->exec("CREATE TABLE IF NOT EXISTS entries (\n" . bt_entries_columns_sql() . "\n)");
    $pdo->exec(<<<'SQL'
CREATE INDEX IF NOT EXISTS idx_entries_family_seq ON entries (family_id, seq);
CREATE TABLE IF NOT EXISTS auth_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d','now')),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (key, value) VALUES ('salt_secret', lower(hex(randomblob(32))));
INSERT OR IGNORE INTO settings (key, value) VALUES ('feed_id', lower(hex(randomblob(16))));
SQL);
    $pdo->prepare(
        "INSERT INTO settings (key, value) VALUES ('schema_version', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )->execute([(string) BT_SCHEMA_VERSION]);
}
