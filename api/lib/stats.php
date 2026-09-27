<?php
/**
 * Usage numbers for the operator (the account of config 'admin_username',
 * see lib/feedback.php): how many families and accounts this installation
 * has and how many of them wrote lately. Counts only — no name, no id, no
 * date of anybody: nothing the database would not show its operator anyway,
 * and nothing about what an entry contains (the server cannot know that).
 *
 * "Active" is judged by the day-granular dates the rows carry: a family is
 * active in a window when one of its rows was created or changed on a day
 * in it (UTC days, like every date the server stores).
 *
 * Target: PHP 7.4+.
 */

require_once __DIR__ . '/http.php';

/** 'YYYY-MM-DD' $days before $day. */
function bt_stats_day_before(string $day, int $days): string
{
    return gmdate('Y-m-d', strtotime($day . ' 00:00:00 UTC') - $days * 86400);
}

/**
 * {asOf, families, familiesActive7, familiesActive30, accounts,
 * accountsNew30, entries, entriesNew7}. The windows include today:
 * 7 days = today and the six before it.
 */
function bt_usage_stats(PDO $pdo, ?string $today = null): array
{
    $day = $today ?? bt_today();
    $since7 = bt_stats_day_before($day, 6);
    $since30 = bt_stats_day_before($day, 29);
    $count = function (string $sql, array $params = []) use ($pdo): int {
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        return (int) $stmt->fetchColumn();
    };
    $activeSql = 'SELECT COUNT(DISTINCT family_id) FROM entries WHERE updated_at >= ? OR created_at >= ?';
    return [
        'asOf' => $day,
        'families' => $count('SELECT COUNT(*) FROM families'),
        'familiesActive7' => $count($activeSql, [$since7, $since7]),
        'familiesActive30' => $count($activeSql, [$since30, $since30]),
        'accounts' => $count('SELECT COUNT(*) FROM users'),
        'accountsNew30' => $count('SELECT COUNT(*) FROM users WHERE created_at >= ?', [$since30]),
        'entries' => $count('SELECT COUNT(*) FROM entries WHERE deleted_at IS NULL'),
        'entriesNew7' => $count('SELECT COUNT(*) FROM entries WHERE created_at >= ?', [$since7]),
    ];
}
