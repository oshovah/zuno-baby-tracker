<?php
/**
 * Dependency-free test runner for the API unit tests.
 *
 * Usage: php api/tests/run.php
 * Prints one line per test and a summary; exits 0 when green, 1 on any failure.
 *
 * Target: PHP 7.4+.
 */

error_reporting(E_ALL);
ini_set('display_errors', '1');

$GLOBALS['__bt_tests'] = [];

function bt_test(string $name, callable $fn): void
{
    $GLOBALS['__bt_tests'][] = [$name, $fn];
}

class BtAssertionError extends RuntimeException
{
}

function bt_format($v): string
{
    if ($v === null) {
        return 'null';
    }
    return (string) json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}

/** Recursive equality: numbers loosely (36 == 36.0), everything else strictly. */
function bt_loose_equals($a, $b): bool
{
    if ((is_int($a) || is_float($a)) && (is_int($b) || is_float($b))) {
        return $a == $b;
    }
    if (is_array($a) && is_array($b)) {
        if (count($a) !== count($b)) {
            return false;
        }
        foreach ($a as $k => $v) {
            if (!array_key_exists($k, $b) || !bt_loose_equals($v, $b[$k])) {
                return false;
            }
        }
        return true;
    }
    return $a === $b;
}

function assert_eq($actual, $expected, string $msg = ''): void
{
    if (!bt_loose_equals($actual, $expected)) {
        throw new BtAssertionError(
            ($msg !== '' ? $msg . ' — ' : '')
            . 'expected ' . bt_format($expected) . ', got ' . bt_format($actual)
        );
    }
}

function assert_true($actual, string $msg = ''): void
{
    assert_eq($actual, true, $msg);
}

function assert_false($actual, string $msg = ''): void
{
    assert_eq($actual, false, $msg);
}

/**
 * Assert that $fn throws an HttpError with the given status. Every HttpError
 * must carry a code (the client's locale key); $code pins which one.
 */
function assert_http_error(callable $fn, int $status, string $msg = '', ?string $code = null): void
{
    $p = $msg !== '' ? $msg . ' — ' : '';
    try {
        $fn();
    } catch (HttpError $e) {
        assert_eq($e->status, $status, $p . 'HttpError status');
        assert_true(is_string($e->code) && $e->code !== '', $p . 'HttpError carries a code');
        if ($code !== null) {
            assert_eq($e->code, $code, $p . 'HttpError code');
        }
        return;
    }
    throw new BtAssertionError($p . "expected HttpError($status), nothing thrown");
}

// Register all tests, then run them. Bcrypt at the minimum cost: the harness
// registers accounts per test (see bt_bcrypt_cost in lib/auth.php).
putenv('BABY_BCRYPT_COST=4');
foreach (glob(__DIR__ . '/*.test.php') as $file) {
    require $file;
}

$pass = 0;
$fail = 0;
foreach ($GLOBALS['__bt_tests'] as $entry) {
    list($name, $fn) = $entry;
    try {
        $fn();
        echo "ok      $name\n";
        $pass++;
    } catch (Throwable $e) {
        echo "FAIL    $name\n";
        echo '        ' . get_class($e) . ': ' . $e->getMessage() . "\n";
        if (!($e instanceof BtAssertionError)) {
            echo '        at ' . $e->getFile() . ':' . $e->getLine() . "\n";
        }
        $fail++;
    }
}

$total = $pass + $fail;
echo "\n$total tests, $pass passed, $fail failed\n";
exit($fail === 0 ? 0 : 1);
