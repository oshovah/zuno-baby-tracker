// «Ort melden», the pure half (src/spots.js): a draft's checks, the body that
// goes up, a stored spot read back, its map feature worded by mapdata.js,
// the overlay over the OSM features and the one-slot hand-off to the map.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { hasKey, setLocale } from '../i18n/index.js';
import {
  SPOT_KINDS,
  SPOT_NAME_MAX,
  SPOT_NOTE_MAX,
  SPOT_PICK_MIN_ZOOM,
  spotText,
  spotDraftError,
  buildSpot,
  cleanSpot,
  isSpotId,
  spotFeature,
  withSpots,
  focusMapAt,
  takeMapFocus,
} from '../spots.js';
import { poiTitle, poiLines, osmUrl, pinKind, filterKind } from '../mapdata.js';

after(() => setLocale('de'));

const DRAFT = { lat: 46.948, lon: 7.4479, kinds: ['changing'], name: '  WC   Zytglogge ', note: 'Im 1. Stock' };

test('spotDraftError: a position, at least one known kind once, the text limits (code points)', () => {
  assert.equal(spotDraftError(DRAFT), null);
  assert.equal(spotDraftError({ ...DRAFT, lat: undefined }), 'spots.form.errorPosition');
  assert.equal(spotDraftError({ ...DRAFT, lon: 181 }), 'spots.form.errorPosition');
  assert.equal(spotDraftError({ ...DRAFT, lat: '46.9' }), 'spots.form.errorPosition');
  assert.equal(spotDraftError({ ...DRAFT, kinds: [] }), 'spots.form.errorKind');
  assert.equal(spotDraftError({ ...DRAFT, kinds: ['playground'] }), 'spots.form.errorKind');
  assert.equal(spotDraftError({ ...DRAFT, kinds: ['changing', 'changing'] }), 'spots.form.errorKind');
  assert.equal(spotDraftError({ ...DRAFT, kinds: ['nursing', 'changing'] }), null);
  assert.equal(spotDraftError({ ...DRAFT, name: 'x'.repeat(SPOT_NAME_MAX) }), null);
  assert.equal(spotDraftError({ ...DRAFT, name: 'x'.repeat(SPOT_NAME_MAX + 1) }), 'spots.form.errorName');
  assert.equal(spotDraftError({ ...DRAFT, note: '👶'.repeat(SPOT_NOTE_MAX) }), null, 'an emoji counts once');
  assert.equal(spotDraftError({ ...DRAFT, note: 'x'.repeat(SPOT_NOTE_MAX + 1) }), 'spots.form.errorNote');
  assert.equal(spotDraftError({ ...DRAFT, name: undefined, note: null }), null, 'name and note may stay empty');
  assert.deepEqual(SPOT_KINDS, ['changing', 'nursing']);
  assert.equal(SPOT_PICK_MIN_ZOOM, 15);
});

test('buildSpot: the body that goes up — texts collapsed, kinds in the map order, five decimals', () => {
  assert.deepEqual(buildSpot({ ...DRAFT, lat: 46.9480001234, kinds: ['nursing', 'changing'] }), {
    lat: 46.948,
    lon: 7.4479,
    kinds: ['changing', 'nursing'],
    name: 'WC Zytglogge',
    note: 'Im 1. Stock',
  });
  assert.equal(spotText(" a \n\n b\t"), 'a b');
  assert.equal(spotText(42), '');
  assert.throws(() => buildSpot({ ...DRAFT, kinds: [] }), /spots\.form\.errorKind/);
});

test('cleanSpot: a row read back, junk refused, unknown kinds dropped, the operator fields kept', () => {
  assert.deepEqual(cleanSpot({ id: 3, lat: 46.948, lon: 7.4479, kinds: ['changing', 'playground'], name: 'WC', note: '' }), {
    id: 3, lat: 46.948, lon: 7.4479, kinds: ['changing'], name: 'WC', note: '',
  });
  assert.equal(cleanSpot({ id: 3, lat: 46.948, lon: 7.4479, kinds: ['playground'] }), null, 'no known kind: nothing to show');
  assert.equal(cleanSpot({ id: 0, lat: 1, lon: 1, kinds: ['changing'] }), null);
  assert.equal(cleanSpot({ id: '7', lat: 1, lon: 1, kinds: ['changing'] }).id, 7, 'a numeric string id is fine');
  assert.equal(cleanSpot({ id: 3, lat: '46.9', lon: 7, kinds: ['changing'] }), null);
  assert.equal(cleanSpot(null), null);
  assert.equal(cleanSpot('x'), null);
  const op = cleanSpot({ id: 3, lat: 1, lon: 1, kinds: ['nursing'], name: 'x'.repeat(200), note: 'n', status: 'approved', createdAt: '2026-10-12', decidedAt: null });
  assert.equal(op.status, 'approved');
  assert.equal(op.createdAt, '2026-10-12');
  assert.equal(op.decidedAt, undefined);
  assert.equal(op.name.length, SPOT_NAME_MAX, 'capped');
  assert.equal(cleanSpot({ id: 3, lat: 1, lon: 1, kinds: ['nursing'], status: 'weird' }).status, 'pending');
});

test('spotFeature: the feature mapdata.js words — id s<id> without an OSM link, the note for any kind, the source last', () => {
  const f = spotFeature(cleanSpot({ id: 12, lat: 46.948, lon: 7.4479, kinds: ['nursing'], name: '', note: 'Hinter der Theke' }));
  assert.deepEqual(f.geometry, { type: 'Point', coordinates: [7.4479, 46.948] });
  assert.deepEqual(f.properties, { id: 's12', cls: 'spot', src: 'app', n: 1, bf: 'yes', note: 'Hinter der Theke' });
  assert.equal(isSpotId('s12'), true);
  assert.equal(isSpotId('n12'), false);
  assert.equal(osmUrl('s12'), null);
  assert.equal(poiTitle(f.properties), 'Gemeldeter Ort');
  assert.deepEqual(
    poiLines(f.properties).map((l) => l.text),
    ['Platz zum Stillen', 'Hinter der Theke', 'Von Eltern gemeldet, vom Betreiber geprüft']
  );
  assert.equal(pinKind(f.properties), 'nursing');
  const both = spotFeature(cleanSpot({ id: 1, lat: 1, lon: 1, kinds: ['changing', 'nursing'], name: 'Café' }));
  assert.equal(poiTitle(both.properties), 'Café');
  assert.equal(pinKind(both.properties), 'both');
  assert.deepEqual(poiLines(both.properties).map((l) => l.kind), ['changing', 'nursing', 'info']);
});

test('withSpots: the OSM features first, then the valid spots; a new array, the filter still applies', () => {
  const osm = [{ type: 'Feature', geometry: { type: 'Point', coordinates: [8.5, 47] }, properties: { id: 'n1', w: 1, ct: 'yes' } }];
  const spots = [
    { id: 2, lat: 46.948, lon: 7.4479, kinds: ['nursing'], name: 'A', note: '' },
    { id: 'junk', lat: 1, lon: 1, kinds: ['changing'] },
    { id: 3, lat: 46.95, lon: 7.45, kinds: ['changing'], name: 'B', note: '' },
  ];
  const all = withSpots(osm, spots);
  assert.deepEqual(all.map((f) => f.properties.id), ['n1', 's2', 's3']);
  assert.notEqual(all, osm);
  assert.equal(osm.length, 1, 'the OSM list is untouched');
  assert.deepEqual(filterKind(all, 'nursing').map((f) => f.properties.id), ['s2']);
  assert.deepEqual(withSpots(osm, null).map((f) => f.properties.id), ['n1']);
  assert.deepEqual(withSpots(undefined, spots).map((f) => f.properties.id), ['s2', 's3']);
});

test('focusMapAt / takeMapFocus: one slot, consumed once, sanitised', () => {
  assert.equal(takeMapFocus(), null);
  focusMapAt({ lon: 7.44791234, lat: 46.9480001, zoom: 17 });
  assert.deepEqual(takeMapFocus(), { lon: 7.44791, lat: 46.948, zoom: 17 });
  assert.equal(takeMapFocus(), null, 'consumed');
  focusMapAt({ lon: 7.4, lat: 46.9 });
  assert.equal(takeMapFocus().zoom, 16, 'the default zoom');
  focusMapAt({ lon: 7.4, lat: 46.9, zoom: 99 });
  assert.equal(takeMapFocus().zoom, 19, 'clamped');
  focusMapAt({ lon: 200, lat: 46.9 });
  assert.equal(takeMapFocus(), null, 'off the planet: nothing');
  focusMapAt(null);
  assert.equal(takeMapFocus(), null);
});

test('the spots namespace is registered with the copy the sheets use', () => {
  for (const key of ['spots.fab', 'spots.pick.here', 'spots.form.title', 'spots.form.privacy', 'spots.section.title', 'spots.sheet.approve', 'map.spot.source', 'map.class.spot', 'map.missing.hintSpots']) {
    assert.equal(hasKey(key), true, key);
  }
});
