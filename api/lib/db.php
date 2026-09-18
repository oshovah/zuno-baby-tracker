<?php
/**
 * Database setup: opens data/baby.db (WAL when the host allows it), creates
 * the end-to-end-encrypted v3 schema, and migrates older files in place — a
 * single-password (v1) database gets a one-time file backup (<db>.v1.bak)
 * first.
 *
 * Schema history:
 *   v1  one shared password, one family: entries (plaintext columns) +
 *       auth_tokens (no user), ONE open timer per type globally
 *       (idx_entries_one_open). Production ran v1 until the v3 release.
 *   v2  accounts + families (built and tagged, never deployed): families and
 *       users tables with bcrypt hashes of the raw passwords, entries.family_id
 *       (NULL = unadopted legacy row), auth_tokens.user_id, ONE open timer per
 *       type PER FAMILY (idx_entries_one_open_family).
 *   v3  end-to-end encryption. entries are opaque per-family AES-GCM blobs
 *       keyed by a client-generated eid (32 hex), with a per-family seq (sync
 *       cursor AND concurrency token) and day-granular created/updated/deleted
 *       dates; legacy_* columns keep the plaintext of migrated rows until the
 *       client seals them (blob IS NULL = legacy row). families/users store
 *       bcrypt of client-derived auth values, the KDF params and the wrapped
 *       Family Data Key (plus a recovery hash per family and an encrypted
 *       profile per user). settings gains salt_secret (stable fake KDF salts
 *       for unknown usernames), legacy_max_seq (the last seq the server may
 *       ever serve as plaintext) and feed_id (a random token every sync page
 *       carries; the v2 -> v3 step always writes a FRESH one, so a client
 *       that synced against an earlier life of the file notices and wipes
 *       its mirror). auth_tokens.created_at is coarsened to the day. The
 *       open-timer rule moved to the client: no partial unique index.
 *
 * Migration story (bt_create_or_migrate): the version is detected
 * STRUCTURALLY — v1 = entries without family_id, v2 = entries with family_id
 * but without blob; the settings stamp is never trusted alone. A v1 file is
 * backed up write-once to <db>.v1.bak (outside the lock), then the chain
 * bt_migrate_v1_to_v2 -> bt_migrate_v2_to_v3 -> bt_create_schema runs inside
 * ONE BEGIN IMMEDIATE, so a failed step leaves the file untouched (SQLite DDL
 * is transactional). v2 files exist only in dev: they get no backup, lose
 * their accounts and sessions (password hashes without key material are
 * useless in v3), and their entries return to the unadopted pool. Up-to-date
 * databases take a fast path of a few reads and never write per request.
 *
 * Future DDL changes (v4): bump the stamp in bt_create_schema, add a
 * bt_migrate_v3_to_v4() with idempotent steps, detect v3 structurally (a new
 * column or table that v4 introduces) in BOTH the pre-check and the re-check
 * under the lock in bt_create_or_migrate, and call it after
 * bt_migrate_v2_to_v3, before bt_create_schema.
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
    // Overwrite freed cells and pages with zeros: nulled legacy plaintext and
    // superseded blob versions must not linger in the file. Per-connection
    // setting, hence on every open.
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

function bt_table_exists(PDO $pdo, string $name): bool
{
    $stmt = $pdo->prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
    $stmt->execute([$name]);
    return $stmt->fetch(PDO::FETCH_ASSOC) !== false;
}

/** Whether the entries table has the given column (false when the table is missing). */
function bt_entries_has_column(PDO $pdo, string $column): bool
{
    foreach ($pdo->query('PRAGMA table_info(entries)')->fetchAll(PDO::FETCH_ASSOC) as $col) {
        if (($col['name'] ?? '') === $column) {
            return true;
        }
    }
    return false;
}

/** Structural v2+ marker: a v1 entries table has no family_id column. */
function bt_entries_has_family_id(PDO $pdo): bool
{
    return bt_entries_has_column($pdo, 'family_id');
}

/** Structural v3 marker: a v1/v2 entries table has no blob column. */
function bt_entries_has_blob(PDO $pdo): bool
{
    return bt_entries_has_column($pdo, 'blob');
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

/** Whether settings.feed_id exists (false when the table is missing). */
function bt_has_feed_id(PDO $pdo): bool
{
    try {
        return $pdo->query("SELECT 1 FROM settings WHERE key = 'feed_id'")->fetchColumn() !== false;
    } catch (Throwable $e) {
        return false;
    }
}

/**
 * Ensure the v3 schema exists, migrating a v1 or v2 database in place first
 * (v1 -> v2 -> v3 in one transaction). Up-to-date databases return after a
 * few cheap reads (no write per request). A v3 file from before feed_id
 * existed (dev files only) gets the row on its next request through
 * bt_create_schema's INSERT OR IGNORE — nothing else is touched.
 */
function bt_create_or_migrate(PDO $pdo, string $dbPath): void
{
    // Structural detection — never trust the version stamp alone.
    $hasEntries = bt_table_exists($pdo, 'entries');
    $isV1 = $hasEntries && !bt_entries_has_family_id($pdo);
    $isV2 = $hasEntries && !$isV1 && !bt_entries_has_blob($pdo);
    if (!$isV1 && !$isV2 && bt_schema_version($pdo) >= 3 && bt_has_feed_id($pdo)) {
        return;
    }
    if ($isV1) {
        bt_backup_v1_file($pdo, $dbPath); // outside the lock
    }

    $pdo->exec('BEGIN IMMEDIATE');
    try {
        // Re-check under the lock: a concurrent request may have migrated already.
        if (bt_table_exists($pdo, 'entries')) {
            if (!bt_entries_has_family_id($pdo)) {
                bt_migrate_v1_to_v2($pdo);
            }
            if (!bt_entries_has_blob($pdo)) {
                bt_migrate_v2_to_v3($pdo);
            }
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
 * One-time file copy of a v1 database before its in-place migration. Lives
 * next to the db (inside the .htaccess-protected data dir). Write-once: the
 * copy goes to a temp file first and is then link()ed into place — an atomic
 * "create only if absent", so a losing concurrent request never overwrites
 * the v1 copy with an already-migrated file. Never fatal.
 */
function bt_backup_v1_file(PDO $pdo, string $dbPath): void
{
    $backup = $dbPath . '.v1.bak';
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
                    error_log('[baby-tracker] v1 backup: checkpoint busy – WAL tail may be missing from ' . $backup);
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
            error_log('[baby-tracker] v1 backup could not be written: ' . $backup);
        }
    } catch (Throwable $e) {
        // A missing backup must never block the migration.
        error_log('[baby-tracker] v1 backup failed: ' . $e->getMessage());
    }
}

/**
 * v1 -> v2 (first link of the chain): entries gain family_id (legacy rows
 * stay NULL until adopted), the global open-timer index goes, and the
 * user-less auth_tokens table is dropped (every phone logs in once; the
 * user-bound table is created by bt_create_schema). Runs inside the caller's
 * BEGIN IMMEDIATE; each step is idempotent.
 */
function bt_migrate_v1_to_v2(PDO $pdo): void
{
    $pdo->exec('DROP INDEX IF EXISTS idx_entries_one_open');
    if (!bt_entries_has_family_id($pdo)) {
        $pdo->exec('ALTER TABLE entries ADD COLUMN family_id INTEGER');
    }
    $pdo->exec('DROP TABLE IF EXISTS auth_tokens');
}

/**
 * Column list of the v3 entries table — one definition shared by
 * bt_create_schema and the v2 -> v3 rebuild so both paths yield the identical
 * table. Columns: no NOT NULL on the payload (legacy_* are NULL once sealed,
 * blob is NULL while legacy), dates are 'YYYY-MM-DD'.
 */
function bt_entries_v3_columns_sql(): string
{
    return <<<'SQL'
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
SQL;
}

/**
 * v2 -> v3 (second link; also the production path right after
 * bt_migrate_v1_to_v2, where users/families do not exist yet — hence only
 * IF EXISTS forms). The entries table is rebuilt: integer ids become random
 * eids, the old id becomes the seq, the plaintext columns move to legacy_*
 * (blob stays NULL until the client seals the row) and the timestamps are
 * coarsened to the day. v2 accounts and sessions are dropped (bcrypt of raw
 * passwords, no key material — useless in v3) and their entries return to
 * the unadopted pool. settings gets salt_secret and legacy_max_seq (the
 * highest seq that existed at migration time: the server never serves
 * plaintext beyond it).
 *
 * Call ONLY for a structurally-v2 file (entries without blob): the account
 * drops are unconditional. Runs inside the caller's BEGIN IMMEDIATE; each
 * step is idempotent.
 */
function bt_migrate_v2_to_v3(PDO $pdo): void
{
    // Old query/uniqueness indexes (v1 and v2 names): their columns no
    // longer exist on the v3 table.
    $pdo->exec(<<<'SQL'
DROP INDEX IF EXISTS idx_entries_one_open;
DROP INDEX IF EXISTS idx_entries_one_open_family;
DROP INDEX IF EXISTS idx_entries_started_at;
DROP INDEX IF EXISTS idx_entries_type_started;
DROP INDEX IF EXISTS idx_entries_family_started;
SQL);

    if (!bt_entries_has_blob($pdo)) {
        // Rebuild instead of ALTER: the NOT NULL constraints on type and
        // started_at must go and the primary key changes to eid.
        $pdo->exec("CREATE TABLE entries_v3 (\n" . bt_entries_v3_columns_sql() . "\n)");
        $pdo->exec(<<<'SQL'
INSERT INTO entries_v3 (eid, family_id, seq, blob,
    legacy_type, legacy_started_at, legacy_ended_at, legacy_details, legacy_logged_by,
    created_at, updated_at, deleted_at)
  SELECT lower(hex(randomblob(16))), family_id, id, NULL,
    type, started_at, ended_at, details, logged_by,
    substr(created_at, 1, 10), substr(updated_at, 1, 10),
    CASE WHEN deleted_at IS NULL THEN NULL ELSE substr(deleted_at, 1, 10) END
  FROM entries;
DROP TABLE entries;
ALTER TABLE entries_v3 RENAME TO entries;
SQL);
    }

    // v2 dev accounts are incompatible with v3 (no wrapped key, no KDF
    // params): drop them together with their sessions. Rows they had adopted
    // return to the unadopted pool — the recreated families table restarts
    // its ids, so a dangling family_id would silently hand the plaintext to
    // whoever registers first.
    //
    // feed_id is REPLACED, never kept: the rebuilt entries table starts a new
    // seq history, so a phone that synced against the previous one (a
    // production file restored from the v1 backup and migrated again, say)
    // must drop its mirror — bt_sync_entries hands the value out as `feed`.
    $pdo->exec(<<<'SQL'
DROP TABLE IF EXISTS auth_tokens;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS families;
UPDATE entries SET family_id = NULL WHERE family_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
INSERT OR IGNORE INTO settings (key, value) VALUES ('salt_secret', lower(hex(randomblob(32))));
INSERT OR IGNORE INTO settings (key, value)
  VALUES ('legacy_max_seq', (SELECT COALESCE(MAX(seq), 0) FROM entries));
INSERT OR REPLACE INTO settings (key, value) VALUES ('feed_id', lower(hex(randomblob(16))));
SQL);
}

/**
 * v3 schema (CREATE IF NOT EXISTS — also fills in new tables/indexes on
 * migrated DBs), the per-install settings rows (INSERT OR IGNORE: a fresh
 * file needs salt_secret and feed_id too, and legacy_max_seq = 0 means "no
 * legacy rows") and the version stamp. Runs inside the caller's transaction.
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
    $pdo->exec("CREATE TABLE IF NOT EXISTS entries (\n" . bt_entries_v3_columns_sql() . "\n)");
    $pdo->exec(<<<'SQL'
CREATE INDEX IF NOT EXISTS idx_entries_family_seq ON entries (family_id, seq);
CREATE INDEX IF NOT EXISTS idx_entries_legacy ON entries (family_id) WHERE blob IS NULL;
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
INSERT OR IGNORE INTO settings (key, value)
  VALUES ('legacy_max_seq', (SELECT COALESCE(MAX(seq), 0) FROM entries));
INSERT OR IGNORE INTO settings (key, value) VALUES ('feed_id', lower(hex(randomblob(16))));
INSERT INTO settings (key, value) VALUES ('schema_version', '3')
  ON CONFLICT(key) DO UPDATE SET value = '3';
SQL);
}
