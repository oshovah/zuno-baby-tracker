// The map's area and its data sources — ONE place for the two build-time
// scripts (scripts/map-data.mjs fetches the places, scripts/map-basemap.mjs
// extracts the basemap): both must cover the same box, or the places would
// sit on a blank background. README › «Karte» and «Hosting somewhere else?»:
// change the box here, then run both scripts again.

/** Switzerland and Liechtenstein with a margin for the border towns parents
 *  drive to (Konstanz, Lörrach, Bregenz, Como, Mulhouse). */
export const BBOX = { west: 5.9, south: 45.7, east: 10.6, north: 47.9 };

/** Overpass wants south,west,north,east … */
export const overpassBbox = (b = BBOX) => `${b.south},${b.west},${b.north},${b.east}`;

/** … `pmtiles extract --bbox` wants west,south,east,north. */
export const pmtilesBbox = (b = BBOX) => `${b.west},${b.south},${b.east},${b.north}`;

/** In this order: the Swiss instance first (it covers the margin), the main one as the fallback. */
export const OVERPASS_ENDPOINTS = ['https://overpass.osm.ch/api/interpreter', 'https://overpass-api.de/api/interpreter'];

/** The daily planet build the basemap is cut from (YYYYMMDD). */
export const protomapsBuildUrl = (build) => `https://build.protomaps.com/${build}.pmtiles`;

/** Zoom levels kept in the archive: 14 is ~570 MB for the box, 15 doubles it.
 *  Above it the renderer overzooms the z14 tiles — streets and the larger
 *  buildings stay sharp, small detail is what goes. */
export const BASEMAP_MAXZOOM = 14;
