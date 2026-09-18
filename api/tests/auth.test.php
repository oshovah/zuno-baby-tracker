<?php
/**
 * Accounts + families + key custody tests (api/lib/auth.php): KDF parameter
 * lookup with the stable fake, register create/join/recovery, the legacy
 * adoption gate, login with key material, family unlock, own-key unlock,
 * profile/password/family-password changes, tokens, throttle, old-shell 400s
 * and the request-guard 415.
 *
 * Runs against its OWN in-memory SQLite database carrying the v3 DDL (so it
 * never depends on db.php's memoised handle or on the migration driver);
 * every test starts from wiped tables, most from ONE registered account
 * (mama in Testfamilie, see auth_fresh). Key material comes from the shared
 * fake_* helpers of api.test.php (random bytes of the right length — the
 * server treats them as opaque, which is exactly what these tests pin).
 * Bcrypt runs at cost 4 (run.php sets BABY_BCRYPT_COST).
 *
 * Helper names are prefixed (auth_*) because run.php loads every test file
 * into one process.
 */

require_once __DIR__ . '/../lib/http.php';
require_once __DIR__ . '/../lib/auth.php';

const AUTH_NOW = '2026-09-01T10:00:00Z';

$GLOBALS['__auth_pdo'] = null;
$GLOBALS['__auth_fix'] = null;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** The v3 tables exactly as db.php creates them (families/users/entries/auth_tokens/settings/login_attempts). */
function auth_v3_ddl(): string
{
    return <<<'SQL'
CREATE TABLE IF NOT EXISTS families (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  auth_hash TEXT NOT NULL,
  kdf_salt TEXT NOT NULL,
  kdf_iter INTEGER NOT NULL,
  fdk_wrapped TEXT NOT NULL,
  recovery_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (date('now'))
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
  created_at TEXT NOT NULL DEFAULT (date('now'))
);
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
CREATE TABLE IF NOT EXISTS auth_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (date('now')),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL
);
INSERT OR IGNORE INTO settings VALUES ('salt_secret', lower(hex(randomblob(32))));
INSERT INTO settings (key, value) VALUES ('schema_version', '3')
  ON CONFLICT(key) DO UPDATE SET value = '3';
SQL;
}

/** The shared in-memory v3 database with every table wiped and no account. */
function auth_db(): PDO
{
    if (!($GLOBALS['__auth_pdo'] instanceof PDO)) {
        $pdo = new PDO('sqlite::memory:');
        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $pdo->exec(auth_v3_ddl());
        $GLOBALS['__auth_pdo'] = $pdo;
    }
    $pdo = $GLOBALS['__auth_pdo'];
    foreach (['entries', 'auth_tokens', 'login_attempts', 'users', 'families', 'sqlite_sequence'] as $table) {
        $pdo->exec("DELETE FROM $table");
    }
    unset($_COOKIE[BT_COOKIE]);
    $GLOBALS['__auth_fix'] = null;
    return $pdo;
}

/** A complete 'create' registration body (override any field). */
function auth_create_body(array $over = []): array
{
    return array_merge([
        'username' => 'mama',
        'authKey' => fake_auth_key(),
        'kdf' => fake_kdf(),
        'profileBlob' => fake_blob(),
        'familyName' => 'Testfamilie',
        'familyMode' => 'create',
        'familyAuthKey' => fake_auth_key(),
        'familyKdf' => fake_kdf(),
        'fdkWrappedFamily' => fake_wrapped(),
        'fdkWrappedUser' => fake_wrapped(),
        'recoveryAuthKey' => fake_auth_key(),
    ], $over);
}

/** A 'join' body for the default family with its real family auth key (override any field). */
function auth_join_body(array $over = []): array
{
    return array_merge([
        'username' => 'papa',
        'authKey' => fake_auth_key(),
        'kdf' => fake_kdf(),
        'profileBlob' => fake_blob(),
        'familyName' => 'Testfamilie',
        'familyMode' => 'join',
        'familyAuthKey' => auth_fix('familyAuthKey'),
        'fdkWrappedUser' => fake_wrapped(),
    ], $over);
}

/** Wiped database with the default account registered (its body kept for auth_fix). */
function auth_fresh(array $config = []): PDO
{
    $pdo = auth_db();
    $body = auth_create_body();
    $res = bt_register($pdo, $body, $config, AUTH_NOW);
    $GLOBALS['__auth_fix'] = ['body' => $body, 'user' => $res['user']];
    return $pdo;
}

/** A field of the default account's registration body (e.g. its authKey). */
function auth_fix(string $key)
{
    return $GLOBALS['__auth_fix']['body'][$key];
}

/** The default account's user array as bt_register returned it. */
function auth_user(): array
{
    return $GLOBALS['__auth_fix']['user'];
}

function auth_fam(): int
{
    return (int) auth_user()['familyId'];
}

function auth_count(PDO $pdo, string $sql): int
{
    return (int) $pdo->query($sql)->fetchColumn();
}

/** $n unadopted plaintext rows from the shared-password era (family_id NULL, seq = the v1 id). */
function auth_seed_legacy(PDO $pdo, int $n): void
{
    $stmt = $pdo->prepare(
        "INSERT INTO entries (eid, family_id, seq, blob, legacy_type, legacy_started_at, legacy_details,
                              legacy_logged_by, created_at, updated_at)
         VALUES (lower(hex(randomblob(16))), NULL, ?, NULL, 'bottle', '2026-08-30T08:00:00Z',
                 '{\"amount_ml\":90}', 'Mama', '2026-08-30', '2026-08-30')"
    );
    for ($i = 1; $i <= $n; $i++) {
        $stmt->execute([$i]);
    }
}

/** Assert that $fn throws an HttpError with the given status AND exact message (and, when given, $code; a code is always required). */
function auth_assert_error(callable $fn, int $status, string $message, string $label = '', ?string $code = null): void
{
    try {
        $fn();
    } catch (HttpError $e) {
        assert_eq($e->status, $status, ($label !== '' ? $label . ' – ' : '') . 'status');
        assert_eq($e->getMessage(), $message, ($label !== '' ? $label . ' – ' : '') . 'message');
        assert_true(is_string($e->code) && $e->code !== '', ($label !== '' ? $label . ' – ' : '') . 'carries a code');
        if ($code !== null) {
            assert_eq($e->code, $code, ($label !== '' ? $label . ' – ' : '') . 'code');
        }
        return;
    }
    throw new BtAssertionError(($label !== '' ? $label . ' – ' : '') . "expected HttpError($status), nothing thrown");
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

bt_test('base64url validators: strict charset, no padding, canonical bits, exact length', function () {
    $auth = fake_auth_key();
    assert_eq(bt_valid_auth_key($auth), $auth, 'returned verbatim');
    assert_eq(strlen($auth), 43);
    $wrapped = fake_wrapped();
    assert_eq(bt_valid_wrapped($wrapped), $wrapped);
    assert_eq(strlen($wrapped), 54);
    assert_eq(bt_valid_b64u(fake_salt(), 16, 'salt') !== '', true);

    // Round trip helpers.
    assert_eq(bt_b64u_decode($auth), base64_decode(strtr($auth, '-_', '+/') . '='));
    assert_eq(bt_b64u_encode("\xfb\xff\xfe"), '-__-');
    assert_eq(bt_b64u_decode('-__-'), "\xfb\xff\xfe");

    // 32 bytes end on a char carrying 4 data bits + 2 zero bits: 'B' is not canonical.
    $nonCanonical = substr($auth, 0, 42) . 'B';
    $bad = [
        'too short' => substr($auth, 0, 42),
        'too long' => $auth . 'A',
        'non-canonical trailing bits' => $nonCanonical,
        'standard alphabet +' => str_repeat('+', 43),
        'standard alphabet /' => str_repeat('/', 43),
        'padded' => substr($auth, 0, 40) . '=',
        'whitespace' => ' ' . substr($auth, 1),
        'wrapped length' => $wrapped,
        'empty' => '',
        'null' => null,
        'int' => 12345,
        'array' => [$auth],
    ];
    foreach ($bad as $label => $value) {
        auth_assert_error(function () use ($value) {
            bt_valid_auth_key($value);
        }, 400, 'Ungültige Schlüsseldaten', $label);
    }
    auth_assert_error(function () use ($auth) {
        bt_valid_wrapped($auth);
    }, 400, 'Ungültige Schlüsseldaten', 'auth-key length is not a wrapped key');
    assert_eq(bt_b64u_decode($nonCanonical), null);
    assert_eq(bt_b64u_decode('AAAAA'), null, 'length % 4 == 1 is impossible');
});

bt_test('bt_valid_kdf: 16-byte salt and an integer iteration count within 600000..5000000', function () {
    $kdf = fake_kdf();
    assert_eq(bt_valid_kdf($kdf), $kdf);
    assert_eq(bt_valid_kdf(['salt' => $kdf['salt'], 'iter' => 5000000, 'extra' => 1]), ['salt' => $kdf['salt'], 'iter' => 5000000], 'extra keys dropped');
    $bad = [
        'not an array' => $kdf['salt'],
        'null' => null,
        'salt missing' => ['iter' => 600000],
        'salt 15 bytes' => ['salt' => fake_b64u(random_bytes(15)), 'iter' => 600000],
        'salt 32 bytes' => ['salt' => fake_auth_key(), 'iter' => 600000],
        'iter missing' => ['salt' => $kdf['salt']],
        'iter below floor' => ['salt' => $kdf['salt'], 'iter' => 599999],
        'iter above cap' => ['salt' => $kdf['salt'], 'iter' => 5000001],
        'iter string' => ['salt' => $kdf['salt'], 'iter' => '600000'],
        'iter float' => ['salt' => $kdf['salt'], 'iter' => 600000.0],
        'iter bool' => ['salt' => $kdf['salt'], 'iter' => true],
    ];
    foreach ($bad as $label => $value) {
        auth_assert_error(function () use ($value) {
            bt_valid_kdf($value);
        }, 400, 'Ungültige Schlüsseldaten', $label);
    }
});

bt_test('bt_valid_blob_field: opaque b64u between one empty envelope and the cap; nullable only on request', function () {
    $blob = fake_blob();
    assert_eq(bt_valid_blob_field($blob, 4096, false), $blob);
    $minimal = fake_b64u(random_bytes(29));
    assert_eq(strlen($minimal), 39);
    assert_eq(bt_valid_blob_field($minimal, 4096, false), $minimal, '29 bytes is the floor');
    assert_eq(bt_valid_blob_field($blob, strlen($blob), false), $blob, 'cap is inclusive');
    assert_eq(bt_valid_blob_field(null, 4096, true), null);
    $bad = [
        'null not nullable' => null,
        '28 bytes' => fake_b64u(random_bytes(28)),
        'over the cap' => fake_blob(4096),
        'standard alphabet' => str_repeat('+', 40),
        'padded' => rtrim($blob, '=') . '==',
        'int' => 42,
        'array' => ['x'],
        'empty' => '',
    ];
    foreach ($bad as $label => $value) {
        auth_assert_error(function () use ($value) {
            bt_valid_blob_field($value, 4096, false);
        }, 400, 'Ungültiger Datensatz', $label);
    }
    auth_assert_error(function () use ($blob) {
        bt_valid_blob_field($blob, strlen($blob) - 1, true);
    }, 400, 'Ungültiger Datensatz', 'nullable does not lift the cap');
});

bt_test('bt_reject_old_shell: bodies with raw password fields get the update hint', function () {
    $msg = 'Neue App-Version – bitte die App schliessen und neu öffnen, dann anmelden';
    foreach ([['password' => 'x'], ['familyPassword' => 'x'], ['password' => null, 'username' => 'mama'],
              ['currentPassword' => 'a', 'familyPassword' => 'b']] as $body) {
        auth_assert_error(function () use ($body) {
            bt_reject_old_shell($body);
        }, 400, $msg);
    }
    bt_reject_old_shell([]);
    bt_reject_old_shell(['username' => 'mama', 'authKey' => fake_auth_key(), 'currentAuthKey' => fake_auth_key()]);

    // Every body-taking entry point rejects it before touching anything.
    $pdo = auth_fresh();
    $user = auth_user();
    $old = ['username' => 'papa', 'password' => 'papa-geheim', 'displayName' => 'Papa',
            'familyName' => 'Testfamilie', 'familyPassword' => 'familie-geheim'];
    auth_assert_error(function () use ($pdo, $old) {
        bt_register($pdo, $old, [], AUTH_NOW);
    }, 400, $msg, 'register');
    auth_assert_error(function () use ($pdo) {
        bt_family_unlock($pdo, ['familyName' => 'Testfamilie', 'familyPassword' => 'familie-geheim']);
    }, 400, $msg, 'unlock');
    auth_assert_error(function () use ($pdo, $user) {
        bt_update_family_password($pdo, $user, ['currentPassword' => 'x', 'familyPassword' => 'neu']);
    }, 400, $msg, 'family password');
    auth_assert_error(function () use ($pdo, $user) {
        bt_update_password($pdo, $user, ['currentPassword' => 'x', 'password' => 'neu']);
    }, 400, $msg, 'own password');
    auth_assert_error(function () use ($pdo, $user) {
        bt_update_profile($pdo, $user, ['displayName' => 'X', 'password' => 'neu']);
    }, 400, $msg, 'profile');
    auth_assert_error(function () use ($pdo, $user) {
        bt_unlock_user_keys($pdo, $user, ['password' => 'x']);
    }, 400, $msg, 'keys unlock');
    assert_eq(auth_count($pdo, 'SELECT COUNT(*) FROM users'), 1, 'nothing written');
});

// ---------------------------------------------------------------------------
// KDF parameters
// ---------------------------------------------------------------------------

bt_test('bt_auth_params: stored values for known users, a stable fake of the same shape for unknown ones', function () {
    $pdo = auth_fresh();
    $real = bt_auth_params($pdo, 'mama');
    assert_eq($real, auth_fix('kdf'), 'the registered salt + iterations');
    assert_eq(bt_auth_params($pdo, ' MAMA '), $real, 'username folded like login');

    $fake = bt_auth_params($pdo, 'niemand');
    assert_eq(array_keys($fake), ['salt', 'iter'], 'identical shape');
    assert_eq(strlen($fake['salt']), 22);
    assert_true(bt_b64u_decode($fake['salt']) !== null && strlen(bt_b64u_decode($fake['salt'])) === 16);
    assert_true(is_int($fake['iter']));
    assert_eq($fake['iter'], 600000);
    assert_eq(bt_auth_params($pdo, 'niemand'), $fake, 'stable across calls');
    assert_eq(bt_auth_params($pdo, 'NIEMAND'), $fake, 'stable across casing');
    assert_true(bt_auth_params($pdo, 'niemand2')['salt'] !== $fake['salt'], 'different names differ');
    assert_true($fake['salt'] !== $real['salt']);
    assert_eq(array_keys(bt_auth_params($pdo, null)), ['salt', 'iter'], 'garbage input still answers');
    assert_eq(array_keys(bt_auth_params($pdo, '')), ['salt', 'iter']);

    // The fake is keyed by the per-install secret: recompute it by hand.
    $secret = hex2bin((string) $pdo->query("SELECT value FROM settings WHERE key = 'salt_secret'")->fetchColumn());
    $expected = fake_b64u(substr(hash_hmac('sha256', 'salt:niemand', $secret, true), 0, 16));
    assert_eq($fake['salt'], $expected);
    $pdo->exec("UPDATE settings SET value = lower(hex(randomblob(32))) WHERE key = 'salt_secret'");
    assert_true(bt_auth_params($pdo, 'niemand')['salt'] !== $fake['salt'], 'a new secret changes every fake');
    assert_eq(bt_auth_params($pdo, 'mama'), $real, 'real values unaffected');
    assert_eq(bt_setting($pdo, 'schema_version'), '3');
    assert_eq(bt_setting($pdo, 'nope'), null);
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

bt_test('register create: bcrypt of the auth values (never the values), salts/wrapped/profile stored verbatim', function () {
    $pdo = auth_db();
    $body = auth_create_body(['username' => 'Mama ']); // stored lowercased + trimmed
    $res = bt_register($pdo, $body, [], AUTH_NOW);
    assert_true($res['familyCreated']);
    assert_eq($res['adoptedEntries'], 0);
    assert_eq($res['legacyRemaining'], 0);
    assert_eq($res['user']['username'], 'mama');
    assert_eq($res['user']['familyName'], 'Testfamilie');
    assert_eq($res['user']['profileBlob'], $body['profileBlob']);
    assert_true($res['user']['id'] >= 1);
    assert_true($res['user']['familyId'] >= 1);
    assert_eq(array_keys($res['user']), ['id', 'username', 'familyId', 'familyName', 'profileBlob']);

    $user = $pdo->query("SELECT * FROM users WHERE username = 'mama'")->fetch(PDO::FETCH_ASSOC);
    assert_eq((int) $user['family_id'], $res['user']['familyId']);
    assert_eq(substr($user['auth_hash'], 0, 7), '$2y$04$', 'bcrypt at the test cost');
    assert_true(password_verify($body['authKey'], $user['auth_hash']));
    assert_eq($user['kdf_salt'], $body['kdf']['salt']);
    assert_eq((int) $user['kdf_iter'], 600000);
    assert_eq($user['fdk_wrapped'], $body['fdkWrappedUser']);
    assert_eq($user['profile_blob'], $body['profileBlob'], 'opaque, verbatim');
    assert_eq($user['created_at'], '2026-09-01', 'day granularity');

    $family = $pdo->query('SELECT * FROM families')->fetch(PDO::FETCH_ASSOC);
    assert_eq($family['name'], 'Testfamilie');
    assert_eq($family['name_key'], 'testfamilie');
    assert_eq(substr($family['auth_hash'], 0, 7), '$2y$04$');
    assert_true(password_verify($body['familyAuthKey'], $family['auth_hash']));
    assert_eq(substr($family['recovery_hash'], 0, 7), '$2y$04$');
    assert_true(password_verify($body['recoveryAuthKey'], $family['recovery_hash']));
    assert_false(password_verify($body['familyAuthKey'], $family['recovery_hash']), 'two independent hashes');
    assert_eq($family['kdf_salt'], $body['familyKdf']['salt']);
    assert_eq((int) $family['kdf_iter'], 600000);
    assert_eq($family['fdk_wrapped'], $body['fdkWrappedFamily']);
    assert_eq($family['created_at'], '2026-09-01');

    // None of the secret wire values is stored as-is anywhere.
    $dump = json_encode($pdo->query('SELECT * FROM users')->fetchAll(PDO::FETCH_ASSOC))
        . json_encode($pdo->query('SELECT * FROM families')->fetchAll(PDO::FETCH_ASSOC));
    foreach (['authKey', 'familyAuthKey', 'recoveryAuthKey'] as $secret) {
        assert_false(strpos($dump, $body[$secret]) !== false, "$secret never stored");
    }
    assert_eq(auth_count($pdo, 'SELECT COUNT(*) FROM families'), 1);
    assert_eq(auth_count($pdo, 'SELECT COUNT(*) FROM users'), 1);
});

bt_test('register join: family auth key or recovery auth key; wrong ones 403; unknown family 404; name folded', function () {
    $pdo = auth_fresh();
    $papa = bt_register($pdo, auth_join_body(['familyName' => ' TESTFAMILIE ']), [], AUTH_NOW);
    assert_false($papa['familyCreated']);
    assert_eq($papa['adoptedEntries'], 0);
    assert_eq($papa['user']['familyId'], auth_fam());
    assert_eq($papa['user']['familyName'], 'Testfamilie', 'stored casing returned');
    $row = $pdo->query("SELECT * FROM users WHERE username = 'papa'")->fetch(PDO::FETCH_ASSOC);
    assert_eq((int) $row['family_id'], auth_fam());
    assert_true($row['fdk_wrapped'] !== null && strlen($row['fdk_wrapped']) === 54, 'wrapped FDK from birth');
    assert_eq(auth_count($pdo, 'SELECT COUNT(*) FROM families'), 1);

    // Recovery code path: recoveryAuthKey instead of the family auth key.
    $oma = bt_register($pdo, auth_join_body([
        'username' => 'oma', 'familyAuthKey' => null, 'recoveryAuthKey' => auth_fix('recoveryAuthKey'),
    ]), [], AUTH_NOW);
    assert_eq($oma['user']['familyId'], auth_fam());

    // Wrong family auth key / wrong recovery key / unknown family: no user row.
    auth_assert_error(function () use ($pdo) {
        bt_register($pdo, auth_join_body(['username' => 'x1', 'familyAuthKey' => fake_auth_key()]), [], AUTH_NOW);
    }, 403, 'Falsches Familien-Passwort');
    auth_assert_error(function () use ($pdo) {
        bt_register($pdo, auth_join_body([
            'username' => 'x2', 'familyAuthKey' => null, 'recoveryAuthKey' => fake_auth_key(),
        ]), [], AUTH_NOW);
    }, 403, 'Ungültiger Wiederherstellungscode');
    auth_assert_error(function () use ($pdo) {
        // The recovery value is not a family auth key and vice versa.
        bt_register($pdo, auth_join_body(['username' => 'x3', 'familyAuthKey' => auth_fix('recoveryAuthKey')]), [], AUTH_NOW);
    }, 403, 'Falsches Familien-Passwort');
    auth_assert_error(function () use ($pdo) {
        bt_register($pdo, auth_join_body(['username' => 'x4', 'familyName' => 'Unbekannt']), [], AUTH_NOW);
    }, 404, 'Familie nicht gefunden – bitte Namen prüfen');
    auth_assert_error(function () use ($pdo) {
        bt_register($pdo, auth_join_body(['username' => 'x5', 'familyAuthKey' => null]), [], AUTH_NOW);
    }, 400, 'Bitte Familien-Passwort oder Wiederherstellungscode angeben');
    assert_eq(auth_count($pdo, "SELECT COUNT(*) FROM users WHERE username LIKE 'x%'"), 0);
    assert_eq(auth_count($pdo, 'SELECT COUNT(*) FROM users'), 3);

    // Unicode folding (mb_strtolower, not SQLite's ASCII-only NOCASE).
    $mBody = auth_create_body(['username' => 'mueller1', 'familyName' => ' Müller ']);
    $m = bt_register($pdo, $mBody, [], AUTH_NOW);
    assert_true($m['familyCreated']);
    assert_eq($m['user']['familyName'], 'Müller');
    $m2 = bt_register($pdo, auth_join_body([
        'username' => 'mueller2', 'familyName' => 'MÜLLER', 'familyAuthKey' => $mBody['familyAuthKey'],
    ]), [], AUTH_NOW);
    assert_false($m2['familyCreated']);
    assert_eq($m2['user']['familyId'], $m['user']['familyId']);
    assert_eq($m2['user']['familyName'], 'Müller');
    assert_eq(auth_count($pdo, 'SELECT COUNT(*) FROM families'), 2);
});

bt_test('register join with rotateFamily: the family credentials are replaced in the join transaction; validated; nothing on failure', function () {
    $pdo = auth_fresh();
    $before = $pdo->query('SELECT auth_hash, kdf_salt, kdf_iter, fdk_wrapped, recovery_hash FROM families')->fetch(PDO::FETCH_ASSOC);
    $rot = ['familyAuthKey' => fake_auth_key(), 'familyKdf' => fake_kdf(800000), 'fdkWrappedFamily' => fake_wrapped()];

    // Validation: the field is optional, but when present it must be complete.
    $reg = bt_validate_registration(auth_join_body(['rotateFamily' => $rot]));
    assert_eq($reg['rotateFamily'], $rot);
    assert_eq(bt_validate_registration(auth_join_body())['rotateFamily'], null);
    assert_eq(bt_validate_registration(auth_join_body(['rotateFamily' => null]))['rotateFamily'], null);
    foreach ([
        'ja', ['familyAuthKey' => $rot['familyAuthKey']], array_merge($rot, ['familyKdf' => fake_kdf(1000)]),
        array_merge($rot, ['fdkWrappedFamily' => fake_blob(39)]), array_merge($rot, ['familyAuthKey' => null]),
    ] as $i => $bad) {
        auth_assert_error(function () use ($bad) {
            bt_validate_registration(auth_join_body(['rotateFamily' => $bad]));
        }, 400, 'Ungültige Schlüsseldaten', "bad rotateFamily #$i");
    }
    assert_eq(bt_validate_registration(auth_create_body(['username' => 'oma2', 'rotateFamily' => $rot]))['rotateFamily'], null,
        'ignored on a create (the create brings its own family keys)');

    // A wrong family key rotates nothing.
    auth_assert_error(function () use ($pdo, $rot) {
        bt_register($pdo, auth_join_body(['username' => 'x1', 'familyAuthKey' => fake_auth_key(), 'rotateFamily' => $rot]), [], AUTH_NOW);
    }, 403, 'Falsches Familien-Passwort');
    assert_eq($pdo->query('SELECT auth_hash, kdf_salt, kdf_iter, fdk_wrapped, recovery_hash FROM families')->fetch(PDO::FETCH_ASSOC), $before, 'untouched');

    // The join: user row + rotated family in one go.
    $papa = bt_register($pdo, auth_join_body(['rotateFamily' => $rot]), [], AUTH_NOW);
    assert_eq([$papa['familyCreated'], $papa['familyClosed']], [false, true]);
    assert_eq($papa['user']['familyId'], auth_fam());
    $fam = $pdo->query('SELECT auth_hash, kdf_salt, kdf_iter, fdk_wrapped, recovery_hash FROM families')->fetch(PDO::FETCH_ASSOC);
    assert_true(password_verify($rot['familyAuthKey'], $fam['auth_hash']), 'bcrypt of the new family auth key');
    assert_false(password_verify(auth_fix('familyAuthKey'), $fam['auth_hash']), 'the old one is dead');
    assert_eq([$fam['kdf_salt'], (int) $fam['kdf_iter'], $fam['fdk_wrapped']], [$rot['familyKdf']['salt'], 800000, $rot['fdkWrappedFamily']], 'stored verbatim');
    assert_eq($fam['recovery_hash'], $before['recovery_hash'], 'the recovery code stays');
    assert_eq(bt_family_exists($pdo, 'Testfamilie')['kdf'], $rot['familyKdf'], 'the next joiner sees the new salt');
    auth_assert_error(function () use ($pdo) {
        bt_family_unlock($pdo, ['familyName' => 'Testfamilie', 'familyAuthKey' => auth_fix('familyAuthKey')]);
    }, 403, 'Falsches Familien-Passwort');
    assert_eq(bt_family_unlock($pdo, ['familyName' => 'Testfamilie', 'familyAuthKey' => $rot['familyAuthKey']])['fdkWrapped'], $rot['fdkWrappedFamily']);

    // The recovery path rotates the same way; a plain join (older shell) does not.
    $rot2 = ['familyAuthKey' => fake_auth_key(), 'familyKdf' => fake_kdf(), 'fdkWrappedFamily' => fake_wrapped()];
    $oma = bt_register($pdo, auth_join_body([
        'username' => 'oma', 'familyAuthKey' => null, 'recoveryAuthKey' => auth_fix('recoveryAuthKey'), 'rotateFamily' => $rot2,
    ]), [], AUTH_NOW);
    assert_true($oma['familyClosed']);
    assert_true(password_verify($rot2['familyAuthKey'], $pdo->query('SELECT auth_hash FROM families')->fetchColumn()));
    $opa = bt_register($pdo, auth_join_body(['username' => 'opa', 'familyAuthKey' => $rot2['familyAuthKey']]), [], AUTH_NOW);
    assert_false($opa['familyClosed']);
    assert_true(password_verify($rot2['familyAuthKey'], $pdo->query('SELECT auth_hash FROM families')->fetchColumn()), 'still open');
    assert_eq(auth_count($pdo, 'SELECT COUNT(*) FROM users'), 4);
    assert_eq(auth_count($pdo, 'SELECT COUNT(*) FROM families'), 1);
});

bt_test('register: create on an existing name 409, duplicate usernames 409, validation 400s leave no rows', function () {
    $pdo = auth_fresh();
    auth_assert_error(function () use ($pdo) {
        bt_register($pdo, auth_create_body(['username' => 'papa', 'familyName' => 'testfamilie']), [], AUTH_NOW);
    }, 409, 'Familie wurde gerade angelegt – bitte nochmals versuchen', 'create on an existing name');
    auth_assert_error(function () use ($pdo) {
        bt_register($pdo, auth_join_body(['username' => 'MAMA']), [], AUTH_NOW);
    }, 409, 'Dieser Benutzername ist bereits vergeben', 'duplicate username (case)');
    auth_assert_error(function () use ($pdo) {
        bt_register($pdo, auth_create_body(['username' => ' mama ', 'familyName' => 'Neu']), [], AUTH_NOW);
    }, 409, 'Dieser Benutzername ist bereits vergeben', 'duplicate username (trimmed), no family created');
    assert_eq(auth_count($pdo, 'SELECT COUNT(*) FROM families'), 1, 'the 409 rolled the family insert back');
    assert_eq(auth_count($pdo, 'SELECT COUNT(*) FROM users'), 1);

    // The UNIQUE constraints back the in-transaction checks (simulated race).
    try {
        $pdo->prepare('INSERT INTO users (family_id, username, auth_hash, kdf_salt, kdf_iter, fdk_wrapped, created_at) VALUES (1, ?, ?, ?, 600000, ?, ?)')
            ->execute(['mama', 'x', fake_salt(), fake_wrapped(), '2026-09-01']);
        throw new BtAssertionError('expected a PDOException');
    } catch (PDOException $e) {
        auth_assert_error(function () use ($e) {
            bt_rethrow_register_conflict($e);
        }, 409, 'Dieser Benutzername ist bereits vergeben');
    }

    $keys = ['keys' => 'Ungültige Schlüsseldaten'];
    $bad = [
        'username too short' => [['username' => 'a'], 'Benutzername: 2–30 Zeichen – Buchstaben, Ziffern, Punkt, Strich oder Unterstrich'],
        'username missing' => [['username' => null], 'Benutzername: 2–30 Zeichen – Buchstaben, Ziffern, Punkt, Strich oder Unterstrich'],
        'auth key missing' => [['authKey' => null], 'Ungültige Schlüsseldaten'],
        'auth key short' => [['authKey' => fake_b64u(random_bytes(31))], 'Ungültige Schlüsseldaten'],
        'kdf missing' => [['kdf' => null], 'Ungültige Schlüsseldaten'],
        'kdf iterations low' => [['kdf' => fake_kdf(100000)], 'Ungültige Schlüsseldaten'],
        'profile missing' => [['profileBlob' => null], 'Ungültiger Datensatz'],
        'profile junk' => [['profileBlob' => 'not base64url!'], 'Ungültiger Datensatz'],
        'family name empty' => [['familyName' => ''], 'Familienname: 1–40 Zeichen'],
        'family name 41 chars' => [['familyName' => str_repeat('x', 41)], 'Familienname: 1–40 Zeichen'],
        'mode missing' => [['familyMode' => null], 'Ungültige Anfrage'],
        'mode unknown' => [['familyMode' => 'both'], 'Ungültige Anfrage'],
        'family auth key missing' => [['familyAuthKey' => null], 'Ungültige Schlüsseldaten'],
        'family kdf missing' => [['familyKdf' => null], 'Ungültige Schlüsseldaten'],
        'family wrapped missing' => [['fdkWrappedFamily' => null], 'Ungültige Schlüsseldaten'],
        'family wrapped short' => [['fdkWrappedFamily' => fake_auth_key()], 'Ungültige Schlüsseldaten'],
        'user wrapped missing' => [['fdkWrappedUser' => null], 'Ungültige Schlüsseldaten'],
        'recovery key missing' => [['recoveryAuthKey' => null], 'Ungültige Schlüsseldaten'],
    ];
    foreach ($bad as $label => $case) {
        list($override, $message) = $case;
        auth_assert_error(function () use ($pdo, $override) {
            bt_register($pdo, auth_create_body(array_merge(['username' => 'neu', 'familyName' => 'Neu'], $override)), [], AUTH_NOW);
        }, 400, $message, $label);
    }
    auth_assert_error(function () use ($pdo) {
        bt_register($pdo, auth_join_body(['fdkWrappedUser' => null]), [], AUTH_NOW);
    }, 400, 'Ungültige Schlüsseldaten', 'join without the wrapped FDK');
    assert_eq(auth_count($pdo, 'SELECT COUNT(*) FROM users'), 1, 'no rows written by 400s');
    assert_eq(auth_count($pdo, 'SELECT COUNT(*) FROM families'), 1);

    // bt_validate_registration alone: no DB, normalised fields, join keeps only the given credential.
    $join = bt_validate_registration(auth_join_body(['username' => ' Papa ']));
    assert_eq($join['username'], 'papa');
    assert_eq($join['familyMode'], 'join');
    assert_eq($join['familyAuthKey'], auth_fix('familyAuthKey'));
    assert_eq($join['recoveryAuthKey'], null);
    assert_eq($join['familyKdf'], null);
    assert_eq($join['legacyPassword'], null);
    $create = bt_validate_registration(auth_create_body(['legacyPassword' => 'altes-passwort', 'familyName' => "  Neue\tFamilie "]));
    assert_eq($create['familyName'], 'Neue Familie');
    assert_eq($create['legacyPassword'], 'altes-passwort');
    assert_eq(bt_validate_registration(auth_create_body(['legacyPassword' => '']))['legacyPassword'], null, 'empty = absent');
});

// ---------------------------------------------------------------------------
// Legacy adoption
// ---------------------------------------------------------------------------

bt_test('legacy adoption without the gate: the first family created adopts, later ones never', function () {
    $pdo = auth_db();
    auth_seed_legacy($pdo, 3);
    $body = auth_create_body();
    $res = bt_register($pdo, $body, [], AUTH_NOW);
    assert_true($res['familyCreated']);
    assert_eq($res['adoptedEntries'], 3);
    assert_eq($res['legacyRemaining'], 3, 'adopted rows are still plaintext until sealed');
    $fid = (int) $res['user']['familyId'];
    assert_eq(auth_count($pdo, 'SELECT COUNT(*) FROM entries WHERE family_id IS NULL'), 0);
    assert_eq(auth_count($pdo, "SELECT COUNT(*) FROM entries WHERE family_id = $fid"), 3);
    assert_eq($pdo->query("SELECT GROUP_CONCAT(seq) FROM entries WHERE family_id = $fid ORDER BY seq")->fetchColumn(), '1,2,3', 'seq kept');

    // A NULL row appearing later is NOT adopted by a second family.
    auth_seed_legacy($pdo, 1);
    $res2 = bt_register($pdo, auth_create_body(['username' => 'fremd', 'familyName' => 'Fremde']), [], AUTH_NOW);
    assert_true($res2['familyCreated']);
    assert_eq($res2['adoptedEntries'], 0);
    assert_eq($res2['legacyRemaining'], 0);
    assert_eq(auth_count($pdo, 'SELECT COUNT(*) FROM entries WHERE family_id IS NULL'), 1, 'stays unadopted');

    // A join never adopts; legacyRemaining reports the joined family's rows
    // that are still unsealed (blob IS NULL), sealed ones excluded.
    $pdo->prepare('UPDATE entries SET blob = ?, legacy_type = NULL WHERE family_id = ? AND seq = 1')
        ->execute([fake_blob(256), $fid]);
    $partner = bt_register($pdo, [
        'username' => 'papa', 'authKey' => fake_auth_key(), 'kdf' => fake_kdf(), 'profileBlob' => fake_blob(),
        'familyName' => 'Testfamilie', 'familyMode' => 'join', 'familyAuthKey' => $body['familyAuthKey'],
        'fdkWrappedUser' => fake_wrapped(),
    ], [], AUTH_NOW);
    assert_false($partner['familyCreated']);
    assert_eq($partner['adoptedEntries'], 0);
    assert_eq($partner['legacyRemaining'], 2);
    assert_eq(auth_count($pdo, 'SELECT COUNT(*) FROM entries WHERE family_id IS NULL'), 1);

    // A config whose key is null behaves like no config at all.
    $pdo = auth_db();
    auth_seed_legacy($pdo, 2);
    assert_eq(bt_register($pdo, auth_create_body(), ['legacy_password_hash' => null], AUTH_NOW)['adoptedEntries'], 2);
});

bt_test('legacy adoption gate: only a creator proving the old shared password adopts; wrong one 403', function () {
    $config = ['legacy_password_hash' => password_hash('altes-passwort', PASSWORD_BCRYPT, ['cost' => 4])];

    // The stranger registers first without the password: nothing is adopted, no error.
    $pdo = auth_db();
    auth_seed_legacy($pdo, 3);
    $stranger = bt_register($pdo, auth_create_body(['username' => 'fremd', 'familyName' => 'Fremde']), $config, AUTH_NOW);
    assert_true($stranger['familyCreated']);
    assert_eq($stranger['adoptedEntries'], 0);
    assert_eq($stranger['legacyRemaining'], 0);
    assert_eq(auth_count($pdo, 'SELECT COUNT(*) FROM entries WHERE family_id IS NULL'), 3, 'sealed under no key');

    // A wrong old password is a 403 and writes nothing.
    auth_assert_error(function () use ($pdo, $config) {
        bt_register($pdo, auth_create_body(['legacyPassword' => 'falsch']), $config, AUTH_NOW);
    }, 403, 'Falsches Alt-Passwort');
    assert_eq(auth_count($pdo, 'SELECT COUNT(*) FROM users'), 1);
    assert_eq(auth_count($pdo, 'SELECT COUNT(*) FROM families'), 1);
    assert_eq(auth_count($pdo, 'SELECT COUNT(*) FROM entries WHERE family_id IS NULL'), 3);

    // The owner creates the SECOND family with the right password: adopted.
    $ownerBody = auth_create_body(['legacyPassword' => 'altes-passwort']);
    $owner = bt_register($pdo, $ownerBody, $config, AUTH_NOW);
    assert_true($owner['familyCreated']);
    assert_eq($owner['adoptedEntries'], 3);
    assert_eq($owner['legacyRemaining'], 3);
    $fid = (int) $owner['user']['familyId'];
    assert_eq(auth_count($pdo, 'SELECT COUNT(*) FROM entries WHERE family_id IS NULL'), 0);
    assert_eq(auth_count($pdo, "SELECT COUNT(*) FROM entries WHERE family_id = $fid"), 3);

    // Joining with the password proves nothing extra and adopts nothing
    // (rows appearing later stay in the pool), and its value is not checked.
    auth_seed_legacy($pdo, 1);
    $partner = bt_register($pdo, [
        'username' => 'papa', 'authKey' => fake_auth_key(), 'kdf' => fake_kdf(), 'profileBlob' => fake_blob(),
        'familyName' => 'Testfamilie', 'familyMode' => 'join', 'familyAuthKey' => $ownerBody['familyAuthKey'],
        'fdkWrappedUser' => fake_wrapped(), 'legacyPassword' => 'egal',
    ], $config, AUTH_NOW);
    assert_false($partner['familyCreated']);
    assert_eq($partner['adoptedEntries'], 0);
    assert_eq($partner['legacyRemaining'], 3, 'the joined family still has its 3 unsealed rows');
    assert_eq(auth_count($pdo, 'SELECT COUNT(*) FROM entries WHERE family_id IS NULL'), 1);

    // With the gate on, the FIRST family does not adopt without the password
    // (the race the gate exists for) — and an empty string counts as absent.
    $pdo = auth_db();
    auth_seed_legacy($pdo, 2);
    $first = bt_register($pdo, auth_create_body(['legacyPassword' => '']), $config, AUTH_NOW);
    assert_eq($first['adoptedEntries'], 0);
    assert_eq(auth_count($pdo, 'SELECT COUNT(*) FROM entries WHERE family_id IS NULL'), 2);
    // An empty config string means "no gate": the first family adopts.
    $pdo = auth_db();
    auth_seed_legacy($pdo, 2);
    assert_eq(bt_register($pdo, auth_create_body(), ['legacy_password_hash' => ''], AUTH_NOW)['adoptedEntries'], 2);
});

// ---------------------------------------------------------------------------
// Login + family unlock + own keys
// ---------------------------------------------------------------------------

bt_test('login: bt_authenticate returns the user with kdf + fdkWrapped; unknown/wrong -> null; 400 on bad input', function () {
    $pdo = auth_fresh();
    $user = bt_authenticate($pdo, 'MAMA', auth_fix('authKey'));
    assert_true($user !== null);
    assert_eq($user['username'], 'mama');
    assert_eq($user['familyId'], auth_fam());
    assert_eq($user['familyName'], 'Testfamilie');
    assert_eq($user['profileBlob'], auth_fix('profileBlob'));
    assert_eq($user['kdf'], auth_fix('kdf'));
    assert_eq($user['fdkWrapped'], auth_fix('fdkWrappedUser'));
    assert_false(array_key_exists('auth_hash', $user), 'no hash in the user array');
    assert_true(bt_authenticate($pdo, ' mama ', auth_fix('authKey')) !== null, 'trimmed');
    assert_eq(bt_user_json($user), [
        'username' => 'mama', 'familyId' => auth_fam(), 'familyName' => 'Testfamilie',
        'profileBlob' => auth_fix('profileBlob'),
    ], 'public shape: no id, no hashes, no key material');

    assert_eq(bt_authenticate($pdo, 'mama', fake_auth_key()), null, 'wrong auth key');
    assert_eq(bt_authenticate($pdo, 'niemand', auth_fix('authKey')), null, 'unknown user (dummy path)');
    assert_eq(bt_authenticate($pdo, 'mama', auth_fix('familyAuthKey')), null, 'family auth key is not a login');
    assert_eq(bt_authenticate($pdo, 'mama', auth_fix('recoveryAuthKey')), null, 'recovery value is not a login');

    auth_assert_error(function () use ($pdo) {
        bt_authenticate($pdo, null, fake_auth_key());
    }, 400, 'Bitte Benutzername und Passwort angeben', 'username missing');
    auth_assert_error(function () use ($pdo) {
        bt_authenticate($pdo, 'mama', null);
    }, 400, 'Bitte Benutzername und Passwort angeben', 'auth key missing');
    auth_assert_error(function () use ($pdo) {
        bt_authenticate($pdo, ['mama'], 12345);
    }, 400, 'Bitte Benutzername und Passwort angeben', 'non-strings');
    auth_assert_error(function () use ($pdo) {
        bt_authenticate($pdo, 'mama', 'mama-geheim');
    }, 400, 'Ungültige Schlüsseldaten', 'a raw password is not an auth key');
    assert_true(strpos(BT_DUMMY_HASH, '$2y$10$') === 0, 'dummy hash at the production cost');
    assert_eq(BT_BCRYPT_COST, 10);
});

bt_test('bt_family_unlock: family auth key or recovery auth key -> kdf + fdkWrapped; 403 texts; 404', function () {
    $pdo = auth_fresh();
    $expected = ['familyId' => auth_fam(), 'kdf' => auth_fix('familyKdf'), 'fdkWrapped' => auth_fix('fdkWrappedFamily')];
    assert_eq(bt_family_unlock($pdo, ['familyName' => ' testFAMILIE ', 'familyAuthKey' => auth_fix('familyAuthKey')]), $expected);
    assert_eq(bt_family_unlock($pdo, ['familyName' => 'Testfamilie', 'recoveryAuthKey' => auth_fix('recoveryAuthKey')]), $expected);
    assert_eq(bt_family_unlock($pdo, [
        'familyName' => 'Testfamilie', 'familyAuthKey' => auth_fix('familyAuthKey'), 'recoveryAuthKey' => fake_auth_key(),
    ]), $expected, 'familyAuthKey wins when both are present');

    auth_assert_error(function () use ($pdo) {
        bt_family_unlock($pdo, ['familyName' => 'Testfamilie', 'familyAuthKey' => fake_auth_key()]);
    }, 403, 'Falsches Familien-Passwort');
    auth_assert_error(function () use ($pdo) {
        bt_family_unlock($pdo, ['familyName' => 'Testfamilie', 'recoveryAuthKey' => fake_auth_key()]);
    }, 403, 'Ungültiger Wiederherstellungscode');
    auth_assert_error(function () use ($pdo) {
        bt_family_unlock($pdo, ['familyName' => 'Testfamilie', 'recoveryAuthKey' => auth_fix('familyAuthKey')]);
    }, 403, 'Ungültiger Wiederherstellungscode', 'values are role-bound');
    auth_assert_error(function () use ($pdo) {
        bt_family_unlock($pdo, ['familyName' => 'Unbekannt', 'familyAuthKey' => auth_fix('familyAuthKey')]);
    }, 404, 'Familie nicht gefunden – bitte Namen prüfen');
    auth_assert_error(function () use ($pdo) {
        bt_family_unlock($pdo, ['familyName' => 'Testfamilie']);
    }, 400, 'Bitte Familien-Passwort oder Wiederherstellungscode angeben');
    auth_assert_error(function () use ($pdo) {
        bt_family_unlock($pdo, ['familyName' => 'Testfamilie', 'familyAuthKey' => 'familie-geheim']);
    }, 400, 'Ungültige Schlüsseldaten');
    auth_assert_error(function () use ($pdo) {
        bt_family_unlock($pdo, ['familyAuthKey' => auth_fix('familyAuthKey')]);
    }, 400, 'Familienname: 1–40 Zeichen');
});

bt_test('bt_family_exists folds case + whitespace, returns the public family kdf, never errors', function () {
    $pdo = auth_fresh();
    $found = ['name' => 'Testfamilie', 'kdf' => auth_fix('familyKdf')];
    assert_eq(bt_family_exists($pdo, 'testfamilie'), $found);
    assert_eq(bt_family_exists($pdo, ' TESTFAMILIE '), $found);
    assert_eq(bt_family_exists($pdo, "Test\tfamilie"), null, 'inner whitespace is significant');
    assert_eq(bt_family_exists($pdo, 'Unbekannt'), null);
    assert_eq(bt_family_exists($pdo, ''), null);
    assert_eq(bt_family_exists($pdo, '   '), null);
    assert_eq(bt_family_exists($pdo, str_repeat('x', 41)), null);
    assert_eq(bt_family_exists($pdo, null), null);
    assert_eq(bt_family_exists($pdo, ['name' => 'Testfamilie']), null);
    $dump = json_encode($found);
    assert_false(strpos($dump, auth_fix('fdkWrappedFamily')) !== false, 'no wrapped FDK without a credential');
});

bt_test('own keys: cookie alone yields none; bt_user_keys; bt_unlock_user_keys 403 on a wrong auth key', function () {
    $pdo = auth_fresh();
    $uid = (int) auth_user()['id'];
    $keys = ['kdf' => auth_fix('kdf'), 'fdkWrapped' => auth_fix('fdkWrappedUser')];

    $_COOKIE[BT_COOKIE] = bt_create_token($pdo, $uid);
    $user = bt_require_auth($pdo);
    assert_eq(array_keys($user), ['id', 'username', 'familyId', 'familyName', 'profileBlob'], 'no key material on a cookie');
    assert_eq(bt_user_keys($pdo, $uid), $keys);
    assert_eq(bt_unlock_user_keys($pdo, $user, ['authKey' => auth_fix('authKey')]), $keys);

    auth_assert_error(function () use ($pdo, $user) {
        bt_unlock_user_keys($pdo, $user, ['authKey' => fake_auth_key()]);
    }, 403, 'Falsches Passwort');
    auth_assert_error(function () use ($pdo, $user) {
        bt_unlock_user_keys($pdo, $user, ['authKey' => auth_fix('familyAuthKey')]);
    }, 403, 'Falsches Passwort', 'family value does not unlock a member', 'auth.badPassword');
    auth_assert_error(function () use ($pdo, $user) {
        bt_unlock_user_keys($pdo, $user, []);
    }, 400, 'Ungültige Schlüsseldaten');
    auth_assert_error(function () use ($pdo) {
        bt_user_keys($pdo, 999);
    }, 401, 'Nicht angemeldet');
    unset($_COOKIE[BT_COOKIE]);
});

// ---------------------------------------------------------------------------
// Profile + password changes
// ---------------------------------------------------------------------------

bt_test('bt_update_profile replaces the opaque profile blob; login and tokens see it', function () {
    $pdo = auth_fresh();
    $user = auth_user();
    $blob = fake_blob();
    $updated = bt_update_profile($pdo, $user, ['profileBlob' => $blob]);
    assert_eq($updated['profileBlob'], $blob);
    assert_eq($updated['username'], 'mama');
    assert_eq($updated['familyId'], auth_fam());
    assert_eq($pdo->query('SELECT profile_blob FROM users')->fetchColumn(), $blob);
    assert_eq(bt_authenticate($pdo, 'mama', auth_fix('authKey'))['profileBlob'], $blob, 'next login sees it');
    assert_eq(bt_user_for_token($pdo, bt_create_token($pdo, (int) $user['id']))['profileBlob'], $blob);

    foreach ([null, '', 'Mami', str_repeat('A', 38), fake_blob(4096), 42] as $invalid) {
        auth_assert_error(function () use ($pdo, $updated, $invalid) {
            bt_update_profile($pdo, $updated, ['profileBlob' => $invalid]);
        }, 400, 'Ungültiger Datensatz');
    }
    assert_eq($pdo->query('SELECT profile_blob FROM users')->fetchColumn(), $blob, 'unchanged after 400s');
});

bt_test('bt_update_password re-wraps (auth hash, kdf, fdk) and revokes the user\'s OTHER tokens only', function () {
    $pdo = auth_fresh();
    $user = auth_user();
    $uid = (int) $user['id'];
    $papa = bt_register($pdo, auth_join_body(), [], AUTH_NOW)['user'];
    $mine = bt_create_token($pdo, $uid);
    $otherPhone = bt_create_token($pdo, $uid);
    $papaToken = bt_create_token($pdo, (int) $papa['id']);
    $_COOKIE[BT_COOKIE] = $mine;
    $before = $pdo->query("SELECT auth_hash, kdf_salt, kdf_iter, fdk_wrapped FROM users WHERE id = $uid")->fetch(PDO::FETCH_ASSOC);

    $new = ['authKey' => fake_auth_key(), 'kdf' => fake_kdf(1000000), 'fdkWrappedUser' => fake_wrapped()];
    // Wrong / missing confirmation and bad new material change nothing.
    auth_assert_error(function () use ($pdo, $user, $new) {
        bt_update_password($pdo, $user, $new + ['currentAuthKey' => fake_auth_key()]);
    }, 403, 'Falsches Passwort', 'wrong current auth key');
    auth_assert_error(function () use ($pdo, $user, $new) {
        bt_update_password($pdo, $user, $new);
    }, 400, 'Bitte dein Passwort zur Bestätigung angeben', 'no confirmation');
    auth_assert_error(function () use ($pdo, $user, $new) {
        bt_update_password($pdo, $user, $new + ['currentAuthKey' => 'mama-geheim']);
    }, 400, 'Ungültige Schlüsseldaten', 'raw password as confirmation');
    foreach (['authKey', 'kdf', 'fdkWrappedUser'] as $field) {
        auth_assert_error(function () use ($pdo, $user, $new, $field) {
            bt_update_password($pdo, $user, array_merge($new, [$field => null, 'currentAuthKey' => auth_fix('authKey')]));
        }, 400, 'Ungültige Schlüsseldaten', "$field missing");
    }
    assert_eq($pdo->query("SELECT auth_hash, kdf_salt, kdf_iter, fdk_wrapped FROM users WHERE id = $uid")->fetch(PDO::FETCH_ASSOC), $before, 'unchanged');
    assert_eq(auth_count($pdo, 'SELECT COUNT(*) FROM auth_tokens'), 3, 'no token revoked by a failed attempt');

    bt_update_password($pdo, $user, $new + ['currentAuthKey' => auth_fix('authKey')]);
    $row = $pdo->query("SELECT auth_hash, kdf_salt, kdf_iter, fdk_wrapped FROM users WHERE id = $uid")->fetch(PDO::FETCH_ASSOC);
    assert_true(password_verify($new['authKey'], $row['auth_hash']));
    assert_false(password_verify(auth_fix('authKey'), $row['auth_hash']), 'old auth key gone');
    assert_eq($row['kdf_salt'], $new['kdf']['salt']);
    assert_eq((int) $row['kdf_iter'], 1000000);
    assert_eq($row['fdk_wrapped'], $new['fdkWrappedUser']);
    assert_eq(bt_authenticate($pdo, 'mama', auth_fix('authKey')), null, 'old login fails');
    $login = bt_authenticate($pdo, 'mama', $new['authKey']);
    assert_eq($login['kdf'], $new['kdf']);
    assert_eq($login['fdkWrapped'], $new['fdkWrappedUser']);
    assert_eq(bt_auth_params($pdo, 'mama'), $new['kdf'], 'params follow the new salt');

    // This session survives, the other phone is logged out, the partner is untouched.
    assert_eq(bt_user_for_token($pdo, $mine)['username'], 'mama');
    assert_eq(bt_user_for_token($pdo, $otherPhone), null);
    assert_eq(bt_user_for_token($pdo, $papaToken)['username'], 'papa');
    assert_eq(auth_count($pdo, 'SELECT COUNT(*) FROM auth_tokens'), 2);

    // Without a cookie (nothing to keep) every token of the user goes.
    unset($_COOKIE[BT_COOKIE]);
    bt_create_token($pdo, $uid);
    bt_update_password($pdo, $user, [
        'currentAuthKey' => $new['authKey'], 'authKey' => fake_auth_key(), 'kdf' => fake_kdf(), 'fdkWrappedUser' => fake_wrapped(),
    ]);
    assert_eq(auth_count($pdo, "SELECT COUNT(*) FROM auth_tokens WHERE user_id = $uid"), 0);
    assert_eq(bt_user_for_token($pdo, $papaToken)['username'], 'papa');
});

bt_test('bt_update_family_password: any member rotates hash + kdf + wrapping with their own auth key; recovery stays; joins follow', function () {
    $pdo = auth_fresh();
    $user = auth_user();
    $famBefore = $pdo->query('SELECT auth_hash, kdf_salt, kdf_iter, fdk_wrapped, recovery_hash FROM families')->fetch(PDO::FETCH_ASSOC);
    $new = ['familyAuthKey' => fake_auth_key(), 'familyKdf' => fake_kdf(), 'fdkWrappedFamily' => fake_wrapped()];

    auth_assert_error(function () use ($pdo, $user, $new) {
        bt_update_family_password($pdo, $user, $new + ['currentAuthKey' => fake_auth_key()]);
    }, 403, 'Falsches Passwort', 'wrong own auth key');
    auth_assert_error(function () use ($pdo, $user, $new) {
        bt_update_family_password($pdo, $user, $new + ['currentAuthKey' => auth_fix('familyAuthKey')]);
    }, 403, 'Falsches Passwort', 'the family value does not confirm');
    auth_assert_error(function () use ($pdo, $user, $new) {
        bt_update_family_password($pdo, $user, $new);
    }, 400, 'Bitte dein Passwort zur Bestätigung angeben', 'no confirmation');
    foreach (['familyAuthKey', 'familyKdf', 'fdkWrappedFamily'] as $field) {
        auth_assert_error(function () use ($pdo, $user, $new, $field) {
            bt_update_family_password($pdo, $user, array_merge($new, [$field => null, 'currentAuthKey' => auth_fix('authKey')]));
        }, 400, 'Ungültige Schlüsseldaten', "$field missing");
    }
    assert_eq($pdo->query('SELECT auth_hash, kdf_salt, kdf_iter, fdk_wrapped, recovery_hash FROM families')->fetch(PDO::FETCH_ASSOC), $famBefore, 'unchanged');

    bt_update_family_password($pdo, $user, $new + ['currentAuthKey' => auth_fix('authKey')]);
    $fam = $pdo->query('SELECT auth_hash, kdf_salt, kdf_iter, fdk_wrapped, recovery_hash FROM families')->fetch(PDO::FETCH_ASSOC);
    assert_true(password_verify($new['familyAuthKey'], $fam['auth_hash']));
    assert_eq($fam['kdf_salt'], $new['familyKdf']['salt']);
    assert_eq($fam['fdk_wrapped'], $new['fdkWrappedFamily']);
    assert_eq($fam['recovery_hash'], $famBefore['recovery_hash'], 'recovery code unaffected');
    assert_eq(bt_family_exists($pdo, 'Testfamilie')['kdf'], $new['familyKdf'], 'joiners get the new salt');

    auth_assert_error(function () use ($pdo) {
        bt_register($pdo, auth_join_body(['username' => 'papa1']), [], AUTH_NOW);
    }, 403, 'Falsches Familien-Passwort', 'old family auth key no longer joins');
    auth_assert_error(function () use ($pdo) {
        bt_family_unlock($pdo, ['familyName' => 'Testfamilie', 'familyAuthKey' => auth_fix('familyAuthKey')]);
    }, 403, 'Falsches Familien-Passwort');
    $unlocked = bt_family_unlock($pdo, ['familyName' => 'Testfamilie', 'familyAuthKey' => $new['familyAuthKey']]);
    assert_eq($unlocked['fdkWrapped'], $new['fdkWrappedFamily']);
    assert_eq($unlocked['kdf'], $new['familyKdf']);
    assert_eq(bt_family_unlock($pdo, ['familyName' => 'Testfamilie', 'recoveryAuthKey' => auth_fix('recoveryAuthKey')])['fdkWrapped'],
        $new['fdkWrappedFamily'], 'recovery still unlocks (the new wrapping)');
    $joinBody = auth_join_body(['username' => 'papa2', 'familyAuthKey' => $new['familyAuthKey']]);
    $joined = bt_register($pdo, $joinBody, [], AUTH_NOW);
    assert_false($joined['familyCreated']);
    assert_eq($joined['user']['familyId'], auth_fam());

    // The new member may rotate it too (their own auth key confirms); the
    // existing member stays logged in regardless.
    $third = ['familyAuthKey' => fake_auth_key(), 'familyKdf' => fake_kdf(), 'fdkWrappedFamily' => fake_wrapped()];
    bt_update_family_password($pdo, $joined['user'], $third + ['currentAuthKey' => $joinBody['authKey']]);
    bt_register($pdo, auth_join_body(['username' => 'papa3', 'familyAuthKey' => $third['familyAuthKey']]), [], AUTH_NOW);
    $_COOKIE[BT_COOKIE] = bt_create_token($pdo, (int) $user['id']);
    assert_eq(bt_require_auth($pdo)['username'], 'mama', 'still logged in');
    unset($_COOKIE[BT_COOKIE]);
    assert_eq(auth_count($pdo, 'SELECT COUNT(*) FROM users'), 3);
});

// ---------------------------------------------------------------------------
// Tokens + throttle + request guard
// ---------------------------------------------------------------------------

bt_test('tokens are bound to users: cookie -> user, expiry, deleted user, no cookie, day-granular created_at', function () {
    $pdo = auth_fresh();
    $uid = (int) auth_user()['id'];
    assert_http_error(function () use ($pdo) {
        bt_require_auth($pdo);
    }, 401, 'no cookie');
    assert_eq(bt_current_user($pdo), null);

    $token = bt_create_token($pdo, $uid);
    assert_eq(bt_user_for_token($pdo, 'not-a-token'), null);
    $_COOKIE[BT_COOKIE] = $token;
    $user = bt_require_auth($pdo);
    assert_eq($user['id'], $uid);
    assert_eq($user['username'], 'mama');
    assert_eq($user['familyId'], auth_fam());
    assert_eq($user['familyName'], 'Testfamilie');
    assert_eq($user['profileBlob'], auth_fix('profileBlob'));
    assert_eq(bt_user_json($user), [
        'username' => 'mama', 'familyId' => auth_fam(), 'familyName' => 'Testfamilie',
        'profileBlob' => auth_fix('profileBlob'),
    ], 'public shape');
    $row = $pdo->query('SELECT user_id, token_hash, created_at FROM auth_tokens')->fetch(PDO::FETCH_ASSOC);
    assert_eq((int) $row['user_id'], $uid);
    assert_eq($row['token_hash'], hash('sha256', $token), 'only the hash is stored');
    assert_true((bool) preg_match('/^\d{4}-\d{2}-\d{2}$/', $row['created_at']), 'created_at is a date: ' . $row['created_at']);

    $pdo->exec("UPDATE auth_tokens SET expires_at = datetime('now', '-1 day')");
    assert_http_error(function () use ($pdo) {
        bt_require_auth($pdo);
    }, 401, 'expired token');

    $_COOKIE[BT_COOKIE] = bt_create_token($pdo, $uid);
    assert_eq(bt_require_auth($pdo)['username'], 'mama');
    assert_eq(bt_current_token_hash(), hash('sha256', $_COOKIE[BT_COOKIE]), 'the presented token (what revoke/password change key on)');
    $pdo->exec('DELETE FROM users');
    assert_http_error(function () use ($pdo) {
        bt_require_auth($pdo);
    }, 401, 'user row deleted');
    unset($_COOKIE[BT_COOKIE]);
    assert_eq(bt_current_token_hash(), '', 'no cookie, nothing to keep');
});

bt_test('sliding renewal extends a token in its second half, leaves fresh ones alone', function () {
    $pdo = auth_fresh();
    $token = bt_create_token($pdo, (int) auth_user()['id']);
    $expiresOf = function () use ($pdo) {
        return (string) $pdo->query('SELECT expires_at FROM auth_tokens LIMIT 1')->fetchColumn();
    };

    $fresh = $expiresOf();
    bt_renew_token_if_stale($pdo, $token);
    assert_eq($expiresOf(), $fresh, 'a fresh token is not rewritten');

    // Age the token into its second half (30 days left of 180).
    $pdo->exec("UPDATE auth_tokens SET expires_at = datetime('now', '+30 days')");
    $old = $expiresOf();
    bt_renew_token_if_stale($pdo, $token);
    assert_true($expiresOf() > $old, 'stale token extended');
    assert_eq(bt_user_for_token($pdo, $token)['username'], 'mama');
});

bt_test('bt_gc_tokens drops expired tokens and day-old throttle rows', function () {
    $pdo = auth_fresh();
    $uid = (int) auth_user()['id'];
    $live = bt_create_token($pdo, $uid);
    $dead = bt_create_token($pdo, $uid);
    $pdo->prepare("UPDATE auth_tokens SET expires_at = datetime('now', '-1 day') WHERE token_hash = ?")
        ->execute([bt_hash_token($dead)]);
    bt_record_login_failure($pdo, '203.0.113.1');
    bt_record_login_failure($pdo, 'reg:203.0.113.2');
    $pdo->prepare("UPDATE login_attempts SET window_start = datetime('now', '-2 days') WHERE ip = ?")
        ->execute(['reg:203.0.113.2']);

    bt_gc_tokens($pdo);
    assert_eq(auth_count($pdo, 'SELECT COUNT(*) FROM auth_tokens'), 1);
    assert_eq(bt_user_for_token($pdo, $live)['username'], 'mama');
    assert_eq(bt_user_for_token($pdo, $dead), null);
    $ips = $pdo->query('SELECT ip FROM login_attempts ORDER BY ip')->fetchAll(PDO::FETCH_COLUMN);
    assert_eq($ips, ['203.0.113.1']);
});

bt_test('login throttle: budget per key and window; registration key independent; success does not clear', function () {
    $pdo = auth_fresh();
    $ip = '203.0.113.7';
    bt_assert_login_allowed($pdo, $ip);
    for ($i = 0; $i < BT_LOGIN_MAX_FAILS; $i++) {
        bt_record_login_failure($pdo, $ip);
    }
    assert_http_error(function () use ($pdo, $ip) {
        bt_assert_login_allowed($pdo, $ip);
    }, 429, 'budget exhausted');

    // The registration budget of the same IP is a separate key.
    bt_assert_login_allowed($pdo, 'reg:' . $ip);
    for ($i = 0; $i < BT_LOGIN_MAX_FAILS; $i++) {
        bt_record_login_failure($pdo, 'reg:' . $ip);
    }
    assert_http_error(function () use ($pdo, $ip) {
        bt_assert_login_allowed($pdo, 'reg:' . $ip);
    }, 429, 'registration budget exhausted');

    // A different IP is unaffected.
    bt_assert_login_allowed($pdo, '203.0.113.8');
    bt_assert_login_allowed($pdo, 'reg:203.0.113.8');

    // A successful login leaves the counter untouched (with open registration
    // an attacker could otherwise reset the budget via their own account).
    assert_true(bt_authenticate($pdo, 'mama', auth_fix('authKey')) !== null);
    assert_http_error(function () use ($pdo, $ip) {
        bt_assert_login_allowed($pdo, $ip);
    }, 429, 'still exhausted after a successful login');
    // index.php is a script, not unit-testable here: pin that it never calls
    // the clear helper on login success.
    $src = (string) file_get_contents(__DIR__ . '/../index.php');
    assert_false(strpos($src, 'bt_clear_login_failures(') !== false, 'index.php must not clear the budget');

    // A lapsed window restarts the count.
    $pdo->exec("UPDATE login_attempts SET window_start = datetime('now', '-1 hour')");
    bt_assert_login_allowed($pdo, $ip);
    bt_record_login_failure($pdo, $ip);
    $fails = (int) $pdo->query("SELECT fails FROM login_attempts WHERE ip = '$ip'")->fetchColumn();
    assert_eq($fails, 1, 'lapsed window restarted');
    bt_clear_login_failures($pdo, $ip);
    assert_eq(auth_count($pdo, "SELECT COUNT(*) FROM login_attempts WHERE ip = '$ip'"), 0);
    assert_eq(auth_count($pdo, 'SELECT COUNT(*) FROM login_attempts'), 1, 'reg: row untouched');
});

bt_test('throttle budgets by key prefix: targets 20 / hour, writes 300 / 15 min, addresses 10 / 15 min; key builders fold', function () {
    $pdo = auth_fresh();
    assert_eq(bt_throttle_budget('203.0.113.7'), [BT_LOGIN_MAX_FAILS, BT_LOGIN_WINDOW_SECONDS]);
    assert_eq(bt_throttle_budget('2001:db8::f'), [BT_LOGIN_MAX_FAILS, BT_LOGIN_WINDOW_SECONDS], 'IPv6 stays an address key');
    assert_eq(bt_throttle_budget('reg:203.0.113.7'), [BT_LOGIN_MAX_FAILS, BT_LOGIN_WINDOW_SECONDS]);
    assert_eq(bt_throttle_budget('user:mama'), [BT_TARGET_MAX_FAILS, BT_TARGET_WINDOW_SECONDS]);
    assert_eq(bt_throttle_budget('family:testfamilie'), [BT_TARGET_MAX_FAILS, BT_TARGET_WINDOW_SECONDS]);
    assert_eq(bt_throttle_budget('write:203.0.113.7'), [BT_WRITE_MAX_PER_WINDOW, BT_WRITE_WINDOW_SECONDS]);
    assert_eq([BT_TARGET_MAX_FAILS, BT_TARGET_WINDOW_SECONDS, BT_WRITE_MAX_PER_WINDOW, BT_WRITE_WINDOW_SECONDS], [20, 3600, 300, 900]);

    assert_eq(bt_user_throttle_key(' MAMA '), 'user:mama', 'folded like the login');
    assert_eq(strlen(bt_user_throttle_key(str_repeat('x', 500))), strlen('user:') + 64, 'junk names are capped');
    assert_eq(bt_family_throttle_key(bt_name_key(' MÜLLER  Meier ')), 'family:müller meier');
    assert_eq(bt_write_throttle_key('203.0.113.7'), 'write:203.0.113.7');

    // A target: 20 attempts, then 429 for an hour – 30 minutes later it still holds, 61 minutes later it restarts.
    $t = 'user:mama';
    for ($i = 0; $i < BT_TARGET_MAX_FAILS; $i++) {
        bt_assert_login_allowed($pdo, $t);
        bt_record_login_failure($pdo, $t);
    }
    assert_http_error(function () use ($pdo, $t) {
        bt_assert_login_allowed($pdo, $t);
    }, 429, 'target budget exhausted');
    $pdo->prepare("UPDATE login_attempts SET window_start = datetime('now', '-30 minutes') WHERE ip = ?")->execute([$t]);
    assert_http_error(function () use ($pdo, $t) {
        bt_assert_login_allowed($pdo, $t);
    }, 429, 'an hour, not 15 minutes');
    $pdo->prepare("UPDATE login_attempts SET window_start = datetime('now', '-61 minutes') WHERE ip = ?")->execute([$t]);
    bt_assert_login_allowed($pdo, $t);
    bt_record_login_failure($pdo, $t);
    assert_eq((int) $pdo->query("SELECT fails FROM login_attempts WHERE ip = '$t'")->fetchColumn(), 1, 'lapsed hour restarted');
    bt_assert_login_allowed($pdo, 'user:papa');
    bt_assert_login_allowed($pdo, 'family:testfamilie');

    // Writes: charged up front, own text once the budget is gone, 15-minute window.
    $ip = '203.0.113.9';
    for ($i = 0; $i < BT_WRITE_MAX_PER_WINDOW; $i++) {
        bt_charge_write($pdo, $ip);
    }
    assert_eq((int) $pdo->query("SELECT fails FROM login_attempts WHERE ip = 'write:$ip'")->fetchColumn(), BT_WRITE_MAX_PER_WINDOW);
    auth_assert_error(function () use ($pdo, $ip) {
        bt_charge_write($pdo, $ip);
    }, 429, 'Zu viele Änderungen in kurzer Zeit – bitte später nochmals versuchen');
    assert_eq((int) $pdo->query("SELECT fails FROM login_attempts WHERE ip = 'write:$ip'")->fetchColumn(), BT_WRITE_MAX_PER_WINDOW, 'a refused write is not counted');
    bt_assert_login_allowed($pdo, $ip);
    bt_assert_login_allowed($pdo, 'reg:' . $ip);
    bt_charge_write($pdo, '203.0.113.10');
    $pdo->prepare("UPDATE login_attempts SET window_start = datetime('now', '-16 minutes') WHERE ip = ?")->execute(['write:' . $ip]);
    bt_charge_write($pdo, $ip);
    assert_eq((int) $pdo->query("SELECT fails FROM login_attempts WHERE ip = 'write:$ip'")->fetchColumn(), 1);

    // Day-old rows of every kind are garbage-collected together.
    $pdo->exec("UPDATE login_attempts SET window_start = datetime('now', '-2 days')");
    bt_gc_tokens($pdo);
    assert_eq(auth_count($pdo, 'SELECT COUNT(*) FROM login_attempts'), 0);
});

bt_test('bt_assert_json_request: 415 unless Content-Type is application/json', function () {
    $saved = [
        'CONTENT_TYPE' => $_SERVER['CONTENT_TYPE'] ?? null,
        'HTTP_CONTENT_TYPE' => $_SERVER['HTTP_CONTENT_TYPE'] ?? null,
    ];
    try {
        unset($_SERVER['CONTENT_TYPE'], $_SERVER['HTTP_CONTENT_TYPE']);
        assert_http_error('bt_assert_json_request', 415, 'no header');
        $_SERVER['CONTENT_TYPE'] = 'text/plain';
        assert_http_error('bt_assert_json_request', 415, 'text/plain');
        $_SERVER['CONTENT_TYPE'] = 'application/x-www-form-urlencoded';
        assert_http_error('bt_assert_json_request', 415, 'form post');
        $_SERVER['CONTENT_TYPE'] = 'text/application/json';
        assert_http_error('bt_assert_json_request', 415, 'must start with application/json');

        $_SERVER['CONTENT_TYPE'] = 'application/json; charset=utf-8';
        bt_assert_json_request();
        $_SERVER['CONTENT_TYPE'] = 'Application/JSON';
        bt_assert_json_request();
        unset($_SERVER['CONTENT_TYPE']);
        $_SERVER['HTTP_CONTENT_TYPE'] = 'application/json';
        bt_assert_json_request();
    } finally {
        foreach ($saved as $key => $value) {
            if ($value === null) {
                unset($_SERVER[$key]);
            } else {
                $_SERVER[$key] = $value;
            }
        }
    }
});

bt_test('send_json marks every API response no-store', function () {
    // The CLI has no real header table; pin the source instead.
    $src = (string) file_get_contents(__DIR__ . '/../lib/http.php');
    assert_true(strpos($src, "header('Cache-Control: no-store');") !== false, 'send_json sets Cache-Control: no-store');
});
