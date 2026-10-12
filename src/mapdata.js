// The map's places (Wickeltische and Still-Orte), pure: how an Overpass
// answer becomes the compact GeoJSON the app ships (scripts/map-data.mjs
// runs this in node), how a place is worded in the sheet and the list
// (views/map.js), the nearest-by-distance list, and which basemap flavour a
// design gets. No DOM, no Leaflet — node-tested in tests/mapdata.test.mjs.
//
// The source is OpenStreetMap: `changing_table=*` (yes | limited; `no` is
// dropped) with its sub-keys for where the table is, and `baby_feeding=*`
// (yes | room) for a place to nurse. Every string a parent reads goes
// through t() at call time; the raw OSM values travel in the properties.

import { t, hasKey, localeMeta } from './i18n/index.js';

/** The two kinds a place can be (one place can be both). */
export const KINDS = ['changing', 'nursing'];

/** Below this zoom the pins stay off the map (800 dots on a country are a
 *  blob); the view says «näher heranzoomen» instead. */
export const MARKER_MIN_ZOOM = 11;

/** The OSM keys whose value names what the place IS, in the order tried
 *  (a station's toilets carry `amenity=toilets`, the station `railway=station`). */
const CLASS_KEYS = ['amenity', 'shop', 'tourism', 'leisure', 'healthcare', 'railway', 'public_transport', 'office', 'building'];

/** `changing_table:location` values the wiki documents (others show raw). */
export const LOCATIONS = ['wheelchair_toilet', 'female_toilet', 'male_toilet', 'unisex_toilet', 'dedicated_room', 'room', 'sales_area', 'outdoor'];

const round5 = (n) => Math.round(n * 1e5) / 1e5;

function clean(v, max = 200) {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/\s+/g, ' ').trim();
  return s === '' ? undefined : s.slice(0, max);
}

/** «Bahnhofstrasse 12, 8001 Zürich» from the addr:* keys, or nothing. */
function address(tags) {
  const street = clean(tags['addr:street'], 80);
  const no = clean(tags['addr:housenumber'], 12);
  const zip = clean(tags['addr:postcode'], 12);
  const city = clean(tags['addr:city'], 60);
  const line1 = street ? (no ? `${street} ${no}` : street) : undefined;
  const line2 = city ? (zip ? `${zip} ${city}` : city) : undefined;
  if (line1 && line2) return `${line1}, ${line2}`;
  return line1 || line2;
}

/**
 * The Overpass answer (`out tags center`) as a FeatureCollection of points:
 * one feature per object that has a changing table or a place to nurse,
 * with ONLY the properties the app reads (short keys — the file ships with
 * every build). Ways and relations use their `center`. `generated` is the
 * day the data was fetched (shown on the map), `bbox` the box it covers.
 */
export function normalizeOverpass(json, { generated, bbox }) {
  const features = [];
  for (const el of (json && json.elements) || []) {
    const tags = el.tags || {};
    const ct = clean(tags.changing_table, 40);
    const bf = clean(tags.baby_feeding, 40);
    const w = ct !== undefined && ct !== 'no';
    const n = bf !== undefined && bf !== 'no';
    if (!w && !n) continue;
    const lat = typeof el.lat === 'number' ? el.lat : el.center && el.center.lat;
    const lon = typeof el.lon === 'number' ? el.lon : el.center && el.center.lon;
    if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const prefix = { node: 'n', way: 'w', relation: 'r' }[el.type];
    if (!prefix || !Number.isInteger(el.id)) continue;
    const p = { id: `${prefix}${el.id}` };
    const name = clean(tags.name, 120) || clean(tags.brand, 80);
    if (name) p.name = name;
    for (const key of CLASS_KEYS) {
      const v = clean(tags[key], 40);
      if (v && v !== 'yes') {
        p.cls = v;
        break;
      }
    }
    if (w) {
      p.w = 1;
      p.ct = ct;
      const loc = clean(tags['changing_table:location'], 120);
      if (loc) p.loc = loc;
      const fee = clean(tags['changing_table:fee'], 10);
      if (fee) p.fee = fee;
      const wc = clean(tags['changing_table:wheelchair'], 10);
      if (wc) p.wc = wc;
      const cnt = parseInt(tags['changing_table:count'], 10);
      if (Number.isInteger(cnt) && cnt > 1) p.cnt = Math.min(cnt, 99);
      const desc = clean(tags['changing_table:description'], 200);
      if (desc) p.desc = desc;
    }
    if (n) {
      p.n = 1;
      p.bf = bf;
      const female = clean(tags['baby_feeding:female'], 10);
      const male = clean(tags['baby_feeding:male'], 10);
      if (female === 'yes' && male !== 'yes') p.bff = 1;
      if (male === 'no') p.bff = 1;
    }
    const oh = clean(tags.opening_hours, 200);
    if (oh) p.oh = oh;
    const acc = clean(tags.access, 20);
    if (acc && acc !== 'yes') p.acc = acc;
    const lvl = clean(tags.level, 10);
    if (lvl && lvl !== '0') p.lvl = lvl;
    const addr = address(tags);
    if (addr) p.addr = addr;
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [round5(lon), round5(lat)] }, properties: p });
  }
  features.sort((a, b) => (a.properties.id < b.properties.id ? -1 : a.properties.id > b.properties.id ? 1 : 0));
  return { type: 'FeatureCollection', generated, bbox, features };
}

/** ['changing', 'nursing'] — the kinds a place is, in KINDS order. */
export function kindsOf(p) {
  const out = [];
  if (p && p.w) out.push('changing');
  if (p && p.n) out.push('nursing');
  return out;
}

/** 'changing' | 'nursing' | 'both' — the pin's class. */
export function pinKind(p) {
  const k = kindsOf(p);
  return k.length === 2 ? 'both' : k[0] || 'changing';
}

/** The features of one kind ('all' keeps every one). */
export function filterKind(features, kind) {
  if (kind !== 'changing' && kind !== 'nursing') return features.slice();
  const flag = kind === 'changing' ? 'w' : 'n';
  return features.filter((f) => f.properties && f.properties[flag]);
}

/** The sheet's title: the place's name, else what it is («Öffentliches WC»). */
export function poiTitle(p) {
  if (p && p.name) return p.name;
  return classLabel(p && p.cls);
}

/** «Restaurant», «Bahnhof» … for an OSM class value, «Ort» for the rest. */
export function classLabel(cls) {
  const key = `map.class.${cls}`;
  if (cls && /^[a-z_]+$/.test(cls) && hasKey(key)) return t(key);
  return t('map.class.place');
}

/** «im Frauen-WC, im Rollstuhl-WC» from a (semicolon-separated) location value. */
function locationWords(loc) {
  return loc
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((v) => (LOCATIONS.includes(v) ? t(`map.loc.${v}`) : v))
    .join(', ');
}

/**
 * What the sheet says about a place, one line each: {kind, text} — the
 * kind lines first ('changing' | 'nursing', with the table's whereabouts),
 * then the plain facts ('info'). Raw text: the view escapes it (the
 * description, the hours and the address come from OpenStreetMap).
 */
export function poiLines(p) {
  const lines = [];
  if (!p) return lines;
  if (p.w) {
    let text = t('map.kind.changing');
    if (p.loc) text += ` · ${locationWords(p.loc)}`;
    lines.push({ kind: 'changing', text });
    if (p.ct === 'limited') lines.push({ kind: 'info', text: t('map.limited') });
    if (p.cnt > 1) lines.push({ kind: 'info', text: t('map.count', { n: p.cnt }) });
    if (p.fee === 'yes' || p.fee === 'no') lines.push({ kind: 'info', text: t(`map.fee.${p.fee}`) });
    if (p.wc === 'yes' || p.wc === 'no' || p.wc === 'limited') lines.push({ kind: 'info', text: t(`map.wheelchair.${p.wc}`) });
    if (p.desc) lines.push({ kind: 'info', text: p.desc });
  }
  if (p.n) {
    lines.push({ kind: 'nursing', text: t(p.bf === 'room' ? 'map.nursing.room' : 'map.nursing.yes') });
    if (p.bff) lines.push({ kind: 'info', text: t('map.nursing.female') });
  }
  if (p.oh) lines.push({ kind: 'info', text: t('map.opening', { hours: p.oh }) });
  if (p.acc === 'private' || p.acc === 'customers') lines.push({ kind: 'info', text: t(`map.access.${p.acc}`) });
  if (p.lvl) lines.push({ kind: 'info', text: /^-/.test(p.lvl) ? t('map.level.basement') : t('map.level', { n: p.lvl }) });
  if (p.addr) lines.push({ kind: 'info', text: p.addr });
  return lines;
}

/** The place on openstreetmap.org (the sheet's link — a page to open, not a request the app makes). */
export function osmUrl(id) {
  const m = /^([nwr])(\d+)$/.exec(id || '');
  if (!m) return null;
  const type = { n: 'node', w: 'way', r: 'relation' }[m[1]];
  return `https://www.openstreetmap.org/${type}/${m[2]}`;
}

const EARTH_M = 6371008.8;
const rad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversineM(lon1, lat1, lon2, lat2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The n closest features to (lon, lat), closest first: [{feature, meters}]. */
export function nearest(features, lon, lat, n = 10) {
  const out = [];
  for (const f of features) {
    const c = f && f.geometry && f.geometry.coordinates;
    if (!c) continue;
    out.push({ feature: f, meters: haversineM(lon, lat, c[0], c[1]) });
  }
  out.sort((a, b) => a.meters - b.meters);
  return out.slice(0, Math.max(0, n));
}

/** «120 m» (10 m steps), «1,4 km» under ten, «12 km» from there — the decimal
 *  separator of the active language. */
export function distanceLabel(meters) {
  const m = Math.max(0, Number(meters) || 0);
  if (m < 995) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  const km = m / 1000;
  if (km < 9.95) return `${km.toFixed(1).replace('.', localeMeta().decimalSeparator)} km`;
  return `${Math.round(km)} km`;
}

/** The basemap flavour (names of @protomaps/basemaps) for a design and the
 *  scheme in force: the design's own light or dark look. `scheme` is the
 *  per-device override ('light' | 'dark' | null = the phone's setting). */
export function mapFlavor(theme, scheme, systemDark) {
  const dark = scheme === 'dark' || (scheme !== 'light' && !!systemDark);
  if (theme === 'swiss') return dark ? 'black' : 'white';
  return dark ? 'dark' : 'light';
}

/** Whether the pins show at this zoom. */
export function markersVisible(zoom) {
  return Number(zoom) >= MARKER_MIN_ZOOM;
}
