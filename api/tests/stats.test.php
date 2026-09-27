<?php
/**
 * Usage numbers (lib/stats.php): counts for the operator only, the windows
 * by the rows' day-granular dates. Helpers come from api.test.php (loaded
 * first by run.php).
 *
 * Target: PHP 7.4+.
 */

bt_test('stats: counts families, accounts and rows; active and new by the day windows', function () {
    $pdo = fresh_db();                    // mama in Testfamilie
    $other = second_family($pdo);         // papa2 in Andere
    $fam2 = (int) $other['user']['familyId'];
    $pdo->exec("UPDATE users SET created_at = '2026-07-01'");
    $pdo->prepare('UPDATE users SET created_at = ? WHERE id = ?')->execute(['2026-08-20', (int) $other['user']['id']]);

    // Testfamilie wrote today and 10 days ago; Andere only 40 days ago.
    bt_create_entry($pdo, fam(), ['eid' => fake_eid(), 'blob' => fake_blob()], '2026-09-01');
    bt_create_entry($pdo, fam(), ['eid' => fake_eid(), 'blob' => fake_blob()], '2026-08-22');
    $old = fake_eid();
    bt_create_entry($pdo, $fam2, ['eid' => $old, 'blob' => fake_blob()], '2026-07-23');
    $gone = fake_eid();
    bt_create_entry($pdo, $fam2, ['eid' => $gone, 'blob' => fake_blob()], '2026-07-23');
    bt_delete_entry($pdo, $fam2, $gone, '2026-07-23');

    assert_eq(bt_usage_stats($pdo, '2026-09-01'), [
        'asOf' => '2026-09-01',
        'families' => 2,
        'familiesActive7' => 1,
        'familiesActive30' => 1,
        'accounts' => 2,
        'accountsNew30' => 1,   // papa2 on 2026-08-20; mama on 2026-07-01 is older
        'entries' => 3,         // the deleted row does not count
        'entriesNew7' => 1,
    ]);

    // The window's edges: 7 days = today and the six before it.
    assert_eq(bt_usage_stats($pdo, '2026-09-07')['familiesActive7'], 1, '09-01 is the 7th day back from 09-07');
    assert_eq(bt_usage_stats($pdo, '2026-09-08')['familiesActive7'], 0, '… and falls out a day later');
    // A change counts as activity too (the partner ended a timer).
    bt_update_entry($pdo, $fam2, $old, ['blob' => fake_blob(), 'ifSeq' => 1], '2026-09-01');
    assert_eq(bt_usage_stats($pdo, '2026-09-01')['familiesActive7'], 2);
    assert_eq(bt_stats_day_before('2026-03-01', 1), '2026-02-28', 'across a month');
});

bt_test('stats: the operator only — everyone else the same 404, whatever the method', function () {
    $pdo = fresh_db();
    $other = second_family($pdo);
    $opts = ['config' => ['admin_username' => 'mama']];

    login_as($pdo, me());
    $res = api_call('GET', '/stats', null, $opts);
    assert_eq($res[0], 200);
    assert_eq(array_keys($res[1]), ['asOf', 'families', 'familiesActive7', 'familiesActive30', 'accounts', 'accountsNew30', 'entries', 'entriesNew7'], 'numbers only');
    assert_eq($res[1]['families'], 2);
    assert_error(api_call('POST', '/stats', [], $opts), 405, 'Methode nicht erlaubt', 'the operator, wrong method', 'request.methodNotAllowed');

    login_as($pdo, $other['user']);
    assert_error(api_call('GET', '/stats', null, $opts), 404, 'Nicht gefunden', 'a member', 'request.notFound');
    assert_error(api_call('POST', '/stats', [], $opts), 404, 'Nicht gefunden', 'a member, POST', 'request.notFound');
    login_as($pdo, me());
    assert_error(api_call('GET', '/stats'), 404, 'Nicht gefunden', 'no operator configured', 'request.notFound');
    logout();
    assert_error(api_call('GET', '/stats', null, $opts), 401, 'Nicht angemeldet', 'no session', 'auth.notLoggedIn');
});
