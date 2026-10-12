<?php
/**
 * Spots: map places reported by parents in the app («Ort melden» on the
 * «Karte» tab) and curated by the operator — the one account named by config
 * 'admin_username', the same account that reads the feedback (lib/feedback.php
 * says who; there is still no role column). With no operator configured the
 * feature is off: nobody would check what comes in.
 *
 * This is the first table that holds something in the clear beyond what
 * logging in needs: a position, the kind of place (changing table, a place
 * to nurse), a name and a note — public map data, nothing about a baby. The
 * row has NO column for who reported it: like a feedback message, a report
 * is throttled per ADDRESS only ('spot:<ip>', lib/auth.php) and the stored
 * row looks the same whoever sent it. Rejecting and withdrawing delete the
 * row for good.
 *
 * Life of a row: a member's POST stores it 'pending'; the operator's PATCH
 * {approve: true} (with corrections, if any) makes it 'approved', DELETE
 * removes it. Every phone reads the approved rows (GET /api/spots) and lays
 * them over the OpenStreetMap snapshot it ships with; settings.spots_version
 * counts every change to the approved rows and travels on the sync page, so
 * a phone fetches the list only when it changed.
 *
 * Mutators take an optional $today ('YYYY-MM-DD') so tests are deterministic.
 *
 * Target: PHP 7.4+.
 */

require_once __DIR__ . '/http.php';

/** The kinds a place can be reported as (the map's filters); a new kind goes here AND into the app (src/spots.js). */
const BT_SPOT_KINDS = ['changing', 'nursing'];
const BT_SPOT_NAME_MAX = 80;
const BT_SPOT_NOTE_MAX = 300;
// What may pile up unchecked, and the table's bound whatever an account does.
const BT_SPOT_MAX_PENDING = 200;
const BT_SPOT_MAX_ROWS = 5000;

/** Is reporting on (an operator configured to curate)? */
function bt_spots_on(array $config): bool
{
    return bt_feedback_on($config);
}

/** 404 while the feature is off. */
function bt_spots_assert_on(array $config): void
{
    if (!bt_spots_on($config)) {
        throw new HttpError(404, 'Orte melden ist nicht eingerichtet', 'spots.unavailable');
    }
}

/** One coordinate: a finite number within ±$limit, kept to 5 decimals (about a metre). */
function bt_valid_spot_coordinate($value, float $limit): float
{
    if (!(is_int($value) || is_float($value)) || !is_finite((float) $value) || abs((float) $value) > $limit) {
        throw new HttpError(400, 'Ungültige Position', 'spots.badPosition');
    }
    return round((float) $value, 5);
}

/** [lat, lon] of a body. */
function bt_valid_spot_position(array $body): array
{
    return [bt_valid_spot_coordinate($body['lat'] ?? null, 90.0), bt_valid_spot_coordinate($body['lon'] ?? null, 180.0)];
}

/** The kinds as stored: one or two distinct whitelist values in canonical order, comma-joined. */
function bt_valid_spot_kinds($value): string
{
    if (!is_array($value) || $value === [] || count($value) > count(BT_SPOT_KINDS)) {
        throw new HttpError(400, 'Ungültige Art des Orts', 'spots.badKinds');
    }
    $kinds = [];
    foreach (BT_SPOT_KINDS as $kind) {
        if (in_array($kind, $value, true)) {
            $kinds[] = $kind;
        }
    }
    if (count($kinds) !== count($value)) {
        throw new HttpError(400, 'Ungültige Art des Orts', 'spots.badKinds');
    }
    return implode(',', $kinds);
}

/** The one text error (name and note share it, so the message names both limits). */
function bt_spot_text_error(): HttpError
{
    return new HttpError(
        400,
        'Name höchstens 80 Zeichen, Notiz höchstens 300 Zeichen',
        'spots.badText',
        ['name' => BT_SPOT_NAME_MAX, 'note' => BT_SPOT_NOTE_MAX]
    );
}

/** A name or note: whitespace collapsed, at most $max characters; null or '' = none. */
function bt_valid_spot_text($value, int $max): string
{
    if ($value !== null && !is_string($value)) {
        throw bt_spot_text_error();
    }
    $text = bt_clean_name($value);
    if (mb_strlen($text, 'UTF-8') > $max) {
        throw bt_spot_text_error();
    }
    return $text;
}

/** Validated id from the path: a positive integer, else the same 404 as an unknown one. */
function bt_valid_spot_id(string $value): int
{
    if (!preg_match('/^[1-9]\d{0,14}$/D', $value)) {
        throw new HttpError(404, 'Ort nicht gefunden', 'spots.notFound');
    }
    return (int) $value;
}

/** The version of the approved list (0 before the first change). */
function bt_spots_version(PDO $pdo): int
{
    $raw = bt_setting($pdo, 'spots_version');
    return $raw === null ? 0 : max(0, (int) $raw);
}

/** Count a change to the approved rows (inside the caller's transaction). */
function bt_spots_bump_version(PDO $pdo): void
{
    $pdo->exec(
        "INSERT INTO settings (key, value) VALUES ('spots_version', '1')
           ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1"
    );
}

/** Row JSON: what every phone gets; the operator additionally sees the status and the dates. */
function bt_spot_json(array $row, bool $forOperator = false): array
{
    $kinds = array_values(array_filter(explode(',', (string) $row['kinds']), function ($kind) {
        return in_array($kind, BT_SPOT_KINDS, true);
    }));
    $json = [
        'id' => (int) $row['id'],
        'lat' => (float) $row['lat'],
        'lon' => (float) $row['lon'],
        'kinds' => $kinds,
        'name' => (string) $row['name'],
        'note' => (string) $row['note'],
    ];
    if ($forOperator) {
        $json['status'] = (string) $row['status'];
        $json['createdAt'] = (string) $row['created_at'];
        $json['decidedAt'] = $row['decided_at'] === null ? null : (string) $row['decided_at'];
    }
    return $json;
}

/** Row JSON for the operator. */
function bt_spot_operator_json(array $row): array
{
    return bt_spot_json($row, true);
}

/** Store a member's report {lat, lon, kinds, name?, note?} as pending; 507 at the caps. */
function bt_spot_create(PDO $pdo, array $body, ?string $today = null): array
{
    list($lat, $lon) = bt_valid_spot_position($body);
    $kinds = bt_valid_spot_kinds($body['kinds'] ?? null);
    $name = bt_valid_spot_text($body['name'] ?? null, BT_SPOT_NAME_MAX);
    $note = bt_valid_spot_text($body['note'] ?? null, BT_SPOT_NOTE_MAX);
    $day = $today ?? bt_today();
    bt_write_txn($pdo, function () use ($pdo, $lat, $lon, $kinds, $name, $note, $day) {
        $pending = (int) $pdo->query("SELECT COUNT(*) FROM spots WHERE status = 'pending'")->fetchColumn();
        $total = (int) $pdo->query('SELECT COUNT(*) FROM spots')->fetchColumn();
        if ($pending >= BT_SPOT_MAX_PENDING || $total >= BT_SPOT_MAX_ROWS) {
            throw new HttpError(507, 'Die Liste der gemeldeten Orte ist voll – bitte später nochmals versuchen', 'spots.full');
        }
        $pdo->prepare("INSERT INTO spots (status, lat, lon, kinds, name, note, created_at) VALUES ('pending', ?, ?, ?, ?, ?, ?)")
            ->execute([$lat, $lon, $kinds, $name, $note, $day]);
    });
    return ['ok' => true];
}

/**
 * The approved rows for every phone: {version, items}. The version is read
 * FIRST: a change landing between the two reads shows as a version mismatch
 * on the next sync page, never as a missed one.
 */
function bt_spots_list(PDO $pdo): array
{
    $version = bt_spots_version($pdo);
    $rows = $pdo->query("SELECT * FROM spots WHERE status = 'approved' ORDER BY id")->fetchAll(PDO::FETCH_ASSOC);
    return ['version' => $version, 'items' => array_map('bt_spot_json', $rows)];
}

/** The pending reports for the operator, oldest first (no paging: the cap bounds them). */
function bt_spots_pending(PDO $pdo): array
{
    $rows = $pdo->query("SELECT * FROM spots WHERE status = 'pending' ORDER BY id")->fetchAll(PDO::FETCH_ASSOC);
    return ['items' => array_map('bt_spot_operator_json', $rows)];
}

/** How many reports wait — the operator's sync page carries it (`spotsPending`). */
function bt_spots_pending_count(PDO $pdo): int
{
    return (int) $pdo->query("SELECT COUNT(*) FROM spots WHERE status = 'pending'")->fetchColumn();
}

/** One row or 404. */
function bt_spot_fetch(PDO $pdo, int $id): array
{
    $stmt = $pdo->prepare('SELECT * FROM spots WHERE id = ?');
    $stmt->execute([$id]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if ($row === false) {
        throw new HttpError(404, 'Ort nicht gefunden', 'spots.notFound');
    }
    return $row;
}

/**
 * The operator corrects and/or approves a row: {approve?: true, name?, note?,
 * kinds?}. `approve` counts only as exactly true. The version moves when the
 * row is approved after the update (newly or already) and something changed.
 */
function bt_spot_update(PDO $pdo, int $id, array $body, ?string $today = null): array
{
    $patch = [];
    if (array_key_exists('name', $body)) {
        $patch['name'] = bt_valid_spot_text($body['name'], BT_SPOT_NAME_MAX);
    }
    if (array_key_exists('note', $body)) {
        $patch['note'] = bt_valid_spot_text($body['note'], BT_SPOT_NOTE_MAX);
    }
    if (array_key_exists('kinds', $body)) {
        $patch['kinds'] = bt_valid_spot_kinds($body['kinds']);
    }
    $approve = ($body['approve'] ?? null) === true;
    $day = $today ?? bt_today();
    return bt_write_txn($pdo, function () use ($pdo, $id, $patch, $approve, $day) {
        $row = bt_spot_fetch($pdo, $id);
        if ($approve && $row['status'] !== 'approved') {
            $patch['status'] = 'approved';
            $patch['decided_at'] = $day;
        }
        if ($patch !== []) {
            $sets = [];
            $args = [];
            foreach ($patch as $column => $value) {
                $sets[] = "$column = ?";
                $args[] = $value;
            }
            $args[] = $id;
            $pdo->prepare('UPDATE spots SET ' . implode(', ', $sets) . ' WHERE id = ?')->execute($args);
            if ($row['status'] === 'approved' || isset($patch['status'])) {
                bt_spots_bump_version($pdo);
            }
        }
        return bt_spot_json(bt_spot_fetch($pdo, $id), true);
    });
}

/** Reject a pending report or withdraw an approved place: the row goes for good. */
function bt_spot_delete(PDO $pdo, int $id): array
{
    bt_write_txn($pdo, function () use ($pdo, $id) {
        $row = bt_spot_fetch($pdo, $id);
        $pdo->prepare('DELETE FROM spots WHERE id = ?')->execute([$id]);
        if ($row['status'] === 'approved') {
            bt_spots_bump_version($pdo);
        }
    });
    return ['ok' => true];
}
