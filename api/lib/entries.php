<?php
/**
 * Entries: the opaque per-family sync store.
 *
 * The server never sees what an entry contains. A row is an AES-GCM
 * envelope (`blob`, base64url) that only the family's phones can open,
 * keyed by a client-generated `eid` (32 lowercase hex, so the ciphertext
 * is bound to its id before it is ever sent), plus the metadata the sync
 * protocol needs:
 *
 *   seq          per-family change counter. EVERY write (create, edit,
 *                delete, restore) assigns the family's next value, so seq
 *                is the sync cursor AND the optimistic-concurrency token:
 *                a PATCH must present the seq it rendered from (ifSeq); a
 *                DELETE may (its body's ifSeq is optional).
 *   created_at, updated_at, deleted_at
 *                'YYYY-MM-DD' (UTC day) — day granularity only; the exact
 *                instants live inside the blob. Deletes are soft
 *                (deleted_at) so a 3am mistap never loses data.
 *
 * Family scoping: every function takes the caller's family id as its 2nd
 * parameter and every SQL statement carries `family_id = ?`. A foreign,
 * unknown or (for writes) deleted eid is a plain 404 "Eintrag nicht
 * gefunden", never a 403.
 *
 * seq assignment (bt_next_seq) happens inside `BEGIN IMMEDIATE`, so writers
 * are serialised and any reader snapshot that contains seq N of a family
 * also contains every lower seq of that family — the `since` cursor of
 * bt_sync_entries is exact, unlike timestamps with busy_timeout-delayed
 * commits.
 *
 * Nothing here validates or interprets entry content: types, timers, day
 * windows and the one-open-timer rule live on the client. What it does
 * bound is volume: a per-family and a total row cap on create
 * (bt_assert_row_budget) — the per-address write budget lives in auth.php's
 * throttle section and is applied by index.php.
 *
 * Mutators take an optional $today ('YYYY-MM-DD') as their last parameter
 * and bt_sync_entries an optional $nowIso, so tests are deterministic.
 *
 * Target: PHP 7.4+.
 */

require_once __DIR__ . '/http.php';

// Envelope: 1 version byte + 12 IV + 16 GCM tag around an empty ciphertext.
const BT_BLOB_MIN_BYTES = 29;
const BT_BLOB_MAX_BYTES = 4096;
const BT_SYNC_MAX_LIMIT = 1000;

// Row caps (bt_assert_row_budget): registration is open, so without them one
// account could fill the host's disk with 4 KB blobs. Deletes are soft and
// rows are never purged, so both count EVERY row. A family logging thirty
// events a day writes ~11 000 rows a year at ~0.5 KB each (256/512-byte
// padding buckets), so the family cap covers four years of a newborn's
// tracker at ~25 MB; an attacker maxing the blob size reaches it at ~275
// MB. The total cap bounds the file whatever the number of families: ~2.2
// GB worst case, ~200 MB of real use. Both answer 507 with a German text.
const BT_FAMILY_MAX_ROWS = 50000;
const BT_TOTAL_MAX_ROWS = 400000;

function bt_now_iso(): string
{
    return gmdate('Y-m-d\TH:i:s\Z');
}

/** The UTC calendar day ('YYYY-MM-DD') stamped on rows. */
function bt_today(): string
{
    return gmdate('Y-m-d');
}

// --- validators (400, German, coded) -----------------------------------------

/** Validated entry id: exactly 32 lowercase hex characters. */
function bt_valid_eid($value): string
{
    if (!is_string($value) || !preg_match('/^[0-9a-f]{32}$/D', $value)) {
        throw new HttpError(400, 'Ungültiger Eintrag', 'entries.badId');
    }
    return $value;
}

/**
 * Validated ciphertext: strict base64url without padding (canonical — a
 * re-encode must reproduce the input, which rejects '=', stray trailing
 * bits and lengths ≡ 1 mod 4) decoding to 29..4096 bytes. Returned verbatim;
 * the server stores the string, never the bytes.
 */
function bt_valid_blob($value): string
{
    // 4096 bytes encode to 5462 chars; refuse anything longer before decoding.
    if (!is_string($value) || strlen($value) > 5464 || !preg_match('/^[A-Za-z0-9_-]+$/D', $value)) {
        throw new HttpError(400, 'Ungültiger Datensatz', 'request.badBlob');
    }
    $bytes = base64_decode(strtr($value, '-_', '+/'), true);
    if ($bytes === false || rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=') !== $value) {
        throw new HttpError(400, 'Ungültiger Datensatz', 'request.badBlob');
    }
    $len = strlen($bytes);
    if ($len < BT_BLOB_MIN_BYTES || $len > BT_BLOB_MAX_BYTES) {
        throw new HttpError(400, 'Ungültiger Datensatz', 'request.badBlob');
    }
    return $value;
}

// --- transaction + seq helpers -------------------------------------------------

/**
 * Run $fn inside BEGIN IMMEDIATE (the write lock is taken up front, so the
 * seq read in bt_next_seq cannot race another writer), commit, and return
 * its result. Any exception rolls back and is rethrown; the nested try
 * around ROLLBACK covers a BEGIN that never took (same pattern as auth.php).
 */
function bt_write_txn(PDO $pdo, callable $fn)
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

/**
 * The family's next seq. Call ONLY inside BEGIN IMMEDIATE: outside the lock
 * two writers could read the same MAX and hand out one seq twice, which
 * would break both the cursor and the ifSeq token.
 */
function bt_next_seq(PDO $pdo, int $familyId): int
{
    $stmt = $pdo->prepare('SELECT COALESCE(MAX(seq), 0) + 1 FROM entries WHERE family_id = ?');
    $stmt->execute([$familyId]);
    return (int) $stmt->fetchColumn();
}

/**
 * 507 'Speicher …' when the family ($familyMax, BT_FAMILY_MAX_ROWS) or the
 * whole database ($totalMax, BT_TOTAL_MAX_ROWS) has no room for another
 * row. Called by bt_create_entry INSIDE its write transaction, so concurrent
 * creates cannot slip past the cap together. Edits, deletes and restores
 * never add a row and stay possible at the cap. The caps are
 * parameters only so the tests can hit them with a handful of rows.
 */
function bt_assert_row_budget(
    PDO $pdo,
    int $familyId,
    int $familyMax = BT_FAMILY_MAX_ROWS,
    int $totalMax = BT_TOTAL_MAX_ROWS
): void {
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM entries WHERE family_id = ?');
    $stmt->execute([$familyId]);
    if ((int) $stmt->fetchColumn() >= $familyMax) {
        throw new HttpError(507, 'Speicherlimit der Familie erreicht – keine neuen Einträge möglich', 'entries.familyFull');
    }
    if ((int) $pdo->query('SELECT COUNT(*) FROM entries')->fetchColumn() >= $totalMax) {
        throw new HttpError(507, 'Der Speicher des Servers ist voll – keine neuen Einträge möglich', 'entries.serverFull');
    }
}

/**
 * settings.feed_id: the identity of THIS database's change feed — 32 random
 * hex chars written once, when bt_create_schema creates the file. Every
 * sync page carries it as `feed`; a client whose stored feed differs (the
 * file was lost and created anew, or replaced by another one) wipes its
 * mirror and cursor exactly as it does on reset:true — the seq space it
 * remembers belongs to another history. '' when unset (a scratch file
 * without the row: the client then never sees a change).
 */
function bt_feed_id(PDO $pdo): string
{
    $value = $pdo->query("SELECT value FROM settings WHERE key = 'feed_id'")->fetchColumn();
    return $value === false ? '' : (string) $value;
}

/** One row of this family by eid, in any state (deleted included); null when absent. */
function bt_fetch_row(PDO $pdo, int $familyId, string $eid): ?array
{
    $stmt = $pdo->prepare('SELECT * FROM entries WHERE eid = ? AND family_id = ?');
    $stmt->execute([$eid, $familyId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row === false ? null : $row;
}

// --- row JSON -------------------------------------------------------------------

/**
 * Public JSON shape of a row (family_id is never exposed):
 *   {eid, seq, blob|null, createdAt, updatedAt, deletedAt}
 * blob is null only on a tombstone without content (see db.php).
 */
function bt_row_json(array $row): array
{
    return [
        'eid' => (string) $row['eid'],
        'seq' => (int) $row['seq'],
        'blob' => $row['blob'] === null ? null : (string) $row['blob'],
        'createdAt' => (string) $row['created_at'],
        'updatedAt' => (string) $row['updated_at'],
        'deletedAt' => $row['deleted_at'] === null ? null : (string) $row['deleted_at'],
    ];
}

// --- sync -----------------------------------------------------------------------

/**
 * One page of the family's change feed: rows with seq > $since, ascending,
 * at most $limit (clamped 1..1000):
 *   {serverNow, feed, rows: [row JSON …], next[, reset: true]}
 * `feed` is settings.feed_id (bt_feed_id) on EVERY page, reset pages
 * included. `next` = seq of the last row when the page is full (the client
 * asks again with since=next), else null. since=0 is a fresh client:
 * tombstones are omitted (nothing to delete locally); any later cursor gets
 * them. A cursor beyond the family's MAX(seq) cannot come from this database
 * (restored backup, wiped family) → reset:true with no rows: the client
 * wipes its store and cursor and starts over. Another file altogether, whose
 * MAX(seq) happens to be >= the cursor, slips past that check — its
 * different `feed` catches it.
 */
function bt_sync_entries(PDO $pdo, int $familyId, int $since, int $limit, ?string $nowIso = null): array
{
    $since = max(0, $since);
    $limit = max(1, min(BT_SYNC_MAX_LIMIT, $limit));
    $now = $nowIso ?? bt_now_iso();
    $feed = bt_feed_id($pdo);

    $stmt = $pdo->prepare('SELECT COALESCE(MAX(seq), 0) FROM entries WHERE family_id = ?');
    $stmt->execute([$familyId]);
    $maxSeq = (int) $stmt->fetchColumn();

    if ($since > $maxSeq) {
        return [
            'serverNow' => $now,
            'feed' => $feed,
            'rows' => [],
            'next' => null,
            'reset' => true,
        ];
    }

    $sql = 'SELECT * FROM entries WHERE family_id = ? AND seq > ?';
    if ($since === 0) {
        $sql .= ' AND deleted_at IS NULL';
    }
    $sql .= ' ORDER BY seq LIMIT ?';
    $stmt = $pdo->prepare($sql);
    $stmt->bindValue(1, $familyId, PDO::PARAM_INT);
    $stmt->bindValue(2, $since, PDO::PARAM_INT);
    $stmt->bindValue(3, $limit, PDO::PARAM_INT);
    $stmt->execute();

    $rows = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $rows[] = bt_row_json($row);
    }
    $next = count($rows) === $limit ? $rows[count($rows) - 1]['seq'] : null;

    return [
        'serverNow' => $now,
        'feed' => $feed,
        'rows' => $rows,
        'next' => $next,
    ];
}

// --- writes ---------------------------------------------------------------------

/**
 * Create an entry for $familyId from {eid, blob}; returns the row JSON
 * (index.php answers 201). 409 "Eintrag existiert bereits" when the eid is
 * taken — eid is the table's primary key, so this also covers a deleted row
 * and another family's row (128-bit random ids never collide by accident;
 * a deliberate probe learns nothing but that the id exists). 507 when the
 * family or the database is at its row cap (bt_assert_row_budget).
 */
function bt_create_entry(PDO $pdo, int $familyId, array $body, ?string $today = null): array
{
    $eid = bt_valid_eid($body['eid'] ?? null);
    $blob = bt_valid_blob($body['blob'] ?? null);
    $day = $today ?? bt_today();

    $row = bt_write_txn($pdo, function () use ($pdo, $familyId, $eid, $blob, $day) {
        $stmt = $pdo->prepare('SELECT 1 FROM entries WHERE eid = ?');
        $stmt->execute([$eid]);
        if ($stmt->fetchColumn() !== false) {
            throw new HttpError(409, 'Eintrag existiert bereits', 'entries.exists');
        }
        bt_assert_row_budget($pdo, $familyId);
        $pdo->prepare(
            'INSERT INTO entries (eid, family_id, seq, blob, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)'
        )->execute([$eid, $familyId, bt_next_seq($pdo, $familyId), $blob, $day, $day]);
        return bt_fetch_row($pdo, $familyId, $eid);
    });
    return bt_row_json($row);
}

/**
 * Replace the blob of a live entry from {blob, ifSeq} (compare-and-set):
 *   UPDATE … WHERE eid = ? AND family_id = ? AND deleted_at IS NULL AND seq = ifSeq
 * No row matched → 404 when the entry is missing, foreign or deleted, else
 * 409 "Der Eintrag wurde inzwischen auf einem anderen Gerät geändert" (the
 * client re-syncs, re-checks its precondition and retries with the fresh
 * seq). ifSeq is required: an unconditional write would silently drop the
 * other phone's edit.
 */
function bt_update_entry(PDO $pdo, int $familyId, $eid, array $body, ?string $today = null): array
{
    $eid = bt_valid_eid($eid);
    $blob = bt_valid_blob($body['blob'] ?? null);
    $ifSeq = $body['ifSeq'] ?? null;
    if (!is_int($ifSeq)) {
        throw new HttpError(400, '"ifSeq" fehlt', 'request.missingField', ['field' => 'ifSeq']);
    }
    $day = $today ?? bt_today();

    $row = bt_write_txn($pdo, function () use ($pdo, $familyId, $eid, $blob, $ifSeq, $day) {
        $stmt = $pdo->prepare(
            'UPDATE entries SET blob = ?, seq = ?, updated_at = ?
             WHERE eid = ? AND family_id = ? AND deleted_at IS NULL AND seq = ?'
        );
        $stmt->execute([$blob, bt_next_seq($pdo, $familyId), $day, $eid, $familyId, $ifSeq]);
        if ($stmt->rowCount() === 0) {
            $current = bt_fetch_row($pdo, $familyId, $eid);
            if ($current === null || $current['deleted_at'] !== null) {
                throw new HttpError(404, 'Eintrag nicht gefunden', 'entries.notFound');
            }
            throw new HttpError(409, 'Der Eintrag wurde inzwischen auf einem anderen Gerät geändert', 'entries.conflict');
        }
        return bt_fetch_row($pdo, $familyId, $eid);
    });
    return bt_row_json($row);
}

/**
 * Soft-delete a live entry of $familyId (new seq, deleted_at = today);
 * returns the row JSON. 404 when it does not exist, is foreign or is
 * already deleted.
 *
 * $body is the optional JSON body of the DELETE: {ifSeq} makes the delete a
 * compare-and-set like bt_update_entry (400 '"ifSeq" ungültig' when present
 * but not an int; absent/null = unconditional, the plain "delete this"
 * of the history sheet). With ifSeq, a live row whose seq moved → 409
 * "Der Eintrag wurde inzwischen auf einem anderen Gerät geändert" — the
 * duplicate-timer resolver uses it so it only ever removes the exact
 * version it judged, never an entry the other phone has since edited.
 */
function bt_delete_entry(PDO $pdo, int $familyId, $eid, ?string $today = null, array $body = []): array
{
    $eid = bt_valid_eid($eid);
    $ifSeq = $body['ifSeq'] ?? null;
    if ($ifSeq !== null && !is_int($ifSeq)) {
        throw new HttpError(400, '"ifSeq" ungültig', 'request.invalidField', ['field' => 'ifSeq']);
    }
    $day = $today ?? bt_today();

    $row = bt_write_txn($pdo, function () use ($pdo, $familyId, $eid, $ifSeq, $day) {
        $sql = 'UPDATE entries SET deleted_at = ?, updated_at = ?, seq = ?
                WHERE eid = ? AND family_id = ? AND deleted_at IS NULL';
        $params = [$day, $day, bt_next_seq($pdo, $familyId), $eid, $familyId];
        if ($ifSeq !== null) {
            $sql .= ' AND seq = ?';
            $params[] = $ifSeq;
        }
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        if ($stmt->rowCount() === 0) {
            $current = $ifSeq === null ? null : bt_fetch_row($pdo, $familyId, $eid);
            if ($current === null || $current['deleted_at'] !== null) {
                throw new HttpError(404, 'Eintrag nicht gefunden', 'entries.notFound');
            }
            throw new HttpError(409, 'Der Eintrag wurde inzwischen auf einem anderen Gerät geändert', 'entries.conflict');
        }
        return bt_fetch_row($pdo, $familyId, $eid);
    });
    return bt_row_json($row);
}

/**
 * Undo a soft delete (new seq); returns the row JSON including the blob so
 * the client can show it again. 404 when the entry does not exist, is
 * foreign or is not deleted.
 */
function bt_restore_entry(PDO $pdo, int $familyId, $eid, ?string $today = null): array
{
    $eid = bt_valid_eid($eid);
    $day = $today ?? bt_today();

    $row = bt_write_txn($pdo, function () use ($pdo, $familyId, $eid, $day) {
        $stmt = $pdo->prepare(
            'UPDATE entries SET deleted_at = NULL, updated_at = ?, seq = ?
             WHERE eid = ? AND family_id = ? AND deleted_at IS NOT NULL'
        );
        $stmt->execute([$day, bt_next_seq($pdo, $familyId), $eid, $familyId]);
        if ($stmt->rowCount() === 0) {
            throw new HttpError(404, 'Eintrag nicht gefunden', 'entries.notFound');
        }
        return bt_fetch_row($pdo, $familyId, $eid);
    });
    return bt_row_json($row);
}
