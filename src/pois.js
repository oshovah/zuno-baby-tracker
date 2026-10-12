// The places file of the map (public/map/pois.json, cut at build time by
// scripts/map-data.mjs): fetched once per app session and shared by the map
// view and the operator's list of reported places (its «nearest known
// place» line). The service worker keeps the file, so it loads offline too.

export function loadJson(url) {
  return fetch(url).then((res) => {
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  });
}

let poisPromise = null; // the places file, once per app session

/** The FeatureCollection of public/map/pois.json; a failure is retried on the next call. */
export function loadPois() {
  if (!poisPromise) {
    poisPromise = loadJson('map/pois.json')
      .then((fc) => {
        if (!fc || !Array.isArray(fc.features)) throw new Error('not a places file');
        return fc;
      })
      .catch((err) => {
        poisPromise = null; // try again on the next visit
        throw err;
      });
  }
  return poisPromise;
}
