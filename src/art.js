// Private artwork: an installation may show ONE family its own pictures
// instead of the public icon set (api/lib/art.php). The pictures never sit in
// the served tree — a member's phone gets them from GET api/art/<name>
// behind its session cookie; everybody else gets a 404 and keeps the icons
// of public/img/.
//
// How a phone learns about it: every sync page of a member carries `art`, a
// short version string (store.artVersion). The shell hands it to syncArt():
//   undefined  no sync has answered yet       -> leave things as they are
//   null       none for this family           -> drop a kept copy
//   string     same as the kept copy          -> nothing to fetch
//              another one                    -> fetch, keep, apply
// The copy (two data: URLs, ~30 KB) lives in localStorage so the next start
// shows it at once and offline. The favicon and the touch icon must BE data:
// URLs: browsers fetch icon links without cookies, the route would answer
// 404 (the CSP allows `img-src data:`). A logout or a 401 drops the copy —
// on a login screen nobody is a member.
//
// The INSTALL icon needs a real URL that works without the session: Android
// builds the installed app from the web manifest and has the icon downloaded
// by URL, iOS reads the touch icon at «Zum Home-Bildschirm». Members get the
// installation's capability key with the version (store.artKey); with it the
// manifest link and the touch icon point at api/art/k/<key>/… instead
// (api/lib/art.php). What this still cannot reach: an icon already on an iOS
// home screen (never refreshed — remove and add again); an installed Android
// app follows the manifest by itself after some days.

const ART_KEY = 'bt.art';
const MAX_PICTURE_BYTES = 256 * 1024; // what localStorage can take without crowding out the snapshot

/** [name of the kept data URL, the <link> it replaces, the file behind the session]. */
const LINKS = [
  ['icon', 'link[rel="icon"]', 'api/art/favicon.png'],
  ['touch', 'link[rel="apple-touch-icon"]', 'api/art/apple-touch-icon.png'],
];

const PUBLIC_BADGE = 'img/zuno.png';
const PRIVATE_BADGE = 'api/art/zuno.png';

let failedVersion = null; // a version that would not load: not tried again until the page reloads
let inFlight = null;

/** What syncArt does for the kept copy's version and the server's (pure; see the table above). */
export function artStep(keptVersion, serverVersion) {
  if (serverVersion === undefined) return 'wait';
  if (serverVersion === null) return keptVersion ? 'drop' : 'none';
  return keptVersion === serverVersion ? 'keep' : 'fetch';
}

const KEY_RE = /^[0-9a-f]{32}$/;
const keyUrl = (k, name) => `api/art/k/${k}/${name}`;

/** The kept copy {v, icon?, touch?, k?, m?} or null — malformed or foreign values read as none.
 *  k = the capability key, m = the keyed manifest exists (the folder holds install icons). */
export function readKept(storage) {
  try {
    const kept = JSON.parse(storage.getItem(ART_KEY) || 'null');
    if (!kept || typeof kept !== 'object' || typeof kept.v !== 'string' || kept.v === '') return null;
    const out = { v: kept.v };
    for (const [key] of LINKS) {
      if (typeof kept[key] === 'string' && kept[key].startsWith('data:image/png;base64,')) out[key] = kept[key];
    }
    if (typeof kept.k === 'string' && KEY_RE.test(kept.k)) {
      out.k = kept.k;
      if (kept.m === true) out.m = true;
    }
    return out;
  } catch {
    return null;
  }
}

function storageOrNull() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

/** What each link points at for a kept copy (pure): the data: URLs, and with
 *  a key the touch icon and the manifest as real URLs — null = the public file. */
export function linkTargets(kept) {
  const k = kept && kept.k ? kept.k : null;
  return {
    icon: (kept && kept.icon) || null,
    touch: kept && kept.touch ? (k ? keyUrl(k, 'apple-touch-icon.png') : kept.touch) : null,
    manifest: k && kept.m ? keyUrl(k, 'manifest.webmanifest') : null,
  };
}

const SELECTORS = { icon: LINKS[0][1], touch: LINKS[1][1], manifest: 'link[rel="manifest"]' };

/** Point the links at the kept pictures, or back at the public files (kept = null). */
function applyLinks(kept) {
  if (typeof document === 'undefined') return;
  const targets = linkTargets(kept);
  for (const [name, selector] of Object.entries(SELECTORS)) {
    const link = document.querySelector(selector);
    if (!link) continue;
    if (link.dataset.publicHref === undefined) link.dataset.publicHref = link.getAttribute('href') || '';
    const href = targets[name] || link.dataset.publicHref;
    if (link.getAttribute('href') !== href) link.setAttribute('href', href);
  }
}

/** At start, before any request: a kept copy shows at once. */
export function applyKeptArt() {
  const storage = storageOrNull();
  const kept = storage ? readKept(storage) : null;
  if (kept) applyLinks(kept);
}

/** Forget the copy and show the public icons (logout, 401, the server says "none"). */
export function clearArt() {
  const storage = storageOrNull();
  try {
    if (storage) storage.removeItem(ART_KEY);
  } catch {
    /* ignore */
  }
  applyLinks(null);
}

function toDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function fetchPicture(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) return null; // a picture the folder does not hold: its public icon stays
  const blob = await res.blob();
  if (blob.size === 0 || blob.size > MAX_PICTURE_BYTES) return null;
  const dataUrl = await toDataUrl(new Blob([blob], { type: 'image/png' }));
  return dataUrl.startsWith('data:image/png;base64,') ? dataUrl : null;
}

/**
 * Bring the kept copy in line with the server's version (store.artVersion).
 * Cheap and idempotent — the shell calls it on every store event.
 */
export function syncArt(serverVersion, serverKey = null) {
  const storage = storageOrNull();
  if (!storage) return;
  const kept = readKept(storage);
  let step = artStep(kept ? kept.v : null, serverVersion);
  // The same pictures under another key (or a first key): fetch again.
  if (step === 'keep' && (kept.k || null) !== (serverKey || null)) step = 'fetch';
  if (step === 'drop') clearArt();
  const attempt = `${serverVersion}|${serverKey || ''}`;
  if (step !== 'fetch' || inFlight || failedVersion === attempt) return;
  inFlight = (async () => {
    try {
      const next = { v: serverVersion };
      for (const [key, , url] of LINKS) {
        const dataUrl = await fetchPicture(url);
        if (dataUrl) next[key] = dataUrl;
      }
      if (!next.icon && !next.touch) throw new Error('no picture');
      if (serverKey && KEY_RE.test(serverKey)) {
        next.k = serverKey;
        // Only a manifest that answers replaces the public one — a folder
        // without install icons has none, and the app must stay installable.
        const res = await fetch(keyUrl(serverKey, 'manifest.webmanifest'), { cache: 'no-store' });
        if (res.ok) next.m = true;
      }
      storage.setItem(ART_KEY, JSON.stringify(next));
      applyLinks(next);
    } catch {
      failedVersion = attempt; // offline, quota, an empty folder: the public icons stay
    } finally {
      inFlight = null;
    }
  })();
}

/** The badge of the login card: the family's picture on a member's phone, else the public one. */
export function badgeSrc() {
  const storage = storageOrNull();
  return storage && readKept(storage) ? PRIVATE_BADGE : PUBLIC_BADGE;
}

/** A private badge that will not load (session gone, no such file) falls back to the public one. */
export function bindBadgeFallback(root) {
  root.querySelectorAll('.auth-logo img').forEach((img) => {
    img.addEventListener('error', () => {
      if (img.getAttribute('src') !== PUBLIC_BADGE) img.setAttribute('src', PUBLIC_BADGE);
    });
  });
}
