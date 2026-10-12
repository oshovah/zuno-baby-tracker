// «Karte»: Wickeltische and Still-Orte around the parents — the places
// OpenStreetMap knows (public/map/pois.json, cut at build time by
// scripts/map-data.mjs) on a basemap this server hosts itself (basemap/,
// scripts/map-basemap.mjs). Nothing is asked of a third party: the login
// page promises that, the CSP enforces it.
//
// The screen is a full-bleed stage (style.css .map-stage) with the filter
// floating at the top, «Mein Standort» at the side and a bar of three
// buttons at the bottom: «Info» (where the data comes from, its date, the
// attribution), «Ort hinzufügen» (below) and «Orte in der Nähe» (the ten
// nearest in the bottom sheet, once the phone has a fix); a small attribution
// link sits over the map's corner. A tap on a pin opens the place in the
// sheet. The engine
// (map-engine.js, Leaflet + the pins) is loaded with import() on the first
// visit; without it — no basemap on this server, no network — the nearest
// list in the sheet still works from the places file, which the service
// worker keeps. Everything a parent reads goes through t() (namespace `map`); the
// wording and the distances are pure in mapdata.js.
//
// Module state survives a re-mount (every tab switch and a language switch
// re-render the view): the places and the basemap index are fetched once,
// the viewport, the filter and the last fix carry over. One thing is per
// device (prefs): where the map starts — the whole box, or the view set
// under Mehr › Einstellungen › Karte, which then wins over the last view.
// The last view is written to prefs on every move: the settings take it as
// the start view.
//
// Reported places (store.spots, src/spots.js): the approved list is laid
// over the OSM file whenever the store says it moved (every sync notifies).
// «Ort hinzufügen» puts the view into picking mode — a crosshair in the
// middle, the button bar replaced by one with «Hier melden» — and opens the form on
// the map centre (spots-sheet.js). The operator's list can send the map
// here with a view to open on (takeMapFocus, consumed once).

import { store, prefs } from '../store.js';
import { t, getLocale, localeMeta } from '../i18n/index.js';
import { escapeHtml, icon, toast } from '../ui.js';
import { openSheet } from '../sheet.js';
import { filterKind, nearest, distanceLabel, poiTitle, poiLines, pinKind, osmUrl, mapFlavor } from '../mapdata.js';
import { loadJson, loadPois } from '../pois.js';
import { withSpots, takeMapFocus, SPOT_PICK_MIN_ZOOM } from '../spots.js';
import { openSpotForm } from '../spots-sheet.js';

const FILTERS = ['all', 'changing', 'nursing'];
const LIST_ROWS = 10;

const LOCATE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="6.5" /><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" /><path d="M12 2.5v3.5M12 18v3.5M2.5 12H6M18 12h3.5" /></svg>`;
const SUGGEST_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21.5s-6.5-5.6-6.5-10.5a6.5 6.5 0 0 1 13 0c0 4.9-6.5 10.5-6.5 10.5z" /><path d="M12 8v6M9 11h6" /></svg>`;
const NEARBY_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21.5s-6.5-5.6-6.5-10.5a6.5 6.5 0 0 1 13 0c0 4.9-6.5 10.5-6.5 10.5z" /><circle cx="12" cy="11" r="2.4" /></svg>`;
const INFO_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5" /><circle cx="12" cy="7.6" r="0.9" fill="currentColor" stroke="none" /></svg>`;

let indexPromise = null; // basemap/index.json, once (null = not set up on this server)
let lastView = null; // {lon, lat, zoom} of the last visit
let lastMe = null; // {lon, lat} of the last fix
let filter = 'all';

function loadBasemapIndex() {
  if (!indexPromise) {
    indexPromise = loadJson('basemap/index.json')
      .then((j) => (j && typeof j.file === 'string' && /^[\w.-]+\.pmtiles$/.test(j.file) ? j : null))
      .catch((err) => {
        if (err.status === 404) return null; // this server has no basemap: the list still works
        indexPromise = null;
        throw err;
      });
  }
  return indexPromise;
}

/** «12.10.2026» for the file's ISO day. */
function fmtDay(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(localeMeta().dateLocale, { day: 'numeric', month: 'numeric', year: 'numeric' });
}

function kindIcon(kind) {
  return icon(kind === 'nursing' ? 'breastfeed' : 'diaper');
}

/** One row of the nearest list (a button: tap = open the place). */
function rowHtml(feature, meters) {
  const p = feature.properties;
  const lines = poiLines(p);
  const sub = lines.length ? lines[0].text : '';
  return `<button type="button" class="nearby-row" data-poi="${escapeHtml(p.id)}">
    <span class="poi-dot ${pinKind(p) === 'nursing' ? 'nursing' : ''}" aria-hidden="true"></span>
    <span class="nr-main"><span class="nr-title">${escapeHtml(poiTitle(p))}</span><span class="nr-sub">${escapeHtml(sub)}</span></span>
    <span class="nr-dist">${escapeHtml(distanceLabel(meters))}</span>
  </button>`;
}

/** The place in the sheet: its lines, the distance, the link to OSM. */
function detailHtml(feature, me, withTitle) {
  const p = feature.properties;
  const lines = poiLines(p);
  const c = feature.geometry.coordinates;
  const dist = me ? nearest([feature], me.lon, me.lat, 1)[0].meters : null;
  const link = osmUrl(p.id);
  return `${withTitle ? `<h3 class="poi-sheet-title">${escapeHtml(poiTitle(p))}</h3>` : ''}
    <ul class="poi-lines">
      ${lines.map((l) => `<li class="${l.kind === 'info' ? '' : 'kind'}">${l.kind === 'info' ? '' : `${kindIcon(l.kind)} `}${escapeHtml(l.text)}</li>`).join('')}
    </ul>
    ${dist !== null ? `<p class="hint">${escapeHtml(t('map.distance', { d: distanceLabel(dist) }))}</p>` : ''}
    ${p.src === 'app' ? '' : `<p class="hint">${escapeHtml(t(store.spots.on ? 'map.missing.hintSpots' : 'map.missing.hint'))}</p>`}
    <div class="poi-actions" data-lon="${c[0]}" data-lat="${c[1]}">
      <button type="button" class="btn small" data-show-on-map>${escapeHtml(t('map.showOnMap'))}</button>
      ${link ? `<a class="btn small" href="${escapeHtml(link)}" target="_blank" rel="noopener">${escapeHtml(t('map.osmLink'))}</a>` : ''}
    </div>`;
}

export function renderMap(el) {
  el.classList.add('map-view');
  el.innerHTML = `
    <div class="map-stage">
      <div class="map-canvas" data-map-canvas role="application" aria-label="${escapeHtml(t('map.aria'))}"></div>
      <div class="map-top">
        <div class="segmented compact" role="radiogroup" aria-label="${escapeHtml(t('map.filter.label'))}">
          ${FILTERS.map(
            (f) => `<button type="button" class="seg${f === filter ? ' active' : ''}" role="radio" aria-checked="${f === filter}" data-filter="${f}">${
              f === 'all' ? '' : `<span class="poi-dot${f === 'nursing' ? ' nursing' : ''}" aria-hidden="true"></span>`
            }${escapeHtml(t(`map.filter.${f}`))}</button>`
          ).join('')}
        </div>
      </div>
      <div class="map-side">
        <button type="button" class="map-fab" data-locate aria-label="${escapeHtml(t('map.locate'))}">${LOCATE_SVG}</button>
      </div>
      <div class="map-cross" aria-hidden="true"></div>
      <div class="map-pick" data-pick hidden>
        <p data-pick-hint></p>
        <button type="button" class="btn" data-pick-cancel>${escapeHtml(t('spots.pick.cancel'))}</button>
        <button type="button" class="btn primary" data-pick-here>${escapeHtml(t('spots.pick.here'))}</button>
      </div>
      <p class="map-notice" data-notice>${escapeHtml(t('map.loading'))}</p>
      <p class="map-hint" data-hint hidden>${escapeHtml(t('map.zoomIn'))}</p>
      <p class="map-attrib"><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">${escapeHtml(t('map.attribution'))}</a></p>
      <div class="map-bar" data-bar>
        <button type="button" class="map-bar-btn" data-info>${INFO_SVG}<span>${escapeHtml(t('map.info.button'))}</span></button>
        <button type="button" class="map-bar-btn" data-add hidden>${SUGGEST_SVG}<span>${escapeHtml(t('spots.fab'))}</span></button>
        <button type="button" class="map-bar-btn" data-nearby>${NEARBY_SVG}<span>${escapeHtml(t('map.nearby.button'))}</span></button>
      </div>
    </div>`;
  document.body.classList.add('map-open');

  const canvas = el.querySelector('[data-map-canvas]');
  const noticeEl = el.querySelector('[data-notice]');
  const hintEl = el.querySelector('[data-hint]');
  const locateBtn = el.querySelector('[data-locate]');
  const nearbyBtn = el.querySelector('[data-nearby]');
  const infoBtn = el.querySelector('[data-info]');
  const addBtn = el.querySelector('[data-add]');
  const pickEl = el.querySelector('[data-pick]');
  const pickHint = el.querySelector('[data-pick-hint]');
  const hereBtn = el.querySelector('[data-pick-here]');

  let gone = false;
  let engine = null;
  let fc = null; // the places file, once loaded
  let all = []; // every place: the file plus the approved reports
  let spotsKey = null; // which list of reports `all` was built with
  let picking = false; // «Ort hinzufügen»: the crosshair is up
  let me = lastMe;
  const darkMedia = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const flavor = () => mapFlavor(prefs.theme, prefs.scheme, !!(darkMedia && darkMedia.matches));

  const notice = (text) => {
    noticeEl.textContent = text || '';
    noticeEl.hidden = !text;
  };
  const shown = () => filterKind(all, filter);
  const byId = (id) => all.find((f) => f.properties.id === id) || null;

  function applyFilter(next) {
    filter = next;
    el.querySelectorAll('[data-filter]').forEach((b) => {
      const on = b.dataset.filter === filter;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    });
    if (engine) engine.setPois(shown());
  }

  /** The places: the file plus the approved reports (store.spots), re-laid
   *  when the list moved — every sync notifies, most say "same as before". */
  function applySpots() {
    if (!fc) return;
    const key = store.spots.on ? `${store.spots.version}:${store.spots.items.length}` : 'off';
    if (key === spotsKey) return;
    spotsKey = key;
    all = withSpots(fc.features, store.spots.on ? store.spots.items : []);
    el.dataset.pois = String(all.length);
    el.dataset.spots = String(all.length - fc.features.length);
    if (engine) engine.setPois(shown());
    addBtn.hidden = !(store.spots.on && engine); // reporting needs the map (the crosshair)
  }

  // --- «Ort hinzufügen»: the crosshair marks the map centre; «Hier melden» needs
  //     a close zoom, so the cross sits on a door, not on a block ---
  function syncPick() {
    if (!picking || !engine) return;
    const ok = engine.getView().zoom >= SPOT_PICK_MIN_ZOOM;
    hereBtn.disabled = !ok;
    pickHint.textContent = t(ok ? 'spots.pick.hint' : 'spots.pick.zoom');
  }
  function enterPick() {
    if (!engine || picking) return;
    picking = true;
    el.classList.add('picking');
    pickEl.hidden = false;
    syncPick();
  }
  function exitPick() {
    picking = false;
    el.classList.remove('picking');
    pickEl.hidden = true;
  }

  /** Centre the map on a place (when there is a map). */
  function goTo(feature, zoom = 16) {
    if (!engine) return;
    const c = feature.geometry.coordinates;
    engine.flyTo(c[0], c[1], zoom);
  }

  function wireDetail(body, feature, close) {
    body.querySelector('[data-show-on-map]')?.addEventListener('click', () => {
      close();
      goTo(feature);
    });
  }

  /** A pin: the place in the sheet. */
  function openPoi(feature) {
    openSheet(poiTitle(feature.properties), (body, close) => {
      body.innerHTML = detailHtml(feature, me, false);
      wireDetail(body, feature, close);
    });
  }

  /** «Orte in der Nähe»: ONE sheet whose body swaps between the list and a place
   *  (a second openSheet right after close() would race the history pop). */
  function openNearby() {
    openSheet(t('map.nearby.title'), (body, close) => {
      const showList = () => {
        const rows = nearest(shown(), me.lon, me.lat, LIST_ROWS);
        body.innerHTML = `<p class="hint">${escapeHtml(t('map.nearby.hint'))}</p>${
          rows.length ? rows.map(({ feature, meters }) => rowHtml(feature, meters)).join('') : `<div class="empty"><p>${escapeHtml(t('map.nearby.empty'))}</p></div>`
        }`;
        body.querySelectorAll('[data-poi]').forEach((btn) =>
          btn.addEventListener('click', () => {
            const f = byId(btn.dataset.poi);
            if (f) showDetail(f);
          })
        );
      };
      const showDetail = (feature) => {
        body.innerHTML = `${detailHtml(feature, me, true)}<button type="button" class="btn wide" data-back>${escapeHtml(t('map.nearby.back'))}</button>`;
        wireDetail(body, feature, close);
        body.querySelector('[data-back]').addEventListener('click', showList);
        body.scrollTop = 0;
      };
      showList();
    });
  }

  /** «Info»: where the places and the map come from, their date, the attribution. */
  function openInfo() {
    openSheet(t('map.info.title'), (body) => {
      const date = fc && fc.generated ? fmtDay(fc.generated) : null;
      body.innerHTML = `
        <p>${escapeHtml(t('map.info.places'))}${date ? ` ${escapeHtml(t('map.info.date', { date }))}` : ''}</p>
        <p>${escapeHtml(t('map.info.tiles'))}</p>
        ${store.spots.on ? `<p>${escapeHtml(t('map.info.spots'))}</p>` : ''}
        <p>${escapeHtml(t('map.info.location'))}</p>
        <p>${escapeHtml(t('map.info.missing'))}</p>
        <p class="hint">${escapeHtml(t('map.info.license'))} <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">openstreetmap.org/copyright</a></p>`;
    });
  }

  /** The phone's position, on a tap only; never leaves the device. */
  function locate() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        toast(t('map.locate.unsupported'), 'error');
        return resolve(null);
      }
      locateBtn.disabled = true;
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          locateBtn.disabled = false;
          if (gone) return resolve(null);
          me = { lon: pos.coords.longitude, lat: pos.coords.latitude };
          lastMe = me;
          locateBtn.classList.add('on');
          if (engine) {
            engine.setMe(me.lon, me.lat);
            engine.flyTo(me.lon, me.lat, 15);
          }
          resolve(me);
        },
        (err) => {
          locateBtn.disabled = false;
          if (!gone) toast(t(err && err.code === 1 ? 'map.locate.denied' : 'map.locate.failed'), 'error');
          resolve(null);
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
      );
    });
  }

  el.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => applyFilter(b.dataset.filter)));
  locateBtn.addEventListener('click', () => {
    locate();
  });
  addBtn.addEventListener('click', enterPick);
  infoBtn.addEventListener('click', openInfo);
  el.querySelector('[data-pick-cancel]').addEventListener('click', exitPick);
  hereBtn.addEventListener('click', () => {
    if (!engine || !picking) return;
    const v = engine.getView();
    openSpotForm({ lon: v.lon, lat: v.lat, onSent: exitPick });
  });
  nearbyBtn.addEventListener('click', async () => {
    if (!all.length) return;
    if (!me && !(await locate())) return;
    if (!gone) openNearby();
  });

  const onScheme = () => {
    if (engine) engine.setFlavor(flavor());
  };
  if (darkMedia && darkMedia.addEventListener) darkMedia.addEventListener('change', onScheme);
  const unsubscribe = store.subscribe(() => {
    if (!gone) applySpots();
  });

  (async () => {
    try {
      fc = await loadPois();
    } catch {
      if (!gone) notice(t('map.offline'));
      return;
    }
    if (gone) return;
    applySpots();
    if (me) locateBtn.classList.add('on');

    let index;
    try {
      index = await loadBasemapIndex();
    } catch {
      index = undefined;
    }
    if (gone) return;
    if (index === null) return notice(t('map.basemap.missing'));
    if (index === undefined) return notice(t('map.offline'));

    let mod;
    try {
      mod = await import('../map-engine.js');
    } catch {
      if (!gone) notice(t('map.failed'));
      return;
    }
    if (gone) return;
    try {
      engine = mod.createMap({
        container: canvas,
        basemapUrl: new URL(`basemap/${index.file}`, document.baseURI).href,
        maxDataZoom: Number.isInteger(index.maxzoom) ? index.maxzoom : 14,
        flavor: flavor(),
        lang: getLocale(),
        bounds: Array.isArray(index.bbox) && index.bbox.length === 4 ? index.bbox : fc.bbox,
        view: takeMapFocus() || prefs.mapStart || lastView, // «Auf der Karte zeigen» first, then the phone's start view, else where this visit left off
        reducedMotion,
        onMove: ({ pinsShown }) => {
          hintEl.hidden = pinsShown;
          if (engine) {
            lastView = engine.getView();
            prefs.mapView = lastView; // the settings offer it as the start view
            if (picking) syncPick();
          }
        },
        onPoiTap: openPoi,
      });
    } catch {
      notice(t('map.failed'));
      return;
    }
    notice('');
    engine.setPois(shown());
    if (me) engine.setMe(me.lon, me.lat);
    addBtn.hidden = !store.spots.on;
    el.dataset.mapState = 'ready';
  })();

  return () => {
    gone = true;
    unsubscribe();
    exitPick();
    if (darkMedia && darkMedia.removeEventListener) darkMedia.removeEventListener('change', onScheme);
    document.body.classList.remove('map-open');
    if (engine) {
      lastView = engine.getView();
      prefs.mapView = lastView;
      engine.destroy();
      engine = null;
    }
  };
}
