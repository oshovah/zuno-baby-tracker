<?php
/**
 * Accounts, families and key custody for the end-to-end encrypted model.
 *
 * The server never sees a password. For every password the client derives
 * (PBKDF2 → HKDF, per role user|family) two independent values: an AUTH KEY
 * — 32 random-looking bytes sent here and stored as bcrypt — and a KEK that
 * never leaves the device. The Family Data Key (FDK) that encrypts every
 * entry exists here only WRAPPED (AES-KW, 40 opaque bytes): once under the
 * family KEK (families.fdk_wrapped — handed out solely by bt_family_unlock
 * after the family auth key or the recovery auth key verified, so a stolen
 * cookie never yields it) and once per member under their own KEK
 * (users.fdk_wrapped — returned on login and by bt_unlock_user_keys, never
 * on a cookie alone).
 *
 * Stored per account: username, bcrypt(authKey), the KDF parameters the
 * client needs BEFORE it can derive anything (client-generated 16-byte salt,
 * iteration count; bt_auth_params serves them, with a stable HMAC-derived
 * fake for unknown usernames so the endpoint cannot enumerate accounts), the
 * wrapped FDK and an opaque encrypted profile blob (the display name lives
 * inside it — the server never sees a name it could validate or show). A
 * family additionally stores bcrypt(recoveryAuthKey), the recovery code's
 * auth value.
 *
 * Registration (bt_register) is ONE request in two modes: 'create' brings
 * the complete family key set (family auth key + KDF, both FDK wrappings,
 * recovery auth key); 'join' proves the family password or the recovery
 * code and brings the FDK wrapped under the new member's own KEK. A member
 * row therefore carries its wrapped FDK from birth — no pending state. A
 * join normally also brings `rotateFamily`, fresh family credentials that
 * replace the old ones in the same transaction: the family password is a
 * one-time invite, not a standing secret (see bt_register).
 *
 * Sessions: DB-backed bearer tokens (auth_tokens.token_hash = sha256(token),
 * so a leaked file exposes no usable token) bound to a user, delivered in the
 * HttpOnly cookie BT_COOKIE, ~6 months sliding. Why not PHP sessions: shared
 * hosting session GC would log people out at 3am; DB tokens are ours and
 * individually revocable (a password change drops the user's other tokens).
 *
 * Throttling (login_attempts, per key): per address for logins ('<ip>'),
 * registrations and family unlocks ('reg:<ip>') and entry writes ('w:<ip>'),
 * plus per TARGET — 'u:<username>' and 'f:<family name key>' — so guesses
 * against one account or family are bounded whatever addresses they come
 * from. Same functions, different keys and budgets (see the throttling
 * section).
 *
 * bcrypt cost is 10: the hashed inputs are uniformly random 256-bit values,
 * so a higher cost buys nothing but CPU. The dummy verification for unknown
 * usernames stays (response timing must not reveal which names exist).
 *
 * Target: PHP 7.4+.
 */

require_once __DIR__ . '/http.php';

const BT_COOKIE = 'bt_auth';
const BT_TOKEN_TTL_SECONDS = 15552000; // 180 days

// Bcrypt cost, pinned so it does NOT vary with the host's PASSWORD_BCRYPT
// default (tests lower it via the BABY_BCRYPT_COST env var, see
// bt_bcrypt_cost). BT_DUMMY_HASH is a real hash at cost 10 — of 32 random
// bytes that were thrown away, so nothing verifies against it — used to make
// a failed login take the same time whether or not the username exists (a
// login with an unknown user must still pay one bcrypt verification).
const BT_BCRYPT_COST = 10;
const BT_DUMMY_HASH = '$2y$10$erYG9hPbTFOBVeshTOw7rOGaXfTirizyX3g3wLUFrekAzA1XyiJbG';

// Key material sizes (bytes) and the PBKDF2 iteration window the client may
// pick from; the client floor is the same 600000 (src/crypto.js KDF_MIN_ITER).
const BT_AUTH_KEY_BYTES = 32;   // HKDF output, b64u 43 chars
const BT_KDF_SALT_BYTES = 16;   // b64u 22 chars
const BT_FDK_WRAPPED_BYTES = 40; // AES-KW of a 32-byte key, b64u 54 chars
const BT_KDF_ITER_MIN = 600000;
const BT_KDF_ITER_MAX = 5000000;
const BT_KDF_ITER_DEFAULT = 600000; // reported for unknown usernames
// Encrypted blobs: at least 29 bytes (version + 12-byte IV + 16-byte GCM tag
// = 39 b64u chars); the profile blob is a 128-byte padded envelope, so its
// cap is generous.
const BT_BLOB_MIN_CHARS = 39;
const BT_PROFILE_BLOB_MAX_CHARS = 4096;

const BT_AUTH_ERR_KEYS = 'Ungültige Schlüsseldaten';
const BT_AUTH_ERR_BLOB = 'Ungültiger Datensatz';

// --- bcrypt on auth keys -----------------------------------------------------

/** Effective bcrypt cost: BABY_BCRYPT_COST env (clamped 4..31) or the pinned default. */
function bt_bcrypt_cost(): int
{
    $env = getenv('BABY_BCRYPT_COST');
    if (is_string($env) && $env !== '' && ctype_digit($env)) {
        return max(4, min(31, (int) $env));
    }
    return BT_BCRYPT_COST;
}

/** Hash an auth key (b64u, 43 chars — well under bcrypt's 72-byte limit) at the effective cost. */
function bt_hash_auth(string $authKey): string
{
    return password_hash($authKey, PASSWORD_BCRYPT, ['cost' => bt_bcrypt_cost()]);
}

/** Burn one bcrypt verification (constant-time login for unknown usernames). */
function bt_dummy_auth_check(string $authKey): void
{
    password_verify($authKey, BT_DUMMY_HASH);
}

// --- base64url + validators (400, German) ------------------------------------

/** base64url without padding (the wire encoding of every byte string). */
function bt_b64u_encode(string $bytes): string
{
    return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
}

/**
 * Strict base64url decode: unpadded, canonical (re-encoding yields the same
 * string, so no stray trailing bits, no '+', '/', '='). Null when not.
 */
function bt_b64u_decode($value): ?string
{
    if (!is_string($value) || $value === '' || strlen($value) % 4 === 1
        || !preg_match('/^[A-Za-z0-9_-]+$/D', $value)
    ) {
        return null;
    }
    $padded = strtr($value, '-_', '+/') . str_repeat('=', (4 - strlen($value) % 4) % 4);
    $bytes = base64_decode($padded, true);
    if ($bytes === false || bt_b64u_encode($bytes) !== $value) {
        return null;
    }
    return $bytes;
}

/**
 * Validated base64url field decoding to EXACTLY $bytes bytes, returned as
 * the wire string (stored verbatim). $label names the field at the call
 * site; the user-facing message is the fixed 'Ungültige Schlüsseldaten'
 * (only a broken client ever sees it).
 */
function bt_valid_b64u($value, int $bytes, string $label): string
{
    $decoded = bt_b64u_decode($value);
    if ($decoded === null || strlen($decoded) !== $bytes) {
        throw new HttpError(400, BT_AUTH_ERR_KEYS, 'auth.badKeyMaterial');
    }
    return $value;
}

/** Validated auth key: 32 bytes (400 otherwise). */
function bt_valid_auth_key($value): string
{
    return bt_valid_b64u($value, BT_AUTH_KEY_BYTES, 'authKey');
}

/** Validated wrapped FDK: 40 bytes (400 otherwise). */
function bt_valid_wrapped($value): string
{
    return bt_valid_b64u($value, BT_FDK_WRAPPED_BYTES, 'fdkWrapped');
}

/** Validated KDF parameters {salt (16 bytes), iter (int 600000..5000000)} -> ['salt' => string, 'iter' => int]. */
function bt_valid_kdf($value): array
{
    if (!is_array($value)) {
        throw new HttpError(400, BT_AUTH_ERR_KEYS, 'auth.badKeyMaterial');
    }
    $salt = bt_valid_b64u($value['salt'] ?? null, BT_KDF_SALT_BYTES, 'kdf.salt');
    $iter = $value['iter'] ?? null;
    if (!is_int($iter) || $iter < BT_KDF_ITER_MIN || $iter > BT_KDF_ITER_MAX) {
        throw new HttpError(400, BT_AUTH_ERR_KEYS, 'auth.badKeyMaterial');
    }
    return ['salt' => $salt, 'iter' => $iter];
}

/**
 * Validated opaque encrypted blob (profile): strict base64url, at least one
 * empty GCM envelope (29 bytes) and at most $maxChars characters — the
 * server never looks inside. Null passes only when $nullable.
 */
function bt_valid_blob_field($value, int $maxChars, bool $nullable): ?string
{
    if ($value === null && $nullable) {
        return null;
    }
    if (!is_string($value) || strlen($value) < BT_BLOB_MIN_CHARS || strlen($value) > $maxChars
        || bt_b64u_decode($value) === null
    ) {
        throw new HttpError(400, BT_AUTH_ERR_BLOB, 'request.badBlob');
    }
    return $value;
}

/**
 * Case-folded lookup key of a family name: whitespace collapsed, trimmed,
 * lowercased with full Unicode support (SQLite's NOCASE is ASCII-only, so
 * 'MÜLLER' and 'müller' would otherwise be two families).
 */
function bt_name_key(string $s): string
{
    // preg_replace returns null on invalid UTF-8 -> '' (never matches, never throws).
    return mb_strtolower(trim((string) preg_replace('/\s+/u', ' ', $s)), 'UTF-8');
}

/** Validated username: trimmed, lowercased, /^[a-z0-9._-]{2,30}$/ (400 otherwise). */
function bt_valid_username($value): string
{
    $name = is_string($value) ? strtolower(trim($value)) : '';
    if (!preg_match('/^[a-z0-9._-]{2,30}$/D', $name)) {
        throw new HttpError(
            400,
            'Benutzername: 2–30 Zeichen – Buchstaben, Ziffern, Punkt, Strich oder Unterstrich',
            'auth.badUsername',
            ['min' => 2, 'max' => 30]
        );
    }
    return $name;
}

/** Trim + collapse whitespace; '' when not a string (or invalid UTF-8). */
function bt_clean_name($value): string
{
    if (!is_string($value)) {
        return '';
    }
    return trim((string) preg_replace('/\s+/u', ' ', $value));
}

/** Validated family name (stored as typed): 1–40 characters (400 otherwise). */
function bt_valid_family_name($value): string
{
    $name = bt_clean_name($value);
    if ($name === '' || mb_strlen($name, 'UTF-8') > 40) {
        throw new HttpError(400, 'Familienname: 1–40 Zeichen', 'auth.badFamilyName', ['min' => 1, 'max' => 40]);
    }
    return $name;
}

// --- settings ----------------------------------------------------------------

/** settings.value for $key, or null when the row is missing. */
function bt_setting(PDO $pdo, string $key): ?string
{
    $stmt = $pdo->prepare('SELECT value FROM settings WHERE key = ?');
    $stmt->execute([$key]);
    $value = $stmt->fetchColumn();
    return ($value === false || $value === null) ? null : (string) $value;
}

/** The per-install secret behind the fake KDF salts (settings.salt_secret, hex), as bytes. */
function bt_salt_secret(PDO $pdo): string
{
    $hex = bt_setting($pdo, 'salt_secret');
    if ($hex === null || strlen($hex) < 32 || strlen($hex) % 2 !== 0 || !ctype_xdigit($hex)) {
        throw new RuntimeException('settings.salt_secret is missing or malformed');
    }
    return (string) hex2bin($hex);
}

// --- transactions ------------------------------------------------------------

/** Run $fn inside BEGIN IMMEDIATE; commit on return, roll back and rethrow on any throwable. */
function bt_auth_txn(PDO $pdo, callable $fn)
{
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $result = $fn();
        $pdo->exec('COMMIT');
        return $result;
    } catch (Throwable $e) {
        try {
            $pdo->exec('ROLLBACK');
        } catch (Throwable $ignored) {
            // Nothing to roll back.
        }
        throw $e;
    }
}

// --- cookie + tokens ---------------------------------------------------------

/** Best-effort HTTPS detection (direct or behind a reverse proxy). */
function bt_is_https(): bool
{
    if (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== '' && $_SERVER['HTTPS'] !== 'off') {
        return true;
    }
    return ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';
}

/**
 * Cookie path = the app's base path ("/" at the domain root, "/baby/" under a
 * subdirectory), derived from the request path up to its /api segment.
 */
function bt_cookie_path(): string
{
    $uri = $_SERVER['REQUEST_URI'] ?? '/';
    if (!is_string($uri) || $uri === '') {
        return '/';
    }
    $qPos = strpos($uri, '?');
    $path = $qPos === false ? $uri : substr($uri, 0, $qPos);
    $apiPos = strpos($path, '/api/');
    if ($apiPos === false && substr($path, -4) === '/api') {
        $apiPos = strlen($path) - 4;
    }
    if ($apiPos === false) {
        return '/';
    }
    $base = substr($path, 0, $apiPos + 1); // keep the trailing slash
    return $base === '' ? '/' : $base;
}

function bt_hash_token(string $token): string
{
    return hash('sha256', $token);
}

function bt_send_auth_cookie(string $value, int $expires): void
{
    setcookie(BT_COOKIE, $value, [
        'expires' => $expires,
        'path' => bt_cookie_path(),
        'httponly' => true,
        'samesite' => 'Lax',
        'secure' => bt_is_https(),
    ]);
}

/** The presented cookie token's hash, or '' without a cookie. */
function bt_current_token_hash(): string
{
    $token = $_COOKIE[BT_COOKIE] ?? null;
    return (is_string($token) && $token !== '') ? bt_hash_token($token) : '';
}

/**
 * Create a fresh token row for the user and return the raw token (cookie
 * sent separately). created_at is a DATE (day granularity — the file leaks
 * no login times), expires_at stays a full datetime for the sliding renewal.
 */
function bt_create_token(PDO $pdo, int $userId): string
{
    $token = bin2hex(random_bytes(32));
    $pdo->prepare(
        "INSERT INTO auth_tokens (user_id, token_hash, created_at, expires_at)
         VALUES (?, ?, date('now'), datetime('now', '+' || ? || ' seconds'))"
    )->execute([$userId, bt_hash_token($token), BT_TOKEN_TTL_SECONDS]);
    return $token;
}

/** Create a fresh token for the user and set the auth cookie. */
function bt_issue_token(PDO $pdo, int $userId): void
{
    $token = bt_create_token($pdo, $userId);
    bt_send_auth_cookie($token, time() + BT_TOKEN_TTL_SECONDS);
}

/**
 * Internal user shape from a users JOIN families row (u.* + family_name):
 * ['id' => int, 'username' => string, 'familyId' => int,
 *  'familyName' => string, 'profileBlob' => string|null]
 * No key material — see bt_keys_from_row for that.
 */
function bt_user_from_row(array $row): array
{
    return [
        'id' => (int) $row['id'],
        'username' => (string) $row['username'],
        'familyId' => (int) $row['family_id'],
        'familyName' => (string) $row['family_name'],
        'profileBlob' => $row['profile_blob'] === null ? null : (string) $row['profile_blob'],
    ];
}

/** ['salt' => string, 'iter' => int] from a users/families row (kdf_salt, kdf_iter). */
function bt_kdf_from_row(array $row): array
{
    return ['salt' => (string) $row['kdf_salt'], 'iter' => (int) $row['kdf_iter']];
}

/** ['kdf' => [...], 'fdkWrapped' => string] from a users/families row. */
function bt_keys_from_row(array $row): array
{
    return ['kdf' => bt_kdf_from_row($row), 'fdkWrapped' => (string) $row['fdk_wrapped']];
}

/** The user owning a live (unexpired) token, or null. One query. */
function bt_user_for_token(PDO $pdo, string $token): ?array
{
    $stmt = $pdo->prepare(
        "SELECT u.id, u.username, u.family_id, u.profile_blob, f.name AS family_name
         FROM auth_tokens t
         JOIN users u ON u.id = t.user_id
         JOIN families f ON f.id = u.family_id
         WHERE t.token_hash = ? AND t.expires_at >= datetime('now')"
    );
    $stmt->execute([bt_hash_token($token)]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row === false ? null : bt_user_from_row($row);
}

/** Delete the presented token (if any) and clear the cookie. */
function bt_revoke_current_token(PDO $pdo): void
{
    $hash = bt_current_token_hash();
    if ($hash !== '') {
        $pdo->prepare('DELETE FROM auth_tokens WHERE token_hash = ?')->execute([$hash]);
    }
    bt_send_auth_cookie('', time() - 86400);
}

/** Drop expired tokens and day-old throttle rows (called on login/register; keeps both tables tiny). */
function bt_gc_tokens(PDO $pdo): void
{
    $pdo->exec("DELETE FROM auth_tokens WHERE expires_at < datetime('now')");
    $pdo->exec("DELETE FROM login_attempts WHERE window_start < datetime('now', '-1 day')");
}

/**
 * Sliding expiry: a token used while under half its TTL remains gets extended
 * back to the full TTL (and the cookie re-sent). Without this, both parents
 * hit a hard password prompt exactly 180 days after their one login — inside
 * the usage year of a newborn tracker. At most one UPDATE per ~90 days.
 */
function bt_renew_token_if_stale(PDO $pdo, string $token): void
{
    $stmt = $pdo->prepare(
        "UPDATE auth_tokens
         SET expires_at = datetime('now', '+' || ? || ' seconds')
         WHERE token_hash = ? AND expires_at < datetime('now', '+' || ? || ' seconds')"
    );
    $stmt->execute([BT_TOKEN_TTL_SECONDS, bt_hash_token($token), intdiv(BT_TOKEN_TTL_SECONDS, 2)]);
    if ($stmt->rowCount() > 0 && !headers_sent()) {
        bt_send_auth_cookie($token, time() + BT_TOKEN_TTL_SECONDS);
    }
}

/** The logged-in user from the auth cookie (renewing a stale token), or null. Never key material. */
function bt_current_user(PDO $pdo): ?array
{
    $token = $_COOKIE[BT_COOKIE] ?? null;
    if (!is_string($token) || $token === '') {
        return null;
    }
    $user = bt_user_for_token($pdo, $token);
    if ($user === null) {
        return null;
    }
    bt_renew_token_if_stale($pdo, $token);
    return $user;
}

/** The logged-in user, or 401. */
function bt_require_auth(PDO $pdo): array
{
    $user = bt_current_user($pdo);
    if ($user === null) {
        throw new HttpError(401, 'Nicht angemeldet', 'auth.notLoggedIn');
    }
    return $user;
}

/** Public JSON shape of a user: {username, familyId, familyName, profileBlob} — no hashes, no keys. */
function bt_user_json(array $user): array
{
    return [
        'username' => $user['username'],
        'familyId' => $user['familyId'],
        'familyName' => $user['familyName'],
        'profileBlob' => $user['profileBlob'],
    ];
}

// --- KDF parameters + login --------------------------------------------------

/**
 * ['salt' => b64u 22, 'iter' => int] the client needs to derive its keys for
 * $username: the stored values for a known user, otherwise a STABLE fake —
 * HMAC(settings.salt_secret, 'salt:<name>') truncated to 16 bytes, at the
 * default iteration count — so the endpoint answers identically shaped, repeatable
 * values for every name and reveals nothing about which accounts exist.
 */
function bt_auth_params(PDO $pdo, $username): array
{
    $name = is_string($username) ? strtolower(trim($username)) : '';
    $stmt = $pdo->prepare('SELECT kdf_salt, kdf_iter FROM users WHERE username = ?');
    $stmt->execute([$name]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if ($row !== false) {
        return bt_kdf_from_row($row);
    }
    $mac = hash_hmac('sha256', 'salt:' . $name, bt_salt_secret($pdo), true);
    return ['salt' => bt_b64u_encode(substr($mac, 0, BT_KDF_SALT_BYTES)), 'iter' => BT_KDF_ITER_DEFAULT];
}

/**
 * Verify username + auth key; on success the user array PLUS
 * 'kdf' => ['salt', 'iter'] and 'fdkWrapped' (the member's own wrapping —
 * this is the login response's key material), null on failure. Unknown
 * usernames pay one dummy bcrypt verification so the response time does not
 * reveal whether the name exists. 400 when either value is missing or the
 * auth key is malformed.
 */
function bt_authenticate(PDO $pdo, $username, $authKey): ?array
{
    if (!is_string($username) || trim($username) === '' || !is_string($authKey) || $authKey === '') {
        throw new HttpError(400, 'Bitte Benutzername und Passwort angeben', 'auth.missingCredentials');
    }
    $authKey = bt_valid_auth_key($authKey);
    $stmt = $pdo->prepare(
        'SELECT u.id, u.username, u.family_id, u.profile_blob, u.auth_hash,
                u.kdf_salt, u.kdf_iter, u.fdk_wrapped, f.name AS family_name
         FROM users u JOIN families f ON f.id = u.family_id
         WHERE u.username = ?'
    );
    $stmt->execute([strtolower(trim($username))]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if ($row === false) {
        bt_dummy_auth_check($authKey);
        return null;
    }
    if (!password_verify($authKey, (string) $row['auth_hash'])) {
        return null;
    }
    return bt_user_from_row($row) + bt_keys_from_row($row);
}

// --- families: lookup + unlock -----------------------------------------------

/** Family row (id, name, auth_hash, recovery_hash, kdf_salt, kdf_iter, fdk_wrapped) by its lookup key, or null. */
function bt_family_by_key(PDO $pdo, string $key): ?array
{
    $stmt = $pdo->prepare(
        'SELECT id, name, auth_hash, recovery_hash, kdf_salt, kdf_iter, fdk_wrapped
         FROM families WHERE name_key = ?'
    );
    $stmt->execute([$key]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row === false ? null : $row;
}

/**
 * ['name' => <stored casing>, 'kdf' => ['salt', 'iter']] when a family with
 * this name exists, else null (also for empty / over-long / non-string
 * input — never an error). Powers the registration form's live "join or
 * create?" hint; the family salt is public by design (a joiner needs it
 * before proving anything).
 */
function bt_family_exists(PDO $pdo, $name): ?array
{
    if (!is_string($name)) {
        return null;
    }
    $key = bt_name_key($name);
    if ($key === '' || mb_strlen($key, 'UTF-8') > 40) {
        return null;
    }
    $family = bt_family_by_key($pdo, $key);
    return $family === null ? null : ['name' => (string) $family['name'], 'kdf' => bt_kdf_from_row($family)];
}

/**
 * The family credential in a body: ['kind' => 'family', 'key' => authKey]
 * from familyAuthKey, else ['kind' => 'recovery', ...] from recoveryAuthKey
 * (400 when neither is present or the value is malformed).
 */
function bt_family_credential(array $body): array
{
    if (isset($body['familyAuthKey'])) {
        return ['kind' => 'family', 'key' => bt_valid_auth_key($body['familyAuthKey'])];
    }
    if (isset($body['recoveryAuthKey'])) {
        return ['kind' => 'recovery', 'key' => bt_valid_auth_key($body['recoveryAuthKey'])];
    }
    throw new HttpError(400, 'Bitte Familien-Passwort oder Wiederherstellungscode angeben', 'auth.missingFamilyCredential');
}

/** bcrypt-verify a credential (see bt_family_credential) against the family row; 403 otherwise. */
function bt_verify_family_credential(array $family, array $cred): void
{
    if ($cred['kind'] === 'family') {
        if (!password_verify($cred['key'], (string) $family['auth_hash'])) {
            throw new HttpError(403, 'Falsches Familien-Passwort', 'auth.badFamilyPassword');
        }
        return;
    }
    if (!password_verify($cred['key'], (string) $family['recovery_hash'])) {
        throw new HttpError(403, 'Ungültiger Wiederherstellungscode', 'auth.badRecoveryCode');
    }
}

/**
 * Hand out the family-wrapped FDK from {familyName, familyAuthKey} or
 * {familyName, recoveryAuthKey}: ['familyId' => int, 'kdf' => ['salt',
 * 'iter'], 'fdkWrapped' => string]. 404 unknown family, 403 'Falsches
 * Familien-Passwort' / 'Ungültiger Wiederherstellungscode' (index.php counts
 * the 403 against the 'reg:' throttle key). This is the ONLY path to the
 * family wrapping — never a cookie.
 */
function bt_family_unlock(PDO $pdo, array $body): array
{
    $name = bt_valid_family_name($body['familyName'] ?? null);
    $cred = bt_family_credential($body);
    $family = bt_family_by_key($pdo, bt_name_key($name));
    if ($family === null) {
        throw new HttpError(404, 'Familie nicht gefunden – bitte Namen prüfen', 'auth.familyUnknown');
    }
    bt_verify_family_credential($family, $cred);
    return ['familyId' => (int) $family['id']] + bt_keys_from_row($family);
}

// --- registration ------------------------------------------------------------

/** Map UNIQUE-constraint failures raised inside bt_register to 409s; rethrow anything else. */
function bt_rethrow_register_conflict(PDOException $e): void
{
    $msg = $e->getMessage();
    if (strpos($msg, 'UNIQUE constraint failed') !== false) {
        if (strpos($msg, 'users.username') !== false) {
            throw new HttpError(409, 'Dieser Benutzername ist bereits vergeben', 'auth.usernameTaken');
        }
        if (strpos($msg, 'families.name_key') !== false) {
            throw new HttpError(409, 'Familie wurde gerade angelegt – bitte nochmals versuchen', 'auth.familyExists');
        }
    }
    throw $e;
}

/**
 * The validated registration fields (400 on the first bad one, no DB
 * access), as an assoc array:
 *   username, authKey, kdf ['salt','iter'], profileBlob, familyName,
 *   familyMode ('create'|'join'), fdkWrappedUser,
 *   create only: familyAuthKey, familyKdf, fdkWrappedFamily, recoveryAuthKey
 *   join only:   familyAuthKey OR recoveryAuthKey (the other one null), and
 *                rotateFamily (null, or the validated {familyAuthKey,
 *                familyKdf, fdkWrappedFamily} the family gets the moment the
 *                join commits — see bt_register)
 * Exposed so index.php can validate BEFORE counting the attempt against the
 * throttle: typos stay free, everything that reaches bcrypt/the DB is counted.
 */
function bt_validate_registration(array $body): array
{
    $mode = $body['familyMode'] ?? null;
    if ($mode !== 'create' && $mode !== 'join') {
        throw new HttpError(400, 'Ungültige Anfrage', 'auth.badFamilyMode');
    }
    $reg = [
        'username' => bt_valid_username($body['username'] ?? null),
        'authKey' => bt_valid_auth_key($body['authKey'] ?? null),
        'kdf' => bt_valid_kdf($body['kdf'] ?? null),
        'profileBlob' => bt_valid_blob_field($body['profileBlob'] ?? null, BT_PROFILE_BLOB_MAX_CHARS, false),
        'familyName' => bt_valid_family_name($body['familyName'] ?? null),
        'familyMode' => $mode,
        'fdkWrappedUser' => bt_valid_wrapped($body['fdkWrappedUser'] ?? null),
        'familyAuthKey' => null,
        'recoveryAuthKey' => null,
        'familyKdf' => null,
        'fdkWrappedFamily' => null,
        'rotateFamily' => null,
    ];
    if ($mode === 'create') {
        $reg['familyAuthKey'] = bt_valid_auth_key($body['familyAuthKey'] ?? null);
        $reg['familyKdf'] = bt_valid_kdf($body['familyKdf'] ?? null);
        $reg['fdkWrappedFamily'] = bt_valid_wrapped($body['fdkWrappedFamily'] ?? null);
        $reg['recoveryAuthKey'] = bt_valid_auth_key($body['recoveryAuthKey'] ?? null);
    } else {
        $cred = bt_family_credential($body);
        $reg[$cred['kind'] === 'family' ? 'familyAuthKey' : 'recoveryAuthKey'] = $cred['key'];
        $rotate = $body['rotateFamily'] ?? null;
        if ($rotate !== null) {
            if (!is_array($rotate)) {
                throw new HttpError(400, BT_AUTH_ERR_KEYS, 'auth.badKeyMaterial');
            }
            $reg['rotateFamily'] = [
                'familyAuthKey' => bt_valid_auth_key($rotate['familyAuthKey'] ?? null),
                'familyKdf' => bt_valid_kdf($rotate['familyKdf'] ?? null),
                'fdkWrappedFamily' => bt_valid_wrapped($rotate['fdkWrappedFamily'] ?? null),
            ];
        }
    }
    return $reg;
}

/**
 * Create an account from a request body (see bt_validate_registration for
 * the fields):
 *   familyMode 'create' — the family must NOT exist (409 'Familie wurde
 *     gerade angelegt …' otherwise; the form re-checks and switches to
 *     join). Stores bcrypt(familyAuthKey), bcrypt(recoveryAuthKey), the
 *     family KDF parameters and the family-wrapped FDK.
 *   familyMode 'join' — the family must exist (404) and familyAuthKey or
 *     recoveryAuthKey must verify (403), exactly as in bt_family_unlock.
 *     With `rotateFamily` ({familyAuthKey, familyKdf, fdkWrappedFamily}) the
 *     family's auth hash, KDF parameters and wrapping are REPLACED in the
 *     same transaction: the password that let this member in stops working
 *     the moment the join commits. The client sends credentials nobody can
 *     type (random bytes), so the join secret is a one-time invite — a
 *     guessable family password exists only between the creation and the
 *     partner's join, and the next person is let in by a member setting a
 *     fresh one (bt_update_family_password). Members never need it again:
 *     their own password unlocks every device (bt_authenticate). Without
 *     the field (an older shell) the family stays open.
 * Either way the user row stores bcrypt(authKey), the KDF parameters, the
 * member-wrapped FDK (NOT NULL from birth) and the opaque profile blob.
 *
 * Returns ['user' => [id, username, familyId, familyName, profileBlob],
 *          'familyCreated' => bool, 'familyClosed' => bool (a join that
 *          rotated the family credentials)].
 * Errors: 400 validation, 403, 404, 409 username taken / family created
 * concurrently. The auth cookie is NOT issued here (index.php does).
 *
 * All bcrypt work happens OUTSIDE the write lock; BEGIN IMMEDIATE then
 * serialises concurrent registrations so the username check and the create /
 * join decision are race-free.
 */
function bt_register(PDO $pdo, array $body, ?string $nowIso = null): array
{
    // 1. Validate everything before any DB write or bcrypt work.
    $reg = bt_validate_registration($body);
    $fKey = bt_name_key($reg['familyName']);
    $today = substr($nowIso ?? gmdate('Y-m-d\TH:i:s\Z'), 0, 10);
    $create = $reg['familyMode'] === 'create';
    $cred = null;
    if (!$create) {
        $cred = $reg['familyAuthKey'] !== null
            ? ['kind' => 'family', 'key' => $reg['familyAuthKey']]
            : ['kind' => 'recovery', 'key' => $reg['recoveryAuthKey']];
    }

    // 2. Outside the lock: the create/join precondition (no bcrypt wasted on
    //    a 409/404/403) and the hashes.
    $existing = bt_family_by_key($pdo, $fKey);
    $famHash = null;
    $recHash = null;
    if ($create) {
        if ($existing !== null) {
            throw new HttpError(409, 'Familie wurde gerade angelegt – bitte nochmals versuchen', 'auth.familyExists');
        }
        $famHash = bt_hash_auth($reg['familyAuthKey']);
        $recHash = bt_hash_auth($reg['recoveryAuthKey']);
    } else {
        if ($existing === null) {
            throw new HttpError(404, 'Familie nicht gefunden – bitte Namen prüfen', 'auth.familyUnknown');
        }
        bt_verify_family_credential($existing, $cred);
        if ($reg['rotateFamily'] !== null) {
            $famHash = bt_hash_auth($reg['rotateFamily']['familyAuthKey']);
        }
    }
    $userHash = bt_hash_auth($reg['authKey']);

    // 3. Under the write lock: username, family create-or-join (+ rotation), user.
    try {
        return bt_auth_txn($pdo, function () use (
            $pdo, $reg, $fKey, $today, $create, $cred, $existing, $famHash, $recHash, $userHash
        ) {
            $stmt = $pdo->prepare('SELECT 1 FROM users WHERE username = ?');
            $stmt->execute([$reg['username']]);
            if ($stmt->fetch(PDO::FETCH_ASSOC) !== false) {
                throw new HttpError(409, 'Dieser Benutzername ist bereits vergeben', 'auth.usernameTaken');
            }

            $familyCreated = false;
            $familyClosed = false;
            $family = bt_family_by_key($pdo, $fKey);
            if ($create) {
                if ($family !== null) {
                    throw new HttpError(409, 'Familie wurde gerade angelegt – bitte nochmals versuchen', 'auth.familyExists');
                }
                $pdo->prepare(
                    'INSERT INTO families
                       (name, name_key, auth_hash, kdf_salt, kdf_iter, fdk_wrapped, recovery_hash, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
                )->execute([
                    $reg['familyName'], $fKey, $famHash,
                    $reg['familyKdf']['salt'], $reg['familyKdf']['iter'], $reg['fdkWrappedFamily'],
                    $recHash, $today,
                ]);
                $familyId = (int) $pdo->lastInsertId();
                $familyName = $reg['familyName'];
                $familyCreated = true;
            } else {
                if ($family === null) {
                    // Deleted by hand between step 2 and the lock.
                    throw new HttpError(404, 'Familie nicht gefunden – bitte Namen prüfen', 'auth.familyUnknown');
                }
                // Rotated by the partner between step 2 and the lock: verify again.
                $col = $cred['kind'] === 'family' ? 'auth_hash' : 'recovery_hash';
                if ((string) $family[$col] !== (string) $existing[$col]) {
                    bt_verify_family_credential($family, $cred);
                }
                $familyId = (int) $family['id'];
                $familyName = (string) $family['name']; // stored casing
                if ($reg['rotateFamily'] !== null) {
                    // Close the door behind this member (see the docblock).
                    $rot = $reg['rotateFamily'];
                    $pdo->prepare(
                        'UPDATE families SET auth_hash = ?, kdf_salt = ?, kdf_iter = ?, fdk_wrapped = ? WHERE id = ?'
                    )->execute([$famHash, $rot['familyKdf']['salt'], $rot['familyKdf']['iter'], $rot['fdkWrappedFamily'], $familyId]);
                    $familyClosed = true;
                }
            }

            $pdo->prepare(
                'INSERT INTO users
                   (family_id, username, auth_hash, kdf_salt, kdf_iter, fdk_wrapped, profile_blob, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
            )->execute([
                $familyId, $reg['username'], $userHash,
                $reg['kdf']['salt'], $reg['kdf']['iter'], $reg['fdkWrappedUser'],
                $reg['profileBlob'], $today,
            ]);
            $userId = (int) $pdo->lastInsertId();

            return [
                'user' => [
                    'id' => $userId,
                    'username' => $reg['username'],
                    'familyId' => $familyId,
                    'familyName' => $familyName,
                    'profileBlob' => $reg['profileBlob'],
                ],
                'familyCreated' => $familyCreated,
                'familyClosed' => $familyClosed,
            ];
        });
    } catch (PDOException $e) {
        bt_rethrow_register_conflict($e);
    }
    return []; // unreachable: bt_rethrow_register_conflict always throws
}

// --- own keys + profile + password changes -----------------------------------

/** 403 'Falsches Passwort' unless $authKey verifies against the user's auth_hash. */
function bt_verify_own_auth(PDO $pdo, int $userId, string $authKey): void
{
    $stmt = $pdo->prepare('SELECT auth_hash FROM users WHERE id = ?');
    $stmt->execute([$userId]);
    $hash = $stmt->fetchColumn();
    if ($hash === false || !password_verify($authKey, (string) $hash)) {
        throw new HttpError(403, 'Falsches Passwort', 'auth.badPassword');
    }
}

/** The confirming auth key of a change request (body.currentAuthKey): 400 when missing or malformed. */
function bt_valid_current_auth_key(array $body): string
{
    $current = $body['currentAuthKey'] ?? null;
    if ($current === null || $current === '') {
        throw new HttpError(400, 'Bitte dein Passwort zur Bestätigung angeben', 'auth.missingConfirmation');
    }
    return bt_valid_auth_key($current);
}

/** ['kdf' => ['salt', 'iter'], 'fdkWrapped' => string] of a user (401 when the row is gone). */
function bt_user_keys(PDO $pdo, int $userId): array
{
    $stmt = $pdo->prepare('SELECT kdf_salt, kdf_iter, fdk_wrapped FROM users WHERE id = ?');
    $stmt->execute([$userId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if ($row === false) {
        throw new HttpError(401, 'Nicht angemeldet', 'auth.notLoggedIn');
    }
    return bt_keys_from_row($row);
}

/**
 * bt_user_keys after {authKey} verified (403 'Falsches Passwort'): the
 * re-unlock of a logged-in device whose local key store was evicted. The
 * cookie alone is deliberately not enough; index.php counts the 403.
 */
function bt_unlock_user_keys(PDO $pdo, array $user, array $body): array
{
    $authKey = bt_valid_auth_key($body['authKey'] ?? null);
    bt_verify_own_auth($pdo, (int) $user['id'], $authKey);
    return bt_user_keys($pdo, (int) $user['id']);
}

/** Replace the logged-in user's opaque profile blob from {profileBlob}; returns the refreshed user array. */
function bt_update_profile(PDO $pdo, array $user, array $body): array
{
    $blob = bt_valid_blob_field($body['profileBlob'] ?? null, BT_PROFILE_BLOB_MAX_CHARS, false);
    $pdo->prepare('UPDATE users SET profile_blob = ? WHERE id = ?')->execute([$blob, (int) $user['id']]);
    $user['profileBlob'] = $blob;
    return $user;
}

/**
 * Own password change from {currentAuthKey, authKey, kdf, fdkWrappedUser}:
 * the current auth key confirms (403 'Falsches Passwort'), then auth_hash,
 * KDF parameters and the member-wrapped FDK are replaced together and every
 * OTHER session of the user is revoked (a lost phone stops working; this one
 * keeps its cookie). Entries are untouched — the FDK itself never changes.
 */
function bt_update_password(PDO $pdo, array $user, array $body): void
{
    $current = bt_valid_current_auth_key($body);
    $authKey = bt_valid_auth_key($body['authKey'] ?? null);
    $kdf = bt_valid_kdf($body['kdf'] ?? null);
    $wrapped = bt_valid_wrapped($body['fdkWrappedUser'] ?? null);
    $userId = (int) $user['id'];
    bt_verify_own_auth($pdo, $userId, $current);
    $hash = bt_hash_auth($authKey);
    $keep = bt_current_token_hash();
    bt_auth_txn($pdo, function () use ($pdo, $userId, $hash, $kdf, $wrapped, $keep) {
        $pdo->prepare(
            'UPDATE users SET auth_hash = ?, kdf_salt = ?, kdf_iter = ?, fdk_wrapped = ? WHERE id = ?'
        )->execute([$hash, $kdf['salt'], $kdf['iter'], $wrapped, $userId]);
        $pdo->prepare('DELETE FROM auth_tokens WHERE user_id = ? AND token_hash <> ?')
            ->execute([$userId, $keep]);
    });
}

/**
 * Family password rotation from {currentAuthKey, familyAuthKey, familyKdf,
 * fdkWrappedFamily}: any member may do it — the family password is only ever
 * needed to JOIN, so a member who forgot it hands a fresh one to the next
 * parent; nobody already in the family is affected. The member's OWN auth key
 * confirms (403 'Falsches Passwort'): a phone handed over unlocked must not be
 * enough to lock the family's door. The recovery hash stays (it derives from
 * the FDK, which does not change).
 */
function bt_update_family_password(PDO $pdo, array $user, array $body): void
{
    $current = bt_valid_current_auth_key($body);
    $familyAuthKey = bt_valid_auth_key($body['familyAuthKey'] ?? null);
    $kdf = bt_valid_kdf($body['familyKdf'] ?? null);
    $wrapped = bt_valid_wrapped($body['fdkWrappedFamily'] ?? null);
    bt_verify_own_auth($pdo, (int) $user['id'], $current);
    $pdo->prepare(
        'UPDATE families SET auth_hash = ?, kdf_salt = ?, kdf_iter = ?, fdk_wrapped = ? WHERE id = ?'
    )->execute([bt_hash_auth($familyAuthKey), $kdf['salt'], $kdf['iter'], $wrapped, (int) $user['familyId']]);
}

// --- throttling ----------------------------------------------------------------
//
// One table (login_attempts: key, fails, window_start), several budgets. The
// key names the thing whose attempts are counted, and its prefix picks the
// budget (bt_throttle_budget):
//   <ip>                logins and own-password confirmations from that address
//   reg:<ip>            registrations and family unlocks from that address
//   user:<username>     guesses AGAINST one account, from any address
//   family:<name key>   guesses AGAINST one family password, from any address
//   write:<ip>          entry writes from that address
// The address budgets stop one machine; the target budgets stop a guesser
// who rotates addresses (a botnet, an IPv6 /64) against one account or
// family: however many machines join in, a target sees at most
// BT_TARGET_MAX_FAILS attempts per hour. A stranger can burn a target budget
// to lock its owner out for that hour — acceptable for a login that happens
// once per phone (the cookie lasts 180 days) and a join that happens once
// per member. The write budget bounds what one address can make the server
// store or churn per window (with the row caps of lib/entries.php). The
// prefixes are letters no IP address can start with, so a raw address key
// never picks a target budget by accident.

const BT_LOGIN_MAX_FAILS = 10;
const BT_LOGIN_WINDOW_SECONDS = 900;
const BT_TARGET_MAX_FAILS = 20;
const BT_TARGET_WINDOW_SECONDS = 3600;
const BT_WRITE_MAX_PER_WINDOW = 300;
const BT_WRITE_WINDOW_SECONDS = 900;

/** Throttle key of guesses against one account (the lowercased username, capped so junk cannot bloat the table). */
function bt_user_throttle_key(string $username): string
{
    return 'user:' . substr(strtolower(trim($username)), 0, 64);
}

/** Throttle key of guesses against one family password (its name key, see bt_name_key). */
function bt_family_throttle_key(string $nameKey): string
{
    return 'family:' . substr($nameKey, 0, 64);
}

/** Throttle key of entry writes from an address. */
function bt_write_throttle_key(string $ip): string
{
    return 'write:' . $ip;
}

/** [max attempts, window seconds] of a throttle key, by its prefix (see the section comment). */
function bt_throttle_budget(string $key): array
{
    if (strpos($key, 'user:') === 0 || strpos($key, 'family:') === 0) {
        return [BT_TARGET_MAX_FAILS, BT_TARGET_WINDOW_SECONDS];
    }
    if (strpos($key, 'write:') === 0) {
        return [BT_WRITE_MAX_PER_WINDOW, BT_WRITE_WINDOW_SECONDS];
    }
    return [BT_LOGIN_MAX_FAILS, BT_LOGIN_WINDOW_SECONDS];
}

/** 429 when this key has burned its attempt budget for its window. */
function bt_assert_login_allowed(PDO $pdo, string $key): void
{
    list($max, $window) = bt_throttle_budget($key);
    $stmt = $pdo->prepare(
        "SELECT fails FROM login_attempts
         WHERE ip = ? AND window_start >= datetime('now', '-' || ? || ' seconds')"
    );
    $stmt->execute([$key, $window]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if ($row !== false && (int) $row['fails'] >= $max) {
        throw new HttpError(
            429,
            'Zu viele Versuche – bitte später nochmals probieren',
            'auth.throttled',
            ['minutes' => (int) ceil($window / 60)]
        );
    }
}

/** Count an attempt against a key; a lapsed window restarts instead of accumulating. */
function bt_record_login_failure(PDO $pdo, string $key): void
{
    list(, $window) = bt_throttle_budget($key);
    $pdo->prepare(
        "INSERT INTO login_attempts (ip, fails, window_start) VALUES (?, 1, datetime('now'))
         ON CONFLICT(ip) DO UPDATE SET
           fails = CASE WHEN window_start < datetime('now', '-' || ? || ' seconds')
                        THEN 1 ELSE fails + 1 END,
           window_start = CASE WHEN window_start < datetime('now', '-' || ? || ' seconds')
                               THEN datetime('now') ELSE window_start END"
    )->execute([$key, $window, $window]);
}

/**
 * The write budget of an address: 429 'Zu viele Änderungen …' once it is
 * used up (its own text — the caller is a logged-in phone, not a guesser),
 * else the write is counted. Every entries mutation goes through here first.
 */
function bt_charge_write(PDO $pdo, string $ip): void
{
    $key = bt_write_throttle_key($ip);
    try {
        bt_assert_login_allowed($pdo, $key);
    } catch (HttpError $e) {
        throw new HttpError(
            429,
            'Zu viele Änderungen in kurzer Zeit – bitte später nochmals versuchen',
            'request.writeBudget',
            ['minutes' => (int) ceil(BT_WRITE_WINDOW_SECONDS / 60)]
        );
    }
    bt_record_login_failure($pdo, $key);
}

/**
 * Clear a key's attempt budget. Nothing calls it on a successful login, on
 * purpose: with open registration a guesser could reset the budget by
 * logging into an account of their own.
 */
function bt_clear_login_failures(PDO $pdo, string $ip): void
{
    $pdo->prepare('DELETE FROM login_attempts WHERE ip = ?')->execute([$ip]);
}
