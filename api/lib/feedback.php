<?php
/**
 * Feedback: messages from the parents to the operator of this installation
 * (a wish, a bug, anything), end-to-end encrypted like everything else.
 *
 * The operator is ONE account, named by config 'admin_username' (packaging
 * takes it from ADMIN_USERNAME in .env; null/'' = feature off). There is no
 * role column: the config is the only place that says who reads.
 *
 * The inbox key: the operator's phone makes an ECDH P-256 key pair (the
 * first time the inbox is opened) and stores it here as two settings rows —
 *   feedback_pub   the public key as a JWK {kty, crv, x, y}, handed to every
 *                  member who wants to write
 *   feedback_priv  the private key, AES-GCM-sealed under the operator's
 *                  Family Data Key (an opaque blob, only the operator gets it)
 * A phone seals each message to feedback_pub (src/crypto.js sealFeedback:
 * a throwaway ECDH key, HKDF, AES-GCM), so the server stores a blob it
 * cannot open, like an entry.
 *
 * The table (lib/db.php) has no sender column. A named message carries the
 * name INSIDE the blob; an anonymous one carries none, and the rows look the
 * same. The send request itself is authenticated (a member's cookie, like
 * every write) and throttled per ADDRESS only ('fb:<ip>'): a per-account
 * counter would write the link this table leaves out.
 *
 * Everyone but the operator gets the same 404 from the inbox routes, and
 * with the feature off everything here is a 404 (feedback.unavailable).
 *
 * Mutators take an optional $today ('YYYY-MM-DD') so tests are deterministic.
 *
 * Target: PHP 7.4+.
 */

require_once __DIR__ . '/http.php';

// Envelope of a sealed message: 1 version byte (0x02) + the throwaway public
// key (65, uncompressed P-256) + 12 IV + 16 GCM tag around the padded
// plaintext (1024 or 4096 bytes, src/crypto.js FEEDBACK_BUCKETS).
const BT_FEEDBACK_BLOB_VERSION = 2;
const BT_FEEDBACK_BLOB_MIN_BYTES = 94;
const BT_FEEDBACK_BLOB_MAX_BYTES = 4608;

// A few thousand messages is years of a small installation's feedback;
// the cap bounds the file (~12 MB worst case) whatever an account does.
const BT_FEEDBACK_MAX_ROWS = 2000;

// One inbox page: newest first, older ones via ?before=<id>.
const BT_FEEDBACK_PAGE = 100;

/** Is feedback switched on (an operator configured)? */
function bt_feedback_on(array $config): bool
{
    $admin = $config['admin_username'] ?? null;
    return is_string($admin) && trim($admin) !== '';
}

/** Is $user the operator? Usernames are stored lowercased. */
function bt_feedback_is_admin(array $config, array $user): bool
{
    if (!bt_feedback_on($config)) {
        return false;
    }
    return strtolower(trim((string) $config['admin_username'])) === (string) $user['username'];
}

/** 404 unless $user is the operator — the same answer as an unknown route. */
function bt_feedback_assert_admin(array $config, array $user): void
{
    if (!bt_feedback_is_admin($config, $user)) {
        throw new HttpError(404, 'Nicht gefunden', 'request.notFound');
    }
}

/** The stored public key (decoded JWK) or null. */
function bt_feedback_public_key(PDO $pdo): ?array
{
    $raw = bt_setting($pdo, 'feedback_pub');
    $jwk = $raw === null ? null : json_decode($raw, true);
    return is_array($jwk) ? $jwk : null;
}

/** The inbox's public key for a writer; 404 while the feature is off or the operator has not opened the inbox yet. */
function bt_feedback_key_for_writer(PDO $pdo, array $config): array
{
    $jwk = bt_feedback_on($config) ? bt_feedback_public_key($pdo) : null;
    if ($jwk === null) {
        throw new HttpError(404, 'Feedback ist nicht eingerichtet', 'feedback.unavailable');
    }
    return $jwk;
}

/** One base64url coordinate of a P-256 point: exactly 32 bytes. */
function bt_valid_p256_coordinate($value): string
{
    if (!is_string($value) || !preg_match('/^[A-Za-z0-9_-]{43}$/D', $value)) {
        throw new HttpError(400, 'Ungültiger Schlüssel', 'feedback.badKey');
    }
    $bytes = base64_decode(strtr($value, '-_', '+/'), true);
    if ($bytes === false || strlen($bytes) !== 32 || rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=') !== $value) {
        throw new HttpError(400, 'Ungültiger Schlüssel', 'feedback.badKey');
    }
    return $value;
}

/** A public P-256 JWK, reduced to the four fields a public key has (no private part can slip through). */
function bt_valid_public_jwk($value): array
{
    if (!is_array($value) || ($value['kty'] ?? null) !== 'EC' || ($value['crv'] ?? null) !== 'P-256' || array_key_exists('d', $value)) {
        throw new HttpError(400, 'Ungültiger Schlüssel', 'feedback.badKey');
    }
    return [
        'kty' => 'EC',
        'crv' => 'P-256',
        'x' => bt_valid_p256_coordinate($value['x'] ?? null),
        'y' => bt_valid_p256_coordinate($value['y'] ?? null),
    ];
}

/**
 * The operator's phone sets up the inbox: {publicKey, privateSealed}. Once
 * only (409 feedback.keyExists): a new key would orphan every message sealed
 * to the old one. The private half is an entry-style blob (bt_valid_blob).
 */
function bt_feedback_set_key(PDO $pdo, array $body): array
{
    $jwk = bt_valid_public_jwk($body['publicKey'] ?? null);
    $sealed = bt_valid_blob($body['privateSealed'] ?? null);
    return bt_write_txn($pdo, function () use ($pdo, $jwk, $sealed) {
        if (bt_setting($pdo, 'feedback_pub') !== null) {
            throw new HttpError(409, 'Das Postfach ist schon eingerichtet', 'feedback.keyExists');
        }
        $stmt = $pdo->prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
        $stmt->execute(['feedback_pub', json_encode($jwk, JSON_UNESCAPED_SLASHES)]);
        $stmt->execute(['feedback_priv', $sealed]);
        return $jwk;
    });
}

/**
 * Validated sealed message: canonical base64url, version byte 0x02,
 * 94..4608 bytes (longer: 413 — the one error a writer can cause by typing).
 */
function bt_valid_feedback_blob($value): string
{
    if (!is_string($value) || !preg_match('/^[A-Za-z0-9_-]+$/D', $value)) {
        throw new HttpError(400, 'Ungültiger Datensatz', 'request.badBlob');
    }
    if (strlen($value) > (int) ceil(BT_FEEDBACK_BLOB_MAX_BYTES * 4 / 3)) {
        throw new HttpError(413, 'Die Nachricht ist zu lang', 'feedback.tooLarge');
    }
    $bytes = base64_decode(strtr($value, '-_', '+/'), true);
    if ($bytes === false || rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=') !== $value) {
        throw new HttpError(400, 'Ungültiger Datensatz', 'request.badBlob');
    }
    $len = strlen($bytes);
    if ($len > BT_FEEDBACK_BLOB_MAX_BYTES) {
        throw new HttpError(413, 'Die Nachricht ist zu lang', 'feedback.tooLarge');
    }
    if ($len < BT_FEEDBACK_BLOB_MIN_BYTES || ord($bytes[0]) !== BT_FEEDBACK_BLOB_VERSION) {
        throw new HttpError(400, 'Ungültiger Datensatz', 'request.badBlob');
    }
    return $value;
}

/** Store a sealed message {blob}; 507 once the table holds BT_FEEDBACK_MAX_ROWS. */
function bt_feedback_create(PDO $pdo, array $body, ?string $today = null): array
{
    $blob = bt_valid_feedback_blob($body['blob'] ?? null);
    $day = $today ?? bt_today();
    bt_write_txn($pdo, function () use ($pdo, $blob, $day) {
        $count = (int) $pdo->query('SELECT COUNT(*) FROM feedback')->fetchColumn();
        if ($count >= BT_FEEDBACK_MAX_ROWS) {
            throw new HttpError(507, 'Das Postfach ist voll – bitte später nochmals versuchen', 'feedback.full');
        }
        $pdo->prepare('INSERT INTO feedback (blob, created_at) VALUES (?, ?)')->execute([$blob, $day]);
    });
    return ['ok' => true];
}

/** Row JSON of a feedback row. */
function bt_feedback_row_json(array $row): array
{
    return [
        'id' => (int) $row['id'],
        'blob' => (string) $row['blob'],
        'createdAt' => (string) $row['created_at'],
        'readAt' => $row['read_at'] === null ? null : (string) $row['read_at'],
    ];
}

/** Validated message id from the path: a positive integer, else the same 404 as an unknown one. */
function bt_valid_feedback_id(string $value): int
{
    if (!preg_match('/^[1-9]\d{0,14}$/D', $value)) {
        throw new HttpError(404, 'Nachricht nicht gefunden', 'feedback.notFound');
    }
    return (int) $value;
}

/** Unread messages — the operator's sync answer carries it (`feedbackUnread`). */
function bt_feedback_unread(PDO $pdo): int
{
    return (int) $pdo->query('SELECT COUNT(*) FROM feedback WHERE read_at IS NULL')->fetchColumn();
}

/**
 * The operator's inbox: the key pair (public + the sealed private half, null
 * while not set up) and one page of messages, newest first; `next` is the
 * `before` of the next page or null.
 */
function bt_feedback_inbox(PDO $pdo, int $before = 0): array
{
    $sql = 'SELECT id, blob, created_at, read_at FROM feedback'
        . ($before > 0 ? ' WHERE id < ?' : '')
        . ' ORDER BY id DESC LIMIT ' . (BT_FEEDBACK_PAGE + 1);
    $stmt = $pdo->prepare($sql);
    $stmt->execute($before > 0 ? [$before] : []);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $more = count($rows) > BT_FEEDBACK_PAGE;
    $rows = array_slice($rows, 0, BT_FEEDBACK_PAGE);
    return [
        'publicKey' => bt_feedback_public_key($pdo),
        'privateSealed' => bt_setting($pdo, 'feedback_priv'),
        'items' => array_map('bt_feedback_row_json', $rows),
        'next' => $more ? (int) $rows[count($rows) - 1]['id'] : null,
        'unread' => bt_feedback_unread($pdo),
    ];
}

/** One message row or 404. */
function bt_feedback_fetch(PDO $pdo, int $id): array
{
    $stmt = $pdo->prepare('SELECT id, blob, created_at, read_at FROM feedback WHERE id = ?');
    $stmt->execute([$id]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if ($row === false) {
        throw new HttpError(404, 'Nachricht nicht gefunden', 'feedback.notFound');
    }
    return $row;
}

/** Mark a message read or unread: {read: bool}. */
function bt_feedback_set_read(PDO $pdo, int $id, array $body, ?string $today = null): array
{
    $read = $body['read'] ?? null;
    if (!is_bool($read)) {
        throw new HttpError(400, 'Ungültige Angabe', 'feedback.badRead');
    }
    bt_feedback_fetch($pdo, $id);
    $pdo->prepare('UPDATE feedback SET read_at = ? WHERE id = ?')
        ->execute([$read ? ($today ?? bt_today()) : null, $id]);
    return bt_feedback_row_json(bt_feedback_fetch($pdo, $id));
}

/** Delete a message for good (secure_delete is on: the bytes are overwritten). */
function bt_feedback_delete(PDO $pdo, int $id): array
{
    bt_feedback_fetch($pdo, $id);
    $pdo->prepare('DELETE FROM feedback WHERE id = ?')->execute([$id]);
    return ['ok' => true];
}
