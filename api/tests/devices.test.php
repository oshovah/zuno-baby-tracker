<?php
/**
 * Devices (lib/devices.php): a member registers a physical button device,
 * the device posts sealed presses without a cookie, the family's sync pages
 * carry them until a phone deletes them. Helpers come from api.test.php
 * (loaded first by run.php).
 *
 * Target: PHP 7.4+.
 */

/** A sealed press of $bytes bytes: version byte 0x03, then random bytes. */
function dv_blob(int $bytes = 157): string
{
    return fake_b64u("\x03" . random_bytes($bytes - 1));
}

/** Register a device for the logged-in member; returns the 201 body {id, token, createdAt}. */
function dv_register(): array
{
    $res = api_call('POST', '/devices', []);
    assert_eq($res[0], 201, 'register (body ' . bt_format($res[1]) . ')');
    return $res[1];
}

/** A press from the device: no cookie, the token in the body. */
function dv_press($token, $blob = null, array $opts = []): array
{
    $cookie = $_COOKIE[BT_COOKIE] ?? null;
    logout();
    try {
        return api_call('POST', '/devices/events', ['token' => $token, 'blob' => func_num_args() >= 2 ? $blob : dv_blob()], $opts);
    } finally {
        if ($cookie !== null) {
            $_COOKIE[BT_COOKIE] = $cookie;
        }
    }
}

bt_test('devices: a member registers one — the token is handed out once and stored only as its hash; at most 10 per family', function () {
    $pdo = fresh_db();
    login_as($pdo, me());
    $dev = dv_register();
    assert_eq(array_keys($dev), ['id', 'token', 'createdAt'], 'the answer');
    assert_eq($dev['id'], 1);
    assert_true(preg_match('/^[0-9a-f]{32}$/D', $dev['token']) === 1, 'a 16-byte token as hex');
    assert_true(preg_match('/^\d{4}-\d{2}-\d{2}$/D', $dev['createdAt']) === 1, 'a day, no time');
    $row = $pdo->query('SELECT * FROM devices')->fetch(PDO::FETCH_ASSOC);
    assert_eq(array_keys($row), ['id', 'family_id', 'token_hash', 'created_at'], 'the whole row: no name, no key');
    assert_eq($row['family_id'], fam());
    assert_eq($row['token_hash'], hash('sha256', $dev['token']), 'sha256, never the token');
    assert_eq(fails_of($pdo, 'write:' . T_IP), 1, 'drawn on the write budget');

    // Two registrations never share a token; the cap is per family.
    $second = dv_register();
    assert_true($second['token'] !== $dev['token']);
    for ($i = 2; $i < BT_DEVICE_MAX_PER_FAMILY; $i++) {
        dv_register();
    }
    assert_error(api_call('POST', '/devices', []), 507, 'Zu viele Taster – bitte zuerst einen entfernen', 'the 11th', 'devices.tooMany', ['max' => 10]);
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM devices'), BT_DEVICE_MAX_PER_FAMILY);
    $other = second_family($pdo);
    login_as($pdo, $other['user']);
    assert_eq(dv_register()['id'], 11, 'another family has its own ten');

    // Not logged in: 401 like every member route; the wrong method: 405.
    logout();
    assert_error(api_call('POST', '/devices', []), 401, 'Nicht angemeldet', 'no cookie', 'auth.notLoggedIn');
    login_as($pdo, me());
    assert_error(api_call('GET', '/devices'), 405, 'Methode nicht erlaubt', 'GET', 'request.methodNotAllowed');
});

bt_test('devices: a press needs no cookie — the token names the device, the blob is stored opaque for its family, a day only', function () {
    $pdo = fresh_db();
    login_as($pdo, me());
    $dev = dv_register();
    $blob = dv_blob();
    assert_response(dv_press($dev['token'], $blob), 201, ['ok' => true]);
    $row = $pdo->query('SELECT * FROM device_events')->fetch(PDO::FETCH_ASSOC);
    assert_eq(array_keys($row), ['id', 'device_id', 'family_id', 'blob', 'created_at'], 'the whole row');
    assert_eq((int) $row['device_id'], $dev['id']);
    assert_eq((int) $row['family_id'], fam());
    assert_eq($row['blob'], $blob, 'stored verbatim');
    assert_true(preg_match('/^\d{4}-\d{2}-\d{2}$/D', $row['created_at']) === 1, 'a day, no time');
    assert_eq(fails_of($pdo, 'dev:' . T_IP), 1, 'counted per address');
    assert_eq(fails_of($pdo, 'write:' . T_IP), 1, 'not on the write budget (that one is the registration)');

    // The family's sync pages carry it; another family's do not.
    $page = api_call('GET', '/sync?since=0')[1];
    assert_eq(array_keys($page), ['serverNow', 'feed', 'rows', 'next', 'deviceEvents']);
    assert_eq($page['deviceEvents'], [['id' => 1, 'device' => $dev['id'], 'blob' => $blob, 'createdAt' => $row['created_at']]]);
    $other = second_family($pdo);
    login_as($pdo, $other['user']);
    assert_false(array_key_exists('deviceEvents', api_call('GET', '/sync?since=0')[1]), 'nothing for another family');
    assert_error(api_call('DELETE', '/devices/events/1'), 404, 'Tastendruck nicht gefunden', 'another family cannot clear it', 'devices.eventNotFound');

    // The phone that made the entry clears the press; the second phone finds it gone.
    login_as($pdo, me());
    assert_response(api_call('DELETE', '/devices/events/1'), 200, ['ok' => true]);
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM device_events'), 0, 'gone, not a tombstone');
    assert_error(api_call('DELETE', '/devices/events/1'), 404, 'Tastendruck nicht gefunden', 'twice', 'devices.eventNotFound');
    assert_error(api_call('DELETE', '/devices/events/abc'), 404, 'Tastendruck nicht gefunden', 'not an id', 'devices.eventNotFound');
    assert_false(array_key_exists('deviceEvents', api_call('GET', '/sync?since=0')[1]), 'the key goes with the last press');

    // Presses come oldest first, fifty per page.
    for ($i = 0; $i < BT_DEVICE_EVENTS_PAGE + 3; $i++) {
        assert_response(dv_press($dev['token']), 201);
    }
    $events = api_call('GET', '/sync?since=0')[1]['deviceEvents'];
    assert_eq(count($events), BT_DEVICE_EVENTS_PAGE);
    assert_eq(array_column($events, 'id'), range(2, BT_DEVICE_EVENTS_PAGE + 1), 'oldest first');
});

bt_test('devices: validation of a press — the token shape, the blob (canonical base64url, version 0x03, 29..1024 bytes); an unknown token is a 404', function () {
    $pdo = fresh_db();
    login_as($pdo, me());
    $dev = dv_register();
    $bad = function ($token, $blob, int $status, string $message, string $label, string $code) {
        assert_error(dv_press($token, $blob), $status, $message, $label, $code);
    };
    foreach ([strtoupper($dev['token']), substr($dev['token'], 1), $dev['token'] . 'a', '', null, 42, ['x']] as $token) {
        $bad($token, dv_blob(), 400, 'Ungültiger Taster-Code', 'token ' . bt_format($token), 'devices.badToken');
    }
    $unknown = str_repeat('0', 32);
    $bad($unknown, dv_blob(), 404, 'Taster nicht gefunden', 'unknown token', 'devices.notFound');
    $bad($dev['token'], fake_b64u("\x01" . random_bytes(156)), 400, 'Ungültiger Datensatz', 'an entry envelope', 'request.badBlob');
    $bad($dev['token'], fake_b64u("\x02" . random_bytes(156)), 400, 'Ungültiger Datensatz', 'a feedback envelope', 'request.badBlob');
    $bad($dev['token'], dv_blob(28), 400, 'Ungültiger Datensatz', 'too short', 'request.badBlob');
    $bad($dev['token'], dv_blob(1025), 400, 'Ungültiger Datensatz', 'too long', 'request.badBlob');
    $bad($dev['token'], dv_blob() . '=', 400, 'Ungültiger Datensatz', 'padding', 'request.badBlob');
    $bad($dev['token'], 'not base64url!', 400, 'Ungültiger Datensatz', 'alphabet', 'request.badBlob');
    $bad($dev['token'], null, 400, 'Ungültiger Datensatz', 'missing', 'request.badBlob');
    assert_response(dv_press($dev['token'], dv_blob(29)), 201, null, 'the minimum');
    assert_response(dv_press($dev['token'], dv_blob(1024)), 201, null, 'the maximum');
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM device_events'), 2);
    assert_eq(fails_of($pdo, 'dev:' . T_IP), 17, 'every attempt counted, good or bad');

    // Without the JSON content type: 415, like every POST.
    logout();
    assert_error(api_call('POST', '/devices/events', ['token' => $dev['token'], 'blob' => dv_blob()], ['contentType' => 'text/plain']), 415, 'Ungültiger Content-Type – JSON erwartet', 'content type', 'request.badContentType');
    assert_error(api_call('GET', '/devices/events'), 405, 'Methode nicht erlaubt', 'GET', 'request.methodNotAllowed');
});

bt_test('devices: the address budget (60 an hour, before validation) and the pending cap (200 per family)', function () {
    $pdo = fresh_db();
    login_as($pdo, me());
    $dev = dv_register();
    for ($i = 0; $i < BT_DEVICE_MAX_PER_WINDOW - 1; $i++) {
        assert_response(dv_press($dev['token']), 201);
    }
    assert_error(dv_press($dev['token'], 'junk!'), 400, 'Ungültiger Datensatz', 'the 60th is junk but counted', 'request.badBlob');
    assert_error(
        dv_press($dev['token']),
        429,
        'Zu viele Tastendrücke in kurzer Zeit – bitte später nochmals versuchen',
        'the 61st',
        'devices.throttled',
        ['minutes' => 60]
    );
    assert_response(dv_press($dev['token'], dv_blob(), ['ip' => '198.51.100.7']), 201, null, 'another address has its own budget');
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM device_events'), BT_DEVICE_MAX_PER_WINDOW);

    // The pending cap: 200 presses nobody has processed answer 507 and store nothing.
    $pdo->exec('DELETE FROM login_attempts');
    $pdo->exec('BEGIN');
    $stmt = $pdo->prepare("INSERT INTO device_events (device_id, family_id, blob, created_at) VALUES (?, ?, 'SEALED', '2026-10-16')");
    for ($i = BT_DEVICE_MAX_PER_WINDOW; $i < BT_DEVICE_MAX_PENDING; $i++) {
        $stmt->execute([$dev['id'], fam()]);
    }
    $pdo->exec('COMMIT');
    assert_error(dv_press($dev['token']), 507, 'Zu viele unverarbeitete Tastendrücke – bitte die App öffnen', 'pending cap', 'devices.full');
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM device_events'), BT_DEVICE_MAX_PENDING);

    // The cap is per family: another family's device still gets through.
    $other = second_family($pdo);
    login_as($pdo, $other['user']);
    $theirs = dv_register();
    assert_response(dv_press($theirs['token']), 201, null, 'another family');
});

bt_test('devices: removing one kills its token at once and drops its waiting presses; a foreign or unknown id is a 404', function () {
    $pdo = fresh_db();
    login_as($pdo, me());
    $a = dv_register();
    $b = dv_register();
    assert_response(dv_press($a['token']), 201);
    assert_response(dv_press($b['token']), 201);
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM device_events'), 2);

    $other = second_family($pdo);
    login_as($pdo, $other['user']);
    assert_error(api_call('DELETE', "/devices/$a[id]"), 404, 'Taster nicht gefunden', 'another family', 'devices.notFound');
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM devices'), 2, 'nothing removed');

    login_as($pdo, me());
    assert_response(api_call('DELETE', "/devices/$a[id]"), 200, ['ok' => true]);
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM devices'), 1);
    assert_eq(count_of($pdo, "SELECT COUNT(*) FROM device_events WHERE device_id = $a[id]"), 0, 'its presses went with it');
    assert_eq(count_of($pdo, "SELECT COUNT(*) FROM device_events WHERE device_id = $b[id]"), 1, 'the other device keeps its press');
    assert_error(dv_press($a['token']), 404, 'Taster nicht gefunden', 'the removed device presses on', 'devices.notFound');
    assert_response(dv_press($b['token']), 201, null, 'the other device still works');
    assert_error(api_call('DELETE', "/devices/$a[id]"), 404, 'Taster nicht gefunden', 'twice', 'devices.notFound');
    assert_error(api_call('DELETE', '/devices/999'), 404, 'Taster nicht gefunden', 'unknown', 'devices.notFound');
    assert_error(api_call('DELETE', '/devices/abc'), 404, 'Taster nicht gefunden', 'not an id', 'devices.notFound');
    assert_error(api_call('PATCH', "/devices/$b[id]", ['x' => 1]), 405, 'Methode nicht erlaubt', 'PATCH', 'request.methodNotAllowed');
    assert_eq(fails_of($pdo, 'write:' . T_IP), 8, 'registrations and removals draw on the write budget');
});
