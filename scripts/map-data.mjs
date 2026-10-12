#!/usr/bin/env node
/**
 * map-data.mjs — the places of the «Karte» tab: every changing table
 * (`changing_table=*`, not `no`) and every place to nurse (`baby_feeding=*`,
 * not `no`) OpenStreetMap knows inside the box of scripts/lib/map-config.mjs,
 * fetched from Overpass and written as compact GeoJSON to
 *
 *   public/map/pois.json       (gitignored; Vite ships it with every build)
 *
 * so the app never asks a third party at run time — the login page promises
 * that, and the packaged CSP enforces it. Run it before a deploy whenever the
 * places should be fresher (the map shows the file's date); packaging
 * refuses without the file (scripts/package.mjs).
 *
 *   npm run map:data
 *
 * The data is © OpenStreetMap contributors, ODbL — the map shows the
 * attribution; README › «Karte» has the licence note.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BBOX, overpassBbox, OVERPASS_ENDPOINTS } from './lib/map-config.mjs';
import { normalizeOverpass } from '../src/mapdata.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(root, 'public', 'map', 'pois.json');
const log = (msg) => console.log(`[map-data] ${msg}`);

const box = overpassBbox();
const query = `[out:json][timeout:180];
(
  nwr["changing_table"]["changing_table"!="no"](${box});
  nwr["baby_feeding"]["baby_feeding"!="no"](${box});
);
out tags center;`;

// Overpass asks for a User-Agent that says who is calling.
const USER_AGENT = 'zuno-baby-tracker map-data (+https://github.com/oshovah/zuno-baby-tracker)';

async function fetchOverpass() {
  let lastErr = null;
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
      return json;
    } catch (err) {
      lastErr = err;
      log(`  ${url}: ${err.message}`);
    }
  }
  throw new Error(`no Overpass instance answered (${lastErr ? lastErr.message : 'unknown'})`);
}

const json = await fetchOverpass();
const generated = new Date().toISOString().slice(0, 10);
const fc = normalizeOverpass(json, { generated, bbox: [BBOX.west, BBOX.south, BBOX.east, BBOX.north] });

const changing = fc.features.filter((f) => f.properties.w).length;
const nursing = fc.features.filter((f) => f.properties.n).length;
const both = fc.features.filter((f) => f.properties.w && f.properties.n).length;
if (changing < 100) {
  console.error(`[map-data] ERROR: only ${changing} changing tables in the answer (${json.elements.length} elements) — that is not Switzerland; nothing written`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
const text = JSON.stringify(fc);
fs.writeFileSync(outFile, text);
log(`${json.elements.length} objects from Overpass → ${fc.features.length} places: ${changing} with a changing table, ${nursing} to nurse (${both} both)`);
log(`wrote ${path.relative(root, outFile)} (${(text.length / 1024).toFixed(0)} KB, data of ${generated})`);
