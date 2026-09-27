<?php
/**
 * Feedback (lib/feedback.php): members seal messages to the operator's inbox
 * key, the operator alone reads them, nothing stored links a message to its
 * sender. Helpers come from api.test.php (loaded first by run.php).
 *
 * Target: PHP 7.4+.
 */

const FB_CONFIG = ['config' => ['admin_username' => ' Mama ']]; // compared lowercased and trimmed

/** A public P-256 JWK of the right shape (random coordinates: the server never does EC math). */
function fb_jwk(array $over = []): array
{
    return array_merge(['kty' => 'EC', 'crv' => 'P-256', 'x' => fake_b64u(random_bytes(32)), 'y' => fake_b64u(random_bytes(32))], $over);
}

/** A sealed message of $bytes bytes: version byte 0x02, then random bytes. */
function fb_blob(int $bytes = 1122): string
{
    return fake_b64u("\x02" . random_bytes($bytes - 1));
}

/** The default account (mama, the operator under FB_CONFIG) sets up the inbox. */
function fb_setup(PDO $pdo): array
{
    login_as($pdo, me());
    $jwk = fb_jwk();
    assert_response(api_call('POST', '/feedback/key', ['publicKey' => $jwk, 'privateSealed' => fake_blob(300)], FB_CONFIG), 200);
    return $jwk;
}

bt_test('feedback: off without an operator — every route is a 404, the sync answer has no inbox count', function () {
    $pdo = fresh_db();
    login_as($pdo, me());
    assert_error(api_call('GET', '/feedback/key'), 404, 'Feedback ist nicht eingerichtet', 'key', 'feedback.unavailable');
    assert_error(api_call('POST', '/feedback', ['blob' => fb_blob()]), 404, 'Feedback ist nicht eingerichtet', 'send', 'feedback.unavailable');
    assert_error(api_call('GET', '/feedback'), 404, 'Nicht gefunden', 'inbox', 'request.notFound');
    assert_error(api_call('POST', '/feedback/key', ['publicKey' => fb_jwk(), 'privateSealed' => fake_blob()]), 404, 'Nicht gefunden', 'set key', 'request.notFound');
    assert_false(array_key_exists('feedbackUnread', api_call('GET', '/sync?since=0')[1]));
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM feedback'), 0);

    // Not logged in: 401 like every member route.
    logout();
    assert_error(api_call('GET', '/feedback/key', null, FB_CONFIG), 401, 'Nicht angemeldet', 'no cookie', 'auth.notLoggedIn');
});

bt_test('feedback: the operator sets up the inbox once; writers get the public key, nobody else the private half', function () {
    $pdo = fresh_db();
    $other = second_family($pdo);

    // Before the operator opened the inbox there is nothing to seal to.
    login_as($pdo, $other['user']);
    assert_false(array_key_exists('feedback', api_call('GET', '/sync?since=0', null, FB_CONFIG)[1]), 'no flag before the setup');
    assert_error(api_call('GET', '/feedback/key', null, FB_CONFIG), 404, 'Feedback ist nicht eingerichtet', 'not set up', 'feedback.unavailable');
    assert_error(api_call('POST', '/feedback', ['blob' => fb_blob()], FB_CONFIG), 404, 'Feedback ist nicht eingerichtet', 'send before setup', 'feedback.unavailable');
    // Only the operator may set it up.
    assert_error(api_call('POST', '/feedback/key', ['publicKey' => fb_jwk(), 'privateSealed' => fake_blob()], FB_CONFIG), 404, 'Nicht gefunden', 'a member', 'request.notFound');

    login_as($pdo, me());
    $sealed = fake_blob(300);
    // A private key can never be handed in as the public one.
    assert_error(api_call('POST', '/feedback/key', ['publicKey' => fb_jwk(['d' => fake_b64u(random_bytes(32))]), 'privateSealed' => $sealed], FB_CONFIG), 400, 'Ungültiger Schlüssel', 'a private JWK', 'feedback.badKey');
    assert_error(api_call('POST', '/feedback/key', ['publicKey' => fb_jwk(['crv' => 'P-384']), 'privateSealed' => $sealed], FB_CONFIG), 400, 'Ungültiger Schlüssel', 'another curve', 'feedback.badKey');
    assert_error(api_call('POST', '/feedback/key', ['publicKey' => fb_jwk(['x' => 'short']), 'privateSealed' => $sealed], FB_CONFIG), 400, 'Ungültiger Schlüssel', 'a bad coordinate', 'feedback.badKey');
    assert_error(api_call('POST', '/feedback/key', ['publicKey' => fb_jwk(), 'privateSealed' => 'no!'], FB_CONFIG), 400, 'Ungültiger Datensatz', 'a bad sealed half', 'request.badBlob');

    $jwk = fb_jwk(['ext' => true, 'key_ops' => []]);
    $res = api_call('POST', '/feedback/key', ['publicKey' => $jwk, 'privateSealed' => $sealed], FB_CONFIG);
    $public = ['kty' => 'EC', 'crv' => 'P-256', 'x' => $jwk['x'], 'y' => $jwk['y']];
    assert_response($res, 200, ['publicKey' => $public], 'stored reduced to the public fields');
    assert_error(api_call('POST', '/feedback/key', ['publicKey' => fb_jwk(), 'privateSealed' => fake_blob()], FB_CONFIG), 409, 'Das Postfach ist schon eingerichtet', 'once only', 'feedback.keyExists');

    login_as($pdo, $other['user']);
    assert_response(api_call('GET', '/feedback/key', null, FB_CONFIG), 200, ['publicKey' => $public], 'another family writes too');
    $page = api_call('GET', '/sync?since=0', null, FB_CONFIG)[1];
    assert_eq($page['feedback'] ?? null, true, 'every member learns that there is an inbox');
    assert_false(array_key_exists('feedbackUnread', $page), '… but no count');
    assert_false(array_key_exists('feedback', api_call('GET', '/sync?since=0')[1]), 'off: no flag');
    assert_error(api_call('GET', '/feedback', null, FB_CONFIG), 404, 'Nicht gefunden', 'a member reads no inbox', 'request.notFound');

    login_as($pdo, me());
    $inbox = api_call('GET', '/feedback', null, FB_CONFIG);
    assert_response($inbox, 200, ['publicKey' => $public, 'privateSealed' => $sealed, 'items' => [], 'next' => null, 'unread' => 0]);
});

bt_test('feedback: a message is stored without its sender — no user, no family, a day-granular date', function () {
    $pdo = fresh_db();
    $other = second_family($pdo);
    fb_setup($pdo);

    login_as($pdo, $other['user']);
    $blob = fb_blob();
    assert_response(api_call('POST', '/feedback', ['blob' => $blob], FB_CONFIG), 201, ['ok' => true]);
    $row = $pdo->query('SELECT * FROM feedback')->fetch(PDO::FETCH_ASSOC);
    assert_eq(array_keys($row), ['id', 'blob', 'created_at', 'read_at'], 'the whole row');
    assert_eq($row['blob'], $blob, 'stored verbatim');
    assert_true(preg_match('/^\d{4}-\d{2}-\d{2}$/D', $row['created_at']) === 1, 'a day, no time');
    assert_eq($row['read_at'], null);
    assert_eq(fails_of($pdo, 'fb:' . T_IP), 1, 'counted per address');
    assert_eq(count_of($pdo, "SELECT COUNT(*) FROM login_attempts WHERE ip LIKE 'user:%' OR ip LIKE 'fb:user%'"), 0, 'no counter per account');

    // Shape checks: the version byte, the length, canonical base64url.
    assert_error(api_call('POST', '/feedback', ['blob' => fake_blob(200)], FB_CONFIG), 400, 'Ungültiger Datensatz', 'an entry blob (0x01)', 'request.badBlob');
    assert_error(api_call('POST', '/feedback', ['blob' => fb_blob(60)], FB_CONFIG), 400, 'Ungültiger Datensatz', 'too short', 'request.badBlob');
    assert_error(api_call('POST', '/feedback', ['blob' => fb_blob(4609)], FB_CONFIG), 413, 'Die Nachricht ist zu lang', 'too long', 'feedback.tooLarge');
    assert_error(api_call('POST', '/feedback', ['blob' => str_repeat('A', 7000)], FB_CONFIG), 413, 'Die Nachricht ist zu lang', 'too long before decoding', 'feedback.tooLarge');
    assert_error(api_call('POST', '/feedback', ['blob' => fb_blob() . '='], FB_CONFIG), 400, 'Ungültiger Datensatz', 'padding', 'request.badBlob');
    assert_error(api_call('POST', '/feedback', [], FB_CONFIG), 400, 'Ungültiger Datensatz', 'no blob', 'request.badBlob');
    assert_response(api_call('POST', '/feedback', ['blob' => fb_blob(4608)], FB_CONFIG), 201, null, 'the largest bucket fits');
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM feedback'), 2);
});

bt_test('feedback: the address budget (10 an hour, before validation) and the row cap', function () {
    $pdo = fresh_db();
    fb_setup($pdo);
    for ($i = 0; $i < 9; $i++) {
        api_call('POST', '/feedback', ['blob' => fb_blob()], FB_CONFIG);
    }
    assert_error(api_call('POST', '/feedback', ['blob' => 'junk'], FB_CONFIG), 400, 'Ungültiger Datensatz', 'the 10th is junk but counted', 'request.badBlob');
    assert_error(
        api_call('POST', '/feedback', ['blob' => fb_blob()], FB_CONFIG),
        429,
        'Zu viele Nachrichten in kurzer Zeit – bitte später nochmals versuchen',
        'the 11th',
        'feedback.throttled',
        ['minutes' => 60]
    );
    assert_response(api_call('POST', '/feedback', ['blob' => fb_blob()], FB_CONFIG + ['ip' => '198.51.100.7']), 201, null, 'another address has its own budget');
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM feedback'), 10);

    // The cap: a full table answers 507 and stores nothing.
    $pdo->exec('DELETE FROM login_attempts');
    $stmt = $pdo->prepare("INSERT INTO feedback (blob, created_at) VALUES ('X', '2026-09-01')");
    for ($i = 10; $i < BT_FEEDBACK_MAX_ROWS; $i++) {
        $stmt->execute();
    }
    assert_error(api_call('POST', '/feedback', ['blob' => fb_blob()], FB_CONFIG), 507, 'Das Postfach ist voll – bitte später nochmals versuchen', 'full', 'feedback.full');
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM feedback'), BT_FEEDBACK_MAX_ROWS);
});

bt_test('feedback: the operator reads (newest first, paged), marks read, deletes for good; the sync answer counts the unread for the operator only', function () {
    $pdo = fresh_db();
    $other = second_family($pdo);
    fb_setup($pdo);
    $pdo->exec('DELETE FROM login_attempts');
    $blobs = [];
    for ($i = 0; $i < 3; $i++) {
        $blobs[] = $b = fb_blob();
        assert_response(api_call('POST', '/feedback', ['blob' => $b], FB_CONFIG), 201);
    }

    assert_eq(api_call('GET', '/sync?since=0', null, FB_CONFIG)[1]['feedbackUnread'] ?? null, 3, 'the operator sees the count');
    $inbox = api_call('GET', '/feedback', null, FB_CONFIG)[1];
    assert_eq(array_column($inbox['items'], 'blob'), array_reverse($blobs), 'newest first');
    assert_eq($inbox['unread'], 3);
    $newest = $inbox['items'][0]['id'];
    $oldest = $inbox['items'][2]['id'];

    $res = api_call('PATCH', "/feedback/$newest", ['read' => true], FB_CONFIG);
    assert_eq($res[0], 200);
    assert_true(is_string($res[1]['readAt']), 'read on a day');
    assert_eq(api_call('GET', '/sync?since=0', null, FB_CONFIG)[1]['feedbackUnread'], 2);
    assert_eq(api_call('PATCH', "/feedback/$newest", ['read' => false], FB_CONFIG)[1]['readAt'], null, 'back to unread');
    assert_error(api_call('PATCH', "/feedback/$newest", ['read' => 'yes'], FB_CONFIG), 400, 'Ungültige Angabe', 'a bool', 'feedback.badRead');

    assert_response(api_call('DELETE', "/feedback/$oldest", null, FB_CONFIG), 200, ['ok' => true]);
    assert_eq(count_of($pdo, "SELECT COUNT(*) FROM feedback WHERE id = $oldest"), 0, 'gone, not a tombstone');
    assert_error(api_call('DELETE', "/feedback/$oldest", null, FB_CONFIG), 404, 'Nachricht nicht gefunden', 'twice', 'feedback.notFound');
    assert_error(api_call('PATCH', '/feedback/abc', ['read' => true], FB_CONFIG), 404, 'Nachricht nicht gefunden', 'not an id', 'feedback.notFound');
    assert_error(api_call('PUT', "/feedback/$newest", null, FB_CONFIG), 405, 'Methode nicht erlaubt', 'PUT', 'request.methodNotAllowed');

    // Paging: ?before=<id> continues below it.
    $page = api_call('GET', "/feedback?before=$newest", null, FB_CONFIG)[1];
    assert_eq(count($page['items']), 1);
    assert_eq($page['next'], null);

    // Anyone else: the same 404 on every inbox route, no count on sync.
    login_as($pdo, $other['user']);
    assert_false(array_key_exists('feedbackUnread', api_call('GET', '/sync?since=0', null, FB_CONFIG)[1]));
    assert_error(api_call('PATCH', "/feedback/$newest", ['read' => true], FB_CONFIG), 404, 'Nicht gefunden', 'member patch', 'request.notFound');
    assert_error(api_call('DELETE', "/feedback/$newest", null, FB_CONFIG), 404, 'Nicht gefunden', 'member delete', 'request.notFound');
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM feedback'), 2, 'nothing a member can remove');
});

bt_test('feedback: inbox pages of 100', function () {
    $pdo = fresh_db();
    fb_setup($pdo);
    $stmt = $pdo->prepare("INSERT INTO feedback (blob, created_at) VALUES (?, '2026-09-01')");
    for ($i = 1; $i <= 150; $i++) {
        $stmt->execute(["B$i"]);
    }
    $first = api_call('GET', '/feedback', null, FB_CONFIG)[1];
    assert_eq(count($first['items']), 100);
    assert_eq($first['items'][0]['blob'], 'B150');
    assert_eq($first['next'], 51);
    $second = api_call('GET', '/feedback?before=51', null, FB_CONFIG)[1];
    assert_eq(count($second['items']), 50);
    assert_eq($second['items'][49]['blob'], 'B1');
    assert_eq($second['next'], null);
});

bt_test('feedback: helpers — the operator by lowercased name, off when empty', function () {
    $user = ['username' => 'mama'];
    assert_true(bt_feedback_is_admin(['admin_username' => 'MAMA '], $user));
    assert_false(bt_feedback_is_admin(['admin_username' => 'papa'], $user));
    assert_false(bt_feedback_is_admin(['admin_username' => ''], $user), 'empty = off');
    assert_false(bt_feedback_is_admin([], $user), 'no config = off');
    assert_false(bt_feedback_on(['admin_username' => '  ']));
});
