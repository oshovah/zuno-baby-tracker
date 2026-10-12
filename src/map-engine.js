// The map engine behind «Karte»: Leaflet with protomaps-leaflet drawing the
// self-hosted PMTiles archive on canvas (OpenStreetMap data, the flavours
// of @protomaps/basemaps), the places as plain DOM pins. This is the ONLY
// module that imports the map libraries — views/map.js loads it with
// import(), so the bundle grows only for the tab, and the whole thing stays
// behind one small interface (createMap) a different renderer could fill.
//
// Nothing here talks to a third party: the archive URL is the app's own
// basemap/ folder, read in byte ranges; labels are drawn with the system
// font (no glyph files), there are no sprites and no worker.

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { leafletLayer } from 'protomaps-leaflet';
import { MARKER_MIN_ZOOM, pinKind } from './mapdata.js';

// protomaps-leaflet extends L.GridLayer from the GLOBAL — Leaflet's UMD
// build sets window.L itself, but the bundler must not be relied on for it.
if (typeof globalThis !== 'undefined' && !globalThis.L) globalThis.L = L;

const PIN = 22;
const icons = {};
function pinIcon(kind) {
  if (!icons[kind]) icons[kind] = L.divIcon({ className: `poi-pin poi-pin-${kind}`, iconSize: [PIN, PIN], iconAnchor: [PIN / 2, PIN / 2], html: '' });
  return icons[kind];
}
const meIcon = () => L.divIcon({ className: 'poi-me', iconSize: [18, 18], iconAnchor: [9, 9], html: '' });

/**
 * A map in `container`.
 *   basemapUrl    absolute URL of the .pmtiles archive
 *   maxDataZoom   the archive's deepest zoom (overzoomed beyond)
 *   flavor        'light' | 'dark' | 'white' | 'black' | 'grayscale' (mapdata.mapFlavor)
 *   lang          label language ('de' → name:de, else name)
 *   bounds        [west, south, east, north] the archive covers — the map stays inside
 *   view          {lon, lat, zoom} to start at (else the whole box)
 *   reducedMotion no fly animations
 *   onMove({zoom, pinsShown, inView})  after every move; onPoiTap(feature) on a pin
 */
export function createMap({ container, basemapUrl, maxDataZoom, flavor, lang, bounds, view, reducedMotion, onMove, onPoiTap }) {
  const box = L.latLngBounds([bounds[1], bounds[0]], [bounds[3], bounds[2]]);
  const map = L.map(container, {
    zoomControl: false,
    attributionControl: false,
    minZoom: 7,
    maxZoom: 18,
    maxBounds: box.pad(0.3),
    maxBoundsViscosity: 0.8,
    zoomSnap: 0.5,
    fadeAnimation: !reducedMotion,
    zoomAnimation: !reducedMotion,
    markerZoomAnimation: !reducedMotion,
  });

  let base = null;
  function setFlavor(f) {
    if (base) {
      base.remove();
      base = null;
    }
    base = leafletLayer({
      url: basemapUrl,
      flavor: f,
      lang,
      maxDataZoom,
      attribution: '',
      noWrap: true,
      bounds: box.pad(0.3),
      keepBuffer: 1,
      updateWhenZooming: false,
      updateWhenIdle: true,
    });
    base.addTo(map);
  }
  setFlavor(flavor);

  const pins = L.layerGroup().addTo(map);
  let all = [];
  let me = null;

  /** The pins of the visible box, from MARKER_MIN_ZOOM on; below it none. */
  function render() {
    const zoom = map.getZoom();
    pins.clearLayers();
    if (zoom < MARKER_MIN_ZOOM) {
      if (onMove) onMove({ zoom, pinsShown: false, inView: 0 });
      return;
    }
    const b = map.getBounds().pad(0.15);
    let n = 0;
    for (const f of all) {
      const c = f.geometry && f.geometry.coordinates;
      if (!c) continue;
      const ll = L.latLng(c[1], c[0]);
      if (!b.contains(ll)) continue;
      const m = L.marker(ll, { icon: pinIcon(pinKind(f.properties)), keyboard: false, riseOnHover: false });
      m.on('click', () => {
        if (onPoiTap) onPoiTap(f);
      });
      pins.addLayer(m);
      n++;
    }
    if (onMove) onMove({ zoom, pinsShown: true, inView: n });
  }
  map.on('moveend', render);

  if (view && Number.isFinite(view.lon) && Number.isFinite(view.lat) && Number.isFinite(view.zoom)) {
    map.setView([view.lat, view.lon], view.zoom, { animate: false });
  } else {
    map.fitBounds(box, { animate: false });
  }
  render();

  return {
    setPois(features) {
      all = features || [];
      render();
    },
    setFlavor,
    setMe(lon, lat) {
      if (me) me.setLatLng([lat, lon]);
      else me = L.marker([lat, lon], { icon: meIcon(), keyboard: false, interactive: false, zIndexOffset: 1000 }).addTo(map);
    },
    /** Centre on a point, zooming in to `zoom` at least (never out). */
    flyTo(lon, lat, zoom = 16) {
      const z = Math.max(map.getZoom(), zoom);
      if (reducedMotion) map.setView([lat, lon], z, { animate: false });
      else map.flyTo([lat, lon], z, { duration: 0.6 });
    },
    getView() {
      const c = map.getCenter();
      return { lon: c.lng, lat: c.lat, zoom: map.getZoom() };
    },
    invalidate() {
      map.invalidateSize();
    },
    destroy() {
      map.off('moveend', render);
      map.remove();
    },
  };
}
