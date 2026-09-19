#!/usr/bin/env node
/**
 * package.mjs — assemble an upload-ready `deploy/` folder for shared PHP hosting.
 *
 * Steps (idempotent — deploy/ is wiped first):
 *   1. `npm run build` (vite) unless --no-build
 *   2. dist/*  -> deploy/            (built frontend, incl. sw.js + manifest)
 *      api/*   -> deploy/api/        (PHP backend, minus tests/ and the dev config.php)
 *   3. generate deploy/api/config.php   (db_path from DEPLOY_DB_PATH, the private-art family)
 *   4. generate deploy/.htaccess        (api rewrite, FilesMatch denials, caching)
 *   5. generate deploy/data/.htaccess   (deny-all stub — the SQLite db must never be served)
 *   5b. private-art/ -> deploy/private-art/ when PRIVATE_ART_FAMILY is set (deny-all stub;
 *       the pictures only ever leave through GET /api/art/<name>, see api/lib/art.php)
 *   6. print a summary + total size
 *
 * Auth note: accounts + families live in the database (api/lib/auth.php) and
 * entries are end-to-end encrypted — no password or key is packaged.
 *
 * Usage: node scripts/package.mjs [--no-build] [--env <file>] [--root <dir>]
 *   --no-build   skip `npm run build` and reuse the existing dist/
 *   --env FILE   read .env keys from FILE (default: <root>/.env)
 *   --root DIR   project root (default: this script's parent dir; used by tests)
 *
 * Zero npm dependencies (Node 18+).
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const flags = { noBuild: false, env: null, root: null };
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-build') flags.noBuild = true;
    else if (a === '--env') flags.env = argv[++i];
    else if (a === '--root') flags.root = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/package.mjs [--no-build] [--env <file>] [--root <dir>]');
      process.exit(0);
    } else {
      console.error(`[package] ERROR: unknown argument "${a}" (try --help)`);
      process.exit(2);
    }
  }
}

const root = flags.root ? path.resolve(flags.root) : path.resolve(scriptDir, '..');
const distDir = path.join(root, 'dist');
const apiDir = path.join(root, 'api');
const deployDir = path.join(root, 'deploy');
const envFile = flags.env ? path.resolve(flags.env) : path.join(root, '.env');

function log(msg) {
  console.log(`[package] ${msg}`);
}
function fail(msg) {
  console.error(`[package] ERROR: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Minimal .env parser (kept in sync with scripts/deploy.mjs).
// KEY=VALUE lines; full-line # comments only (an inline "#" belongs to the value);
// optional surrounding single/double quotes are stripped.
// ---------------------------------------------------------------------------

function parseEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DB_FILE_RE = /\.(db|sqlite|sqlite3|db-wal|db-shm|db-journal)$/i;

/** Recursive copy with an exclude callback; returns number of files copied. */
function copyTree(srcDir, destDir, exclude) {
  let count = 0;
  const walk = (rel) => {
    const from = rel ? path.join(srcDir, rel) : srcDir;
    const to = rel ? path.join(destDir, rel) : destDir;
    fs.mkdirSync(to, { recursive: true });
    const entries = fs
      .readdirSync(from, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (exclude(childRel, entry)) continue;
      if (entry.isDirectory()) {
        walk(childRel);
      } else if (entry.isFile()) {
        fs.copyFileSync(path.join(from, entry.name), path.join(to, entry.name));
        count++;
      }
      // symlinks/sockets etc. are skipped on purpose
    }
  };
  walk('');
  return count;
}

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Total size + file count of a directory tree. */
function dirStats(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) {
        bytes += fs.statSync(p).size;
        files++;
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

// ---------------------------------------------------------------------------
// 0. Read .env
// ---------------------------------------------------------------------------

const env = parseEnvFile(envFile);

// DEPLOY_DB_PATH — where the SQLite file lives ON THE SERVER. Unset = the
// default <docroot>/data/baby.db, which two .htaccess rules keep off the web.
// A location above the docroot removes that dependency altogether: either an
// absolute server path or one starting with "../", which the API resolves
// against the app root (= the docroot) — handy on shared hosting, where the
// FTP view does not show the real absolute path. The file must already be
// there when the packaged config goes live: the API creates an EMPTY
// database at a missing path (fresh feed id, no accounts — every phone would
// log out and drop its mirror), so move baby.db together with its -wal and
// -shm files FIRST, then set the variable and deploy.
let deployDbPath = null;
if (env.DEPLOY_DB_PATH) {
  const p = env.DEPLOY_DB_PATH.trim();
  if (!p.startsWith('/') && !p.startsWith('../')) {
    fail(`DEPLOY_DB_PATH must be absolute or start with "../" (relative to the docroot); got "${p}"`);
  }
  if (/[\r\n\0]/.test(p)) fail('DEPLOY_DB_PATH contains a line break or NUL');
  deployDbPath = p;
  log(`DEPLOY_DB_PATH set: the API will open ${p} (move the file there before this config goes live)`);
} else {
  log('no DEPLOY_DB_PATH in .env: the API uses <docroot>/data/baby.db');
}

// PRIVATE_ART_FAMILY — the NAME of the one family that sees this
// installation's private artwork (private-art/, gitignored) instead of the
// public icon set. The pictures are packaged into a folder nothing serves
// and handed out by the API to that family's sessions only (api/lib/art.php).
// Unset = the feature is off and private-art/ is NOT packaged.
const ART_NAMES = ['favicon.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'zuno.png']; // = BT_ART_NAMES
const artSrcDir = path.join(root, 'private-art');
let privateArtFamily = null;
if (env.PRIVATE_ART_FAMILY && env.PRIVATE_ART_FAMILY.trim() !== '') {
  privateArtFamily = env.PRIVATE_ART_FAMILY.trim();
  if (/[\r\n\0]/.test(privateArtFamily)) fail('PRIVATE_ART_FAMILY contains a line break or NUL');
}

// ---------------------------------------------------------------------------
// 1. Wipe deploy/, build
// ---------------------------------------------------------------------------

// A partially assembled deploy/ must never survive a failure: it would look
// complete enough (index.html + api/index.php are copied early) to pass
// deploy.mjs's checks while missing the generated .htaccess/config.php.
let assembling = false;
process.on('exit', (code) => {
  if (assembling && code !== 0) {
    try {
      fs.rmSync(deployDir, { recursive: true, force: true });
      console.error('[package] removed the partially assembled deploy/ (packaging failed)');
    } catch {
      /* best effort */
    }
  }
});

log(`project root: ${root}`);
fs.rmSync(deployDir, { recursive: true, force: true });
log('wiped deploy/');
assembling = true;

if (!flags.noBuild) {
  log('running "npm run build" ...');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const res = spawnSync(npm, ['run', 'build'], { cwd: root, stdio: 'inherit' });
  if (res.error) fail(`could not run npm: ${res.error.message}`);
  if (res.status !== 0) fail(`"npm run build" failed with exit code ${res.status}`);
} else {
  log('skipping build (--no-build), reusing existing dist/');
}

if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  fail(`no build output at ${distDir}/index.html — run "npm run build" (or drop --no-build)`);
}
if (!fs.existsSync(path.join(apiDir, 'index.php'))) {
  fail(`no PHP backend at ${apiDir}/index.php — the api/ folder is required`);
}

// ---------------------------------------------------------------------------
// 2. Copy dist/* -> deploy/ and api/ -> deploy/api/ (minus tests/ + dev config)
// ---------------------------------------------------------------------------

const distCount = copyTree(distDir, deployDir, (rel, entry) => {
  if (entry.name === '.DS_Store') return true;
  if (entry.isFile() && DB_FILE_RE.test(entry.name)) return true;
  return false;
});
log(`copied dist/ -> deploy/ (${distCount} files)`);

const apiCount = copyTree(apiDir, path.join(deployDir, 'api'), (rel, entry) => {
  if (entry.name === '.DS_Store') return true;
  if (rel === 'tests' && entry.isDirectory()) return true; // test harness stays local
  if (rel === 'config.php') return true; // dev config; a deploy config is generated below
  if (rel === 'data' && entry.isDirectory()) return true; // never ship data
  if (entry.isFile() && DB_FILE_RE.test(entry.name)) return true;
  return false;
});
log(`copied api/ -> deploy/api/ (${apiCount} files, excluded tests/ and dev config.php)`);

// ---------------------------------------------------------------------------
// 2b. Version the service worker: precache the build's shell files and tie the
//     cache name to their content, so the FIRST offline open works and every
//     deploy activates into a fresh cache (the SW's activate drops the old one).
// ---------------------------------------------------------------------------

{
  const indexHtml = fs.readFileSync(path.join(deployDir, 'index.html'), 'utf8');
  const assetRefs = [...indexHtml.matchAll(/(?:src|href)="\.\/(assets\/[^"]+)"/g)].map((m) => `./${m[1]}`);
  if (assetRefs.length === 0) fail('no ./assets/* references found in dist/index.html — build output changed shape?');

  // The bundled design fonts are referenced from the CSS, not index.html:
  // precache them too (~115 KB once), so switching a design works offline.
  const fontRefs = fs
    .readdirSync(path.join(deployDir, 'assets'))
    .filter((f) => f.endsWith('.woff2'))
    .sort()
    .map((f) => `./assets/${f}`);

  const precache = ['./', './manifest.webmanifest', ...assetRefs, ...fontRefs];
  const version = createHash('sha256').update(precache.join('\n') + indexHtml).digest('hex').slice(0, 10);

  const swPath = path.join(deployDir, 'sw.js');
  let sw = fs.readFileSync(swPath, 'utf8');
  const cacheLine = `const CACHE = 'bt-shell-${version}';`;
  const precacheLine = `const PRECACHE = ${JSON.stringify(precache)};`;
  const before = sw;
  sw = sw.replace(/^const CACHE = .*$/m, cacheLine).replace(/^const PRECACHE = .*$/m, precacheLine);
  if (sw === before || !sw.includes(cacheLine) || !sw.includes(precacheLine)) {
    fail('could not rewrite the CACHE/PRECACHE placeholders in sw.js — did public/sw.js change shape?');
  }
  fs.writeFileSync(swPath, sw);
  log(`versioned deploy/sw.js (cache bt-shell-${version}, ${precache.length} precached files)`);
}

// ---------------------------------------------------------------------------
// 3. deploy/api/config.php
// ---------------------------------------------------------------------------

// SINGLE-quoted PHP string: a "$<letters>" sequence in a path or a name would
// be interpolated inside double quotes.
const phpSingleQuoted = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";

const configPhp = `<?php
// Generated by scripts/package.mjs — do not edit; regenerated on every "npm run package".
// Accounts, families, wrapped keys and entries live (encrypted) in the SQLite
// database — see api/lib/auth.php and api/lib/entries.php.
return [
    // Absolute path to the SQLite file (DEPLOY_DB_PATH in .env at packaging
    // time), or null for the default: <app root>/data/baby.db (app root = the
    // parent directory of api/).
    'db_path' => ${deployDbPath === null ? 'null' : phpSingleQuoted(deployDbPath)},
    // Name of the one family that gets the pictures in <app root>/private-art/
    // (PRIVATE_ART_FAMILY in .env at packaging time), or null: nobody does.
    'private_art_family' => ${privateArtFamily === null ? 'null' : phpSingleQuoted(privateArtFamily)},
    'private_art_dir' => null,
];
`;
fs.writeFileSync(path.join(deployDir, 'api', 'config.php'), configPhp);
log(`wrote deploy/api/config.php (db_path ${deployDbPath === null ? 'default' : deployDbPath})`);

// ---------------------------------------------------------------------------
// 4. deploy/.htaccess
// ---------------------------------------------------------------------------

const htaccess = `# Generated by scripts/package.mjs — do not edit; regenerated on every "npm run package".

<IfModule mod_rewrite.c>
  RewriteEngine On

  # Everything over HTTPS: an http-origin install runs WITHOUT a service worker
  # (secure-context requirement) and would send the auth cookie in cleartext.
  RewriteCond %{HTTPS} !=on
  RewriteCond %{HTTP:X-Forwarded-Proto} !https
  RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L]

  # private-art/ is never served (its own deny stub says the same; this rule
  # holds even if that file went missing). The API reads it from disk.
  RewriteRule ^private-art(/|$) - [F,L]

  # Route /api/* to the PHP front controller.
  # Relative substitution keeps this subdirectory-safe (no RewriteBase needed).
  RewriteRule ^api/(.*)$ api/index.php [L,QSA]
</IfModule>

# Never serve database files or the PHP config directly.
<FilesMatch "(\\.(db|sqlite|sqlite3|db-wal|db-shm|db-journal)$|^config\\.php$)">
  <IfModule mod_authz_core.c>
    Require all denied
  </IfModule>
  <IfModule !mod_authz_core.c>
    Order allow,deny
    Deny from all
  </IfModule>
</FilesMatch>

AddType application/manifest+json .webmanifest

# Caching: hashed build assets are safe to cache hard; HTML, the manifest and
# ESPECIALLY sw.js must always be revalidated (a stale service worker would
# pin users to an old version).
<IfModule mod_headers.c>
  <FilesMatch "\\.(js|css|jpg|jpeg|png|gif|svg|webp|ico|woff|woff2)$">
    Header set Cache-Control "public, max-age=2592000, immutable"
  </FilesMatch>
  <FilesMatch "^(sw\\.js|manifest\\.webmanifest|.*\\.html|.*\\.json)$">
    Header set Cache-Control "no-cache"
  </FilesMatch>

  # Pin browsers to https for a year (only ever sent on https responses).
  Header always set Strict-Transport-Security "max-age=31536000" env=HTTPS

  # No MIME sniffing (a response is what its Content-Type says), and the
  # app's URLs (hash routes included) never travel to another site.
  Header always set X-Content-Type-Options "nosniff"
  Header always set Referrer-Policy "same-origin"

  # Content Security Policy: with end-to-end encryption, injected script is the
  # one remaining way to read entries, so only same-origin script may run.
  # (No inline scripts in the Vite build; inline styles are set from JS.)
  Header always set Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
</IfModule>
`;

fs.writeFileSync(path.join(deployDir, '.htaccess'), htaccess);
log('wrote deploy/.htaccess');

// ---------------------------------------------------------------------------
// 5. deploy/data/.htaccess deny stub (belt and braces; api also self-protects)
// ---------------------------------------------------------------------------

fs.mkdirSync(path.join(deployDir, 'data'), { recursive: true });
fs.writeFileSync(
  path.join(deployDir, 'data', '.htaccess'),
  `# Never serve anything from data/ — the SQLite database lives here.
<IfModule mod_authz_core.c>
  Require all denied
</IfModule>
<IfModule !mod_authz_core.c>
  Order allow,deny
  Deny from all
</IfModule>
`
);
log('wrote deploy/data/.htaccess (deny all)');

// ---------------------------------------------------------------------------
// 5b. deploy/private-art/ — only with PRIVATE_ART_FAMILY, only the known names
// ---------------------------------------------------------------------------

const DENY_ALL = `<IfModule mod_authz_core.c>
  Require all denied
</IfModule>
<IfModule !mod_authz_core.c>
  Order allow,deny
  Deny from all
</IfModule>
`;
const artFound = ART_NAMES.filter((name) => fs.existsSync(path.join(artSrcDir, name)));
if (privateArtFamily !== null && artFound.length > 0) {
  const artDest = path.join(deployDir, 'private-art');
  fs.mkdirSync(artDest, { recursive: true });
  for (const name of artFound) fs.copyFileSync(path.join(artSrcDir, name), path.join(artDest, name));
  fs.writeFileSync(path.join(artDest, '.htaccess'), `# Never served: the API hands these pictures to ONE family's sessions.\n${DENY_ALL}`);
  log(`private artwork: ${artFound.length} picture(s) -> deploy/private-art/ (deny all), shown to the family "${privateArtFamily}" only`);
} else if (privateArtFamily !== null) {
  log(`PRIVATE_ART_FAMILY is set but private-art/ holds none of ${ART_NAMES.join(', ')}: everyone gets the public icons`);
} else if (artFound.length > 0) {
  log('private-art/ found but PRIVATE_ART_FAMILY is not set in .env: NOT packaged, everyone gets the public icons');
}
assembling = false; // deploy/ is complete from here on

// ---------------------------------------------------------------------------
// 6. Summary
// ---------------------------------------------------------------------------

const top = fs
  .readdirSync(deployDir, { withFileTypes: true })
  .sort((a, b) => a.name.localeCompare(b.name));
log('deploy/ contents:');
for (const entry of top) {
  const p = path.join(deployDir, entry.name);
  if (entry.isDirectory()) {
    const s = dirStats(p);
    console.log(`  ${(entry.name + '/').padEnd(24)} ${human(s.bytes).padStart(9)}  (${s.files} files)`);
  } else {
    console.log(`  ${entry.name.padEnd(24)} ${human(fs.statSync(p).size).padStart(9)}`);
  }
}
const total = dirStats(deployDir);
log(`total: ${total.files} files, ${human(total.bytes)}`);
log('next: "npm run preview" to test locally, "npm run deploy" to upload');
