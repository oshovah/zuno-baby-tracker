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
 *   legacy_password_hash  string|null  bcrypt of the shared password of the
 *                         pre-accounts release (package.mjs hashes
 *                         APP_PASSWORD from .env for the migration release
 *                         only). While set, the plaintext rows migrated from
 *                         that era are adopted only by a family creator who
 *                         sends that password as `legacyPassword`; null = no
 *                         gate, the first family created adopts them (see
 *                         bt_register in lib/auth.php).
 *   private_art_family    string|null  NAME of the one family that gets the
 *                         installation's private artwork (lib/art.php) instead
 *                         of the public icon set; null = nobody does. Packaging
 *                         takes it from PRIVATE_ART_FAMILY in .env; in dev the
 *                         BABY_ART_FAMILY environment variable sets it.
 *   private_art_dir       string|null  folder of those pictures; null =
 *                         <app root>/private-art (gitignored). Dev/tests:
 *                         BABY_ART_DIR.
 *
 * (The former 'password'/'password_hash' keys — the one shared login password,
 * hashed from APP_PASSWORD in .env at packaging time — were removed when the
 * app got its own accounts + families; see lib/auth.php. In dev, register a
 * user in the app; there is no dev password any more.)
 */

$envDbPath = getenv('BABY_DB_PATH');
$envArtFamily = getenv('BABY_ART_FAMILY');
$envArtDir = getenv('BABY_ART_DIR');

return [
    'db_path' => (is_string($envDbPath) && $envDbPath !== '') ? $envDbPath : null,
    'legacy_password_hash' => null,
    'private_art_family' => (is_string($envArtFamily) && $envArtFamily !== '') ? $envArtFamily : null,
    'private_art_dir' => (is_string($envArtDir) && $envArtDir !== '') ? $envArtDir : null,
];
