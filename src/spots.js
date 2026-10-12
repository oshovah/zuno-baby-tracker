// «Ort melden» — the pure half (node-tested): what a report holds and its
// checks, how an approved spot becomes a map feature next to the OSM ones,
// and the one-slot hand-off that lets the operator's list send the map to a
// place. The sheet (spots-sheet.js) collects the input, the store sends it
// and keeps the approved list (store.spots), the map view lays that list
// over the OpenStreetMap file (views/map.js).
//
// A report is { lat, lon, kinds: ['changing' | 'nursing'], name, note }.
// Nothing about the sender travels with it, and api/lib/spots.php stores no
// sender either. An approved spot comes back as { id, lat, lon, kinds, name,
// note }; its feature carries the props mapdata.js words — plus `note`
// (shown for any kind) and `src: 'app'` (the source line) — under the id
// `s<id>`, which osmUrl() does not link. No DOM, no store here.

/** The kinds a place can be reported as (api/lib/spots.php has the same list). */
export const SPOT_KINDS = ['changing', 'nursing'];
export const SPOT_NAME_MAX = 80;
export const SPOT_NOTE_MAX = 300;
/** Below this zoom «Hier melden» stays off: the crosshair would cover a block, not a door. */
export const SPOT_PICK_MIN_ZOOM = 15;

const isCoord = (v, limit) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= limit;
const round5 = (n) => Math.round(n * 1e5) / 1e5;
const length = (s) => [...s].length;

/** A name or note as it will be sent: whitespace collapsed, trimmed (the server does the same). */
export function spotText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/**
 * Why a draft cannot be sent, as an i18n key — or null when it can.
 * `kinds` = the chips ticked, `name`/`note` the raw inputs.
 */
export function spotDraftError({ lat, lon, kinds, name, note }) {
  if (!isCoord(lat, 90) || !isCoord(lon, 180)) return 'spots.form.errorPosition';
  if (!Array.isArray(kinds) || !kinds.length || kinds.some((k) => !SPOT_KINDS.includes(k)) || new Set(kinds).size !== kinds.length) {
    return 'spots.form.errorKind';
  }
  if (length(spotText(name)) > SPOT_NAME_MAX) return 'spots.form.errorName';
  if (length(spotText(note)) > SPOT_NOTE_MAX) return 'spots.form.errorNote';
  return null;
}

/** The request body for a valid draft (kinds in the map's order). Throws on an invalid one — check spotDraftError first. */
export function buildSpot(draft) {
  const error = spotDraftError(draft);
  if (error) throw new Error(error);
  return {
    lat: round5(draft.lat),
    lon: round5(draft.lon),
    kinds: SPOT_KINDS.filter((k) => draft.kinds.includes(k)),
    name: spotText(draft.name),
    note: spotText(draft.note),
  };
}

/**
 * A spot as the server or localStorage hands it over, checked: {id, lat,
 * lon, kinds, name, note} — plus status, createdAt and decidedAt when the
 * row carries them (the operator's list) — or null. Kinds the app does not
 * know are dropped; a spot of no known kind is nothing.
 */
export function cleanSpot(row) {
  if (!row || typeof row !== 'object') return null;
  const id = Number(row.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  if (!isCoord(row.lat, 90) || !isCoord(row.lon, 180)) return null;
  const kinds = Array.isArray(row.kinds) ? SPOT_KINDS.filter((k) => row.kinds.includes(k)) : [];
  if (!kinds.length) return null;
  const spot = {
    id,
    lat: round5(row.lat),
    lon: round5(row.lon),
    kinds,
    name: spotText(row.name).slice(0, SPOT_NAME_MAX),
    note: spotText(row.note).slice(0, SPOT_NOTE_MAX),
  };
  if (typeof row.status === 'string') spot.status = row.status === 'approved' ? 'approved' : 'pending';
  if (typeof row.createdAt === 'string') spot.createdAt = row.createdAt;
  if (typeof row.decidedAt === 'string') spot.decidedAt = row.decidedAt;
  return spot;
}

/** Whether a feature id names a reported spot (`s12`) rather than an OSM object. */
export const isSpotId = (id) => /^s\d+$/.test(String(id || ''));

/** The map feature of an approved spot: the props mapdata.js words, plus `note` and `src`. */
export function spotFeature(spot) {
  const p = { id: `s${spot.id}`, cls: 'spot', src: 'app' };
  if (spot.name) p.name = spot.name;
  if (spot.kinds.includes('changing')) {
    p.w = 1;
    p.ct = 'yes';
  }
  if (spot.kinds.includes('nursing')) {
    p.n = 1;
    p.bf = 'yes';
  }
  if (spot.note) p.note = spot.note;
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [spot.lon, spot.lat] }, properties: p };
}

/** The OSM features with the approved spots after them (junk skipped); always a new array. */
export function withSpots(features, spots) {
  const out = Array.isArray(features) ? features.slice() : [];
  for (const row of Array.isArray(spots) ? spots : []) {
    const spot = cleanSpot(row);
    if (spot) out.push(spotFeature(spot));
  }
  return out;
}

// --- the hand-off to the map -------------------------------------------------
// «Auf der Karte zeigen» in the operator's list: the view the map opens on
// next, consumed by the next mount of views/map.js (takeMapFocus) — no hash
// parameter, no import cycle.

let focus = null;

/** Remember where the map should open next: {lon, lat, zoom?} (zoom 16 by default). */
export function focusMapAt(view) {
  if (!view || !isCoord(view.lat, 90) || !isCoord(view.lon, 180)) {
    focus = null;
    return;
  }
  const zoom = typeof view.zoom === 'number' && Number.isFinite(view.zoom) ? Math.min(19, Math.max(3, view.zoom)) : 16;
  focus = { lon: round5(view.lon), lat: round5(view.lat), zoom };
}

/** The remembered view, once; null when there is none. */
export function takeMapFocus() {
  const v = focus;
  focus = null;
  return v;
}
