<?php
/**
 * Entries: the opaque per-family sync store (schema v3).
 *
 * The server never sees what an entry contains. A row is an AES-GCM
 * envelope (`blob`, base64url) that only the family's phones can open,
 * keyed by a client-generated `eid` (32 lowercase hex, so the ciphertext
 * is bound to its id before it is ever sent), plus the metadata the sync
 * protocol needs:
 *
 *   seq          per-family change counter. EVERY write (create, edit,
 *                delete, restore, seal) assigns the family's next value, so
 *                seq is the sync cursor AND the optimistic-concurrency token:
 *                a PATCH must present the seq it rendered from (ifSeq); a
 *                DELETE may (its body's ifSeq is optional).
 *   created_at, updated_at, deleted_at
 *                'YYYY-MM-DD' (UTC day) — day granularity only; the exact
 *                instants live inside the blob. Deletes are soft
 *                (deleted_at) so a 3am mistap never loses data.
 *   legacy_*     the five plaintext fields of a row that pre-dates
 *                encryption (blob IS NULL) — a migration-window state. The
 *                client reads them as `plain` in the sync feed, encrypts
 *                them and posts them back through bt_seal_legacy, which
 *                nulls them; the freed bytes are zeroed (PRAGMA
 *                secure_delete, set in db.php) and the file is compacted
 *                once the last row of a family is sealed.
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
 * Plaintext ever leaves the server only for rows that existed at migration
 * time: `plain` requires seq <= settings.legacy_max_seq (stamped by the
 * v2 -> v3 migration). Every write assigns a higher seq, so a plaintext row
 * that turns up later — whoever wrote it into the file — is never handed
 * to the client as content it should trust and encrypt.
 *
 * Nothing here validates or interprets entry content: types, timers, day
 * windows and the one-open-timer rule live on the client now. What it does
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
const BT_SEAL_MAX_ITEMS = 200;

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

// What a pre-encryption shell (still served from a phone's service-worker
// cache) gets for its plaintext writes; the UI shows it verbatim.
const BT_OLD_SHELL_MESSAGE = 'Neue App-Version – bitte die App schliessen und neu öffnen';

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

/**
 * 400 with the old-shell text for a body that carries v2 plaintext fields
 * and no blob — a phone that has not reloaded since the update. Better than
 * a puzzling "Ungültiger Datensatz" from bt_valid_blob.
 */
function bt_assert_not_old_shell(array $body): void
{
    if (array_key_exists('blob', $body)) {
        return;
    }
    foreach (['type', 'startedAt', 'endedAt', 'details', 'ifOpen'] as $key) {
        if (array_key_exists($key, $body)) {
            throw new HttpError(400, BT_OLD_SHELL_MESSAGE, 'request.oldShell');
        }
    }
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
 * creates cannot slip past the cap together. Edits, deletes, restores and
 * seals never add a row and stay possible at the cap. The caps are
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

/** settings.legacy_max_seq (the last seq that existed at migration time); 0 when unset. */
function bt_legacy_max_seq(PDO $pdo): int
{
    $value = $pdo->query("SELECT value FROM settings WHERE key = 'legacy_max_seq'")->fetchColumn();
    return $value === false ? 0 : (int) $value;
}

/**
 * settings.feed_id: the identity of THIS database's change feed — 32 random
 * hex chars written by bt_create_schema and REPLACED by the v2 -> v3
 * migration (db.php), so a restored backup or a re-migrated file carries a
 * different value than the one the phones stored. Every sync page carries
 * it as `feed`; a client whose stored feed differs wipes its mirror and
 * cursor exactly as it does on reset:true — the seq space it remembers
 * belongs to another history. '' when unset (a scratch file without the
 * row: the client then never sees a change).
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
 *   {eid, seq, blob|null, plain|null, createdAt, updatedAt, deletedAt}
 * `plain` = {type, startedAt, endedAt, details, loggedBy} ONLY for a
 * still-plaintext row (blob IS NULL) that has content to show (legacy_type
 * set) and is live — a tombstone's content is never read by anyone. Never
 * on an encrypted row. Callers that answer requests go through
 * bt_public_row, which adds the legacy_max_seq guard.
 */
function bt_row_json(array $row): array
{
    $plain = null;
    if ($row['blob'] === null && $row['legacy_type'] !== null && $row['deleted_at'] === null) {
        $details = json_decode((string) $row['legacy_details'], true);
        $plain = [
            'type' => (string) $row['legacy_type'],
            'startedAt' => (string) $row['legacy_started_at'],
            'endedAt' => $row['legacy_ended_at'] === null ? null : (string) $row['legacy_ended_at'],
            'details' => is_array($details) && $details !== [] ? $details : new stdClass(),
            'loggedBy' => $row['legacy_logged_by'] === null ? null : (string) $row['legacy_logged_by'],
        ];
    }
    return [
        'eid' => (string) $row['eid'],
        'seq' => (int) $row['seq'],
        'blob' => $row['blob'] === null ? null : (string) $row['blob'],
        'plain' => $plain,
        'createdAt' => (string) $row['created_at'],
        'updatedAt' => (string) $row['updated_at'],
        'deletedAt' => $row['deleted_at'] === null ? null : (string) $row['deleted_at'],
    ];
}

/**
 * bt_row_json for API responses: `plain` additionally requires
 * seq <= settings.legacy_max_seq (see the file docblock). $legacyMax lets a
 * page of rows share one settings read.
 */
function bt_public_row(PDO $pdo, array $row, ?int $legacyMax = null): array
{
    $json = bt_row_json($row);
    if ($json['plain'] !== null && $json['seq'] > ($legacyMax ?? bt_legacy_max_seq($pdo))) {
        $json['plain'] = null;
    }
    return $json;
}

// --- sync -----------------------------------------------------------------------

/**
 * Rows of this family the client can still seal: live, still plaintext,
 * and from before the migration (the only ones ever served as `plain`).
 */
function bt_count_legacy(PDO $pdo, int $familyId): int
{
    $stmt = $pdo->prepare(
        'SELECT COUNT(*) FROM entries
         WHERE family_id = ? AND blob IS NULL AND deleted_at IS NULL AND seq <= ?'
    );
    $stmt->execute([$familyId, bt_legacy_max_seq($pdo)]);
    return (int) $stmt->fetchColumn();
}

/**
 * One page of the family's change feed: rows with seq > $since, ascending,
 * at most $limit (clamped 1..1000):
 *   {serverNow, feed, rows: [row JSON …], next, legacyRemaining[, reset: true]}
 * `feed` is settings.feed_id (bt_feed_id) on EVERY page, reset pages
 * included. `next` = seq of the last row when the page is full (the client
 * asks again with since=next), else null. since=0 is a fresh client:
 * tombstones are omitted (nothing to delete locally); any later cursor gets
 * them. A cursor beyond the family's MAX(seq) cannot come from this database
 * (restored backup, wiped family) → reset:true with no rows: the client
 * wipes its store and cursor and starts over. A backup restored to a state
 * whose MAX(seq) is still >= the cursor slips past that check — the changed
 * `feed` catches it.
 */
function bt_sync_entries(PDO $pdo, int $familyId, int $since, int $limit, ?string $nowIso = null): array
{
    $since = max(0, $since);
    $limit = max(1, min(BT_SYNC_MAX_LIMIT, $limit));
    $now = $nowIso ?? bt_now_iso();
    $feed = bt_feed_id($pdo);
    $legacyMax = bt_legacy_max_seq($pdo);

    $stmt = $pdo->prepare('SELECT COALESCE(MAX(seq), 0) FROM entries WHERE family_id = ?');
    $stmt->execute([$familyId]);
    $maxSeq = (int) $stmt->fetchColumn();
    $legacyRemaining = bt_count_legacy($pdo, $familyId);

    if ($since > $maxSeq) {
        return [
            'serverNow' => $now,
            'feed' => $feed,
            'rows' => [],
            'next' => null,
            'legacyRemaining' => $legacyRemaining,
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
        $rows[] = bt_public_row($pdo, $row, $legacyMax);
    }
    $next = count($rows) === $limit ? $rows[count($rows) - 1]['seq'] : null;

    return [
        'serverNow' => $now,
        'feed' => $feed,
        'rows' => $rows,
        'next' => $next,
        'legacyRemaining' => $legacyRemaining,
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
    bt_assert_not_old_shell($body);
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
    return bt_public_row($pdo, $row);
}

/**
 * Replace the blob of a live entry from {blob, ifSeq} (compare-and-set):
 *   UPDATE … WHERE eid = ? AND family_id = ? AND deleted_at IS NULL AND seq = ifSeq
 * A legacy row edited this way is sealed by the edit (legacy_* nulled).
 * No row matched → 404 when the entry is missing, foreign or deleted, else
 * 409 "Der Eintrag wurde inzwischen auf einem anderen Gerät geändert" (the
 * client re-syncs, re-checks its precondition and retries with the fresh
 * seq). ifSeq is required: an unconditional write would silently drop the
 * other phone's edit.
 */
function bt_update_entry(PDO $pdo, int $familyId, $eid, array $body, ?string $today = null): array
{
    bt_assert_not_old_shell($body);
    $eid = bt_valid_eid($eid);
    $blob = bt_valid_blob($body['blob'] ?? null);
    $ifSeq = $body['ifSeq'] ?? null;
    if (!is_int($ifSeq)) {
        throw new HttpError(400, '"ifSeq" fehlt', 'request.missingField', ['field' => 'ifSeq']);
    }
    $day = $today ?? bt_today();

    $row = bt_write_txn($pdo, function () use ($pdo, $familyId, $eid, $blob, $ifSeq, $day) {
        $stmt = $pdo->prepare(
            'UPDATE entries
             SET blob = ?, legacy_type = NULL, legacy_started_at = NULL, legacy_ended_at = NULL,
                 legacy_details = NULL, legacy_logged_by = NULL, seq = ?, updated_at = ?
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
    return bt_public_row($pdo, $row);
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
    return bt_public_row($pdo, $row);
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
    return bt_public_row($pdo, $row);
}

// --- legacy seal ----------------------------------------------------------------

/**
 * Store the client's encryption of legacy rows: $items = up to 200 of
 * {eid, seq, blob}, each applied as
 *   UPDATE … SET blob, legacy_* = NULL, seq = <next>, updated_at = today
 *   WHERE eid = ? AND family_id = ? AND blob IS NULL AND seq = ?
 * Returns {done: [{eid, seq, updatedAt}], skipped: [eid …], remaining}.
 * An item is skipped (never an error) when the row is already sealed,
 * changed since the client read it, foreign or unknown — the client's next
 * sync sorts it out. Idempotent: a repeated batch skips everything.
 *
 * When `remaining` (bt_count_legacy) reaches 0 the family's plaintext era
 * is over: the legacy columns of every row of the family that can no longer
 * be served as `plain` (tombstones, rows whose seq moved past
 * legacy_max_seq) are nulled in the same transaction — no client can ever
 * read them — and, if anything was written, the file is compacted after
 * the commit (bt_compact_db) so the zeroed cells leave the freed pages too.
 */
function bt_seal_legacy(PDO $pdo, int $familyId, array $items, ?string $today = null): array
{
    if (count($items) > BT_SEAL_MAX_ITEMS) {
        throw new HttpError(
            400,
            'Höchstens ' . BT_SEAL_MAX_ITEMS . ' Einträge pro Anfrage',
            'entries.sealTooMany',
            ['max' => BT_SEAL_MAX_ITEMS]
        );
    }
    $clean = [];
    foreach ($items as $item) {
        if (!is_array($item)) {
            throw new HttpError(400, 'Ungültiger Eintrag', 'entries.badItem');
        }
        $eid = bt_valid_eid($item['eid'] ?? null);
        $seq = $item['seq'] ?? null;
        if (!is_int($seq)) {
            throw new HttpError(400, '"seq" fehlt', 'request.missingField', ['field' => 'seq']);
        }
        $clean[] = [$eid, $seq, bt_valid_blob($item['blob'] ?? null)];
    }
    $day = $today ?? bt_today();

    $result = bt_write_txn($pdo, function () use ($pdo, $familyId, $clean, $day) {
        $done = [];
        $skipped = [];
        $seq = bt_next_seq($pdo, $familyId);
        $stmt = $pdo->prepare(
            'UPDATE entries
             SET blob = ?, legacy_type = NULL, legacy_started_at = NULL, legacy_ended_at = NULL,
                 legacy_details = NULL, legacy_logged_by = NULL, seq = ?, updated_at = ?
             WHERE eid = ? AND family_id = ? AND blob IS NULL AND seq = ?'
        );
        foreach ($clean as $item) {
            list($eid, $ifSeq, $blob) = $item;
            $stmt->execute([$blob, $seq, $day, $eid, $familyId, $ifSeq]);
            if ($stmt->rowCount() === 1) {
                $done[] = ['eid' => $eid, 'seq' => $seq, 'updatedAt' => $day];
                $seq++;
            } else {
                $skipped[] = $eid;
            }
        }

        $remaining = bt_count_legacy($pdo, $familyId);
        $scrubbed = 0;
        if ($remaining === 0) {
            $scrub = $pdo->prepare(
                'UPDATE entries
                 SET legacy_type = NULL, legacy_started_at = NULL, legacy_ended_at = NULL,
                     legacy_details = NULL, legacy_logged_by = NULL
                 WHERE family_id = ? AND blob IS NULL AND legacy_type IS NOT NULL'
            );
            $scrub->execute([$familyId]);
            $scrubbed = $scrub->rowCount();
        }
        return [
            'done' => $done,
            'skipped' => $skipped,
            'remaining' => $remaining,
            'compact' => $remaining === 0 && ($done !== [] || $scrubbed > 0),
        ];
    });

    $compact = $result['compact'];
    unset($result['compact']);
    if ($compact) {
        bt_compact_db($pdo);
    }
    return $result;
}

/**
 * Fold the WAL into the main file, rebuild it (VACUUM drops freed pages and
 * rewrites the rest) and fold again so the compacted image is what sits on
 * disk. Must run OUTSIDE any transaction (VACUUM refuses otherwise).
 *
 * The TRUNCATE checkpoint is not optional: secure_delete zeroes the cells
 * in the NEW page images, but the WAL still holds the old frames with the
 * plaintext until it is checkpointed and truncated. Best effort: a busy
 * checkpoint (the other phone mid-read) or a host that forbids VACUUM only
 * logs — the next checkpoint or seal finishes the job.
 */
function bt_compact_db(PDO $pdo): void
{
    try {
        bt_checkpoint($pdo);
        $pdo->exec('VACUUM');
        bt_checkpoint($pdo);
    } catch (Throwable $e) {
        error_log('[baby-tracker] compaction after legacy seal failed: ' . $e->getMessage());
    }
}

/** PRAGMA wal_checkpoint(TRUNCATE); logs when a reader kept it from completing. */
function bt_checkpoint(PDO $pdo): void
{
    $row = $pdo->query('PRAGMA wal_checkpoint(TRUNCATE)')->fetch(PDO::FETCH_ASSOC);
    if (is_array($row) && (int) ($row['busy'] ?? 0) === 1) {
        error_log('[baby-tracker] checkpoint after legacy seal busy – WAL tail kept until the next one');
    }
}
