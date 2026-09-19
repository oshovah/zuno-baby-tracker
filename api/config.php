<?php
/**
 * Dev configuration (this file ships in the repo).
 * Packaging (scripts/package.mjs) writes a deploy-only replacement — never
 * commit credentials here.
 *
 * Keys:
 *   db_path  string|null  SQLite file path; absolute, or relative to the app
 *                         root (the parent of api/). null = data/baby.db.
 *                         Dev convenience: the BABY_DB_PATH environment
 *                         variable overrides it (used by tests/tooling to run
 *                         against a scratch database).
 *   private_art_family    string|null  NAME of the one family that gets the
 *                         installation's private artwork (lib/art.php) instead
 *                         of the public icon set; null = nobody does. Packaging
 *                         takes it from PRIVATE_ART_FAMILY in .env; in dev the
 *                         BABY_ART_FAMILY environment variable sets it.
 *   private_art_dir       string|null  folder of those pictures; null =
 *                         <app root>/private-art (gitignored). Dev/tests:
 *                         BABY_ART_DIR.
 *
 * There is no password here: accounts live in the database (lib/auth.php).
 * In dev, register a user in the app.
 */

$envDbPath = getenv('BABY_DB_PATH');
$envArtFamily = getenv('BABY_ART_FAMILY');
$envArtDir = getenv('BABY_ART_DIR');

return [
    'db_path' => (is_string($envDbPath) && $envDbPath !== '') ? $envDbPath : null,
    'private_art_family' => (is_string($envArtFamily) && $envArtFamily !== '') ? $envArtFamily : null,
    'private_art_dir' => (is_string($envArtDir) && $envArtDir !== '') ? $envArtDir : null,
];
