<?php
/**
 * Devices («Analog-Buttons»): physical buttons — a microcontroller next to the
 * changing table (arduino/ in the repository) — that log an entry without
 * anyone picking up a phone, end-to-end encrypted like everything else.
 *
 * The server never sees what a press means. A device holds two secrets a
 * member's phone made for it (Mehr › Einstellungen › Analog-Buttons, one code to
 * paste into the sketch):
 *   token   16 random bytes made HERE on registration and handed out once;
 *           stored as its sha256 (`devices.token_hash`, like a session
 *           token) — the device's credential for POST /api/devices/events
 *   key     32 random bytes the PHONE made and never sent: the device seals
 *           every press with it (AES-256-GCM, src/crypto.js sealPress)
 * The key travels to the family's other phones inside an entry of type
 * `device` (encrypted under the family data key), never through here.
 *
 * A press is ONE opaque row in `device_events` (lib/db.php): the device id,
 * the family, the sealed blob and a day-granular date — no column for what
 * was pressed or when (the instant is inside the blob). Every sync page of
 * the family carries the pending presses (`deviceEvents`); the first phone
 * that syncs opens them with the device's key, writes the real entries
 * through the normal path and deletes the presses (DELETE
 * /api/devices/events/:id). The row is a mailbox, not a record: it lives
 * for about one sync.
 *
 * POST /api/devices/events is the one route a device calls: no cookie, the
 * token in the body, answered BEFORE the auth gate (index.php). An unknown
 * token is a plain 404 (a removed device learns it this way). Throttled per
 * address ('dev:<ip>', auth.php bt_charge_device, before validation) and
 * capped per family (BT_DEVICE_MAX_PENDING open presses → 507: a stuck
 * button while nobody opens the app cannot grow the file).
 *
 * Mutators take an optional $today ('YYYY-MM-DD') so tests are deterministic.
 *
 * Target: PHP 7.4+.
 */

require_once __DIR__ . '/http.php';

// The token: 16 random bytes, 32 lowercase hex on the wire.
const BT_DEVICE_TOKEN_BYTES = 16;

// Envelope of a sealed press: 1 version byte (0x03) + 12 IV + the padded
// plaintext (128 bytes on the device, src/crypto.js DEVICE_BUCKETS) + 16
// GCM tag. The maximum leaves room for a longer bucket.
const BT_DEVICE_BLOB_VERSION = 3;
const BT_DEVICE_BLOB_MIN_BYTES = 29;
const BT_DEVICE_BLOB_MAX_BYTES = 1024;

// Caps: a family has a handful of buttons, and a press waits about one sync.
const BT_DEVICE_MAX_PER_FAMILY = 10;
const BT_DEVICE_MAX_PENDING = 200;

// Pending presses per sync page, oldest first (the rest come on the next page).
const BT_DEVICE_EVENTS_PAGE = 50;

/** sha256 of a token: what the table stores, never the token itself. */
function bt_device_token_hash(string $token): string
{
    return hash('sha256', $token);
}

/** Validated token from a press: exactly 32 lowercase hex characters. */
function bt_valid_device_token($value): string
{
    if (!is_string($value) || !preg_match('/^[0-9a-f]{32}$/D', $value)) {
        throw new HttpError(400, 'Ungültiger Knopf-Code', 'devices.badToken');
    }
    return $value;
}

/**
 * Validated sealed press: canonical base64url, version byte 0x03,
 * 29..1024 bytes. Returned verbatim; the server stores the string.
 */
function bt_valid_device_blob($value): string
{
    if (!is_string($value) || strlen($value) > (int) ceil(BT_DEVICE_BLOB_MAX_BYTES * 4 / 3) + 2 || !preg_match('/^[A-Za-z0-9_-]+$/D', $value)) {
        throw new HttpError(400, 'Ungültiger Datensatz', 'request.badBlob');
    }
    $bytes = base64_decode(strtr($value, '-_', '+/'), true);
    if ($bytes === false || rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=') !== $value) {
        throw new HttpError(400, 'Ungültiger Datensatz', 'request.badBlob');
    }
    $len = strlen($bytes);
    if ($len < BT_DEVICE_BLOB_MIN_BYTES || $len > BT_DEVICE_BLOB_MAX_BYTES || ord($bytes[0]) !== BT_DEVICE_BLOB_VERSION) {
        throw new HttpError(400, 'Ungültiger Datensatz', 'request.badBlob');
    }
    return $value;
}

/** Validated device id from the path: a positive integer, else the same 404 as an unknown one. */
function bt_valid_device_id(string $value): int
{
    if (!preg_match('/^[1-9]\d{0,14}$/D', $value)) {
        throw new HttpError(404, 'Knopf nicht gefunden', 'devices.notFound');
    }
    return (int) $value;
}

/** Validated press id from the path: a positive integer, else the same 404 as an unknown one. */
function bt_valid_device_event_id(string $value): int
{
    if (!preg_match('/^[1-9]\d{0,14}$/D', $value)) {
        throw new HttpError(404, 'Knopfdruck nicht gefunden', 'devices.eventNotFound');
    }
    return (int) $value;
}

/**
 * Register a device for $familyId: {id, token, createdAt} — the token is
 * shown ONCE (the phone keeps it inside the device entry; the table holds
 * only its hash). 507 at BT_DEVICE_MAX_PER_FAMILY.
 */
function bt_device_create(PDO $pdo, int $familyId, ?string $today = null): array
{
    $day = $today ?? bt_today();
    $token = bin2hex(random_bytes(BT_DEVICE_TOKEN_BYTES));
    $id = bt_write_txn($pdo, function () use ($pdo, $familyId, $token, $day) {
        $stmt = $pdo->prepare('SELECT COUNT(*) FROM devices WHERE family_id = ?');
        $stmt->execute([$familyId]);
        if ((int) $stmt->fetchColumn() >= BT_DEVICE_MAX_PER_FAMILY) {
            throw new HttpError(507, 'Zu viele Knöpfe – bitte zuerst einen entfernen', 'devices.tooMany', ['max' => BT_DEVICE_MAX_PER_FAMILY]);
        }
        $pdo->prepare('INSERT INTO devices (family_id, token_hash, created_at) VALUES (?, ?, ?)')
            ->execute([$familyId, bt_device_token_hash($token), $day]);
        return (int) $pdo->lastInsertId();
    });
    return ['id' => $id, 'token' => $token, 'createdAt' => $day];
}

/**
 * Remove a device of $familyId and every press it still has waiting: its
 * token stops working at once (the device gets 404 from then on). 404 when
 * the id is unknown or belongs to another family.
 */
function bt_device_delete(PDO $pdo, int $familyId, int $id): array
{
    bt_write_txn($pdo, function () use ($pdo, $familyId, $id) {
        $stmt = $pdo->prepare('DELETE FROM devices WHERE id = ? AND family_id = ?');
        $stmt->execute([$id, $familyId]);
        if ($stmt->rowCount() === 0) {
            throw new HttpError(404, 'Knopf nicht gefunden', 'devices.notFound');
        }
        $pdo->prepare('DELETE FROM device_events WHERE device_id = ? AND family_id = ?')->execute([$id, $familyId]);
    });
    return ['ok' => true];
}

/**
 * A press from a device: {token, blob} → the sealed blob is stored for the
 * device's family. 404 for a token nobody registered (or a removed
 * device), 507 once the family has BT_DEVICE_MAX_PENDING presses waiting.
 */
function bt_device_press(PDO $pdo, array $body, ?string $today = null): array
{
    $token = bt_valid_device_token($body['token'] ?? null);
    $blob = bt_valid_device_blob($body['blob'] ?? null);
    $day = $today ?? bt_today();
    bt_write_txn($pdo, function () use ($pdo, $token, $blob, $day) {
        $stmt = $pdo->prepare('SELECT id, family_id FROM devices WHERE token_hash = ?');
        $stmt->execute([bt_device_token_hash($token)]);
        $device = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($device === false) {
            throw new HttpError(404, 'Knopf nicht gefunden', 'devices.notFound');
        }
        $familyId = (int) $device['family_id'];
        $stmt = $pdo->prepare('SELECT COUNT(*) FROM device_events WHERE family_id = ?');
        $stmt->execute([$familyId]);
        if ((int) $stmt->fetchColumn() >= BT_DEVICE_MAX_PENDING) {
            throw new HttpError(507, 'Zu viele unverarbeitete Knopfdrücke – bitte die App öffnen', 'devices.full');
        }
        $pdo->prepare('INSERT INTO device_events (device_id, family_id, blob, created_at) VALUES (?, ?, ?, ?)')
            ->execute([(int) $device['id'], $familyId, $blob, $day]);
    });
    return ['ok' => true];
}

/** Row JSON of a press: {id, device, blob, createdAt}. */
function bt_device_event_json(array $row): array
{
    return [
        'id' => (int) $row['id'],
        'device' => (int) $row['device_id'],
        'blob' => (string) $row['blob'],
        'createdAt' => (string) $row['created_at'],
    ];
}

/** The family's presses waiting to become entries, oldest first, at most $limit. */
function bt_device_events_pending(PDO $pdo, int $familyId, int $limit = BT_DEVICE_EVENTS_PAGE): array
{
    $stmt = $pdo->prepare('SELECT id, device_id, blob, created_at FROM device_events WHERE family_id = ? ORDER BY id LIMIT ?');
    $stmt->bindValue(1, $familyId, PDO::PARAM_INT);
    $stmt->bindValue(2, max(1, $limit), PDO::PARAM_INT);
    $stmt->execute();
    return array_map('bt_device_event_json', $stmt->fetchAll(PDO::FETCH_ASSOC));
}

/**
 * A phone has turned a press into an entry (or found it unreadable): the
 * row goes. 404 when it is gone already — the other phone was first — or
 * belongs to another family.
 */
function bt_device_event_delete(PDO $pdo, int $familyId, int $id): array
{
    $stmt = $pdo->prepare('DELETE FROM device_events WHERE id = ? AND family_id = ?');
    $stmt->execute([$id, $familyId]);
    if ($stmt->rowCount() === 0) {
        throw new HttpError(404, 'Knopfdruck nicht gefunden', 'devices.eventNotFound');
    }
    return ['ok' => true];
}
