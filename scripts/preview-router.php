<?php
/**
 * preview-router.php — router script for previewing the PACKAGED app locally.
 *
 *   php -S 127.0.0.1:8081 scripts/preview-router.php
 *   PHP_CLI_SERVER_WORKERS=8 npm run preview   (the map: pmtiles asks for
 *                                               several byte ranges at once;
 *                                               php -S is single-threaded)
 *
 * Serves ../deploy (the output of `npm run package`) the way Apache on shared
 * hosting would, BOTH at "/" and under a simulated "/baby/" subdirectory:
 *   - /api/*  and  /baby/api/*   -> deploy/api/index.php (mimics the
 *     .htaccess rewrite; index.php parses REQUEST_URI itself, subdir-safe)
 *   - static files with correct MIME types (html, js, css, json, svg, ...),
 *     byte ranges included (Range → 206, like Apache: the map's basemap
 *     archive is read that way by pmtiles, which gives up on a 200)
 *   - /basemap/*  -> ../basemap (the archive is uploaded on its own with
 *     `npm run deploy:basemap` and never part of deploy/)
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
        'pmtiles' => 'application/octet-stream',
    );
    return isset($map[$ext]) ? $map[$ext] : 'application/octet-stream';
}

/**
 * Sends a file like Apache would, byte ranges included: a `Range: bytes=…`
 * header gets 206 + Content-Range (an unsatisfiable one 416), anything else
 * the whole file with 200. The same rule as scripts/lib/range.mjs (the dev
 * server); pmtiles reads the basemap archive this way and refuses a 200.
 * Streams in 64 KB pieces — never readfile() on a 600 MB archive.
 */
function bt_send_file($real, $mime)
{
    $size = filesize($real);
    header('Accept-Ranges: bytes');
    header('Content-Type: ' . $mime);
    $start = 0;
    $end = $size - 1;
    $status = 200;
    $range = isset($_SERVER['HTTP_RANGE']) ? trim($_SERVER['HTTP_RANGE']) : '';
    if ($range !== '' && preg_match('/^bytes=(\d*)-(\d*)$/', $range, $m) && ($m[1] !== '' || $m[2] !== '')) {
        $bad = $size <= 0;
        if (!$bad) {
            if ($m[1] === '') { // suffix range: the last n bytes
                $n = (int) $m[2];
                if ($n === 0) {
                    $bad = true;
                } else {
                    $start = max(0, $size - $n);
                }
            } else {
                $start = (int) $m[1];
                if ($m[2] !== '') {
                    $end = min((int) $m[2], $size - 1);
                }
            }
        }
        if ($bad || $start >= $size || $start > $end) {
            http_response_code(416);
            header('Content-Range: bytes */' . $size);
            return;
        }
        $status = 206;
        header('Content-Range: bytes ' . $start . '-' . $end . '/' . $size);
    }
    http_response_code($status);
    header('Content-Length: ' . (string) ($end - $start + 1));
    if (isset($_SERVER['REQUEST_METHOD']) && $_SERVER['REQUEST_METHOD'] === 'HEAD') {
        return;
    }
    $fh = fopen($real, 'rb');
    if ($fh === false) {
        return;
    }
    fseek($fh, $start);
    $left = $end - $start + 1;
    while ($left > 0 && !feof($fh)) {
        $chunk = fread($fh, (int) min(65536, $left));
        if ($chunk === false || $chunk === '') {
            break;
        }
        echo $chunk;
        $left -= strlen($chunk);
    }
    fclose($fh);
}

$baseDir = $deployDir;
$target = $rel === '' ? 'index.html' : $rel;
// The basemap archive lives outside deploy/ (basemap/ at the project root,
// uploaded on its own): serve it from there, like the Vite plugin does.
if (strpos($rel, 'basemap/') === 0) {
    $basemapDir = realpath(__DIR__ . '/../basemap');
    if ($basemapDir !== false && is_dir($basemapDir)) {
        $baseDir = $basemapDir;
        $target = substr($rel, strlen('basemap/'));
    }
}
$full = $baseDir . '/' . $target;
if (is_dir($full)) {
    $full .= '/index.html';
}
$real = realpath($full);
if (
    $real !== false
    && is_file($real)
    && strpos($real, $baseDir . DIRECTORY_SEPARATOR) === 0 // no ../ escapes
) {
    bt_send_file($real, bt_mime($real));
    return true;
}

http_response_code(404);
header('Content-Type: text/plain; charset=utf-8');
echo "404 Not Found\n";
return true;
