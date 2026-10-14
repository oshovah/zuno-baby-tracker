#!/usr/bin/env node
/**
 * map-data.mjs — the places of the «Karte» tab: every changing table
 * (`changing_table=*`, not `no`) and every place to nurse (`baby_feeding=*`,
 * not `no`) OpenStreetMap knows inside the box of scripts/lib/map-config.mjs,
 * fetched from Overpass, plus the few places of scripts/map/extra-places.csv
 * that OSM does not know (yet), or lacks the table at — written as compact
 * GeoJSON to
 *
 *   public/map/pois.json       (gitignored; Vite ships it with every build)
 *
 * so the app never asks a third party at run time — the login page promises
 * that, and the packaged CSP enforces it. Run it before a deploy whenever the
 * places should be fresher (the map shows the day the OSM data is from);
 * packaging refuses without the file (scripts/package.mjs).
 *
 *   npm run map:data
 *
 * The extras are laid OVER OpenStreetMap, never beside it: a second, small
 * Overpass query fetches what stands at each row's spot, and mergeExtras
 * (src/mapdata.js) decides per row — covered (OSM has it already, nothing
 * changes), merged (the OSM object gets the row's tags, its link stays) or
 * added (an own point). The run prints the verdicts.
 *
 * The data is © OpenStreetMap contributors, ODbL — the map shows the
 * attribution; README › «Karte» has the licence note.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BBOX, overpassBbox, OVERPASS_ENDPOINTS } from './lib/map-config.mjs';
import { parseCsv } from './lib/csv.mjs';
import { normalizeOverpass, parseExtraRow, mergeExtras, EXTRA_MATCH_M } from '../src/mapdata.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(root, 'public', 'map', 'pois.json');
const extrasFile = path.join(root, 'scripts', 'map', 'extra-places.csv');
const log = (msg) => console.log(`[map-data] ${msg}`);
function fail(msg) {
  console.error(`[map-data] ERROR: ${msg}`);
  process.exit(1);
}

const box = overpassBbox();
const placesQuery = `[out:json][timeout:180];
(
  nwr["changing_table"]["changing_table"!="no"](${box});
  nwr["baby_feeding"]["baby_feeding"!="no"](${box});
);
out tags center;`;

// Overpass asks for a User-Agent that says who is calling.
const USER_AGENT = 'zuno-baby-tracker map-data (+https://github.com/oshovah/zuno-baby-tracker)';

/** The answer of the first instance that gives one — they all hold the same
 *  data (map-config.mjs), so which one it was does not matter. A 504 under
 *  load or an HTML error page instead of JSON is common and passes: the
 *  list is tried twice, with a pause before the second round. */
async function fetchOverpass(query) {
  let lastErr = null;
  for (let round = 1; round <= 2; round++) {
    if (round > 1) {
      log('every instance failed once — once more in 15 s …');
      await new Promise((f) => setTimeout(f, 15000));
    }
    for (const url of OVERPASS_ENDPOINTS) {
      log(`asking ${url} …`);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
          body: new URLSearchParams({ data: query }),
          signal: AbortSignal.timeout(240000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!json || !Array.isArray(json.elements)) throw new Error('no elements in the answer');
        if (json.remark && /timed out|runtime error/i.test(json.remark)) throw new Error(json.remark);
        log(`  answered: ${json.elements.length} elements, data of ${dataStamp(json) || 'an unknown day'}`);
        return json;
      } catch (err) {
        lastErr = err;
        log(`  ${url}: ${err.message}`);
      }
    }
  }
  throw new Error(`no Overpass instance answered (${lastErr ? lastErr.message : 'unknown'})`);
}

/** When the answer's data is from: the instance's database timestamp
 *  (`osm3s.timestamp_osm_base`, ISO), or null when the answer has none. */
function dataStamp(json) {
  const ts = json && json.osm3s && json.osm3s.timestamp_osm_base;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(String(ts || '')) ? String(ts) : null;
}

/** The rows of the extras file, checked — a bad row stops the run: a typo
 *  there would otherwise ship as a place. */
function readExtras() {
  if (!fs.existsSync(extrasFile)) return [];
  const rows = [];
  const problems = [];
  const seen = new Set();
  for (const record of parseCsv(fs.readFileSync(extrasFile, 'utf8'))) {
    const { row, error } = parseExtraRow(record);
    if (error) {
      problems.push(error);
      continue;
    }
    if (seen.has(row.id)) problems.push(`${row.id}: twice in the file`);
    seen.add(row.id);
    if (row.use === 'yes' && !(row.lat >= BBOX.south && row.lat <= BBOX.north && row.lon >= BBOX.west && row.lon <= BBOX.east)) {
      problems.push(`${row.id}: outside the box of scripts/lib/map-config.mjs`);
    }
    rows.push(row);
  }
  if (problems.length) fail(`${path.relative(root, extrasFile)}:\n  ${problems.join('\n  ')}`);
  return rows;
}

const extras = readExtras();
const json = await fetchOverpass(placesQuery);
// the day the data is from — the map shows it as «Stand der Orte»; the day of
// the run only when the answer carries no timestamp
const generated = (dataStamp(json) || new Date().toISOString()).slice(0, 10);
const fc = normalizeOverpass(json, { generated, bbox: [BBOX.west, BBOX.south, BBOX.east, BBOX.north] });

const osmChanging = fc.features.filter((f) => f.properties.w).length;
if (osmChanging < 100) fail(`only ${osmChanging} changing tables in the answer (${json.elements.length} elements) — that is not Switzerland; nothing written`);
log(`${json.elements.length} objects from Overpass → ${fc.features.length} places`);

// The extras: what OSM has at each spot (the same kind of object, as far as
// the merge may look), then the verdict per row.
const live = extras.filter((r) => r.use === 'yes');
let candidates = { elements: [] };
if (live.length) {
  const reach = Math.max(EXTRA_MATCH_M.node, EXTRA_MATCH_M.area);
  log(`${live.length} extra places in ${path.relative(root, extrasFile)} (${extras.length - live.length} off) — what does OSM have there?`);
  const around = live.map((r) => `  nwr(around:${reach},${r.lat},${r.lon})["${r.feature.key}"="${r.feature.value}"];`).join('\n');
  candidates = await fetchOverpass(`[out:json][timeout:60];\n(\n${around}\n);\nout tags center;`);
}
const merged = mergeExtras(fc.features, extras, candidates);
fc.features = merged.features;
for (const r of merged.report) {
  if (r.action === 'off') continue;
  const where = r.osm ? ` → ${r.osm} (${r.meters.toFixed(0)} m)` : r.near ? ` (nearest of the kind: ${r.near}, ${r.meters.toFixed(0)} m away)` : '';
  log(`  ${r.action.padEnd(7)} ${r.id}${where}`);
}

const changing = fc.features.filter((f) => f.properties.w).length;
const nursing = fc.features.filter((f) => f.properties.n).length;
const both = fc.features.filter((f) => f.properties.w && f.properties.n).length;
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const text = JSON.stringify(fc);
fs.writeFileSync(outFile, text);
log(`${fc.features.length} places: ${changing} with a changing table, ${nursing} to nurse (${both} both)`);
log(`wrote ${path.relative(root, outFile)} (${(text.length / 1024).toFixed(0)} KB, data of ${generated})`);
