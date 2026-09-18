<?php
/**
 * Private artwork: an installation may show ONE family its own pictures —
 * the app icon, the badge on the unlock screen — without publishing them.
 *
 * Everyone else gets the public icon set of public/img/ (drawn by
 * scripts/make-icons.mjs). The private files live OUTSIDE the served tree:
 * <app root>/private-art/ (gitignored; packaged with a deny-all .htaccess)
 * and leave the server only through GET /api/art/<name>, behind the session
 * cookie, for members of the family named in the config. Anyone else — no
 * cookie, another family, an unknown name, the feature off — gets the same
 * 404, so the route does not even say that there is something to see.
 *
 *  - config 'private_art_family'  the family's NAME (compared as its name
 *    key, see bt_name_key); null/'' = feature off
 *  - config 'private_art_dir'     the folder; null = <app root>/private-art
 *  - BT_ART_NAMES                 the fixed list of files: nothing else in
 *    the folder is ever read, whatever the request says
 *
 * The sync answer tells a member's phone about it: `art` = a short version
 * string over the files' sizes and mtimes (bt_art_version). The phone
 * fetches the pictures once per version and keeps them (src/art.js).
 *
 * Target: PHP 7.4+.
 */

const BT_ART_NAMES = ['favicon.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'zuno.png'];

/** A file answer of bt_dispatch (everything else it returns is JSON data). */
class BtFileResponse
{
    /** @var string */
    public $path;

    /** @var string */
    public $contentType;

    public function __construct(string $path, string $contentType)
    {
        $this->path = $path;
        $this->contentType = $contentType;
    }
}

/** The artwork folder: config 'private_art_dir', else <app root>/private-art. */
function bt_art_dir(array $config): string
{
    $dir = $config['private_art_dir'] ?? null;
    if (is_string($dir) && $dir !== '') {
        return rtrim($dir, '/');
    }
    return dirname(__DIR__, 2) . '/private-art';
}

/** Is $user a member of the family the artwork is for? False for null users and with the feature off. */
function bt_art_member(array $config, ?array $user): bool
{
    $family = $config['private_art_family'] ?? null;
    if ($user === null || !is_string($family) || trim($family) === '') {
        return false;
    }
    return bt_name_key($family) === bt_name_key((string) $user['familyName']);
}

/** Absolute paths of the artwork files that exist, by name (only names of BT_ART_NAMES). */
function bt_art_files(array $config): array
{
    $dir = bt_art_dir($config);
    $files = [];
    foreach (BT_ART_NAMES as $name) {
        $path = $dir . '/' . $name;
        if (is_file($path) && is_readable($path)) {
            $files[$name] = $path;
        }
    }
    return $files;
}

/**
 * The version string a member's phone keys its copy on, or null when $user
 * gets no artwork (not a member, feature off, empty folder). Changes when
 * a file is replaced, added or removed.
 */
function bt_art_version(array $config, ?array $user): ?string
{
    if (!bt_art_member($config, $user)) {
        return null;
    }
    $parts = [];
    foreach (bt_art_files($config) as $name => $path) {
        $parts[] = $name . ':' . filesize($path) . ':' . filemtime($path);
    }
    return $parts === [] ? null : substr(hash('sha256', implode('|', $parts)), 0, 12);
}

/** GET /api/art/<name>: the file for a member, 404 for everything and everyone else. */
function bt_art_response(array $config, ?array $user, string $name): BtFileResponse
{
    $files = bt_art_member($config, $user) ? bt_art_files($config) : [];
    if (!isset($files[$name])) {
        throw new HttpError(404, 'Nicht gefunden', 'request.notFound');
    }
    return new BtFileResponse($files[$name], 'image/png');
}

/** Send a file answer. `no-store` like every API answer; the phone keeps its own copy per version. */
function bt_send_file(BtFileResponse $file, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: ' . $file->contentType);
    header('Content-Length: ' . filesize($file->path));
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    readfile($file->path);
}
