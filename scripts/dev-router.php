<?php
/**
 * dev-router.php — router script for the PHP built-in dev server.
 *
 *   php -S 127.0.0.1:8788 scripts/dev-router.php
 *
 * Routes every /api/* request into api/index.php (the front controller parses
 * REQUEST_URI itself, exactly as it does behind the Apache rewrite in
 * production — so dev exercises the same code path). Everything else is 404:
 * in dev the frontend is served by Vite on its own port, which proxies /api here.
 *
 * PHP 7.4+ compatible.
 */

$path = parse_url(isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '/', PHP_URL_PATH);
if (!is_string($path) || $path === '') {
    $path = '/';
}

if ($path === '/api' || strpos($path, '/api/') === 0) {
    // Apache's internal rewrite (production) never sets PATH_INFO, but the PHP
    // built-in server sometimes computes a junk one. Drop it so index.php
    // falls back to parsing REQUEST_URI — the same code path as behind Apache.
    unset($_SERVER['PATH_INFO'], $_SERVER['PATH_TRANSLATED'], $_SERVER['ORIG_PATH_INFO']);
    require __DIR__ . '/../api/index.php';
    return true;
}

http_response_code(404);
header('Content-Type: text/plain; charset=utf-8');
echo "404 Not Found\n";
echo "This dev server only handles /api/* (the Vite dev server serves the UI).\n";
return true;
