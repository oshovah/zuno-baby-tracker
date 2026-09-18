#!/usr/bin/env node
/**
 * deploy.mjs — upload the packaged deploy/ folder to shared hosting.
 *
 * Configuration comes from a gitignored `.env` (see .env.example). Methods:
 *   rsync  rsync -avz over SSH (key/agent auth)
 *   sftp   sftp batch file over SSH (key/agent auth)
 *   ftp    curl per file, FTPS (--ssl-reqd) by default; FTP_INSECURE=1 for plain FTP.
 *          Each file uploads to "<name>.tmp~" and is renamed into place
 *          (RNFR/RNTO), so a request hitting the site mid-deploy never sees a
 *          truncated index.html or PHP file.
 *   local  plain copy to DEPLOY_PATH on this machine (pipeline testing)
 *
 * Guarantees:
 *   - Runs `node scripts/package.mjs` first unless --no-package.
 *   - NEVER touches remote data/ or any *.db file: uploads exclude everything under
 *     data/ except the harmless data/.htaccess deny stub — for rsync via ordered
 *     include/exclude filters, for sftp/ftp/local via the upload list; nothing is
 *     ever deleted remotely unless DEPLOY_DELETE=1 (rsync only, and even then the
 *     excluded data/ contents are left alone).
 *   - Passwords never appear in argv (visible in `ps`): ftp/health-check credentials
 *     go into a chmod-600 temp curl config file that is deleted in a finally block.
 *   - --dry-run prints the upload list and the exact commands (secrets masked)
 *     without connecting anywhere.
 *
 * Usage: node scripts/deploy.mjs [--dry-run] [--no-package] [--env <file>] [--root <dir>]
 *
 * Zero npm dependencies (Node 18+).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const flags = { dryRun: false, noPackage: false, env: null, root: null };
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--no-package') flags.noPackage = true;
    else if (a === '--env') flags.env = argv[++i];
    else if (a === '--root') flags.root = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: node scripts/deploy.mjs [--dry-run] [--no-package] [--env <file>] [--root <dir>]'
      );
      process.exit(0);
    } else {
      console.error(`[deploy] ERROR: unknown argument "${a}" (try --help)`);
      process.exit(2);
    }
  }
}

const root = flags.root ? path.resolve(flags.root) : path.resolve(scriptDir, '..');
const deployDir = path.join(root, 'deploy');
const envFile = flags.env ? path.resolve(flags.env) : path.join(root, '.env');

function log(msg) {
  console.log(`[deploy] ${msg}`);
}

class DeployError extends Error {}
function fail(msg) {
  throw new DeployError(msg);
}

// ---------------------------------------------------------------------------
// Minimal .env parser (kept in sync with scripts/package.mjs).
// KEY=VALUE lines; full-line # comments only (an inline "#" belongs to the value);
// optional surrounding single/double quotes are stripped.
// ---------------------------------------------------------------------------

function parseEnvFile(file) {
  const out = {};
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

const MASK = '********';
const DB_FILE_RE = /\.(db|sqlite|sqlite3|db-wal|db-shm|db-journal)$/i;

const tmpDirs = [];
function makeTmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-deploy-'));
  tmpDirs.push(d);
  return d;
}
function cleanupTmpDirs() {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}
process.on('exit', cleanupTmpDirs);

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Shell-quote for *printing* commands (spawnSync itself never uses a shell). */
function shq(s) {
  return /^[A-Za-z0-9_@%+=:,.\/-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`;
}
function printable(cmd, args) {
  return [cmd, ...args].map(shq).join(' ');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Files to upload, as sorted posix-relative paths.
 * Excludes: .DS_Store, any *.db/*.sqlite (belt and braces — packaging never puts
 * them there), and everything under data/ EXCEPT the data/.htaccess deny stub.
 */
function collectFiles(baseDir) {
  const files = [];
  const walk = (rel) => {
    const abs = rel ? path.join(baseDir, rel) : baseDir;
    const entries = fs
      .readdirSync(abs, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.name === '.DS_Store') continue;
      if (entry.isDirectory()) {
        if (childRel === 'data') {
          // remote data/ is sacred: only the .htaccess deny stub is ever uploaded
          if (fs.existsSync(path.join(abs, entry.name, '.htaccess'))) {
            files.push('data/.htaccess');
          }
          continue;
        }
        walk(childRel);
      } else if (entry.isFile()) {
        if (DB_FILE_RE.test(entry.name)) continue;
        files.push(childRel);
      }
    }
  };
  walk('');
  return files.sort();
}

/** Every directory (sorted parents-first) needed to hold the given files. */
function collectDirs(files) {
  const dirs = new Set();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return [...dirs].sort();
}

/** curl config file line value: double-quoted with backslash escapes. */
function curlConfigValue(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** Percent-encode a path for use inside an ftp:// URL, keeping "/" separators. */
function encodeUrlPath(p) {
  return p
    .split('/')
    .filter((seg) => seg !== '')
    .map(encodeURIComponent)
    .join('/');
}

function runOrFail(cmd, args, what) {
  log(`$ ${printable(cmd, args)}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit' });
  if (res.error) {
    if (res.error.code === 'ENOENT') fail(`"${cmd}" not found on PATH — required for ${what}`);
    fail(`could not run "${cmd}": ${res.error.message}`);
  }
  return res.status;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // ---- read + validate config ------------------------------------------------
  if (!fs.existsSync(envFile)) {
    fail(`no ${envFile} found — copy .env.example to .env and fill in your server details`);
  }
  const cfg = parseEnvFile(envFile);

  const method = (cfg.DEPLOY_METHOD || '').toLowerCase();
  const METHODS = ['rsync', 'sftp', 'ftp', 'local'];
  if (!METHODS.includes(method)) {
    fail(`DEPLOY_METHOD must be one of ${METHODS.join(' | ')} (got "${cfg.DEPLOY_METHOD || ''}")`);
  }

  const need = (key) => {
    if (!cfg[key] || cfg[key].trim() === '') {
      fail(`${key} is required for DEPLOY_METHOD=${method} — set it in .env (see .env.example)`);
    }
    return cfg[key].trim();
  };

  const remotePath = need('DEPLOY_PATH').replace(/\/+$/, '');
  let host = '';
  let user = '';
  if (method !== 'local') {
    host = need('DEPLOY_HOST');
    user = need('DEPLOY_USER');
  }
  const defaultPort = method === 'ftp' ? 21 : 22;
  const port = cfg.DEPLOY_PORT && cfg.DEPLOY_PORT.trim() !== '' ? Number(cfg.DEPLOY_PORT) : defaultPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`DEPLOY_PORT must be a port number (got "${cfg.DEPLOY_PORT}")`);
  }
  const password = cfg.DEPLOY_PASSWORD || '';
  const ftpInsecure = cfg.FTP_INSECURE === '1';
  const doDelete = cfg.DEPLOY_DELETE === '1';
  const deployUrl = (cfg.DEPLOY_URL || '').replace(/\/+$/, '');

  if (method === 'ftp' && password === '') {
    fail('DEPLOY_PASSWORD is required for DEPLOY_METHOD=ftp — set it in .env');
  }
  if ((method === 'rsync' || method === 'sftp') && password !== '') {
    log(`note: DEPLOY_PASSWORD is ignored for ${method} — it authenticates with SSH keys/agent.`);
    log('      If the server asks for a password, set up a key instead:');
    log(`      ssh-keygen -t ed25519 && ssh-copy-id ${user ? `${user}@${host}` : 'user@host'}`);
  }

  log(`method: ${method}${flags.dryRun ? '  (DRY RUN — nothing will be uploaded)' : ''}`);
  if (method !== 'local') log(`target: ${user}@${host}:${port} -> ${remotePath}`);
  else log(`target: ${remotePath} (this machine)`);

  // ---- package first ---------------------------------------------------------
  if (!flags.noPackage) {
    const args = [path.join(scriptDir, 'package.mjs'), '--root', root, '--env', envFile];
    log(`$ ${printable(process.execPath, args)}`);
    const res = spawnSync(process.execPath, args, { stdio: 'inherit' });
    if (res.status !== 0) fail(`packaging failed (exit ${res.status})`);
  } else {
    log('skipping packaging (--no-package)');
  }

  // Completeness check: a mid-package failure can leave a half-built deploy/
  // (frontend + api copied, generated files missing) — require every artifact
  // packaging generates, not just the copied trees.
  const requiredArtifacts = ['index.html', 'api/index.php', 'api/config.php', '.htaccess', 'data/.htaccess'];
  const missingArtifacts = requiredArtifacts.filter(
    (f) => !fs.existsSync(path.join(deployDir, ...f.split('/')))
  );
  if (missingArtifacts.length > 0) {
    fail(`${deployDir} is missing or incomplete (no ${missingArtifacts.join(', ')}) — run "npm run package" (or drop --no-package)`);
  }

  // ---- upload list -----------------------------------------------------------
  const files = collectFiles(deployDir);
  if (files.length === 0) fail('nothing to upload — deploy/ is empty');
  let totalBytes = 0;
  for (const f of files) totalBytes += fs.statSync(path.join(deployDir, f)).size;
  log(`upload set: ${files.length} files, ${human(totalBytes)} (data/ ships only data/.htaccess; *.db never uploaded)`);

  if (flags.dryRun) {
    for (const f of files) {
      console.log(`  ${f.padEnd(48)} ${human(fs.statSync(path.join(deployDir, f)).size).padStart(9)}`);
    }
  }

  // ---- per-method upload -----------------------------------------------------
  if (method === 'rsync') {
    // Filters are ORDERED (first match wins): data/ itself and data/.htaccess
    // are let through, then everything else under data/ is excluded — so a
    // database copy left in deploy/data/ by a preview rehearsal (baby.db,
    // -wal/-shm, a .v1.bak) never ships, whatever its name. The *.db patterns
    // after that are belt and braces for the rest of the tree.
    const args = [
      '-avz',
      '--include=data/',
      '--include=data/.htaccess',
      '--exclude=data/*',
      '--exclude=*.db',
      '--exclude=*.sqlite',
      '--exclude=*.sqlite3',
      '--exclude=*.db-wal',
      '--exclude=*.db-shm',
      '--exclude=*.db-journal',
    ];
    // --delete must never reach into the remote data/: with the excludes
    // above rsync does not delete excluded files there (no --delete-excluded).
    if (doDelete) args.push('--delete');
    if (port !== 22) args.push('-e', `ssh -p ${port}`);
    args.push(deployDir + '/', `${user}@${host}:${remotePath}/`);

    if (flags.dryRun) {
      log(`would run: ${printable('rsync', args)}`);
    } else {
      const status = runOrFail('rsync', args, 'the rsync method');
      if (status !== 0) {
        log('hint: rsync uses SSH keys/agent for auth — if you were asked for a password,');
        log(`      set up a key: ssh-keygen -t ed25519 && ssh-copy-id ${user}@${host}`);
        fail(`rsync exited with code ${status}`);
      }
    }
  } else if (method === 'sftp') {
    // batch file: "-mkdir" ("-" = ignore errors for already-existing dirs), then puts
    const batchLines = [];
    const q = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    const rootSegs = remotePath.split('/').filter((s) => s !== '');
    const absolute = remotePath.startsWith('/');
    let prefix = absolute ? '' : '.';
    const mkdirs = [];
    for (const seg of rootSegs) {
      prefix = prefix === '' ? `/${seg}` : `${prefix}/${seg}`;
      mkdirs.push(prefix);
    }
    for (const d of collectDirs(files)) mkdirs.push(`${remotePath}/${d}`);
    for (const d of mkdirs) batchLines.push(`-mkdir ${q(d)}`);
    for (const f of files) {
      batchLines.push(`put ${q(path.join(deployDir, f))} ${q(`${remotePath}/${f}`)}`);
    }
    const batchContent = batchLines.join('\n') + '\n';
    const sftpArgs = ['-b', '<batchfile>', '-P', String(port), `${user}@${host}`];

    if (flags.dryRun) {
      log(`would run: ${printable('sftp', sftpArgs)}`);
      log('with batch file:');
      for (const line of batchLines) console.log(`  ${line}`);
    } else {
      const tmp = makeTmpDir();
      const batchFile = path.join(tmp, 'sftp-batch.txt');
      fs.writeFileSync(batchFile, batchContent, { mode: 0o600 });
      try {
        sftpArgs[1] = batchFile;
        const status = runOrFail('sftp', sftpArgs, 'the sftp method');
        if (status !== 0) {
          log('hint: sftp -b needs non-interactive auth (SSH key or agent).');
          log(`      Set up a key: ssh-keygen -t ed25519 && ssh-copy-id ${user}@${host}`);
          fail(`sftp exited with code ${status}`);
        }
      } finally {
        cleanupTmpDirs();
      }
    }
  } else if (method === 'ftp') {
    if (ftpInsecure) {
      log('WARNING: FTP_INSECURE=1 — using plain FTP, credentials and data travel unencrypted.');
    }
    if (remotePath.startsWith('/')) {
      log(`note: for FTP, DEPLOY_PATH "${remotePath}" is treated as RELATIVE to the FTP login (home)`);
      log('      directory, not the filesystem root (FTP URL semantics strip the leading "/").');
    }
    const baseArgs = ['--fail', '--silent', '--show-error', '--connect-timeout', '15', '--ftp-create-dirs'];
    // --tls-max 1.2: Pure-FTPd (e.g. cyon) aborts TLS 1.3 data connections that
    // don't resume the control-channel session ("451 Transfer aborted" after
    // the first 16 KiB); TLS 1.2 session IDs resume fine.
    if (!ftpInsecure) baseArgs.push('--ssl-reqd', '--tls-max', '1.2');
    const urlBase = `ftp://${host}:${port}/${encodeUrlPath(remotePath)}`;
    const configContent = `user = ${curlConfigValue(`${user}:${password}`)}\n`;

    // Upload to "<name>.tmp~", then rename into place with post-transfer quote
    // commands. curl CWDs into the file's directory segment by segment, so the
    // rename runs there and plain basenames are correct. The rename is atomic
    // server-side — no request ever sees a half-written file.
    const ftpArgsFor = (rel) => {
      const base = rel.split('/').pop();
      return [
        ...baseArgs,
        '-T', path.join(deployDir, rel),
        `${urlBase}/${encodeUrlPath(rel)}.tmp~`,
        '-Q', `-RNFR ${base}.tmp~`,
        '-Q', `-RNTO ${base}`,
      ];
    };

    if (flags.dryRun) {
      log('would write a chmod-600 temp curl config (deleted afterwards) containing:');
      console.log(`  user = ${curlConfigValue(`${user}:${MASK}`)}`);
      log('would run, per file (upload to .tmp~, then rename into place):');
      const example = files.slice(0, 5);
      for (const f of example) {
        console.log(`  ${printable('curl', ['--config', '<tmp>/curl.cfg', ...ftpArgsFor(f)])}`);
      }
      if (files.length > example.length) console.log(`  ... and ${files.length - example.length} more files`);
    } else {
      const tmp = makeTmpDir();
      const configFile = path.join(tmp, 'curl.cfg');
      fs.writeFileSync(configFile, configContent, { mode: 0o600 });
      try {
        for (let i = 0; i < files.length; i++) {
          const rel = files[i];
          const args = ['--config', configFile, ...ftpArgsFor(rel)];
          let uploaded = false;
          let lastErr = '';
          for (let attempt = 1; attempt <= 2 && !uploaded; attempt++) {
            const res = spawnSync('curl', args, { encoding: 'utf8' });
            if (res.error) {
              if (res.error.code === 'ENOENT') fail('"curl" not found on PATH — required for the ftp method');
              fail(`could not run curl: ${res.error.message}`);
            }
            if (res.status === 0) {
              uploaded = true;
            } else {
              lastErr = (res.stderr || '').trim() || `curl exit code ${res.status}`;
              if (attempt === 1) {
                log(`  transient failure on "${rel}" — retrying once ...`);
                await sleep(1000);
              }
            }
          }
          if (!uploaded) {
            if (!ftpInsecure && /ssl|tls|starttls|auth/i.test(lastErr)) {
              log('hint: the server may not support FTPS. If you accept plaintext FTP, set FTP_INSECURE=1 in .env.');
            }
            fail(`upload failed for "${rel}": ${lastErr}`);
          }
          log(`  [${i + 1}/${files.length}] ${rel}`);
        }
      } finally {
        cleanupTmpDirs(); // removes the curl config with the password
      }
    }
  } else if (method === 'local') {
    const target = path.isAbsolute(remotePath) ? remotePath : path.resolve(root, remotePath);
    // Guard rails: the copy must never land on or around the project itself —
    // copying deploy/ over the source tree would overwrite e.g. the source
    // index.html and api/config.php with their built/generated versions.
    const isInside = (parent, child) => {
      const rel = path.relative(parent, child);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    };
    if (isInside(deployDir, target)) {
      fail(`DEPLOY_PATH (${target}) must not be inside deploy/ itself`);
    }
    if (path.relative(root, target) === '') {
      fail(`DEPLOY_PATH (${target}) is the project root — the copy would overwrite the project's source files. Pick a directory outside the project.`);
    }
    if (isInside(target, root)) {
      fail(`DEPLOY_PATH (${target}) contains this project — pick a directory outside it.`);
    }
    if (isInside(root, target)) {
      fail(`DEPLOY_PATH (${target}) is inside the project working tree — pick a directory outside it (e.g. a temp dir).`);
    }
    if (fs.existsSync(path.join(target, 'scripts', 'deploy.mjs')) || fs.existsSync(path.join(target, 'vite.config.js'))) {
      fail(`DEPLOY_PATH (${target}) looks like a source checkout of this project — refusing to copy over it.`);
    }
    if (flags.dryRun) {
      log(`would copy ${files.length} files to ${target} (never deleting anything there)`);
    } else {
      for (const f of files) {
        const dest = path.join(target, f);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(deployDir, f), dest);
      }
      log(`copied ${files.length} files to ${target}`);
    }
  }

  // ---- post-deploy health check ---------------------------------------------
  // GET /api/me is public by design (it powers the login screen), so the check
  // needs no credentials and must return 200 on a healthy install.
  // It is also the FIRST request after the upload: bt_create_or_migrate
  // (api/lib/db.php) runs the schema migration on it, inside one transaction
  // (a v1 file is backed up to data/baby.db.v1.bak first). 200 = migration
  // committed (or nothing to migrate); 500 = rolled back, the DB is still v1
  // (see README, "Rollback").
  if (deployUrl !== '') {
    const checkUrl = `${deployUrl}/api/me`;
    const curlArgs = ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '20'];

    if (flags.dryRun) {
      log(`would health-check: ${printable('curl', [...curlArgs, checkUrl])}`);
    } else {
      log(`health check: GET ${checkUrl}`);
      const res = spawnSync('curl', [...curlArgs, checkUrl], { encoding: 'utf8' });
      if (res.error) fail(`could not run curl for the health check: ${res.error.message}`);
      const code = (res.stdout || '').trim();
      if (res.status !== 0) {
        fail(`health check could not connect (${(res.stderr || '').trim() || `curl exit ${res.status}`}) — check DEPLOY_URL`);
      } else if (code === '200') {
        log('health check OK: /api/me responded 200');
      } else if (code === '404') {
        fail('health check got 404 — is DEPLOY_URL correct? On Apache, check mod_rewrite + AllowOverride for the .htaccess api rewrite');
      } else if (code === '500') {
        fail('health check got 500 — check the host PHP version (7.4+) and that pdo_sqlite is enabled, and that data/ is writable');
      } else {
        fail(`health check got HTTP ${code} from ${checkUrl}`);
      }
    }
  }

  log(flags.dryRun ? 'dry run complete — nothing was uploaded.' : 'deploy complete.');
}

main().catch((err) => {
  console.error(`[deploy] ERROR: ${err instanceof DeployError ? err.message : err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
});
