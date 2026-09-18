<?php
/**
 * preview-router.php — router script for previewing the PACKAGED app locally.
 *
 *   php -S 127.0.0.1:8081 scripts/preview-router.php
 *
 * Serves ../deploy (the output of `npm run package`) the way Apache on shared
 * hosting would, BOTH at "/" and under a simulated "/baby/" subdirectory:
 *   - /api/*  and  /baby/api/*   -> deploy/api/index.php (mimics the
 *     .htaccess rewrite; index.php parses REQUEST_URI itself, subdir-safe)
 *   - static files with correct MIME types (html, js, css, json, svg, ...)
 *   - 403 for deploy/data/*, deploy/private-art/*, .ht*, *.db/*.sqlite, config.php (mimics the
 *     .htaccess deny rules)
 *   - 404 for everything else
 *
 * PHP 7.4+ compatible.
 */

$deployDir = realpath(__DIR__ . '/../deploy');
if ($deployDir === false || !is_dir($deployDir)) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    echo "500 — no deploy/ folder found. Run \"npm run package\" first.\n";
    return true;
}

$rawPath = parse_url(isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '/', PHP_URL_PATH);
if (!is_string($rawPath) || $rawPath === '') {
    $rawPath = '/';
}
$path = rawurldecode($rawPath);

// --- simulated /baby subdirectory -------------------------------------------
if ($path === '/baby') {
    $qs = isset($_SERVER['QUERY_STRING']) && $_SERVER['QUERY_STRING'] !== ''
        ? '?' . $_SERVER['QUERY_STRING'] : '';
    header('Location: /baby/' . $qs, true, 301); // like Apache mod_dir
    return true;
}
if (strpos($path, '/baby/') === 0) {
    $path = substr($path, strlen('/baby')); // keep the leading "/"
}

$rel = ltrim($path, '/');

// --- API rewrite (mimics: RewriteRule ^api/(.*)$ api/index.php [L,QSA]) -----
if ($rel === 'api' || strpos($rel, 'api/') === 0) {
    unset($_SERVER['PATH_INFO'], $_SERVER['PATH_TRANSLATED'], $_SERVER['ORIG_PATH_INFO']);
    require $deployDir . '/api/index.php';
    return true;
}

// --- denials (mimic data/.htaccess + the root FilesMatch rules) -------------
function bt_forbidden()
{
    http_response_code(403);
    header('Content-Type: text/plain; charset=utf-8');
    echo "403 Forbidden\n";
}

if ($rel === 'data' || strpos($rel, 'data/') === 0
    || $rel === 'private-art' || strpos($rel, 'private-art/') === 0 // the API reads it from disk (api/lib/art.php)
) {
    bt_forbidden();
    return true;
}
$base = basename($rel);
if ($base !== '' && (
    preg_match('/\.(db|sqlite|sqlite3|db-wal|db-shm|db-journal)$/i', $base)
    || strpos($base, '.ht') === 0   // .htaccess (Apache never serves .ht*)
    || $base === 'config.php'
)) {
    bt_forbidden();
    return true;
}

// --- static files -----------------------------------------------------------
function bt_mime($file)
{
    $ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
    $map = array(
        'html'  => 'text/html; charset=utf-8',
        'htm'   => 'text/html; charset=utf-8',
        'css'   => 'text/css; charset=utf-8',
        'js'    => 'text/javascript; charset=utf-8',
        'mjs'   => 'text/javascript; charset=utf-8',
        'json'  => 'application/json; charset=utf-8',
        'webmanifest' => 'application/manifest+json; charset=utf-8',
        'map'   => 'application/json; charset=utf-8',
        'svg'   => 'image/svg+xml',
        'jpg'   => 'image/jpeg',
        'jpeg'  => 'image/jpeg',
        'png'   => 'image/png',
        'gif'   => 'image/gif',
        'webp'  => 'image/webp',
        'ico'   => 'image/x-icon',
        'txt'   => 'text/plain; charset=utf-8',
        'woff'  => 'font/woff',
        'woff2' => 'font/woff2',
    );
    return isset($map[$ext]) ? $map[$ext] : 'application/octet-stream';
}

$target = $rel === '' ? 'index.html' : $rel;
$full = $deployDir . '/' . $target;
if (is_dir($full)) {
    $full .= '/index.html';
}
$real = realpath($full);
if (
    $real !== false
    && is_file($real)
    && strpos($real, $deployDir . DIRECTORY_SEPARATOR) === 0 // no ../ escapes
) {
    header('Content-Type: ' . bt_mime($real));
    header('Content-Length: ' . (string) filesize($real));
    readfile($real);
    return true;
}

http_response_code(404);
header('Content-Type: text/plain; charset=utf-8');
echo "404 Not Found\n";
return true;
