#!/usr/bin/env node
/**
 * map-basemap.mjs — the background map of the «Karte» tab, self-hosted: one
 * PMTiles archive cut from the daily Protomaps planet build (OpenStreetMap
 * data, ODbL) down to the box of scripts/lib/map-config.mjs, into
 *
 *   basemap/basemap-<build>.pmtiles   the tiles (~570 MB at zoom 0–14)
 *   basemap/index.json                which file the app loads, its zoom and box
 *   basemap/LICENSE.txt               the attribution that travels with the tiles
 *
 * The folder is gitignored and NOT part of deploy/: it goes to the server
 * once, with `npm run deploy:basemap` (scripts/deploy.mjs --basemap), and the
 * browser reads it in byte ranges — so nothing but this server is ever
 * asked for a tile. A new build gets a new file name (the old one may stay
 * until every phone has the new index): a date-named archive can be cached
 * hard and never changes under a reader.
 *
 *   npm run map:basemap -- --build 20261011            # zoom 0–14 (the default)
 *   npm run map:basemap -- --build 20261011 --maxzoom 15   # twice the size, more detail
 *   npm run map:basemap -- --build 20261011 --force    # cut again although the file exists
 *
 * Needs the `pmtiles` CLI on the PATH (brew install pmtiles, or the binary
 * from github.com/protomaps/go-pmtiles/releases). The build date is the
 * planet file at build.protomaps.com/<YYYYMMDD>.pmtiles (yesterday's is
 * usually there); the extract fetches only the box's tiles (~600 MB).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BBOX, pmtilesBbox, protomapsBuildUrl, BASEMAP_MAXZOOM } from './lib/map-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'basemap');
const log = (msg) => console.log(`[map-basemap] ${msg}`);
function fail(msg) {
  console.error(`[map-basemap] ERROR: ${msg}`);
  process.exit(1);
}

const flags = { build: null, maxzoom: BASEMAP_MAXZOOM, force: false };
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--build') flags.build = argv[++i];
    else if (a === '--maxzoom') flags.maxzoom = Number(argv[++i]);
    else if (a === '--force') flags.force = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/map-basemap.mjs --build YYYYMMDD [--maxzoom 14] [--force]');
      process.exit(0);
    } else fail(`unknown argument "${a}" (try --help)`);
  }
}
if (!/^\d{8}$/.test(flags.build || '')) fail('--build YYYYMMDD is required: the date of the Protomaps planet build to cut from');
if (!Number.isInteger(flags.maxzoom) || flags.maxzoom < 10 || flags.maxzoom > 15) fail('--maxzoom must be between 10 and 15');

const build = flags.build;
const file = `basemap-${build}.pmtiles`;
const target = path.join(dir, file);
fs.mkdirSync(dir, { recursive: true });

if (fs.existsSync(target) && !flags.force) {
  log(`${path.relative(root, target)} exists — not cut again (--force to redo)`);
} else {
  const probe = spawnSync('pmtiles', ['--help'], { encoding: 'utf8' });
  if (probe.error) fail('the "pmtiles" CLI is not on the PATH — brew install pmtiles (or github.com/protomaps/go-pmtiles/releases)');
  const args = ['extract', protomapsBuildUrl(build), target, `--bbox=${pmtilesBbox()}`, `--maxzoom=${flags.maxzoom}`, '--download-threads=8'];
  log(`$ pmtiles ${args.join(' ')}`);
  const res = spawnSync('pmtiles', args, { stdio: 'inherit' });
  if (res.status !== 0) {
    try {
      fs.rmSync(target, { force: true });
    } catch {
      /* best effort */
    }
    fail(`pmtiles extract exited with code ${res.status} (is ${protomapsBuildUrl(build)} a real build? yesterday's date usually is)`);
  }
}

const size = fs.statSync(target).size;
const buildDate = `${build.slice(0, 4)}-${build.slice(4, 6)}-${build.slice(6, 8)}`;
const index = {
  file,
  build: buildDate,
  maxzoom: flags.maxzoom,
  bbox: [BBOX.west, BBOX.south, BBOX.east, BBOX.north],
  generated: new Date().toISOString().slice(0, 10),
};
fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index, null, 2) + '\n');

fs.writeFileSync(
  path.join(dir, 'LICENSE.txt'),
  `${file}
Map tiles for the «Karte» tab of Zuno – Baby Tracker, cut with the pmtiles
CLI from the Protomaps planet build of ${buildDate} (https://protomaps.com,
BSD-licensed software, OpenStreetMap data), limited to the box
${pmtilesBbox()} (west,south,east,north) and the zoom levels 0–${flags.maxzoom}.

Map data © OpenStreetMap contributors, Open Database License (ODbL 1.0):
https://www.openstreetmap.org/copyright
These tiles are a Produced Work of that database; the app shows the required
attribution («© OpenStreetMap-Mitwirkende») on the map.
`
);

log(`${path.relative(root, target)}: ${(size / 1024 / 1024).toFixed(0)} MB, zoom 0–${flags.maxzoom}, box ${pmtilesBbox()}`);
log('wrote basemap/index.json and basemap/LICENSE.txt');
log('next: "npm run dev" shows it at once; "npm run deploy:basemap" uploads the folder (once per build)');
