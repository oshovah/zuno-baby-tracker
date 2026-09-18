<?php
/**
 * Front controller for the baby tracker API (schema v3: end-to-end encrypted
 * entries, per-person accounts grouped in families).
 *
 * All endpoints live under /api, JSON in/out, errors as {"error": "...",
 * "code": "entries.notFound", "params": {...}?} with
 * 400/401/403/404/405/409/410/415/429/500/503/507. Error messages are German;
 * the code names the error by meaning and the UI translates it when it can
 * (older shells show the message verbatim — see lib/http.php). Every
 * response is Cache-Control: no-store.
 *
 * The server never sees a password or an entry's content: clients send
 * password-derived AUTH KEYS (bcrypted here), wrapped Family Data Keys and
 * opaque AES-GCM blobs (see lib/auth.php and lib/entries.php).
 *
 * Public:
 *   GET  /api/me                      {authenticated, user|null} — the health check; never key material
 *   GET  /api/auth/params?username=…  {kdf: {salt, iter}} (a stable fake for unknown names)
 *   GET  /api/families/check?name=…   {exists, name, kdf|null}
 *   POST /api/families/unlock         {familyName, familyAuthKey | recoveryAuthKey} -> {kdf, fdkWrapped}
 *   POST /api/register                create-or-join in ONE request (a join may carry rotateFamily:
 *                                     fresh family credentials applied with the join, see lib/auth.php)
 *                                     -> 201 {ok, user, familyCreated, familyClosed, adoptedEntries, legacyRemaining}
 *   POST /api/login                   {username, authKey} -> {ok, user, kdf, fdkWrappedUser}
 *   POST /api/logout
 *   GET  /api/state, GET /api/entries, /api/entries/<integer id>… -> 410 with the update hint
 *                                     (routes only the pre-encryption shell calls)
 * Authenticated (cookie; everything scoped to the user's family):
 *   POST   /api/me/keys/unlock        {authKey} -> {kdf, fdkWrappedUser}
 *   PATCH  /api/me                    {profileBlob} -> {ok, user}
 *   PATCH  /api/me/password           {currentAuthKey, authKey, kdf, fdkWrappedUser} -> {ok}
 *   PATCH  /api/families/password     {currentAuthKey, familyAuthKey, familyKdf, fdkWrappedFamily} -> {ok}
 *   GET    /api/sync?since=&limit=    {serverNow, feed, rows, next, legacyRemaining[, reset][, art]}
 *   POST   /api/entries               {eid, blob} -> 201 row (507 at the family's or the database's row cap)
 *   PATCH  /api/entries/:eid          {blob, ifSeq} -> row (409 when the seq moved)
 *   DELETE /api/entries/:eid          [{ifSeq}] -> row (soft delete; with a body, 409 when the seq moved)
 *   POST   /api/entries/:eid/restore  -> row
 *   POST   /api/entries/seal          {items: [{eid, seq, blob}]} -> {done, skipped, remaining}
 *   GET    /api/art/<name>            a private artwork file (image/png) for members of the configured
 *                                     family; the same 404 for everyone and everything else (lib/art.php)
 * User JSON everywhere: {username, familyId, familyName, profileBlob}; row
 * JSON: {eid, seq, blob|null, plain|null, createdAt, updatedAt, deletedAt}.
 *
 * Every POST/PATCH — and a DELETE that carries a body — must declare
 * Content-Type: application/json (415 otherwise); that closes cross-site
 * form posts against login/register.
 * Throttling (429, see lib/auth.php): per IP — the plain IP for login and
 * for every "own password" confirmation (keys unlock, password changes),
 * 'reg:<ip>' for registration and family unlock, 10 attempts / 15 min — and
 * per TARGET: 'user:<username>' for logins and confirmations against one
 * account, 'family:<name key>' for family unlocks and joins against one
 * family, 20 / hour from any number of addresses. Attempts are counted
 * AFTER validation (typos are free, everything that reaches bcrypt or the
 * DB counts, successes included) and never cleared on success. Wrong
 * secrets are additionally damped by 300 ms. Entry writes draw on a per-IP
 * write budget ('write:<ip>', 300 / 15 min) before anything else happens,
 * and a create stops at the row caps of lib/entries.php (507). A body still
 * carrying raw passwords comes from the service-worker-cached previous
 * shell -> 400 with an update hint before any work.
 *
 * Routing works identically in three situations:
 *  1. Apache + .htaccess rewrite (possibly under a subdirectory):
 *       RewriteRule ^api/(.*)$ api/index.php [L,QSA]   ->  /baby/api/sync
 *  2. php -S with a router script (dev/preview)         ->  /api/sync
 *  3. Direct PATH_INFO style                            ->  /api/index.php/sync
 *
 * Structure: bt_dispatch() maps a request to [status, data] and never sends
 * anything; bt_handle() turns throwables into the same shape; the bottom of
 * the file serves the real request unless BT_NO_SERVE is defined first (the
 * tests include this file that way and call the routes directly).
 *
 * Target: PHP 7.4+ with pdo_sqlite.
 */

require_once __DIR__ . '/lib/http.php';
require_once __DIR__ . '/lib/db.php';
require_once __DIR__ . '/lib/auth.php';
require_once __DIR__ . '/lib/entries.php';
require_once __DIR__ . '/lib/art.php';

/** Damping delay after a wrong secret (microseconds). */
const BT_WRONG_SECRET_DELAY_US = 300000;

/** Request method; HEAD is served by GET handlers. */
function bt_method(): string
{
    $m = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    return $m === 'HEAD' ? 'GET' : $m;
}

/**
 * Whether the request carries a body: the test override when given, else
 * CONTENT_LENGTH > 0 (php://input is not consulted — it is read once, by
 * read_json_body, and only by routes that want a body).
 */
function bt_has_request_body(?array $body): bool
{
    if ($body !== null) {
        return true;
    }
    $length = $_SERVER['CONTENT_LENGTH'] ?? ($_SERVER['HTTP_CONTENT_LENGTH'] ?? '0');
    return is_scalar($length) && (int) $length > 0;
}

/**
 * Resolve the API route path to url-decoded segments.
 * Prefer PATH_INFO when set; fall back to the path component of REQUEST_URI.
 * In both cases, find the FIRST "/api/" segment and use the remainder
 * (subdirectory-safe); a leading "/index.php" script segment is stripped for
 * hosts that do not populate PATH_INFO.
 */
function bt_route_segments(): array
{
    $pathInfo = $_SERVER['PATH_INFO'] ?? '';
    if (is_string($pathInfo) && $pathInfo !== '') {
        $path = $pathInfo;
    } else {
        $uri = $_SERVER['REQUEST_URI'] ?? '/';
        if (!is_string($uri) || $uri === '') {
            $uri = '/';
        }
        $qPos = strpos($uri, '?');
        $path = $qPos === false ? $uri : substr($uri, 0, $qPos);
    }

    $apiPos = strpos($path, '/api/');
    if ($apiPos !== false) {
        $path = substr($path, $apiPos + 4); // keep the leading slash: "/sync"
    } elseif (substr($path, -4) === '/api') {
        $path = '/';
    }
    if (strpos($path, '/index.php') === 0) {
        $path = substr($path, strlen('/index.php'));
    }

    $path = rtrim($path, '/');
    if ($path === '') {
        return [];
    }
    $segments = explode('/', ltrim($path, '/'));
    foreach ($segments as $i => $seg) {
        $segments[$i] = rawurldecode($seg);
    }
    return $segments;
}

/** Throw 405 unless the request method is in $allowed. */
function bt_require_method(string $method, array $allowed): void
{
    if (!in_array($method, $allowed, true)) {
        throw new HttpError(405, 'Methode nicht erlaubt', 'request.methodNotAllowed');
    }
}

/** Client IP for the throttle keys. */
function bt_client_ip(): string
{
    return (string) ($_SERVER['REMOTE_ADDR'] ?? 'unknown');
}

/** A non-negative integer query parameter ($_GET), $default when absent; 400 on anything else. */
function bt_query_int(string $name, int $default): int
{
    $value = $_GET[$name] ?? null;
    if ($value === null || $value === '') {
        return $default;
    }
    if (!is_string($value) || !preg_match('/^\d{1,15}$/D', $value)) {
        throw new HttpError(400, '"' . $name . '" muss eine ganze Zahl sein', 'request.notAnInteger', ['field' => $name]);
    }
    return (int) $value;
}

/**
 * Run $fn (which returns [status, data]) and, when it throws, the matching
 * error response instead — never an exception: HttpError -> its status,
 * German text, code and params (bt_error_body), a locked SQLite file
 * (rollback-journal hosts) -> a transient 503, anything else -> a logged 500.
 */
function bt_handle(callable $fn): array
{
    try {
        return $fn();
    } catch (HttpError $e) {
        return [$e->status, bt_error_body($e->getMessage(), $e->code, $e->params)];
    } catch (PDOException $e) {
        if (stripos($e->getMessage(), 'locked') !== false || stripos($e->getMessage(), 'busy') !== false) {
            return [503, bt_error_body('Kurz überlastet – bitte nochmals versuchen', 'server.busy')];
        }
        error_log('[baby-tracker] ' . $e->getMessage() . ' at ' . $e->getFile() . ':' . $e->getLine());
        return [500, bt_error_body('Serverfehler', 'server.internal')];
    } catch (Throwable $e) {
        error_log('[baby-tracker] ' . $e->getMessage() . ' at ' . $e->getFile() . ':' . $e->getLine());
        return [500, bt_error_body('Serverfehler', 'server.internal')];
    }
}

/**
 * Run $fn; a 403 from it (a wrong secret, verified by bcrypt) is damped by
 * BT_WRONG_SECRET_DELAY_US before it propagates and counted against every
 * throttle key in $keys first ([] = the attempt was already counted up
 * front, as registration and family unlock do).
 */
function bt_damp_wrong_secret(PDO $pdo, array $keys, callable $fn)
{
    try {
        return $fn();
    } catch (HttpError $e) {
        if ($e->status === 403) {
            foreach ($keys as $key) {
                bt_record_login_failure($pdo, $key);
            }
            usleep(BT_WRONG_SECRET_DELAY_US);
        }
        throw $e;
    }
}

/**
 * Map a request to [status, data] (see the file docblock for the routes).
 * $body overrides the JSON request body (tests); null reads php://input on
 * demand. Throws HttpError for every client error — bt_handle maps them.
 */
function bt_dispatch(PDO $pdo, array $config, string $method, array $segments, ?array $body = null): array
{
    // A DELETE normally has no body; when it carries one (the ifSeq of a
    // conditional delete) it must declare JSON like every POST/PATCH — a
    // body without the header is refused (415) before any route runs.
    if ($method === 'POST' || $method === 'PATCH' || ($method === 'DELETE' && bt_has_request_body($body))) {
        bt_assert_json_request();
    }
    $readBody = function () use ($body): array {
        return $body ?? read_json_body();
    };

    // --- public -------------------------------------------------------------

    if ($segments === ['me'] && $method === 'GET') {
        $user = bt_current_user($pdo);
        return [200, [
            'authenticated' => $user !== null,
            'user' => $user !== null ? bt_user_json($user) : null,
        ]];
    }

    if ($segments === ['auth', 'params']) {
        bt_require_method($method, ['GET']);
        return [200, ['kdf' => bt_auth_params($pdo, $_GET['username'] ?? null)]];
    }

    if ($segments === ['families', 'check']) {
        bt_require_method($method, ['GET']);
        $found = bt_family_exists($pdo, $_GET['name'] ?? null);
        return [200, [
            'exists' => $found !== null,
            'name' => $found !== null ? $found['name'] : null,
            'kdf' => $found !== null ? $found['kdf'] : null,
        ]];
    }

    // The only way to the family-wrapped FDK: the family password (or the
    // recovery code) must verify — a cookie never suffices. Throttled like
    // registration; every attempt that reaches the lookup/bcrypt is counted.
    if ($segments === ['families', 'unlock']) {
        bt_require_method($method, ['POST']);
        $key = 'reg:' . bt_client_ip();
        bt_assert_login_allowed($pdo, $key);
        $body = $readBody();
        bt_reject_old_shell($body);
        $name = bt_valid_family_name($body['familyName'] ?? null); // typos (400) are free ...
        bt_family_credential($body);
        $target = bt_family_throttle_key(bt_name_key($name));
        bt_assert_login_allowed($pdo, $target);
        bt_record_login_failure($pdo, $key);               // ... the verification is counted
        bt_record_login_failure($pdo, $target);            //     against the address AND the family
        $res = bt_damp_wrong_secret($pdo, [], function () use ($pdo, $body) {
            return bt_family_unlock($pdo, $body);
        });
        return [200, ['kdf' => $res['kdf'], 'fdkWrapped' => $res['fdkWrapped']]];
    }

    if ($segments === ['register']) {
        bt_require_method($method, ['POST']);
        $key = 'reg:' . bt_client_ip();
        bt_assert_login_allowed($pdo, $key);
        $body = $readBody();
        $reg = bt_validate_registration($body); // typos (400) are free ...
        // A join guesses a family's password: its target budget applies too.
        $target = $reg['familyMode'] === 'join' ? bt_family_throttle_key(bt_name_key($reg['familyName'])) : null;
        if ($target !== null) {
            bt_assert_login_allowed($pdo, $target);
        }
        // ... everything that reaches bcrypt or the DB is counted FIRST, so a
        // burst of concurrent guesses or an aborted request cannot dodge the
        // budget (successful registrations count too).
        bt_record_login_failure($pdo, $key);
        if ($target !== null) {
            bt_record_login_failure($pdo, $target);
        }
        $res = bt_damp_wrong_secret($pdo, [], function () use ($pdo, $body, $config) {
            return bt_register($pdo, $body, $config);
        });
        bt_gc_tokens($pdo);
        bt_issue_token($pdo, (int) $res['user']['id']);
        return [201, [
            'ok' => true,
            'user' => bt_user_json($res['user']),
            'familyCreated' => $res['familyCreated'],
            'familyClosed' => $res['familyClosed'],
            'adoptedEntries' => $res['adoptedEntries'],
            'legacyRemaining' => $res['legacyRemaining'],
        ]];
    }

    if ($segments === ['login']) {
        bt_require_method($method, ['POST']);
        $ip = bt_client_ip();
        bt_assert_login_allowed($pdo, $ip);
        $body = $readBody();
        bt_reject_old_shell($body);
        // The account under attack has a budget of its own (any address).
        $username = $body['username'] ?? null;
        $target = is_string($username) && trim($username) !== '' ? bt_user_throttle_key($username) : null;
        if ($target !== null) {
            bt_assert_login_allowed($pdo, $target);
        }
        $user = bt_authenticate($pdo, $username, $body['authKey'] ?? null);
        if ($user === null) {
            bt_record_login_failure($pdo, $ip);
            if ($target !== null) {
                bt_record_login_failure($pdo, $target);
            }
            usleep(BT_WRONG_SECRET_DELAY_US);
            throw new HttpError(401, 'Benutzername oder Passwort falsch', 'auth.badCredentials');
        }
        // Deliberately no bt_clear_login_failures: with open registration a
        // guesser could reset the budget by logging into their own account.
        bt_gc_tokens($pdo);
        bt_issue_token($pdo, (int) $user['id']);
        return [200, [
            'ok' => true,
            'user' => bt_user_json($user),
            'kdf' => $user['kdf'],
            'fdkWrappedUser' => $user['fdkWrapped'],
        ]];
    }

    if ($segments === ['logout']) {
        bt_require_method($method, ['POST']);
        bt_revoke_current_token($pdo);
        return [200, ['ok' => true]];
    }

    // Routes only the pre-encryption shell knows (its state fetch, its
    // history range, its integer entry ids): answered before auth so the
    // update hint reaches the phone no matter what its cookie is worth.
    if ($segments === ['state'] || ($segments === ['entries'] && $method === 'GET')
        || (count($segments) >= 2 && $segments[0] === 'entries' && ctype_digit($segments[1]) && strlen($segments[1]) < 32)
    ) {
        throw new HttpError(410, BT_OLD_SHELL_MESSAGE, 'request.oldShell');
    }

    // Private artwork (lib/art.php). Answered before the auth gate: a
    // stranger must get the same 404 as a member of another family, not a
    // 401 that says "log in and there is something here".
    if (count($segments) === 2 && $segments[0] === 'art') {
        bt_require_method($method, ['GET']);
        return [200, bt_art_response($config, bt_current_user($pdo), $segments[1])];
    }

    // --- authenticated (scoped to the user's family) --------------------------

    $user = bt_require_auth($pdo);
    return bt_dispatch_authed($pdo, $user, $method, $segments, $readBody, $config);
}

/**
 * The routes behind the auth cookie. A wrong "own password" confirmation
 * (403) burns the IP's login budget AND the account's target budget so a
 * stolen cookie cannot brute-force the member's password through them.
 * Every entries mutation is charged to the address's write budget before
 * anything else (bt_charge_write): invalid bodies included — a loop is a
 * loop.
 */
function bt_dispatch_authed(PDO $pdo, array $user, string $method, array $segments, callable $readBody, array $config = []): array
{
    $fid = (int) $user['familyId'];
    $ip = bt_client_ip();
    $ownKeys = [$ip, bt_user_throttle_key($user['username'])];
    $assertOwnAllowed = function () use ($pdo, $ownKeys) {
        foreach ($ownKeys as $key) {
            bt_assert_login_allowed($pdo, $key);
        }
    };
    if ($segments !== [] && $segments[0] === 'entries' && $method !== 'GET') {
        bt_charge_write($pdo, $ip);
    }

    if ($segments === ['me']) {
        bt_require_method($method, ['PATCH']);
        $updated = bt_update_profile($pdo, $user, $readBody());
        return [200, ['ok' => true, 'user' => bt_user_json($updated)]];
    }

    // The member-wrapped FDK for a device whose local key store is gone
    // (the cookie is alive, the key is not): the own password must verify.
    if ($segments === ['me', 'keys', 'unlock']) {
        bt_require_method($method, ['POST']);
        $assertOwnAllowed();
        $body = $readBody();
        $keys = bt_damp_wrong_secret($pdo, $ownKeys, function () use ($pdo, $user, $body) {
            return bt_unlock_user_keys($pdo, $user, $body);
        });
        return [200, ['kdf' => $keys['kdf'], 'fdkWrappedUser' => $keys['fdkWrapped']]];
    }

    if ($segments === ['me', 'password']) {
        bt_require_method($method, ['PATCH']);
        $assertOwnAllowed();
        $body = $readBody();
        bt_damp_wrong_secret($pdo, $ownKeys, function () use ($pdo, $user, $body) {
            bt_update_password($pdo, $user, $body);
        });
        return [200, ['ok' => true]];
    }

    // Any member may set a new family password (needed only to JOIN); their
    // own password confirms it.
    if ($segments === ['families', 'password']) {
        bt_require_method($method, ['PATCH']);
        $assertOwnAllowed();
        $body = $readBody();
        bt_damp_wrong_secret($pdo, $ownKeys, function () use ($pdo, $user, $body) {
            bt_update_family_password($pdo, $user, $body);
        });
        return [200, ['ok' => true]];
    }

    if ($segments === ['sync']) {
        bt_require_method($method, ['GET']);
        $since = bt_query_int('since', 0);
        $limit = bt_query_int('limit', BT_SYNC_MAX_LIMIT);
        $page = bt_sync_entries($pdo, $fid, $since, $limit);
        // A member of the artwork family learns which version of its
        // pictures the server holds (lib/art.php); nobody else gets the key.
        $art = bt_art_version($config, $user);
        if ($art !== null) {
            $page['art'] = $art;
        }
        return [200, $page];
    }

    if ($segments === ['entries']) {
        bt_require_method($method, ['POST']);
        return [201, bt_create_entry($pdo, $fid, $readBody())];
    }

    if ($segments === ['entries', 'seal']) {
        bt_require_method($method, ['POST']);
        $body = $readBody();
        $items = $body['items'] ?? null;
        if (!is_array($items)) {
            throw new HttpError(400, '"items" fehlt', 'request.missingField', ['field' => 'items']);
        }
        return [200, bt_seal_legacy($pdo, $fid, array_values($items))];
    }

    if (count($segments) === 2 && $segments[0] === 'entries') {
        $eid = bt_valid_eid($segments[1]);
        if ($method === 'PATCH') {
            return [200, bt_update_entry($pdo, $fid, $eid, $readBody())];
        }
        if ($method === 'DELETE') {
            // Optional {ifSeq} body (conditional delete); no body = unconditional.
            return [200, bt_delete_entry($pdo, $fid, $eid, null, $readBody())];
        }
        throw new HttpError(405, 'Methode nicht erlaubt', 'request.methodNotAllowed');
    }

    // Undo of a soft delete (the delete toast's Rückgängig).
    if (count($segments) === 3 && $segments[0] === 'entries' && $segments[2] === 'restore') {
        $eid = bt_valid_eid($segments[1]);
        bt_require_method($method, ['POST']);
        return [200, bt_restore_entry($pdo, $fid, $eid)];
    }

    throw new HttpError(404, 'Nicht gefunden', 'request.notFound');
}

// ---------------------------------------------------------------------------
// Serve the request (skipped when the tests include this file)
// ---------------------------------------------------------------------------

if (!defined('BT_NO_SERVE')) {
    // A PHP warning must never end up in a response (paths, SQL fragments):
    // the host's log gets it, the client gets JSON. Belt and braces over
    // the production php.ini; the test runner keeps its own setting.
    ini_set('display_errors', '0');
    $config = require __DIR__ . '/config.php';
    list($status, $data) = bt_handle(function () use ($config) {
        return bt_dispatch(bt_db($config), $config, bt_method(), bt_route_segments());
    });
    if ($data instanceof BtFileResponse) {
        bt_send_file($data, $status);
    } else {
        send_json($data, $status);
    }
}
