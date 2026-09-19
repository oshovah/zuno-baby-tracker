<?php
/**
 * Shared test harness + front-controller (api/index.php) tests.
 *
 * Loaded first by run.php (alphabetical), so everything defined here is
 * available to the other *.test.php files:
 *   - fake key material: fake_auth_key(), fake_salt(), fake_kdf(),
 *     fake_wrapped(), fake_blob(), fake_eid(), fake_b64u() — random bytes of
 *     the exact wire lengths; the server treats them as opaque, which is
 *     precisely what the tests pin.
 *   - the shared scratch database behind bt_db() (memoized handle):
 *     empty_db() wipes it, fresh_db() additionally registers the default
 *     account (mama, family Testfamilie) through bt_register with fake key
 *     material; fix()/me()/fam() expose what was registered; second_family()
 *     adds papa2 in family Andere; login_as() puts a real token cookie in
 *     $_COOKIE.
 *   - api_call(): drives the routes exactly as an HTTP request would (method,
 *     REQUEST_URI under a /baby subdirectory, query string, JSON content
 *     type, client IP) and returns [status, data] — index.php is included
 *     with BT_NO_SERVE so it dispatches without sending; the "headers already
 *     sent" warnings of setcookie() under the CLI are swallowed, nothing else.
 *
 * NOW is 2026-09-01T10:00:00Z. Bcrypt runs at cost 4 (run.php sets
 * BABY_BCRYPT_COST). The 300 ms damping of wrong secrets is real, so the
 * 401/403 cases are kept few.
 */

require_once __DIR__ . '/../lib/http.php';
require_once __DIR__ . '/../lib/db.php';
require_once __DIR__ . '/../lib/auth.php';
require_once __DIR__ . '/../lib/entries.php';
define('BT_NO_SERVE', true);
require_once __DIR__ . '/../index.php';

const T_NOW = '2026-09-01T10:00:00Z';
const T_IP = '203.0.113.10';
const T_USER_KEYS = ['username', 'familyId', 'familyName', 'profileBlob'];
const T_ROW_KEYS = ['eid', 'seq', 'blob', 'createdAt', 'updatedAt', 'deletedAt'];

$GLOBALS['__bt_db_file'] = tempnam(sys_get_temp_dir(), 'baby-test-');
$GLOBALS['__bt_fix'] = null;
register_shutdown_function(function () {
    foreach (['', '-wal', '-shm', '.v1.bak'] as $suffix) {
        @unlink($GLOBALS['__bt_db_file'] . $suffix);
    }
});

// ---------------------------------------------------------------------------
// Fake key material (shared by every test file)
// ---------------------------------------------------------------------------

/** base64url without padding — the wire encoding of every byte string. */
function fake_b64u(string $bytes): string
{
    return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
}

/** 32 random bytes -> 43 chars: an auth key (user, family or recovery). */
function fake_auth_key(): string
{
    return fake_b64u(random_bytes(32));
}

/** 16 random bytes -> 22 chars: a KDF salt. */
function fake_salt(): string
{
    return fake_b64u(random_bytes(16));
}

/** {salt, iter}: the KDF parameters of one password. */
function fake_kdf(int $iter = 600000): array
{
    return ['salt' => fake_salt(), 'iter' => $iter];
}

/** 40 random bytes -> 54 chars: an AES-KW wrapped FDK. */
function fake_wrapped(): string
{
    return fake_b64u(random_bytes(40));
}

/** An opaque blob of exactly $bytes random bytes (a GCM envelope is >= 29). */
function fake_blob(int $bytes = 64): string
{
    return fake_b64u(random_bytes($bytes));
}

/** A client-style entry id: 32 lowercase hex chars. */
function fake_eid(): string
{
    return bin2hex(random_bytes(16));
}

// ---------------------------------------------------------------------------
// Shared scratch database + accounts
// ---------------------------------------------------------------------------

/** The shared scratch database (via bt_db) with every table wiped and no account. */
function empty_db(): PDO
{
    $pdo = bt_db(['db_path' => $GLOBALS['__bt_db_file']]);
    foreach (['entries', 'auth_tokens', 'login_attempts', 'users', 'families', 'sqlite_sequence'] as $table) {
        $pdo->exec("DELETE FROM $table");
    }
    logout();
    $GLOBALS['__bt_fix'] = null;
    return $pdo;
}

/** A complete 'create' registration body for mama / Testfamilie (override any field). */
function create_body(array $over = []): array
{
    return array_merge([
        'username' => 'mama',
        'authKey' => fake_auth_key(),
        'kdf' => fake_kdf(),
        'profileBlob' => fake_blob(),
        'familyName' => 'Testfamilie',
        'familyMode' => 'create',
        'familyAuthKey' => fake_auth_key(),
        'familyKdf' => fake_kdf(),
        'fdkWrappedFamily' => fake_wrapped(),
        'fdkWrappedUser' => fake_wrapped(),
        'recoveryAuthKey' => fake_auth_key(),
    ], $over);
}

/** A 'join' body for papa joining the default family with its real family auth key (override any field). */
function join_body(array $over = []): array
{
    $body = [
        'username' => 'papa',
        'authKey' => fake_auth_key(),
        'kdf' => fake_kdf(),
        'profileBlob' => fake_blob(),
        'familyName' => 'Testfamilie',
        'familyMode' => 'join',
        'fdkWrappedUser' => fake_wrapped(),
    ];
    if (!array_key_exists('familyAuthKey', $over) && !array_key_exists('recoveryAuthKey', $over)) {
        $body['familyAuthKey'] = fix('familyAuthKey');
    }
    return array_merge($body, $over);
}

/** The shared scratch database, wiped, with the default account registered (its body kept for fix()). */
function fresh_db(): PDO
{
    $pdo = empty_db();
    $body = create_body();
    $res = bt_register($pdo, $body, T_NOW);
    $GLOBALS['__bt_fix'] = ['body' => $body, 'user' => $res['user']];
    return $pdo;
}

/** A field of the default account's registration body (e.g. its authKey). */
function fix(string $key)
{
    if ($GLOBALS['__bt_fix'] === null) {
        throw new BtAssertionError('fix(): no default account registered – call fresh_db() first');
    }
    return $GLOBALS['__bt_fix']['body'][$key];
}

/** The default account's user array as bt_register returned it (with id). */
function me(): array
{
    return $GLOBALS['__bt_fix']['user'];
}

/** Family id of the default account. */
function fam(): int
{
    return (int) me()['familyId'];
}

/** Register papa2 creating a second family ("Andere"); returns bt_register's result plus its 'body'. */
function second_family(PDO $pdo): array
{
    $body = create_body(['username' => 'papa2', 'familyName' => 'Andere']);
    return bt_register($pdo, $body, T_NOW) + ['body' => $body];
}

/** Put a real session cookie for $user (a bt_register user array) into $_COOKIE. */
function login_as(PDO $pdo, array $user): void
{
    $_COOKIE[BT_COOKIE] = bt_create_token($pdo, (int) $user['id']);
}

function logout(): void
{
    unset($_COOKIE[BT_COOKIE]);
}

/** Throttle counter of a key ('' when no row). */
function fails_of(PDO $pdo, string $key): int
{
    $stmt = $pdo->prepare('SELECT fails FROM login_attempts WHERE ip = ?');
    $stmt->execute([$key]);
    $value = $stmt->fetchColumn();
    return $value === false ? 0 : (int) $value;
}

function count_of(PDO $pdo, string $sql): int
{
    return (int) $pdo->query($sql)->fetchColumn();
}

// ---------------------------------------------------------------------------
// Driving the front controller
// ---------------------------------------------------------------------------

/**
 * Dispatch one request through index.php's routing and error mapping.
 * $path is the part after /api (query string included); $body the decoded
 * JSON body (null = none). $opts: 'ip' (REMOTE_ADDR, default T_IP),
 * 'contentType' (string, or null for no header; default application/json
 * on POST/PATCH and whenever a $body is given), 'contentLength' (CONTENT_LENGTH
 * as the server sees it; default none — the body override is what the routes
 * read, this only drives the DELETE body guard), 'config' (the config array,
 * default []).
 * Returns [status, data].
 */
function api_call(string $method, string $path, ?array $body = null, array $opts = []): array
{
    $pdo = bt_db(['db_path' => $GLOBALS['__bt_db_file']]);
    $config = $opts['config'] ?? [];

    $query = [];
    $qPos = strpos($path, '?');
    if ($qPos !== false) {
        parse_str(substr($path, $qPos + 1), $query);
    }
    $_GET = $query;
    $_SERVER['REQUEST_METHOD'] = $method;
    $_SERVER['REQUEST_URI'] = '/baby/api' . $path;
    $_SERVER['REMOTE_ADDR'] = $opts['ip'] ?? T_IP;
    unset($_SERVER['PATH_INFO'], $_SERVER['CONTENT_TYPE'], $_SERVER['HTTP_CONTENT_TYPE'], $_SERVER['CONTENT_LENGTH']);
    $contentType = array_key_exists('contentType', $opts)
        ? $opts['contentType']
        : (($method === 'POST' || $method === 'PATCH' || $body !== null) ? 'application/json' : null);
    if ($contentType !== null) {
        $_SERVER['CONTENT_TYPE'] = $contentType;
    }
    if (isset($opts['contentLength'])) {
        $_SERVER['CONTENT_LENGTH'] = (string) $opts['contentLength'];
    }

    // setcookie()/header() warn under the CLI once the runner has printed;
    // exactly that warning is swallowed, every other one still surfaces.
    set_error_handler(function (int $no, string $msg): bool {
        return strpos($msg, 'headers already sent') !== false;
    }, E_WARNING);
    try {
        return bt_handle(function () use ($pdo, $config, $body) {
            return bt_dispatch($pdo, $config, bt_method(), bt_route_segments(), $body);
        });
    } finally {
        restore_error_handler();
    }
}

/** Assert [status, data] of api_call: the status and, unless null, the exact data. */
function assert_response(array $res, int $status, $data = null, string $msg = ''): void
{
    $p = $msg !== '' ? $msg . ' – ' : '';
    assert_eq($res[0], $status, $p . 'status (body ' . bt_format($res[1]) . ')');
    if ($data !== null) {
        assert_eq($res[1], $data, $p . 'body');
    }
}

/**
 * Assert an error response: the status, the exact German message and that
 * the envelope carries a dotted code (every throw site names one — it is the
 * client's locale key). $code pins the code, $params the exact params; an
 * answer without params must omit the key (never send an empty one).
 */
function assert_error(array $res, int $status, string $message, string $msg = '', ?string $code = null, ?array $params = null): void
{
    $p = $msg !== '' ? $msg . ' – ' : '';
    $body = $res[1];
    assert_eq($res[0], $status, $p . 'status (body ' . bt_format($body) . ')');
    assert_true(is_array($body), $p . 'body is an object');
    assert_eq($body['error'] ?? null, $message, $p . 'message');
    assert_eq(array_values(array_diff(array_keys($body), ['error', 'code', 'params'])), [], $p . 'envelope keys');
    $got = $body['code'] ?? null;
    assert_true(is_string($got) && preg_match('/^[a-z]+(\.[A-Za-z0-9]+)+$/D', $got) === 1, $p . 'dotted code (body ' . bt_format($body) . ')');
    if ($code !== null) {
        assert_eq($got, $code, $p . 'code');
    }
    if (array_key_exists('params', $body)) {
        assert_true(is_array($body['params']) && $body['params'] !== [], $p . 'params is a non-empty object');
    }
    if ($params !== null) {
        assert_eq($body['params'] ?? null, $params, $p . 'params');
    }
}

/** Strict shape check of a row JSON as the routes return it. */
function assert_row_shape(array $row, string $msg = ''): void
{
    $p = $msg !== '' ? $msg . ' – ' : '';
    assert_eq(array_keys($row), T_ROW_KEYS, $p . 'row keys');
    assert_true(preg_match('/^[0-9a-f]{32}$/D', $row['eid']) === 1, $p . 'eid');
    assert_true(is_int($row['seq']) && $row['seq'] >= 1, $p . 'seq');
    assert_true($row['blob'] === null || is_string($row['blob']), $p . 'blob');
    foreach (['createdAt', 'updatedAt'] as $k) {
        assert_true(preg_match('/^\d{4}-\d{2}-\d{2}$/D', $row[$k]) === 1, $p . $k);
    }
    assert_true($row['deletedAt'] === null || preg_match('/^\d{4}-\d{2}-\d{2}$/D', $row['deletedAt']) === 1, $p . 'deletedAt');
}

// ---------------------------------------------------------------------------
// Routing helpers
// ---------------------------------------------------------------------------

bt_test('routing: segments from PATH_INFO, REQUEST_URI (root, subdirectory, index.php); HEAD served as GET', function () {
    $saved = ['PATH_INFO' => $_SERVER['PATH_INFO'] ?? null, 'REQUEST_URI' => $_SERVER['REQUEST_URI'] ?? null,
              'REQUEST_METHOD' => $_SERVER['REQUEST_METHOD'] ?? null];
    $route = function (?string $pathInfo, ?string $uri): array {
        unset($_SERVER['PATH_INFO'], $_SERVER['REQUEST_URI']);
        if ($pathInfo !== null) {
            $_SERVER['PATH_INFO'] = $pathInfo;
        }
        if ($uri !== null) {
            $_SERVER['REQUEST_URI'] = $uri;
        }
        return bt_route_segments();
    };
    try {
        // php -S router / Apache at the domain root.
        assert_eq($route(null, '/api/sync?since=3&limit=10'), ['sync']);
        assert_eq($route(null, '/api/me'), ['me']);
        assert_eq($route(null, '/api'), []);
        assert_eq($route(null, '/api/'), []);
        assert_eq($route(null, '/api/entries/0123456789abcdef0123456789abcdef/restore'), ['entries', '0123456789abcdef0123456789abcdef', 'restore']);
        // Apache rewrite under a subdirectory: the FIRST /api/ wins.
        assert_eq($route(null, '/baby/api/families/check?name=M%C3%BCller'), ['families', 'check']);
        assert_eq($route(null, '/baby/api'), []);
        assert_eq($route(null, '/baby/api/entries/'), ['entries'], 'trailing slash dropped');
        // Hosts without a rewrite: the script name in the path.
        assert_eq($route(null, '/api/index.php/state'), ['state']);
        assert_eq($route(null, '/baby/api/index.php'), []);
        // PATH_INFO wins over REQUEST_URI; segments are url-decoded.
        assert_eq($route('/entries/abc%20def', '/api/other'), ['entries', 'abc def']);
        assert_eq($route('/api/entries/x', null), ['entries', 'x'], 'PATH_INFO containing /api/');
        assert_eq($route('', '/api/logout'), ['logout'], 'empty PATH_INFO falls back');
        assert_eq($route(null, null), [], 'no URI at all');
        assert_eq($route(null, '/index.html'), ['index.html'], 'outside /api the path is taken as is');

        $_SERVER['REQUEST_METHOD'] = 'HEAD';
        assert_eq(bt_method(), 'GET');
        $_SERVER['REQUEST_METHOD'] = 'patch';
        assert_eq(bt_method(), 'PATCH');
        unset($_SERVER['REQUEST_METHOD']);
        assert_eq(bt_method(), 'GET');
    } finally {
        foreach ($saved as $key => $value) {
            if ($value === null) {
                unset($_SERVER[$key]);
            } else {
                $_SERVER[$key] = $value;
            }
        }
    }
});

bt_test('bt_handle maps HttpError, a locked SQLite file (503) and anything else (500) to responses', function () {
    assert_eq(bt_handle(function () {
        return [201, ['ok' => true]];
    }), [201, ['ok' => true]]);
    // The envelope: {error} alone without a code, {error, code} with one,
    // {params} only when there are any.
    assert_eq(bt_handle(function () {
        throw new HttpError(409, 'Konflikt');
    }), [409, ['error' => 'Konflikt']]);
    assert_eq(bt_handle(function () {
        throw new HttpError(404, 'Weg', 'test.gone');
    }), [404, ['error' => 'Weg', 'code' => 'test.gone']]);
    assert_eq(bt_handle(function () {
        throw new HttpError(404, 'Weg', 'test.gone', []);
    }), [404, ['error' => 'Weg', 'code' => 'test.gone']], 'empty params are omitted');
    assert_eq(bt_handle(function () {
        throw new HttpError(429, 'Zu viel', 'test.limit', ['minutes' => 15, 'field' => 'x']);
    }), [429, ['error' => 'Zu viel', 'code' => 'test.limit', 'params' => ['minutes' => 15, 'field' => 'x']]]);
    assert_eq(bt_handle(function () {
        throw new PDOException('SQLSTATE[HY000]: General error: 5 database is locked');
    }), [503, ['error' => 'Kurz überlastet – bitte nochmals versuchen', 'code' => 'server.busy']]);
    assert_eq(bt_handle(function () {
        throw new PDOException('SQLSTATE[HY000]: database table is busy');
    })[0], 503);
    // (error_log writes one line to stderr for each of these.)
    assert_eq(bt_handle(function () {
        throw new PDOException('SQLSTATE[HY000]: no such table: nothing');
    }), [500, ['error' => 'Serverfehler', 'code' => 'server.internal']]);
    assert_eq(bt_handle(function () {
        throw new RuntimeException('settings.salt_secret is missing');
    }), [500, ['error' => 'Serverfehler', 'code' => 'server.internal']]);
});

bt_test('bt_decode_json_body: empty/scalar -> [], objects decode, malformed JSON -> 400 request.badJson with the reason', function () {
    assert_eq(bt_decode_json_body(''), []);
    assert_eq(bt_decode_json_body('null'), []);
    assert_eq(bt_decode_json_body('"x"'), []);
    assert_eq(bt_decode_json_body('{"a": 1, "b": [true]}'), ['a' => 1, 'b' => [true]]);
    assert_http_error(function () {
        bt_decode_json_body('{');
    }, 400, 'malformed', 'request.badJson');
    assert_eq(bt_handle(function () {
        return bt_decode_json_body('{"a": 1,}');
    }), [400, [
        'error' => 'Ungültiger JSON-Body: Syntax error',
        'code' => 'request.badJson',
        'params' => ['reason' => 'Syntax error'],
    ]]);
});

bt_test('bt_query_int: absent -> default, digits -> int, anything else 400', function () {
    $_GET = [];
    assert_eq(bt_query_int('since', 0), 0);
    assert_eq(bt_query_int('limit', 1000), 1000);
    $_GET = ['since' => '42', 'limit' => '', 'x' => '007'];
    assert_eq(bt_query_int('since', 0), 42);
    assert_eq(bt_query_int('limit', 1000), 1000, 'empty string = absent');
    assert_eq(bt_query_int('x', 0), 7);
    foreach (['-1', '1.5', 'abc', ' 3', '3 ', '1e3', ['1'], str_repeat('9', 16)] as $bad) {
        $_GET = ['since' => $bad];
        assert_http_error(function () {
            bt_query_int('since', 0);
        }, 400, bt_format($bad), 'request.notAnInteger');
    }
    $_GET = [];
});

// ---------------------------------------------------------------------------
// Public routes
// ---------------------------------------------------------------------------

bt_test('routes: GET /me health check, JSON guard 415, unknown routes 401/404, wrong methods 405', function () {
    $pdo = fresh_db();
    assert_response(api_call('GET', '/me'), 200, ['authenticated' => false, 'user' => null]);
    assert_response(api_call('GET', '/me?x=1'), 200, ['authenticated' => false, 'user' => null], 'query ignored');
    assert_error(api_call('GET', '/'), 401, 'Nicht angemeldet', 'bare /api needs auth', 'auth.notLoggedIn');
    assert_error(api_call('GET', '/nope'), 401, 'Nicht angemeldet', 'unknown route without a cookie is a 401');
    assert_error(api_call('POST', '/me'), 401, 'Nicht angemeldet', 'POST /me is not public');

    foreach ([null, 'text/plain', 'application/x-www-form-urlencoded', 'text/application/json'] as $ct) {
        assert_error(api_call('POST', '/login', ['username' => 'mama', 'authKey' => fix('authKey')], ['contentType' => $ct]),
            415, 'Ungültiger Content-Type – JSON erwartet', bt_format($ct), 'request.badContentType');
        assert_error(api_call('PATCH', '/me', ['profileBlob' => fake_blob()], ['contentType' => $ct]),
            415, 'Ungültiger Content-Type – JSON erwartet', 'PATCH ' . bt_format($ct));
    }
    assert_response(api_call('POST', '/logout', null, ['contentType' => 'application/json; charset=utf-8']), 200, ['ok' => true]);
    assert_response(api_call('POST', '/logout', null, ['contentType' => 'Application/JSON']), 200, ['ok' => true]);
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM login_attempts'), 0, 'none of that is counted');

    login_as($pdo, me());
    $res = api_call('GET', '/me');
    assert_response($res, 200, ['authenticated' => true, 'user' => [
        'username' => 'mama', 'familyId' => fam(), 'familyName' => 'Testfamilie', 'profileBlob' => fix('profileBlob'),
    ]]);
    assert_eq(array_keys($res[1]['user']), T_USER_KEYS, 'user JSON shape');
    assert_error(api_call('GET', '/nope'), 404, 'Nicht gefunden', '', 'request.notFound');
    assert_error(api_call('DELETE', '/me'), 405, 'Methode nicht erlaubt', '', 'request.methodNotAllowed');
    assert_error(api_call('GET', '/login'), 405, 'Methode nicht erlaubt');
    assert_error(api_call('GET', '/register'), 405, 'Methode nicht erlaubt');
    assert_error(api_call('GET', '/logout'), 405, 'Methode nicht erlaubt');
    assert_error(api_call('POST', '/families/check', []), 405, 'Methode nicht erlaubt');
    assert_error(api_call('GET', '/families/unlock'), 405, 'Methode nicht erlaubt');
    assert_error(api_call('PATCH', '/auth/params', []), 405, 'Methode nicht erlaubt');
    assert_error(api_call('POST', '/sync', []), 405, 'Methode nicht erlaubt');
    assert_error(api_call('GET', '/me/keys/unlock'), 405, 'Methode nicht erlaubt');
    assert_error(api_call('POST', '/me/password', []), 405, 'Methode nicht erlaubt');
    assert_error(api_call('POST', '/families/password', []), 405, 'Methode nicht erlaubt');
});

bt_test('routes: GET /auth/params and GET /families/check are public and shaped for the client', function () {
    $pdo = fresh_db();
    assert_response(api_call('GET', '/auth/params?username=mama'), 200, ['kdf' => fix('kdf')]);
    assert_response(api_call('GET', '/auth/params?username=%20MAMA%20'), 200, ['kdf' => fix('kdf')], 'folded like login');
    $fake = api_call('GET', '/auth/params?username=niemand');
    assert_eq($fake[0], 200);
    assert_eq(array_keys($fake[1]), ['kdf']);
    assert_eq(array_keys($fake[1]['kdf']), ['salt', 'iter'], 'same shape as a real one');
    assert_eq(strlen($fake[1]['kdf']['salt']), 22);
    assert_eq($fake[1]['kdf']['iter'], 600000);
    assert_eq(api_call('GET', '/auth/params?username=niemand'), $fake, 'stable');
    assert_true(api_call('GET', '/auth/params?username=niemand2')[1]['kdf']['salt'] !== $fake[1]['kdf']['salt']);
    assert_eq(array_keys(api_call('GET', '/auth/params')[1]['kdf']), ['salt', 'iter'], 'no username: still an answer');

    assert_response(api_call('GET', '/families/check?name=%20TESTFAMILIE%20'), 200, [
        'exists' => true, 'name' => 'Testfamilie', 'kdf' => fix('familyKdf'),
    ]);
    assert_response(api_call('GET', '/families/check?name=Unbekannt'), 200, ['exists' => false, 'name' => null, 'kdf' => null]);
    assert_response(api_call('GET', '/families/check'), 200, ['exists' => false, 'name' => null, 'kdf' => null]);
    assert_response(api_call('GET', '/families/check?name='), 200, ['exists' => false, 'name' => null, 'kdf' => null]);
    // The family wrapping is never in a public answer.
    $dump = json_encode(api_call('GET', '/families/check?name=Testfamilie')[1]);
    assert_false(strpos($dump, fix('fdkWrappedFamily')) !== false);
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM login_attempts'), 0, 'lookups are not throttled');
});

bt_test('routes: POST /families/unlock hands out the family wrapping against the family/recovery key; counted under reg:', function () {
    $pdo = fresh_db();
    $key = 'reg:' . T_IP;
    $expected = ['kdf' => fix('familyKdf'), 'fdkWrapped' => fix('fdkWrappedFamily')];
    assert_response(api_call('POST', '/families/unlock', ['familyName' => ' testfamilie ', 'familyAuthKey' => fix('familyAuthKey')]), 200, $expected);
    assert_response(api_call('POST', '/families/unlock', ['familyName' => 'Testfamilie', 'recoveryAuthKey' => fix('recoveryAuthKey')]), 200, $expected);
    assert_eq(fails_of($pdo, $key), 2, 'successes count too');
    assert_eq(fails_of($pdo, T_IP), 0, 'not the login key');

    // Typos are free, a verification is counted, a wrong secret is damped.
    assert_error(api_call('POST', '/families/unlock', ['familyAuthKey' => fix('familyAuthKey')]), 400, 'Familienname: 1–40 Zeichen', '', 'auth.badFamilyName', ['min' => 1, 'max' => 40]);
    assert_error(api_call('POST', '/families/unlock', ['familyName' => 'Testfamilie']), 400, 'Bitte Familien-Passwort oder Wiederherstellungscode angeben', '', 'auth.missingFamilyCredential');
    assert_error(api_call('POST', '/families/unlock', ['familyName' => 'Testfamilie', 'familyAuthKey' => 'familie-geheim']), 400, 'Ungültige Schlüsseldaten');
    assert_eq(fails_of($pdo, $key), 2);
    $t0 = microtime(true);
    assert_error(api_call('POST', '/families/unlock', ['familyName' => 'Testfamilie', 'familyAuthKey' => fake_auth_key()]), 403, 'Falsches Familien-Passwort');
    assert_true(microtime(true) - $t0 >= 0.25, 'wrong secret damped');
    assert_eq(fails_of($pdo, $key), 3);
    assert_error(api_call('POST', '/families/unlock', ['familyName' => 'Unbekannt', 'familyAuthKey' => fix('familyAuthKey')]), 404, 'Familie nicht gefunden – bitte Namen prüfen');
    assert_eq(fails_of($pdo, $key), 4, 'name probing is counted');

    // Budget exhausted: 429 before anything is read; another IP is fine.
    $pdo->prepare('UPDATE login_attempts SET fails = ? WHERE ip = ?')->execute([BT_LOGIN_MAX_FAILS, $key]);
    assert_error(api_call('POST', '/families/unlock', ['familyName' => 'Testfamilie', 'familyAuthKey' => fix('familyAuthKey')]),
        429, 'Zu viele Versuche – bitte später nochmals probieren');
    assert_response(api_call('POST', '/families/unlock', ['familyName' => 'Testfamilie', 'familyAuthKey' => fix('familyAuthKey')], ['ip' => '203.0.113.11']), 200, $expected);
});

bt_test('routes: POST /register creates (201, session) and joins; counted under reg:; 429', function () {
    $pdo = empty_db();
    $key = 'reg:' . T_IP;
    $body = create_body();
    $res = api_call('POST', '/register', $body);
    assert_response($res, 201, [
        'ok' => true,
        'user' => ['username' => 'mama', 'familyId' => 1, 'familyName' => 'Testfamilie', 'profileBlob' => $body['profileBlob']],
        'familyCreated' => true,
        'familyClosed' => false,
    ]);
    assert_eq(array_keys($res[1]['user']), T_USER_KEYS);
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM auth_tokens WHERE user_id = 1'), 1, 'a session token was issued');
    assert_eq(fails_of($pdo, $key), 1, 'a successful registration counts');
    assert_false(strpos(json_encode($res[1]), $body['fdkWrappedUser']) !== false, 'no key material in the answer');

    // Join with the family auth key; the create/join errors are counted, typos are not.
    $join = join_body(['familyAuthKey' => $body['familyAuthKey']]);
    $res2 = api_call('POST', '/register', $join);
    assert_response($res2, 201, [
        'ok' => true,
        'user' => ['username' => 'papa', 'familyId' => 1, 'familyName' => 'Testfamilie', 'profileBlob' => $join['profileBlob']],
        'familyCreated' => false,
        'familyClosed' => false,
    ]);
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM auth_tokens'), 2);
    assert_eq(fails_of($pdo, $key), 2);
    assert_eq(fails_of($pdo, 'family:testfamilie'), 1, 'a join counts against the family, a create does not');
    assert_error(api_call('POST', '/register', create_body(['username' => 'a'])), 400,
        'Benutzername: 2–30 Zeichen – Buchstaben, Ziffern, Punkt, Strich oder Unterstrich');
    assert_error(api_call('POST', '/register', create_body(['username' => 'oma', 'familyMode' => null])), 400, 'Ungültige Anfrage', '', 'auth.badFamilyMode');
    assert_error(api_call('POST', '/register', create_body(['username' => 'oma', 'authKey' => 'mama-geheim'])), 400, 'Ungültige Schlüsseldaten');
    assert_eq(fails_of($pdo, $key), 2, 'validation errors are free');
    assert_error(api_call('POST', '/register', create_body(['username' => 'oma'])), 409, 'Familie wurde gerade angelegt – bitte nochmals versuchen', '', 'auth.familyExists');
    assert_error(api_call('POST', '/register', join_body(['username' => 'MAMA', 'familyAuthKey' => $body['familyAuthKey']])), 409, 'Dieser Benutzername ist bereits vergeben', '', 'auth.usernameTaken');
    assert_error(api_call('POST', '/register', join_body(['username' => 'oma', 'familyAuthKey' => fake_auth_key()])), 403, 'Falsches Familien-Passwort');
    assert_eq(fails_of($pdo, $key), 5);
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM users'), 2);

    // Budget: 10 counted attempts, then 429 (before the body is even looked at).
    $pdo = empty_db();
    $pdo->prepare("INSERT INTO login_attempts (ip, fails, window_start) VALUES (?, ?, datetime('now'))")
        ->execute([$key, BT_LOGIN_MAX_FAILS]);
    assert_error(api_call('POST', '/register', create_body()), 429, 'Zu viele Versuche – bitte später nochmals probieren', '', 'auth.throttled', ['minutes' => 15]);
    assert_error(api_call('POST', '/register', ['password' => 'x']), 429, 'Zu viele Versuche – bitte später nochmals probieren');
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM users'), 0);
    assert_eq(api_call('POST', '/register', create_body(), ['ip' => '203.0.113.12'])[0], 201, 'another IP registers');
});

bt_test('routes: a join with rotateFamily closes the family the moment it commits; joins and unlocks are budgeted per family', function () {
    $pdo = fresh_db();
    $fKey = 'family:testfamilie';
    // Unlock probes come from an address of their own so the joins' reg:
    // budget of T_IP (10 counted attempts) is not what ends the test.
    $unlock = function (string $familyAuthKey, array $opts = []) {
        return api_call('POST', '/families/unlock', ['familyName' => 'Testfamilie', 'familyAuthKey' => $familyAuthKey],
            $opts + ['ip' => '203.0.113.50']);
    };

    $rot = ['familyAuthKey' => fake_auth_key(), 'familyKdf' => fake_kdf(700000), 'fdkWrappedFamily' => fake_wrapped()];
    $res = api_call('POST', '/register', join_body(['rotateFamily' => $rot]));
    assert_eq($res[0], 201, 'join with rotation');
    assert_eq([$res[1]['familyCreated'], $res[1]['familyClosed']], [false, true]);
    assert_eq(fails_of($pdo, $fKey), 1, 'counted against the family');
    assert_eq(fails_of($pdo, 'reg:' . T_IP), 1, '... and the address');
    // The credentials that let papa in are dead; the fresh ones work (until the next join).
    assert_error($unlock(fix('familyAuthKey')), 403, 'Falsches Familien-Passwort');
    assert_response($unlock($rot['familyAuthKey']), 200, ['kdf' => $rot['familyKdf'], 'fdkWrapped' => $rot['fdkWrappedFamily']]);
    assert_response(api_call('GET', '/families/check?name=Testfamilie'), 200, ['exists' => true, 'name' => 'Testfamilie', 'kdf' => $rot['familyKdf']]);
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM users'), 2);

    // A recovery join rotates too; the recovery code itself stays.
    $rot2 = ['familyAuthKey' => fake_auth_key(), 'familyKdf' => fake_kdf(), 'fdkWrappedFamily' => fake_wrapped()];
    $res2 = api_call('POST', '/register', join_body([
        'username' => 'oma', 'familyAuthKey' => null, 'recoveryAuthKey' => fix('recoveryAuthKey'), 'rotateFamily' => $rot2,
    ]));
    assert_eq([$res2[0], $res2[1]['familyClosed']], [201, true]);
    assert_error($unlock($rot['familyAuthKey']), 403, 'Falsches Familien-Passwort');
    assert_eq($unlock($rot2['familyAuthKey'])[0], 200);
    assert_eq(api_call('POST', '/families/unlock', ['familyName' => 'Testfamilie', 'recoveryAuthKey' => fix('recoveryAuthKey')])[0], 200, 'recovery stays');

    // Without the field (an older shell) the family stays open: a member
    // hands out a known password, the plain join keeps it.
    login_as($pdo, me());
    $rot3 = ['familyAuthKey' => fake_auth_key(), 'familyKdf' => fake_kdf(), 'fdkWrappedFamily' => fake_wrapped()];
    assert_response(api_call('PATCH', '/families/password', $rot3 + ['currentAuthKey' => fix('authKey')]), 200, ['ok' => true]);
    logout();
    $res3 = api_call('POST', '/register', join_body(['username' => 'opa', 'familyAuthKey' => $rot3['familyAuthKey']]));
    assert_eq([$res3[0], $res3[1]['familyClosed']], [201, false]);
    assert_eq($unlock($rot3['familyAuthKey'])[0], 200, 'still open');

    // Malformed rotation material is a free 400; a wrong family key rotates nothing.
    assert_error(api_call('POST', '/register', join_body([
        'username' => 'x1', 'familyAuthKey' => $rot3['familyAuthKey'], 'rotateFamily' => ['familyAuthKey' => 'kurz'],
    ])), 400, 'Ungültige Schlüsseldaten');
    assert_error(api_call('POST', '/register', join_body([
        'username' => 'x2', 'familyAuthKey' => $rot3['familyAuthKey'], 'rotateFamily' => 'ja',
    ])), 400, 'Ungültige Schlüsseldaten');
    $before = fails_of($pdo, $fKey);
    assert_error(api_call('POST', '/register', join_body([
        'username' => 'x3', 'familyAuthKey' => fake_auth_key(), 'rotateFamily' => $rot,
    ])), 403, 'Falsches Familien-Passwort');
    assert_eq(fails_of($pdo, $fKey), $before + 1, 'the guess is counted');
    assert_eq($unlock($rot3['familyAuthKey'])[0], 200, 'a failed join rotates nothing');
    assert_eq(count_of($pdo, "SELECT COUNT(*) FROM users WHERE username LIKE 'x%'"), 0);

    // The family's own budget: BT_TARGET_MAX_FAILS per hour from ANY address.
    $pdo->prepare('UPDATE login_attempts SET fails = ? WHERE ip = ?')->execute([BT_TARGET_MAX_FAILS, $fKey]);
    assert_error(api_call('POST', '/register', join_body(['username' => 'x4', 'familyAuthKey' => $rot3['familyAuthKey']]), ['ip' => '203.0.113.99']),
        429, 'Zu viele Versuche – bitte später nochmals probieren', 'join from a fresh address');
    assert_error(api_call('POST', '/families/unlock', ['familyName' => ' TESTFAMILIE ', 'familyAuthKey' => $rot3['familyAuthKey']], ['ip' => '203.0.113.98']),
        429, 'Zu viele Versuche – bitte später nochmals probieren', 'unlock from a fresh address, name folded');
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM users'), 4);
    assert_eq(api_call('POST', '/register', create_body(['username' => 'neu', 'familyName' => 'Andere']), ['ip' => '203.0.113.97'])[0], 201,
        'creating another family is unaffected');
    // An hour later the family accepts guesses again.
    $pdo->prepare("UPDATE login_attempts SET window_start = datetime('now', '-61 minutes') WHERE ip = ?")->execute([$fKey]);
    assert_eq($unlock($rot3['familyAuthKey'], ['ip' => '203.0.113.96'])[0], 200);
    assert_eq(fails_of($pdo, $fKey), 1, 'lapsed window restarted');
});

bt_test('routes: POST /login returns user + kdf + fdkWrappedUser; failures counted under the IP, never cleared; logout', function () {
    $pdo = fresh_db();
    $res = api_call('POST', '/login', ['username' => ' MAMA ', 'authKey' => fix('authKey')]);
    assert_response($res, 200, [
        'ok' => true,
        'user' => ['username' => 'mama', 'familyId' => fam(), 'familyName' => 'Testfamilie', 'profileBlob' => fix('profileBlob')],
        'kdf' => fix('kdf'),
        'fdkWrappedUser' => fix('fdkWrappedUser'),
    ]);
    assert_eq(array_keys($res[1]), ['ok', 'user', 'kdf', 'fdkWrappedUser']);
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM auth_tokens'), 1, 'session issued');
    assert_eq(fails_of($pdo, T_IP), 0, 'a successful login is not counted');

    assert_error(api_call('POST', '/login', ['username' => 'mama', 'authKey' => fake_auth_key()]), 401, 'Benutzername oder Passwort falsch', '', 'auth.badCredentials');
    assert_error(api_call('POST', '/login', ['username' => 'niemand', 'authKey' => fix('authKey')]), 401, 'Benutzername oder Passwort falsch');
    assert_error(api_call('POST', '/login', ['username' => 'mama', 'authKey' => fix('familyAuthKey')]), 401, 'Benutzername oder Passwort falsch');
    assert_eq(fails_of($pdo, T_IP), 3);
    assert_eq([fails_of($pdo, 'user:mama'), fails_of($pdo, 'user:niemand')], [2, 1], 'counted against the account too');
    assert_error(api_call('POST', '/login', ['username' => 'mama']), 400, 'Bitte Benutzername und Passwort angeben', '', 'auth.missingCredentials');
    assert_error(api_call('POST', '/login', []), 400, 'Bitte Benutzername und Passwort angeben');
    assert_error(api_call('POST', '/login', ['username' => 'mama', 'authKey' => 'mama-geheim']), 400, 'Ungültige Schlüsseldaten', '', 'auth.badKeyMaterial');
    assert_eq(fails_of($pdo, T_IP), 3, 'malformed requests are free');
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM auth_tokens'), 1, 'no session for a failure');

    assert_eq(api_call('POST', '/login', ['username' => 'mama', 'authKey' => fix('authKey')])[0], 200);
    assert_eq(fails_of($pdo, T_IP), 3, 'success does not clear the budget');
    assert_eq(fails_of($pdo, 'reg:' . T_IP), 0);
    $pdo->prepare('UPDATE login_attempts SET fails = ? WHERE ip = ?')->execute([BT_LOGIN_MAX_FAILS, T_IP]);
    assert_error(api_call('POST', '/login', ['username' => 'mama', 'authKey' => fix('authKey')]), 429, 'Zu viele Versuche – bitte später nochmals probieren', '', 'auth.throttled', ['minutes' => 15]);
    assert_eq(api_call('POST', '/families/unlock', ['familyName' => 'Testfamilie', 'familyAuthKey' => fix('familyAuthKey')])[0], 200, 'reg: budget is separate');
    assert_eq(api_call('POST', '/login', ['username' => 'mama', 'authKey' => fix('authKey')], ['ip' => '203.0.113.13'])[0], 200);
    // The account's own budget holds from any address (the name folds like the login does).
    $pdo->prepare('UPDATE login_attempts SET fails = ? WHERE ip = ?')->execute([BT_TARGET_MAX_FAILS, 'user:mama']);
    assert_error(api_call('POST', '/login', ['username' => ' MAMA ', 'authKey' => fix('authKey')], ['ip' => '203.0.113.14']),
        429, 'Zu viele Versuche – bitte später nochmals probieren');
    assert_error(api_call('POST', '/login', ['username' => 'niemand', 'authKey' => fake_auth_key()], ['ip' => '203.0.113.14']),
        401, 'Benutzername oder Passwort falsch', 'other names are not blocked');
    $pdo->prepare('DELETE FROM login_attempts WHERE ip = ?')->execute(['user:mama']);

    // Logout deletes the presented token; without a cookie it is a harmless ok.
    login_as($pdo, me());
    $tokens = count_of($pdo, 'SELECT COUNT(*) FROM auth_tokens');
    assert_eq(api_call('GET', '/me')[1]['authenticated'], true);
    assert_response(api_call('POST', '/logout'), 200, ['ok' => true]);
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM auth_tokens'), $tokens - 1, 'the presented token is gone');
    assert_response(api_call('GET', '/me'), 200, ['authenticated' => false, 'user' => null], 'the cookie is dead');
    logout();
    assert_response(api_call('POST', '/logout'), 200, ['ok' => true]);
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM auth_tokens'), $tokens - 1);
});

// ---------------------------------------------------------------------------
// Authenticated routes: keys, profile, password changes
// ---------------------------------------------------------------------------

bt_test('routes: 401 without a cookie; keys unlock, profile, own + family password changes; 403s counted under the IP', function () {
    $pdo = fresh_db();
    $eid = fake_eid();
    foreach ([
        ['POST', '/me/keys/unlock', ['authKey' => fix('authKey')]],
        ['PATCH', '/me', ['profileBlob' => fake_blob()]],
        ['PATCH', '/me/password', []],
        ['PATCH', '/families/password', []],
        ['GET', '/sync', null],
        ['POST', '/entries', ['eid' => $eid, 'blob' => fake_blob()]],
        ['PATCH', "/entries/$eid", ['blob' => fake_blob(), 'ifSeq' => 1]],
        ['DELETE', "/entries/$eid", null],
        ['POST', "/entries/$eid/restore", null],
    ] as $case) {
        list($method, $path, $body) = $case;
        assert_error(api_call($method, $path, $body), 401, 'Nicht angemeldet', "$method $path");
    }
    $_COOKIE[BT_COOKIE] = 'not-a-token';
    assert_error(api_call('GET', '/sync'), 401, 'Nicht angemeldet', 'junk cookie');
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM entries'), 0);

    login_as($pdo, me());
    // Own keys: the cookie alone is not enough, the auth key must verify.
    assert_response(api_call('POST', '/me/keys/unlock', ['authKey' => fix('authKey')]), 200, [
        'kdf' => fix('kdf'), 'fdkWrappedUser' => fix('fdkWrappedUser'),
    ]);
    assert_error(api_call('POST', '/me/keys/unlock', ['authKey' => fake_auth_key()]), 403, 'Falsches Passwort', '', 'auth.badPassword');
    assert_eq(fails_of($pdo, T_IP), 1, 'a wrong own password burns the login budget');
    assert_eq(fails_of($pdo, 'user:mama'), 1, '... and the account budget');
    assert_error(api_call('POST', '/me/keys/unlock', []), 400, 'Ungültige Schlüsseldaten');
    assert_eq(fails_of($pdo, T_IP), 1);

    // Profile blob.
    $blob = fake_blob();
    assert_response(api_call('PATCH', '/me', ['profileBlob' => $blob]), 200, ['ok' => true, 'user' => [
        'username' => 'mama', 'familyId' => fam(), 'familyName' => 'Testfamilie', 'profileBlob' => $blob,
    ]]);
    assert_eq(api_call('GET', '/me')[1]['user']['profileBlob'], $blob);
    assert_error(api_call('PATCH', '/me', ['profileBlob' => 'Mami']), 400, 'Ungültiger Datensatz', '', 'request.badBlob');
    assert_error(api_call('PATCH', '/me', []), 400, 'Ungültiger Datensatz');

    // Own password: wrong confirmation counted, then the re-wrap; this session survives.
    $new = ['authKey' => fake_auth_key(), 'kdf' => fake_kdf(1000000), 'fdkWrappedUser' => fake_wrapped()];
    assert_error(api_call('PATCH', '/me/password', $new + ['currentAuthKey' => fake_auth_key()]), 403, 'Falsches Passwort');
    assert_eq(fails_of($pdo, T_IP), 2);
    assert_error(api_call('PATCH', '/me/password', $new), 400, 'Bitte dein Passwort zur Bestätigung angeben', '', 'auth.missingConfirmation');
    assert_eq(fails_of($pdo, T_IP), 2);
    $otherPhone = bt_create_token($pdo, (int) me()['id']);
    assert_response(api_call('PATCH', '/me/password', $new + ['currentAuthKey' => fix('authKey')]), 200, ['ok' => true]);
    assert_eq(api_call('GET', '/me')[1]['authenticated'], true, 'this session survives');
    assert_eq(bt_user_for_token($pdo, $otherPhone), null, 'the other phone is logged out');
    assert_eq(api_call('POST', '/login', ['username' => 'mama', 'authKey' => $new['authKey']])[1]['fdkWrappedUser'], $new['fdkWrappedUser']);
    assert_response(api_call('GET', '/auth/params?username=mama'), 200, ['kdf' => $new['kdf']]);
    assert_response(api_call('POST', '/me/keys/unlock', ['authKey' => $new['authKey']]), 200, [
        'kdf' => $new['kdf'], 'fdkWrappedUser' => $new['fdkWrappedUser'],
    ]);

    // Family password: the (new) own auth key confirms; joins and unlock follow.
    $rot = ['familyAuthKey' => fake_auth_key(), 'familyKdf' => fake_kdf(), 'fdkWrappedFamily' => fake_wrapped()];
    assert_error(api_call('PATCH', '/families/password', $rot + ['currentAuthKey' => fix('authKey')]), 403, 'Falsches Passwort', 'the old own key is gone');
    assert_eq(fails_of($pdo, T_IP), 3);
    assert_response(api_call('PATCH', '/families/password', $rot + ['currentAuthKey' => $new['authKey']]), 200, ['ok' => true]);
    assert_response(api_call('POST', '/families/unlock', ['familyName' => 'Testfamilie', 'familyAuthKey' => $rot['familyAuthKey']]), 200, [
        'kdf' => $rot['familyKdf'], 'fdkWrapped' => $rot['fdkWrappedFamily'],
    ]);
    assert_response(api_call('GET', '/families/check?name=Testfamilie'), 200, ['exists' => true, 'name' => 'Testfamilie', 'kdf' => $rot['familyKdf']]);
    assert_eq(api_call('POST', '/register', join_body(['familyAuthKey' => $rot['familyAuthKey']]))[0], 201);

    // Budget exhausted on the IP: the confirmations are refused up front.
    $pdo->prepare('UPDATE login_attempts SET fails = ? WHERE ip = ?')->execute([BT_LOGIN_MAX_FAILS, T_IP]);
    foreach ([
        ['POST', '/me/keys/unlock', ['authKey' => $new['authKey']]],
        ['PATCH', '/me/password', $new + ['currentAuthKey' => $new['authKey']]],
        ['PATCH', '/families/password', $rot + ['currentAuthKey' => $new['authKey']]],
    ] as $case) {
        list($method, $path, $body) = $case;
        assert_error(api_call($method, $path, $body), 429, 'Zu viele Versuche – bitte später nochmals probieren', "$method $path");
    }
    assert_eq(api_call('PATCH', '/me', ['profileBlob' => fake_blob()])[0], 200, 'the profile needs no secret');
    // ... and on the account, from any address.
    $pdo->prepare('DELETE FROM login_attempts WHERE ip = ?')->execute([T_IP]);
    assert_eq(fails_of($pdo, 'user:mama'), 3, 'every wrong confirmation counted against the account');
    $pdo->prepare('UPDATE login_attempts SET fails = ? WHERE ip = ?')->execute([BT_TARGET_MAX_FAILS, 'user:mama']);
    assert_error(api_call('POST', '/me/keys/unlock', ['authKey' => $new['authKey']], ['ip' => '203.0.113.15']),
        429, 'Zu viele Versuche – bitte später nochmals probieren', 'account budget from a fresh address', 'auth.throttled', ['minutes' => 60]);
});

bt_test('routes: entries mutations draw on the address write budget (429 with its own text once used up); reads are free', function () {
    $pdo = fresh_db();
    login_as($pdo, me());
    $wKey = 'write:' . T_IP;
    $eid = fake_eid();
    assert_eq(api_call('POST', '/entries', ['eid' => $eid, 'blob' => fake_blob()])[0], 201);
    assert_eq(api_call('PATCH', "/entries/$eid", ['blob' => fake_blob(), 'ifSeq' => 1])[0], 200);
    assert_eq(api_call('DELETE', "/entries/$eid")[0], 200);
    assert_eq(api_call('POST', "/entries/$eid/restore")[0], 200);
    assert_eq(api_call('POST', '/entries', ['eid' => 'kaputt'])[0], 400);
    assert_eq(fails_of($pdo, $wKey), 5, 'every mutation counts, invalid ones included');
    assert_eq(api_call('GET', '/sync')[0], 200);
    assert_eq(api_call('GET', '/me')[0], 200);
    assert_eq(fails_of($pdo, $wKey), 5, 'reads are free');
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM login_attempts'), 1, 'no other key touched');

    $pdo->prepare('UPDATE login_attempts SET fails = ? WHERE ip = ?')->execute([BT_WRITE_MAX_PER_WINDOW, $wKey]);
    $msg = 'Zu viele Änderungen in kurzer Zeit – bitte später nochmals versuchen';
    assert_error(api_call('POST', '/entries', ['eid' => fake_eid(), 'blob' => fake_blob()]), 429, $msg, 'create', 'request.writeBudget', ['minutes' => 15]);
    assert_error(api_call('PATCH', "/entries/$eid", ['blob' => fake_blob(), 'ifSeq' => 4]), 429, $msg, 'edit');
    assert_error(api_call('DELETE', "/entries/$eid"), 429, $msg, 'delete');
    assert_error(api_call('POST', "/entries/$eid/restore"), 429, $msg, 'restore');
    assert_eq(api_call('GET', '/sync')[0], 200, 'reads still work');
    assert_eq(api_call('POST', '/entries', ['eid' => fake_eid(), 'blob' => fake_blob()], ['ip' => '203.0.113.20'])[0], 201, 'another address');
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM entries'), 2);
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM entries WHERE deleted_at IS NOT NULL'), 0, 'the refused delete changed nothing');

    // A lapsed window restarts the count.
    $pdo->prepare("UPDATE login_attempts SET window_start = datetime('now', '-16 minutes') WHERE ip = ?")->execute([$wKey]);
    assert_eq(api_call('POST', '/entries', ['eid' => fake_eid(), 'blob' => fake_blob()])[0], 201);
    assert_eq(fails_of($pdo, $wKey), 1);
});

// ---------------------------------------------------------------------------
// Authenticated routes: entries
// ---------------------------------------------------------------------------

bt_test('routes: entries – create 201, sync paging + params, CAS 409, delete/restore, family scoping', function () {
    $pdo = fresh_db();
    login_as($pdo, me());
    $today = gmdate('Y-m-d');

    $eid = fake_eid();
    $blob = fake_blob(256);
    $created = api_call('POST', '/entries', ['eid' => $eid, 'blob' => $blob]);
    assert_response($created, 201, [
        'eid' => $eid, 'seq' => 1, 'blob' => $blob,
        'createdAt' => $today, 'updatedAt' => $today, 'deletedAt' => null,
    ]);
    assert_row_shape($created[1], 'create');
    assert_error(api_call('POST', '/entries', ['eid' => $eid, 'blob' => fake_blob()]), 409, 'Eintrag existiert bereits');
    assert_error(api_call('POST', '/entries', ['eid' => strtoupper($eid), 'blob' => fake_blob()]), 400, 'Ungültiger Eintrag');
    assert_error(api_call('POST', '/entries', ['eid' => fake_eid(), 'blob' => fake_blob(10)]), 400, 'Ungültiger Datensatz');
    assert_error(api_call('POST', '/entries', ['eid' => fake_eid()]), 400, 'Ungültiger Datensatz');
    $eid2 = fake_eid();
    assert_eq(api_call('POST', '/entries', ['eid' => $eid2, 'blob' => fake_blob()])[1]['seq'], 2);

    // Sync: defaults, paging, parameter validation.
    $sync = api_call('GET', '/sync');
    assert_eq($sync[0], 200);
    assert_eq(array_keys($sync[1]), ['serverNow', 'feed', 'rows', 'next']);
    assert_true(preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/D', $sync[1]['serverNow']) === 1, 'serverNow canonical');
    assert_true(preg_match('/^[0-9a-f]{32}$/D', $sync[1]['feed']) === 1, 'feed is the install\'s 32-hex token');
    assert_eq($sync[1]['feed'], bt_feed_id($pdo));
    assert_eq(array_column($sync[1]['rows'], 'eid'), [$eid, $eid2]);
    assert_eq($sync[1]['next'], null);
    foreach ($sync[1]['rows'] as $row) {
        assert_row_shape($row, 'sync row');
    }
    $page = api_call('GET', '/sync?since=0&limit=1');
    assert_eq(array_column($page[1]['rows'], 'eid'), [$eid]);
    assert_eq($page[1]['next'], 1);
    $page2 = api_call('GET', '/sync?since=1&limit=1');
    assert_eq(array_column($page2[1]['rows'], 'eid'), [$eid2]);
    assert_eq($page2[1]['next'], 2);
    assert_eq(api_call('GET', '/sync?since=2&limit=1')[1]['rows'], []);
    assert_eq($page2[1]['feed'], $sync[1]['feed'], 'feed stable across pages');
    $reset = api_call('GET', '/sync?since=99');
    assert_eq($reset[1]['reset'] ?? null, true, 'cursor beyond MAX(seq): reset');
    assert_eq($reset[1]['feed'], $sync[1]['feed'], 'reset pages carry the feed too');
    assert_error(api_call('GET', '/sync?since=abc'), 400, '"since" muss eine ganze Zahl sein');
    assert_error(api_call('GET', '/sync?limit=-1'), 400, '"limit" muss eine ganze Zahl sein');
    assert_error(api_call('GET', '/sync?since=1.5'), 400, '"since" muss eine ganze Zahl sein');
    assert_eq(count(api_call('GET', '/sync?limit=0')[1]['rows']), 1, 'limit clamped to 1');
    assert_eq(count(api_call('GET', '/sync?limit=99999')[1]['rows']), 2, 'limit clamped to 1000');

    // Update: compare-and-set on ifSeq.
    $newBlob = fake_blob(256);
    assert_error(api_call('PATCH', "/entries/$eid", ['blob' => $newBlob, 'ifSeq' => 99]), 409, 'Der Eintrag wurde inzwischen auf einem anderen Gerät geändert');
    assert_error(api_call('PATCH', "/entries/$eid", ['blob' => $newBlob]), 400, '"ifSeq" fehlt');
    assert_error(api_call('PATCH', "/entries/$eid", ['blob' => $newBlob, 'ifSeq' => '1']), 400, '"ifSeq" fehlt');
    assert_error(api_call('PATCH', '/entries/not-an-eid', ['blob' => $newBlob, 'ifSeq' => 1]), 400, 'Ungültiger Eintrag');
    assert_error(api_call('PATCH', '/entries/' . strtoupper($eid), ['blob' => $newBlob, 'ifSeq' => 1]), 400, 'Ungültiger Eintrag');
    assert_error(api_call('PATCH', '/entries/' . fake_eid(), ['blob' => $newBlob, 'ifSeq' => 1]), 404, 'Eintrag nicht gefunden');
    $updated = api_call('PATCH', "/entries/$eid", ['blob' => $newBlob, 'ifSeq' => 1]);
    assert_response($updated, 200, [
        'eid' => $eid, 'seq' => 3, 'blob' => $newBlob,
        'createdAt' => $today, 'updatedAt' => $today, 'deletedAt' => null,
    ]);
    assert_error(api_call('GET', "/entries/$eid"), 405, 'Methode nicht erlaubt');
    assert_error(api_call('PUT', "/entries/$eid"), 405, 'Methode nicht erlaubt');
    assert_error(api_call('GET', "/entries/$eid/restore"), 405, 'Methode nicht erlaubt');
    assert_error(api_call('POST', "/entries/$eid/nope"), 404, 'Nicht gefunden', '', 'request.notFound');

    // Delete + restore. A DELETE body is optional: with {ifSeq} it is a CAS
    // (409 when the seq moved), and then it must declare JSON like a POST.
    assert_error(api_call('DELETE', "/entries/$eid2", ['ifSeq' => 1]), 409, 'Der Eintrag wurde inzwischen auf einem anderen Gerät geändert', 'stale ifSeq');
    assert_error(api_call('DELETE', "/entries/$eid2", ['ifSeq' => '2']), 400, '"ifSeq" ungültig');
    assert_error(api_call('DELETE', "/entries/$eid2", ['ifSeq' => 2], ['contentType' => null]), 415, 'Ungültiger Content-Type – JSON erwartet', 'body without the header');
    assert_error(api_call('DELETE', "/entries/$eid2", ['ifSeq' => 2], ['contentType' => 'text/plain']), 415, 'Ungültiger Content-Type – JSON erwartet');
    // The real server sees only CONTENT_LENGTH: a declared body without JSON is refused ...
    assert_error(api_call('DELETE', "/entries/$eid2", null, ['contentLength' => 12]), 415, 'Ungültiger Content-Type – JSON erwartet', 'CONTENT_LENGTH > 0 without JSON');
    // ... a declared empty one, or none, needs no header (the plain delete).
    assert_error(api_call('DELETE', '/entries/' . fake_eid(), null, ['contentLength' => 0]), 404, 'Eintrag nicht gefunden', 'CONTENT_LENGTH 0');
    assert_error(api_call('DELETE', '/entries/' . fake_eid(), ['ifSeq' => 1]), 404, 'Eintrag nicht gefunden', 'unknown eid with ifSeq: 404, not 409');
    assert_eq(count_of($pdo, 'SELECT COUNT(*) FROM entries WHERE deleted_at IS NOT NULL'), 0, 'nothing deleted so far');
    $deleted = api_call('DELETE', "/entries/$eid2", ['ifSeq' => 2]);
    assert_response($deleted, 200);
    assert_row_shape($deleted[1], 'conditional delete');
    assert_eq([$deleted[1]['eid'], $deleted[1]['seq'], $deleted[1]['deletedAt']], [$eid2, 4, $today]);
    assert_error(api_call('DELETE', "/entries/$eid2"), 404, 'Eintrag nicht gefunden');
    assert_error(api_call('DELETE', "/entries/$eid2", ['ifSeq' => 4]), 404, 'Eintrag nicht gefunden', 'deleted: 404 even with the right seq');
    assert_error(api_call('DELETE', '/entries/zzz'), 400, 'Ungültiger Eintrag');
    assert_eq(array_column(api_call('GET', '/sync')[1]['rows'], 'eid'), [$eid], 'fresh clients never see the tombstone');
    $cursor = api_call('GET', '/sync?since=3');
    assert_eq([$cursor[1]['rows'][0]['eid'], $cursor[1]['rows'][0]['deletedAt']], [$eid2, $today], 'cursor clients get it');
    $restored = api_call('POST', "/entries/$eid2/restore");
    assert_response($restored, 200);
    assert_eq([$restored[1]['eid'], $restored[1]['seq'], $restored[1]['deletedAt']], [$eid2, 5, null]);
    assert_true(is_string($restored[1]['blob']), 'restore returns the blob');
    assert_error(api_call('POST', "/entries/$eid2/restore"), 404, 'Eintrag nicht gefunden');
    assert_error(api_call('POST', '/entries/zzz/restore'), 400, 'Ungültiger Eintrag');
    // The unconditional delete (no body) still works on the restored row.
    $plain = api_call('DELETE', "/entries/$eid2");
    assert_response($plain, 200);
    assert_eq([$plain[1]['seq'], $plain[1]['deletedAt']], [6, $today], 'plain delete');
    assert_response(api_call('POST', "/entries/$eid2/restore"), 200); // seq 7

    // The server has no route that takes or returns an entry's content.
    assert_error(api_call('POST', '/entries/seal', ['items' => []]), 400, 'Ungültiger Eintrag', 'no seal route: "seal" is just a bad eid');
    assert_error(api_call('POST', '/entries', ['eid' => fake_eid(), 'type' => 'diaper', 'details' => ['kind' => 'pee']]), 400, 'Ungültiger Datensatz');

    // Scoping: another family sees nothing and cannot touch these rows (404, never 403).
    $mine = $eid;
    $other = second_family($pdo);
    login_as($pdo, $other['user']);
    assert_eq(api_call('GET', '/sync')[1]['rows'], []);
    assert_error(api_call('PATCH', "/entries/$mine", ['blob' => fake_blob(), 'ifSeq' => 3]), 404, 'Eintrag nicht gefunden');
    assert_error(api_call('DELETE', "/entries/$mine"), 404, 'Eintrag nicht gefunden');
    assert_error(api_call('POST', "/entries/$mine/restore"), 404, 'Eintrag nicht gefunden');
    assert_error(api_call('POST', '/entries', ['eid' => $mine, 'blob' => fake_blob()]), 409, 'Eintrag existiert bereits', 'eids are global');
    $theirs = api_call('POST', '/entries', ['eid' => fake_eid(), 'blob' => fake_blob()]);
    assert_eq($theirs[1]['seq'], 1, 'own seq space');
    $_COOKIE[BT_COOKIE] = bt_create_token($pdo, 1);
    assert_eq(count(api_call('GET', '/sync')[1]['rows']), 2, 'family A unchanged');
    logout();
});
