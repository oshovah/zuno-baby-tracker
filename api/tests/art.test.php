<?php
/**
 * Private artwork (lib/art.php): pictures for ONE family, the same 404 for
 * everyone and everything else, and the version key on the sync answer.
 * Helpers come from api.test.php (loaded first by run.php).
 *
 * Target: PHP 7.4+.
 */

/** A scratch artwork folder holding $names (each file = its own name as bytes); removed at shutdown. */
function art_dir(array $names): string
{
    $dir = sys_get_temp_dir() . '/bt-art-' . bin2hex(random_bytes(6));
    mkdir($dir);
    foreach ($names as $name) {
        file_put_contents($dir . '/' . $name, 'PNG:' . $name);
    }
    register_shutdown_function(function () use ($dir) {
        foreach ((array) glob($dir . '/*') as $file) {
            @unlink($file);
        }
        @rmdir($dir);
    });
    return $dir;
}

bt_test('art: members of the configured family get the file; strangers, other families and unknown names the same 404', function () {
    $pdo = fresh_db();
    $other = second_family($pdo);
    $dir = art_dir(['favicon.png', 'zuno.png', 'secret.txt']);
    $config = ['private_art_family' => '  TESTFAMILIE ', 'private_art_dir' => $dir]; // compared as the name key
    $opts = ['config' => $config];

    // No cookie: 404, not 401 — the route must not say "log in and look again".
    assert_error(api_call('GET', '/art/favicon.png', null, $opts), 404, 'Nicht gefunden', 'stranger', 'request.notFound');

    login_as($pdo, $other['user']);
    assert_error(api_call('GET', '/art/favicon.png', null, $opts), 404, 'Nicht gefunden', 'another family', 'request.notFound');

    login_as($pdo, me());
    $res = api_call('GET', '/art/favicon.png', null, $opts);
    assert_eq($res[0], 200, 'member: status');
    assert_true($res[1] instanceof BtFileResponse, 'member: a file answer');
    assert_eq($res[1]->path, $dir . '/favicon.png');
    assert_eq($res[1]->contentType, 'image/png');

    // Only names of BT_ART_NAMES, only files that exist, no way out of the folder.
    assert_error(api_call('GET', '/art/secret.txt', null, $opts), 404, 'Nicht gefunden', 'a file outside the list', 'request.notFound');
    assert_error(api_call('GET', '/art/icon-512.png', null, $opts), 404, 'Nicht gefunden', 'a listed name without a file', 'request.notFound');
    assert_error(api_call('GET', '/art/..%2Ffavicon.png', null, $opts), 404, 'Nicht gefunden', 'traversal', 'request.notFound');
    assert_error(api_call('POST', '/art/favicon.png', [], $opts), 405, 'Methode nicht erlaubt', 'GET only', 'request.methodNotAllowed');

    // Feature off (no family configured): nobody gets anything, the member included.
    assert_error(api_call('GET', '/art/favicon.png', null, ['config' => ['private_art_dir' => $dir]]), 404, 'Nicht gefunden', 'off', 'request.notFound');
    assert_error(api_call('GET', '/art/favicon.png'), 404, 'Nicht gefunden', 'no config at all', 'request.notFound');
});

bt_test('art: the sync answer carries the version for members only, and it follows the files', function () {
    $pdo = fresh_db();
    $other = second_family($pdo);
    $dir = art_dir(['favicon.png']);
    $opts = ['config' => ['private_art_family' => 'Testfamilie', 'private_art_dir' => $dir]];

    login_as($pdo, me());
    $page = api_call('GET', '/sync?since=0', null, $opts);
    assert_eq($page[0], 200);
    assert_true(is_string($page[1]['art'] ?? null) && strlen($page[1]['art']) === 12, 'member: a 12-char version');
    $v1 = $page[1]['art'];
    assert_eq(api_call('GET', '/sync?since=0', null, $opts)[1]['art'], $v1, 'stable while nothing changes');

    file_put_contents($dir . '/zuno.png', 'PNG:zuno, a second picture');
    clearstatcache();
    $v2 = api_call('GET', '/sync?since=0', null, $opts)[1]['art'];
    assert_true($v2 !== $v1, 'a new file moves the version');

    login_as($pdo, $other['user']);
    assert_false(array_key_exists('art', api_call('GET', '/sync?since=0', null, $opts)[1]), 'another family: no key at all');

    login_as($pdo, me());
    assert_false(array_key_exists('art', api_call('GET', '/sync?since=0')[1]), 'feature off: no key');
    $empty = art_dir([]);
    $none = api_call('GET', '/sync?since=0', null, ['config' => ['private_art_family' => 'Testfamilie', 'private_art_dir' => $empty]]);
    assert_false(array_key_exists('art', $none[1]), 'an empty folder: no key');
});

bt_test('art: helpers — the default folder, membership by name key, null users', function () {
    assert_eq(bt_art_dir([]), dirname(__DIR__, 2) . '/private-art');
    assert_eq(bt_art_dir(['private_art_dir' => '/srv/art/']), '/srv/art');
    $user = ['familyName' => 'Müller  Meier'];
    assert_true(bt_art_member(['private_art_family' => 'müller meier'], $user), 'case and whitespace folded');
    assert_false(bt_art_member(['private_art_family' => 'Müller'], $user));
    assert_false(bt_art_member(['private_art_family' => ''], $user), 'empty = off');
    assert_false(bt_art_member(['private_art_family' => 'müller meier'], null), 'no user');
    assert_eq(bt_art_version(['private_art_family' => 'müller meier'], null), null);
});

bt_test('art: the capability link — files and the manifest for whoever holds the key, the same 404 for everything else, no session involved', function () {
    $pdo = fresh_db();
    $other = second_family($pdo);
    $dir = art_dir(['favicon.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'secret.txt']);
    $opts = ['config' => ['private_art_family' => 'Testfamilie', 'private_art_dir' => $dir]];

    // Before any member synced there is no key: guesses create nothing.
    $pdo->exec("DELETE FROM settings WHERE key = 'art_key'");
    assert_error(api_call('GET', '/art/k/' . str_repeat('0', 32) . '/icon-192.png', null, $opts), 404, 'Nicht gefunden', 'no key yet', 'request.notFound');
    assert_eq(bt_setting($pdo, 'art_key'), null, 'a stranger never makes the key');

    // Members get the key with the version; nobody else does.
    login_as($pdo, $other['user']);
    assert_false(array_key_exists('artKey', api_call('GET', '/sync?since=0', null, $opts)[1]), 'another family: no key');
    login_as($pdo, me());
    assert_false(array_key_exists('artKey', api_call('GET', '/sync?since=0')[1]), 'feature off: no key');
    $page = api_call('GET', '/sync?since=0', null, $opts)[1];
    $key = $page['artKey'] ?? null;
    assert_true(is_string($key) && preg_match('/^[0-9a-f]{32}$/', $key) === 1, 'member: 32 hex digits');
    assert_eq(api_call('GET', '/sync?since=0', null, $opts)[1]['artKey'], $key, 'stable');

    // The link works WITHOUT a session — that is its point.
    logout();
    $res = api_call('GET', "/art/k/$key/icon-512.png", null, $opts);
    assert_eq($res[0], 200);
    assert_true($res[1] instanceof BtFileResponse, 'a file answer');
    assert_eq($res[1]->path, $dir . '/icon-512.png');

    $m = api_call('GET', "/art/k/$key/manifest.webmanifest", null, $opts);
    assert_eq($m[0], 200);
    assert_eq($m[1]['start_url'], '../../../../');
    assert_eq($m[1]['scope'], '../../../../');
    assert_eq($m[1]['id'], './', 'the same app id as the public manifest');
    assert_eq($m[1]['short_name'], 'Zuno');
    assert_eq(array_column($m[1]['icons'], 'src'), ['icon-192.png', 'icon-192.png', 'icon-512.png', 'icon-512.png']);
    assert_eq(array_column($m[1]['icons'], 'purpose'), ['any', 'maskable', 'any', 'maskable']);

    // Wrong key, unknown name, traversal, other verbs, feature off: the same 404 / 405.
    $wrong = strrev($key) === $key ? str_repeat('1', 32) : strrev($key);
    assert_error(api_call('GET', "/art/k/$wrong/icon-512.png", null, $opts), 404, 'Nicht gefunden', 'wrong key', 'request.notFound');
    assert_error(api_call('GET', "/art/k/$key/secret.txt", null, $opts), 404, 'Nicht gefunden', 'a file outside the list', 'request.notFound');
    assert_error(api_call('GET', "/art/k/$key/zuno.png", null, $opts), 404, 'Nicht gefunden', 'a listed name without a file', 'request.notFound');
    assert_error(api_call('GET', "/art/k/$key/..%2Ficon-512.png", null, $opts), 404, 'Nicht gefunden', 'traversal', 'request.notFound');
    assert_error(api_call('POST', "/art/k/$key/icon-512.png", [], $opts), 405, 'Methode nicht erlaubt', 'GET only', 'request.methodNotAllowed');
    assert_error(api_call('GET', "/art/k/$key/icon-512.png"), 404, 'Nicht gefunden', 'feature off', 'request.notFound');

    // No install icons in the folder: no manifest either (the public one stays in use).
    $few = art_dir(['favicon.png']);
    $fewOpts = ['config' => ['private_art_family' => 'Testfamilie', 'private_art_dir' => $few]];
    assert_error(api_call('GET', "/art/k/$key/manifest.webmanifest", null, $fewOpts), 404, 'Nicht gefunden', 'no icons', 'request.notFound');
});
