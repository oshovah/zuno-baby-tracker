// The map's pure half (src/mapdata.js): an Overpass answer becomes the
// compact places file, a place is worded the way the sheet shows it, the
// nearest list sorts by distance, the basemap flavour follows the design.
// Node runs in German; the English wording is checked after setLocale('en').
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../i18n/index.js';
import {
  KINDS,
  MARKER_MIN_ZOOM,
  normalizeOverpass,
  kindsOf,
  pinKind,
  filterKind,
  poiTitle,
  classLabel,
  poiLines,
  osmUrl,
  haversineM,
  nearest,
  distanceLabel,
  mapFlavor,
  markersVisible,
  parseExtraRow,
  mergeExtras,
  EXTRA_MATCH_M,
} from '../mapdata.js';

after(() => setLocale('de'));

const META = { generated: '2026-10-12', bbox: [5.9, 45.7, 10.6, 47.9] };

/** A slice of an Overpass `out tags center` answer: a shop with a table in
 *  two toilets, a nameless public toilet (a way), a library with a nursing
 *  room (a relation), a place with both, and two objects that must drop out. */
const OVERPASS = {
  elements: [
    {
      type: 'node', id: 101, lat: 47.3712345678, lon: 8.5389,
      tags: {
        name: 'Globus', shop: 'department_store', changing_table: 'yes', 'changing_table:location': 'female_toilet;wheelchair_toilet',
        'changing_table:fee': 'no', 'changing_table:count': '2', opening_hours: 'Mo-Sa 09:00-20:00', 'addr:street': 'Schweizergasse',
        'addr:housenumber': '11', 'addr:postcode': '8001', 'addr:city': 'Zürich', level: '2',
      },
    },
    { type: 'way', id: 202, center: { lat: 46.948, lon: 7.4474 }, tags: { amenity: 'toilets', changing_table: 'limited', 'changing_table:wheelchair': 'yes', fee: 'yes', access: 'customers' } },
    { type: 'relation', id: 303, center: { lat: 47.05, lon: 8.3 }, tags: { name: 'Stadtbibliothek', amenity: 'library', baby_feeding: 'room', 'baby_feeding:female': 'yes', 'baby_feeding:male': 'no' } },
    { type: 'node', id: 404, lat: 46.2, lon: 6.15, tags: { amenity: 'cafe', changing_table: 'yes', baby_feeding: 'yes', 'changing_table:description': 'Im Gang hinter der Theke  ', level: '-1' } },
    { type: 'node', id: 505, lat: 47.0, lon: 8.0, tags: { amenity: 'toilets', changing_table: 'no' } },
    { type: 'node', id: 606, tags: { changing_table: 'yes' } },
    { type: 'node', id: 707, lat: 47.1, lon: 8.1, tags: { amenity: 'restaurant', baby_feeding: 'no', changing_table: 'no' } },
  ],
};

test('normalizeOverpass: one point per object with a table or a nursing place, compact properties, sorted by id', () => {
  const fc = normalizeOverpass(OVERPASS, META);
  assert.equal(fc.type, 'FeatureCollection');
  assert.equal(fc.generated, '2026-10-12');
  assert.deepEqual(fc.bbox, META.bbox);
  assert.deepEqual(
    fc.features.map((f) => f.properties.id),
    ['n101', 'n404', 'r303', 'w202']
  );
  const shop = fc.features[0];
  assert.deepEqual(shop.geometry, { type: 'Point', coordinates: [8.5389, 47.37123] }); // five decimals
  assert.deepEqual(shop.properties, {
    id: 'n101', name: 'Globus', cls: 'department_store', w: 1, ct: 'yes', loc: 'female_toilet;wheelchair_toilet', fee: 'no', cnt: 2,
    oh: 'Mo-Sa 09:00-20:00', lvl: '2', addr: 'Schweizergasse 11, 8001 Zürich',
  });
  const wc = fc.features[3];
  assert.deepEqual(wc.geometry.coordinates, [7.4474, 46.948]); // the way's center
  assert.deepEqual(wc.properties, { id: 'w202', cls: 'toilets', w: 1, ct: 'limited', wc: 'yes', acc: 'customers' });
  const library = fc.features[2];
  assert.deepEqual(library.properties, { id: 'r303', name: 'Stadtbibliothek', cls: 'library', n: 1, bf: 'room', bff: 1 });
  const both = fc.features[1];
  assert.equal(both.properties.w, 1);
  assert.equal(both.properties.n, 1);
  assert.equal(both.properties.desc, 'Im Gang hinter der Theke'); // whitespace trimmed
  assert.equal(both.properties.lvl, '-1');
  assert.equal(both.properties.loc, undefined);
});

test('normalizeOverpass: tolerates an empty or malformed answer', () => {
  assert.deepEqual(normalizeOverpass({}, META).features, []);
  assert.deepEqual(normalizeOverpass(null, META).features, []);
  assert.deepEqual(normalizeOverpass({ elements: [{ type: 'node', id: 1, lat: 1, lon: 1 }] }, META).features, []);
});

test('kindsOf, pinKind, filterKind', () => {
  const fc = normalizeOverpass(OVERPASS, META);
  const [shop, both, library, wc] = fc.features;
  assert.deepEqual(KINDS, ['changing', 'nursing']);
  assert.deepEqual(kindsOf(shop.properties), ['changing']);
  assert.deepEqual(kindsOf(library.properties), ['nursing']);
  assert.deepEqual(kindsOf(both.properties), ['changing', 'nursing']);
  assert.deepEqual(kindsOf(null), []);
  assert.equal(pinKind(shop.properties), 'changing');
  assert.equal(pinKind(library.properties), 'nursing');
  assert.equal(pinKind(both.properties), 'both');
  assert.deepEqual(filterKind(fc.features, 'changing').map((f) => f.properties.id), ['n101', 'n404', 'w202']);
  assert.deepEqual(filterKind(fc.features, 'nursing').map((f) => f.properties.id), ['n404', 'r303']);
  assert.deepEqual(filterKind(fc.features, 'all').map((f) => f.properties.id), ['n101', 'n404', 'r303', 'w202']);
  assert.notEqual(filterKind(fc.features, 'all'), fc.features, 'a copy, never the caller\'s array');
  assert.equal(wc.properties.n, undefined);
});

test('poiTitle: the name, else what the place is — in German', () => {
  assert.equal(poiTitle({ name: 'Globus', cls: 'department_store' }), 'Globus');
  assert.equal(poiTitle({ cls: 'toilets' }), 'Öffentliches WC');
  assert.equal(poiTitle({ cls: 'station' }), 'Bahnhof');
  assert.equal(poiTitle({ cls: 'some_unknown_value' }), 'Ort');
  assert.equal(poiTitle({}), 'Ort');
  assert.equal(poiTitle(null), 'Ort');
  assert.equal(classLabel('Not A Key!'), 'Ort');
});

test('poiLines: the kind lines with the table\'s whereabouts, then the plain facts', () => {
  const fc = normalizeOverpass(OVERPASS, META);
  const [shop, both, library, wc] = fc.features;
  assert.deepEqual(poiLines(shop.properties), [
    { kind: 'changing', text: 'Wickeltisch · im Frauen-WC, im Rollstuhl-WC' },
    { kind: 'info', text: '2 Wickeltische' },
    { kind: 'info', text: 'Gratis' },
    { kind: 'info', text: 'Öffnungszeiten: Mo-Sa 09:00-20:00' },
    { kind: 'info', text: 'Etage 2' },
    { kind: 'info', text: 'Schweizergasse 11, 8001 Zürich' },
  ]);
  assert.deepEqual(poiLines(wc.properties), [
    { kind: 'changing', text: 'Wickeltisch' },
    { kind: 'info', text: 'Behelfsmässig – kein richtiger Wickeltisch' },
    { kind: 'info', text: 'Rollstuhlgängig' },
    { kind: 'info', text: 'Für Kundschaft' },
  ]);
  assert.deepEqual(poiLines(library.properties), [
    { kind: 'nursing', text: 'Eigener Stillraum' },
    { kind: 'info', text: 'Nur für Frauen' },
  ]);
  assert.deepEqual(poiLines(both.properties), [
    { kind: 'changing', text: 'Wickeltisch' },
    { kind: 'info', text: 'Im Gang hinter der Theke' },
    { kind: 'nursing', text: 'Platz zum Stillen' },
    { kind: 'info', text: 'Im Untergeschoss' },
  ]);
  // an undocumented location value shows raw
  assert.equal(poiLines({ w: 1, loc: 'female_toilet;staff_room' })[0].text, 'Wickeltisch · im Frauen-WC, staff_room');
  assert.deepEqual(poiLines(null), []);
});

test('osmUrl: the place on openstreetmap.org', () => {
  assert.equal(osmUrl('n101'), 'https://www.openstreetmap.org/node/101');
  assert.equal(osmUrl('w202'), 'https://www.openstreetmap.org/way/202');
  assert.equal(osmUrl('r303'), 'https://www.openstreetmap.org/relation/303');
  assert.equal(osmUrl('x1'), null);
  assert.equal(osmUrl(undefined), null);
});

test('haversineM: Zürich–Bern is about 95 km, a point to itself 0', () => {
  const d = haversineM(8.5417, 47.3769, 7.4474, 46.948);
  assert.ok(d > 94000 && d < 96500, `got ${d}`);
  assert.equal(haversineM(8.5, 47.3, 8.5, 47.3), 0);
});

test('nearest: closest first, n at most, from the given point', () => {
  const fc = normalizeOverpass(OVERPASS, META);
  const list = nearest(fc.features, 8.54, 47.37, 3); // standing in Zürich
  assert.deepEqual(list.map((x) => x.feature.properties.id), ['n101', 'r303', 'w202']);
  assert.ok(list[0].meters < 500);
  assert.ok(list[0].meters < list[1].meters && list[1].meters < list[2].meters);
  assert.deepEqual(nearest(fc.features, 8.54, 47.37, 0), []);
  assert.deepEqual(nearest([], 8.54, 47.37), []);
});

test('distanceLabel: metres in tens, kilometres with one decimal under ten', () => {
  assert.equal(distanceLabel(3), '10 m');
  assert.equal(distanceLabel(123), '120 m');
  assert.equal(distanceLabel(994), '990 m');
  assert.equal(distanceLabel(995), '1,0 km');
  assert.equal(distanceLabel(1440), '1,4 km');
  assert.equal(distanceLabel(9949), '9,9 km');
  assert.equal(distanceLabel(9950), '10 km');
  assert.equal(distanceLabel(12345), '12 km');
  assert.equal(distanceLabel(NaN), '10 m');
});

test('mapFlavor: the design\'s light or dark look, the override before the phone', () => {
  assert.equal(mapFlavor('nursery', null, false), 'light');
  assert.equal(mapFlavor('nursery', null, true), 'dark');
  assert.equal(mapFlavor('nursery', 'light', true), 'light');
  assert.equal(mapFlavor('nursery', 'dark', false), 'dark');
  assert.equal(mapFlavor('swiss', null, false), 'white');
  assert.equal(mapFlavor('swiss', 'dark', false), 'black');
  assert.equal(mapFlavor('bauhaus', null, true), 'dark');
  assert.equal(mapFlavor('bauhaus', null, false), 'light');
  assert.equal(mapFlavor(undefined, undefined, undefined), 'light');
});

test('markersVisible: from zoom 11 on', () => {
  assert.equal(MARKER_MIN_ZOOM, 11);
  assert.equal(markersVisible(10.9), false);
  assert.equal(markersVisible(11), true);
  assert.equal(markersVisible(undefined), false);
});

test('English after setLocale("en"): titles, lines and the distance separator', () => {
  setLocale('en');
  assert.equal(poiTitle({ cls: 'toilets' }), 'Public toilet');
  assert.equal(poiTitle({ cls: 'nope' }), 'Place');
  assert.deepEqual(poiLines({ w: 1, loc: 'female_toilet', fee: 'yes' }), [
    { kind: 'changing', text: "Changing table · in the women's toilet" },
    { kind: 'info', text: 'Fee' },
  ]);
  assert.equal(poiLines({ n: 1, bf: 'room' })[0].text, 'Own nursing room');
  assert.deepEqual(
    poiLines({ n: 1, bf: 'yes', note: 'Behind the counter', src: 'app' }).map((l) => l.text),
    ['A place to nurse', 'Behind the counter', 'Reported by parents, checked by the operator'],
    'a reported place: the note for any kind, the source last'
  );
  assert.equal(poiTitle({ cls: 'spot' }), 'Reported place');
  assert.equal(distanceLabel(1440), '1.4 km');
  setLocale('de');
  assert.equal(distanceLabel(1440), '1,4 km');
});

// --- the extra places (scripts/map/extra-places.csv) ---------------------

/** One record as the CSV reader hands it over: a city toilet at 47.0, 8.5. */
const ROW = {
  id: 'bern-wc-test', use: 'yes', name: 'WC Test', feature: 'amenity=toilets', lat: '47.0', lon: '8.5',
  changing_table: 'yes', 'changing_table:fee': 'no', 'changing_table:description': 'Hinter der Eurokey-Tür?', level: '',
  source: 'a list', checked: '2026-10-12', note: 'for the maintainer only',
};
const rowOf = (patch = {}) => parseExtraRow({ ...ROW, ...patch }).row;
const cand = (type, id, lat, lon, tags) => (type === 'node' ? { type, id, lat, lon, tags } : { type, id, center: { lat, lon }, tags });

test('parseExtraRow: the columns become tags, the meta columns do not, empty cells vanish', () => {
  const { row, error } = parseExtraRow(ROW);
  assert.equal(error, undefined);
  assert.equal(row.id, 'bern-wc-test');
  assert.equal(row.use, 'yes');
  assert.deepEqual(row.feature, { key: 'amenity', value: 'toilets' });
  assert.deepEqual(row.tags, {
    name: 'WC Test', changing_table: 'yes', 'changing_table:fee': 'no', 'changing_table:description': 'Hinter der Eurokey-Tür?', amenity: 'toilets',
  });
  assert.equal(row.lat, 47);
  assert.equal(row.lon, 8.5);
});

test('parseExtraRow: what is refused, and the little a row with use=no needs', () => {
  const bad = (patch) => parseExtraRow({ ...ROW, ...patch }).error;
  assert.match(bad({ id: 'kramgasse' }), /dash/);
  assert.match(bad({ id: 'Bern-WC' }), /dash/);
  assert.match(bad({ use: 'maybe' }), /use/);
  assert.match(bad({ feature: 'toilets' }), /feature/);
  assert.match(bad({ lat: '' }), /lat and lon/);
  assert.match(bad({ lon: 'x' }), /lat and lon/);
  assert.match(bad({ changing_table: 'no' }), /neither/);
  assert.match(bad({ checked: '12.10.2026' }), /checked/);
  assert.equal(parseExtraRow({ id: 'a-b', use: 'no', feature: 'shop=kiosk' }).row.use, 'no');
  assert.match(parseExtraRow({ id: 'a-b', use: 'no' }).error, /feature/);
});

test('mergeExtras: an object of the kind within 30 m that has the tag → covered, nothing changes', () => {
  const base = normalizeOverpass(OVERPASS, META).features;
  const { features, report } = mergeExtras(base, [rowOf()], { elements: [cand('node', 1, 47.0001, 8.5, { amenity: 'toilets', changing_table: 'yes' })] });
  assert.deepEqual(features, base);
  assert.equal(report.length, 1);
  assert.equal(report[0].action, 'covered');
  assert.equal(report[0].osm, 'n1');
  assert.ok(report[0].meters > 5 && report[0].meters < 15, `${report[0].meters} m`);
});

test('mergeExtras: the object lacks the tag → merged: the OSM id and point, the row\'s tags over its own', () => {
  const base = normalizeOverpass(OVERPASS, META).features;
  const osm = cand('node', 2, 47.0001, 8.5, { amenity: 'toilets', fee: 'no', opening_hours: '24/7', level: '-1', name: 'Altes WC' });
  const { features, report } = mergeExtras(base, [rowOf({ level: '5' })], { elements: [osm] });
  assert.equal(features.length, base.length + 1);
  const f = features.find((x) => x.properties.id === 'n2');
  assert.deepEqual(f.geometry.coordinates, [8.5, 47.0001]);
  assert.deepEqual(f.properties, { id: 'n2', name: 'WC Test', cls: 'toilets', w: 1, ct: 'yes', fee: 'no', desc: 'Hinter der Eurokey-Tür?', oh: '24/7', lvl: '5' });
  assert.equal(report[0].action, 'merged');
  assert.equal(report[0].osm, 'n2');
  assert.equal(osmUrl(f.properties.id), 'https://www.openstreetmap.org/node/2');
});

test('mergeExtras: nothing of the kind in reach → added under the row id without an OSM link; an area counts to 60 m', () => {
  const base = normalizeOverpass(OVERPASS, META).features;
  const far = cand('node', 3, 47.0004, 8.5, { amenity: 'toilets' }); // ≈ 44 m: too far for a point
  const other = cand('node', 5, 47.00001, 8.5, { shop: 'kiosk', changing_table: 'yes' }); // 1 m, but another kind
  const r1 = mergeExtras(base, [rowOf()], { elements: [far, other] });
  assert.equal(r1.features.length, base.length + 1);
  const f = r1.features[0]; // a slug sorts before every n… id
  assert.equal(f.properties.id, 'bern-wc-test');
  assert.deepEqual(f.geometry.coordinates, [8.5, 47]);
  assert.equal(f.properties.name, 'WC Test');
  assert.equal(osmUrl(f.properties.id), null);
  assert.equal(r1.report[0].action, 'added');
  assert.equal(r1.report[0].near, 'n3');
  assert.ok(r1.report[0].meters > 40 && r1.report[0].meters < 50, `${r1.report[0].meters} m`);
  const r2 = mergeExtras(base, [rowOf()], { elements: [cand('way', 4, 47.0004, 8.5, { amenity: 'toilets' })] });
  assert.equal(r2.report[0].action, 'merged');
  assert.equal(r2.report[0].osm, 'w4');
  assert.deepEqual(EXTRA_MATCH_M, { node: 30, area: 60 });
  assert.deepEqual(mergeExtras(base, [rowOf()], { elements: [] }).report, [{ id: 'bern-wc-test', action: 'added' }]);
});

test('mergeExtras: a row that adds the other kind replaces the listed feature in place; use=no is off', () => {
  const base = normalizeOverpass(OVERPASS, META).features; // w202: the toilet with a limited table at 46.948, 7.4474
  const row = rowOf({ id: 'bern-still-test', lat: '46.948', lon: '7.4474', changing_table: '', 'changing_table:fee': '', 'changing_table:description': '', baby_feeding: 'room' });
  const way = { type: 'way', id: 202, center: { lat: 46.948, lon: 7.4474 }, tags: OVERPASS.elements[1].tags };
  const { features, report } = mergeExtras(base, [row, rowOf({ use: 'no' })], { elements: [way] });
  assert.equal(features.length, base.length);
  const f = features.find((x) => x.properties.id === 'w202');
  assert.deepEqual(f.properties, { id: 'w202', name: 'WC Test', cls: 'toilets', w: 1, ct: 'limited', wc: 'yes', n: 1, bf: 'room', acc: 'customers' });
  assert.deepEqual(report.map((r) => r.action), ['merged', 'off']);
});
