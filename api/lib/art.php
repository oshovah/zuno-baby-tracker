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
 * The INSTALL icon is the one thing a cookie cannot serve: a browser reads
 * the web manifest and its icons without the page's session, and Android's
 * install service downloads the icon by URL from its own servers. For that
 * there is a second way in, a capability link: GET /api/art/k/<key>/<name>,
 * <key> = 32 random hex digits of this installation (settings.art_key, made
 * on first use), handed to members only (`artKey` on their sync answer).
 * Whoever holds the link sees the picture — nobody can guess it, and a wrong
 * key is the same 404 as everything else here. <name> is a file of
 * BT_ART_NAMES or `manifest.webmanifest`: the public manifest with the
 * family's icons, the same app id, so an installed app keeps its identity.
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

/** This installation's capability key (settings.art_key): 32 hex digits, made on first use. */
function bt_art_key(PDO $pdo): string
{
    $key = bt_setting($pdo, 'art_key');
    if ($key === null || !preg_match('/^[0-9a-f]{32}$/D', $key)) {
        $stmt = $pdo->prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('art_key', ?)");
        $stmt->execute([bin2hex(random_bytes(16))]);
        $key = (string) bt_setting($pdo, 'art_key');
    }
    return $key;
}

/** The public web manifest as an array, or null when it cannot be read (packaged: app root; dev: public/). */
function bt_public_manifest(): ?array
{
    $root = dirname(__DIR__, 2);
    foreach ([$root . '/manifest.webmanifest', $root . '/public/manifest.webmanifest'] as $path) {
        if (is_file($path)) {
            $data = json_decode((string) file_get_contents($path), true);
            return is_array($data) ? $data : null;
        }
    }
    return null;
}

/**
 * GET /api/art/k/<key>/<name>: the file, or the manifest that points at the
 * family's install icons, for whoever holds the key — no session involved.
 * Feature off, wrong key, unknown name, missing file: the same 404.
 *
 * @return BtFileResponse|array
 */
function bt_art_key_response(PDO $pdo, array $config, string $key, string $name)
{
    $notFound = new HttpError(404, 'Nicht gefunden', 'request.notFound');
    $family = $config['private_art_family'] ?? null;
    $files = is_string($family) && trim($family) !== '' ? bt_art_files($config) : [];
    // The stored key is only ever made for a member's sync answer: a
    // stranger's guesses never create it.
    $stored = bt_setting($pdo, 'art_key');
    if ($files === [] || $stored === null || !hash_equals($stored, $key)) {
        throw $notFound;
    }
    if ($name !== 'manifest.webmanifest') {
        if (!isset($files[$name])) {
            throw $notFound;
        }
        return new BtFileResponse($files[$name], 'image/png');
    }
    $manifest = bt_public_manifest();
    $icons = [];
    foreach (['icon-192.png' => '192x192', 'icon-512.png' => '512x512'] as $file => $sizes) {
        if (isset($files[$file])) {
            foreach (['any', 'maskable'] as $purpose) {
                $icons[] = ['src' => $file, 'sizes' => $sizes, 'type' => 'image/png', 'purpose' => $purpose];
            }
        }
    }
    if ($manifest === null || $icons === []) {
        throw $notFound;
    }
    // Relative to THIS answer's URL (<base>/api/art/k/<key>/): four levels up
    // is the app — the same start, scope and id as the public manifest.
    $manifest['start_url'] = '../../../../';
    $manifest['scope'] = '../../../../';
    $manifest['icons'] = $icons;
    return $manifest;
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
