<?php
/**
 * Spots (lib/spots.php): members report map places, the operator curates
 * them, every phone reads the approved list; nothing stored links a report
 * to its sender. Helpers come from api.test.php (loaded first by run.php).
 *
 * Target: PHP 7.4+.
 */

const SP_CONFIG = ['config' => ['admin_username' => ' Mama ']]; // compared lowercased and trimmed

const SP_TEXT_ERROR = 'Name höchstens 80 Zeichen, Notiz höchstens 300 Zeichen';

/** A report body: a changing table at the Zytglogge; override any field. */
function sp_body(array $over = []): array
{
    return array_merge(['lat' => 46.948, 'lon' => 7.4479, 'kinds' => ['changing'], 'name' => 'WC Test', 'note' => 'Im 1. Stock'], $over);
}

/** Every row, oldest first. */
function sp_rows(PDO $pdo): array
{
    return $pdo->query('SELECT * FROM spots ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
}

bt_test('spots: off without an operator — every route is a 404, the sync answer has no spots fields', function () {
    $pdo = fresh_db();
    login_as($pdo, me());
    assert_error(api_call('POST', '/spots', sp_body()), 404, 'Orte melden ist nicht eingerichtet', 'report', 'spots.unavailable');
    assert_error(api_call('GET', '/spots'), 404, 'Orte melden ist nicht eingerichtet', 'list', 'spots.unavailable');
    assert_error(api_call('GET', '/spots/pending'), 404, 'Nicht gefunden', 'pending', 'request.notFound');
    assert_error(api_call('PATCH', '/spots/1', ['approve' => true]), 404, 'Nicht gefunden', 'approve', 'request.notFound');
    assert_error(api_call('DELETE', '/spots/1'), 404, 'Nicht gefunden', 'delete', 'request.notFound');
    $page = api_call('GET', '/sync?since=0')[1];
    assert_false(array_key_exists('spots', $page), 'no version');
    assert_false(array_key_exists('spotsPending', $page), 'no count');
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM spots'), 0);
    assert_eq(fails_of($pdo, 'spot:' . T_IP), 1, 'the budget is charged before the feature check, like feedback');

    // Not logged in: 401 like every member route.
    logout();
    assert_error(api_call('GET', '/spots', null, SP_CONFIG), 401, 'Nicht angemeldet', 'no cookie', 'auth.notLoggedIn');
    assert_error(api_call('POST', '/spots', sp_body(), SP_CONFIG), 401, 'Nicht angemeldet', 'no cookie, report', 'auth.notLoggedIn');
});

bt_test('spots: a report is stored pending, without its sender — a day-granular date, texts normalised, coordinates to five decimals', function () {
    $pdo = fresh_db();
    $other = second_family($pdo);
    login_as($pdo, $other['user']);
    $body = sp_body(['lat' => 46.9480001234, 'lon' => 7.44791, 'name' => "  WC   Test\n", 'note' => '', 'kinds' => ['nursing', 'changing']]);
    assert_response(api_call('POST', '/spots', $body, SP_CONFIG), 201, ['ok' => true]);
    $row = sp_rows($pdo)[0];
    assert_eq(array_keys($row), ['id', 'status', 'lat', 'lon', 'kinds', 'name', 'note', 'created_at', 'decided_at'], 'the whole row');
    assert_eq($row['status'], 'pending');
    assert_eq((float) $row['lat'], 46.948, 'five decimals');
    assert_eq((float) $row['lon'], 7.44791);
    assert_eq($row['kinds'], 'changing,nursing', 'canonical order');
    assert_eq($row['name'], 'WC Test', 'whitespace collapsed');
    assert_eq($row['note'], '');
    assert_true(preg_match('/^\d{4}-\d{2}-\d{2}$/D', $row['created_at']) === 1, 'a day, no time');
    assert_eq($row['decided_at'], null);
    assert_eq(fails_of($pdo, 'spot:' . T_IP), 1, 'counted per address');
    assert_eq(count_of($pdo, "SELECT COUNT(*) FROM login_attempts WHERE ip LIKE 'user:%' OR ip LIKE 'spot:user%'"), 0, 'no counter per account');

    // A position and a kind are a report; name and note may stay empty.
    assert_response(api_call('POST', '/spots', ['lat' => 47, 'lon' => 8, 'kinds' => ['changing']], SP_CONFIG), 201, ['ok' => true]);
    assert_eq(sp_rows($pdo)[1]['name'], '');
    assert_eq(sp_rows($pdo)[1]['note'], '');
});

bt_test('spots: validation — the position, the kinds, the text lengths; every attempt counts against the budget', function () {
    $pdo = fresh_db();
    login_as($pdo, me());
    $bad = function (array $over, string $message, string $label, string $code, ?array $params = null) {
        assert_error(api_call('POST', '/spots', sp_body($over), SP_CONFIG), 400, $message, $label, $code, $params);
    };
    $positions = [['lat' => '46.9'], ['lat' => null], ['lat' => 90.5], ['lon' => -181], ['lon' => true], ['lat' => 'NaN']];
    foreach ($positions as $over) {
        $bad($over, 'Ungültige Position', bt_format($over), 'spots.badPosition');
    }
    assert_eq(fails_of($pdo, 'spot:' . T_IP), count($positions), 'every attempt counted, good or bad');
    $pdo->exec('DELETE FROM login_attempts');
    $kinds = [['kinds' => []], ['kinds' => ['x']], ['kinds' => ['changing', 'changing']], ['kinds' => ['changing', 'nursing', 'changing']], ['kinds' => 'changing'], ['kinds' => null]];
    foreach ($kinds as $over) {
        $bad($over, 'Ungültige Art des Orts', bt_format($over), 'spots.badKinds');
    }
    $pdo->exec('DELETE FROM login_attempts');
    $limits = ['name' => 80, 'note' => 300];
    $bad(['name' => str_repeat('a', 81)], SP_TEXT_ERROR, 'name 81', 'spots.badText', $limits);
    $bad(['note' => str_repeat('ä', 301)], SP_TEXT_ERROR, 'note 301 (multibyte)', 'spots.badText', $limits);
    $bad(['name' => ['x']], SP_TEXT_ERROR, 'name not a string', 'spots.badText', $limits);
    assert_response(api_call('POST', '/spots', sp_body(['name' => str_repeat('ä', 80), 'note' => str_repeat('ö', 300)]), SP_CONFIG), 201, null, 'the limits themselves fit');
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM spots'), 1);
    assert_eq(fails_of($pdo, 'spot:' . T_IP), 4);
});

bt_test('spots: the address budget (10 an hour, before validation) and the caps (200 pending, 5000 rows)', function () {
    $pdo = fresh_db();
    login_as($pdo, me());
    for ($i = 0; $i < 9; $i++) {
        assert_response(api_call('POST', '/spots', sp_body(), SP_CONFIG), 201);
    }
    assert_error(api_call('POST', '/spots', sp_body(['kinds' => []]), SP_CONFIG), 400, 'Ungültige Art des Orts', 'the 10th is junk but counted', 'spots.badKinds');
    assert_error(
        api_call('POST', '/spots', sp_body(), SP_CONFIG),
        429,
        'Zu viele Meldungen in kurzer Zeit – bitte später nochmals versuchen',
        'the 11th',
        'spots.throttled',
        ['minutes' => 60]
    );
    assert_response(api_call('POST', '/spots', sp_body(), SP_CONFIG + ['ip' => '198.51.100.7']), 201, null, 'another address has its own budget');
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM spots'), 10);

    // The pending cap: 200 unchecked reports answer 507 and store nothing.
    $pdo->exec('DELETE FROM login_attempts');
    $pdo->exec('BEGIN');
    $stmt = $pdo->prepare("INSERT INTO spots (status, lat, lon, kinds, name, note, created_at) VALUES ('pending', 47, 8, 'changing', '', '', '2026-10-01')");
    for ($i = 10; $i < BT_SPOT_MAX_PENDING; $i++) {
        $stmt->execute();
    }
    $pdo->exec('COMMIT');
    assert_error(api_call('POST', '/spots', sp_body(), SP_CONFIG), 507, 'Die Liste der gemeldeten Orte ist voll – bitte später nochmals versuchen', 'pending cap', 'spots.full');
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM spots'), BT_SPOT_MAX_PENDING);

    // The row cap: approved rows count too.
    $pdo->exec("UPDATE spots SET status = 'approved', decided_at = '2026-10-02'");
    $pdo->exec('BEGIN');
    $stmt = $pdo->prepare("INSERT INTO spots (status, lat, lon, kinds, name, note, created_at, decided_at) VALUES ('approved', 47, 8, 'changing', '', '', '2026-10-01', '2026-10-02')");
    for ($i = BT_SPOT_MAX_PENDING; $i < BT_SPOT_MAX_ROWS; $i++) {
        $stmt->execute();
    }
    $pdo->exec('COMMIT');
    assert_error(api_call('POST', '/spots', sp_body(), SP_CONFIG), 507, 'Die Liste der gemeldeten Orte ist voll – bitte später nochmals versuchen', 'row cap', 'spots.full');
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM spots'), BT_SPOT_MAX_ROWS);
});

bt_test('spots: the operator reads the pending reports oldest first, corrects, approves, deletes; the version counts changes to the approved list', function () {
    $pdo = fresh_db();
    $other = second_family($pdo);
    login_as($pdo, $other['user']);
    assert_response(api_call('POST', '/spots', sp_body(['name' => 'Erster']), SP_CONFIG), 201);
    assert_response(api_call('POST', '/spots', sp_body(['name' => 'Zweiter', 'kinds' => ['nursing']]), SP_CONFIG), 201);
    assert_response(api_call('POST', '/spots', sp_body(['name' => 'Dritter']), SP_CONFIG), 201);
    assert_response(api_call('GET', '/spots', null, SP_CONFIG), 200, ['version' => 0, 'items' => []], 'nothing approved yet');

    login_as($pdo, me());
    assert_eq(api_call('GET', '/sync?since=0', null, SP_CONFIG)[1]['spotsPending'] ?? null, 3, 'the operator sees the count');
    $pending = api_call('GET', '/spots/pending', null, SP_CONFIG);
    assert_eq($pending[0], 200);
    assert_eq(array_column($pending[1]['items'], 'name'), ['Erster', 'Zweiter', 'Dritter'], 'oldest first');
    $first = $pending[1]['items'][0];
    assert_eq(array_keys($first), ['id', 'lat', 'lon', 'kinds', 'name', 'note', 'status', 'createdAt', 'decidedAt'], 'operator JSON');
    assert_eq($first['status'], 'pending');
    assert_eq($first['kinds'], ['changing']);
    assert_eq($first['decidedAt'], null);
    $ids = array_column($pending[1]['items'], 'id');

    // Approve with a correction: approved today, the version moves to 1.
    $res = api_call('PATCH', "/spots/$ids[0]", ['approve' => true, 'name' => 'WC Erster', 'kinds' => ['nursing', 'changing']], SP_CONFIG);
    assert_eq($res[0], 200);
    assert_eq($res[1]['status'], 'approved');
    assert_eq($res[1]['name'], 'WC Erster');
    assert_eq($res[1]['kinds'], ['changing', 'nursing'], 'canonical order');
    assert_true(preg_match('/^\d{4}-\d{2}-\d{2}$/D', (string) $res[1]['decidedAt']) === 1, 'decided on a day');
    assert_eq(bt_spots_version($pdo), 1);
    $page = api_call('GET', '/sync?since=0', null, SP_CONFIG)[1];
    assert_eq($page['spots'], 1, 'the version travels on the sync page');
    assert_eq($page['spotsPending'], 2);

    // A correction on an approved row moves the version; one on a pending row does not.
    assert_eq(api_call('PATCH', "/spots/$ids[0]", ['note' => 'Im UG'], SP_CONFIG)[1]['note'], 'Im UG');
    assert_eq(bt_spots_version($pdo), 2);
    assert_eq(api_call('PATCH', "/spots/$ids[1]", ['note' => 'Noch offen'], SP_CONFIG)[1]['status'], 'pending');
    assert_eq(bt_spots_version($pdo), 2, 'a pending row is on no phone');
    assert_eq(api_call('PATCH', "/spots/$ids[0]", ['approve' => true], SP_CONFIG)[1]['status'], 'approved', 'approving twice changes nothing');
    assert_eq(bt_spots_version($pdo), 2);
    assert_eq(api_call('PATCH', "/spots/$ids[1]", ['approve' => false], SP_CONFIG)[1]['status'], 'pending', 'approve counts only as exactly true');
    assert_eq(api_call('PATCH', "/spots/$ids[1]", ['approve' => 'yes'], SP_CONFIG)[1]['status'], 'pending');

    // Corrections are validated like a report.
    assert_error(api_call('PATCH', "/spots/$ids[1]", ['kinds' => ['x']], SP_CONFIG), 400, 'Ungültige Art des Orts', 'bad kinds', 'spots.badKinds');
    assert_error(api_call('PATCH', "/spots/$ids[1]", ['name' => str_repeat('x', 81)], SP_CONFIG), 400, SP_TEXT_ERROR, 'bad name', 'spots.badText', ['name' => 80, 'note' => 300]);
    assert_eq(sp_rows($pdo)[1]['note'], 'Noch offen', 'a refused correction changes nothing');

    // Reject a pending one (gone, the version stays), later withdraw the approved one (the version moves).
    assert_response(api_call('DELETE', "/spots/$ids[2]", null, SP_CONFIG), 200, ['ok' => true]);
    assert_eq(bt_spots_version($pdo), 2);
    assert_eq(count_of($pdo, "SELECT COUNT(*) FROM spots WHERE id = $ids[2]"), 0, 'gone, not a tombstone');
    assert_error(api_call('DELETE', "/spots/$ids[2]", null, SP_CONFIG), 404, 'Ort nicht gefunden', 'twice', 'spots.notFound');
    assert_error(api_call('PATCH', '/spots/abc', ['approve' => true], SP_CONFIG), 404, 'Ort nicht gefunden', 'not an id', 'spots.notFound');
    assert_error(api_call('PATCH', '/spots/999', ['approve' => true], SP_CONFIG), 404, 'Ort nicht gefunden', 'unknown id', 'spots.notFound');
    assert_error(api_call('PUT', "/spots/$ids[0]", null, SP_CONFIG), 405, 'Methode nicht erlaubt', 'PUT', 'request.methodNotAllowed');
    assert_error(api_call('POST', '/spots/pending', [], SP_CONFIG), 405, 'Methode nicht erlaubt', 'POST pending', 'request.methodNotAllowed');

    // Every phone: the approved rows, public fields only, id ascending.
    login_as($pdo, $other['user']);
    $list = api_call('GET', '/spots', null, SP_CONFIG);
    assert_eq($list[0], 200);
    assert_eq($list[1]['version'], 2);
    assert_eq(count($list[1]['items']), 1);
    assert_eq(array_keys($list[1]['items'][0]), ['id', 'lat', 'lon', 'kinds', 'name', 'note'], 'public JSON: no status, no dates');
    assert_eq($list[1]['items'][0]['name'], 'WC Erster');
    assert_eq($list[1]['items'][0]['lat'], 46.948);
    assert_eq($list[1]['items'][0]['kinds'], ['changing', 'nursing']);

    login_as($pdo, me());
    assert_response(api_call('DELETE', "/spots/$ids[0]", null, SP_CONFIG), 200, ['ok' => true]);
    assert_eq(bt_spots_version($pdo), 3, 'withdrawing an approved place moves the version');
    assert_response(api_call('GET', '/spots', null, SP_CONFIG), 200, ['version' => 3, 'items' => []]);
    assert_eq(api_call('GET', '/sync?since=0', null, SP_CONFIG)[1]['spotsPending'], 1, 'the second report still waits');
});

bt_test('spots: everyone but the operator gets the same 404 on the curation routes, whatever the method; nothing a member can change', function () {
    $pdo = fresh_db();
    $other = second_family($pdo);
    login_as($pdo, $other['user']);
    assert_response(api_call('POST', '/spots', sp_body(), SP_CONFIG), 201);
    $id = (int) $pdo->query('SELECT id FROM spots')->fetchColumn();
    foreach (['GET', 'POST', 'PATCH', 'DELETE'] as $m) {
        assert_error(api_call($m, '/spots/pending', $m === 'GET' || $m === 'DELETE' ? null : [], SP_CONFIG), 404, 'Nicht gefunden', "$m pending", 'request.notFound');
    }
    assert_error(api_call('PATCH', "/spots/$id", ['approve' => true], SP_CONFIG), 404, 'Nicht gefunden', 'a member approves', 'request.notFound');
    assert_error(api_call('DELETE', "/spots/$id", null, SP_CONFIG), 404, 'Nicht gefunden', 'a member deletes', 'request.notFound');
    assert_error(api_call('PATCH', '/spots/abc', ['approve' => true], SP_CONFIG), 404, 'Nicht gefunden', 'a member learns nothing about ids', 'request.notFound');
    assert_eq($pdo->query('SELECT status FROM spots')->fetchColumn(), 'pending');
    $page = api_call('GET', '/sync?since=0', null, SP_CONFIG)[1];
    assert_eq($page['spots'] ?? null, 0, 'every member gets the version');
    assert_false(array_key_exists('spotsPending', $page), '… but no pending count');

    // Without an operator configured the operator herself is just a member, and the sync page is as before.
    login_as($pdo, me());
    assert_error(api_call('GET', '/spots/pending'), 404, 'Nicht gefunden', 'no operator configured', 'request.notFound');
    assert_eq(array_keys(api_call('GET', '/sync')[1]), ['serverNow', 'feed', 'rows', 'next'], 'the sync page without an operator');
});

bt_test('spots: helpers — kinds in canonical order, a stored kind the server no longer knows is dropped from the JSON', function () {
    assert_eq(bt_valid_spot_kinds(['nursing', 'changing']), 'changing,nursing');
    assert_eq(bt_valid_spot_kinds(['nursing']), 'nursing');
    $row = ['id' => '7', 'status' => 'approved', 'lat' => '46.948', 'lon' => '7.4479', 'kinds' => 'changing,playground', 'name' => 'X', 'note' => '', 'created_at' => '2026-10-12', 'decided_at' => null];
    assert_eq(bt_spot_json($row), ['id' => 7, 'lat' => 46.948, 'lon' => 7.4479, 'kinds' => ['changing'], 'name' => 'X', 'note' => '']);
    assert_true(bt_spots_on(['admin_username' => 'mama']));
    assert_false(bt_spots_on(['admin_username' => ' ']), 'off when empty');
    assert_http_error(function () {
        bt_valid_spot_coordinate(NAN, 90.0);
    }, 400, 'NaN', 'spots.badPosition');
    assert_http_error(function () {
        bt_valid_spot_coordinate(INF, 180.0);
    }, 400, 'Inf', 'spots.badPosition');
});
