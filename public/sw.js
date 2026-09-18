/**
 * Service worker: the app SHELL opens instantly on any connection; DATA is
 * never cached here (the app keeps its own last-state snapshot in
 * localStorage — see src/store.js).
 *
 * Strategy:
 *   - /api/*            -> network only, never cached
 *   - everything else   -> install-time precache of the shell + stale-while-
 *                          revalidate. Precaching means the FIRST offline
 *                          launch after an install (or after iOS evicts Cache
 *                          Storage) still opens — the 3am guarantee.
 *
 * The two placeholder lines below are rewritten by scripts/package.mjs with
 * the build's hashed asset URLs and a cache name derived from the build, so
 * every deploy activates into its own cache and the activate handler drops the
 * previous build's files. In dev the file is served as-is (and never
 * registered — see src/main.js).
 *
 * This file must be served with Cache-Control: no-cache (the packaged
 * .htaccess handles that) so browsers pick up new versions promptly.
 */

const CACHE = 'baby-tracker-shell-dev'; /* __CACHE_NAME__ */
const PRECACHE = ['./', './manifest.webmanifest']; /* __PRECACHE__ */

// Last line of defense: shown when the cache is empty AND the network is down
// (e.g. right after storage eviction). Lives inline so it survives anything.
const OFFLINE_HTML = `<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Baby Tracker</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #171310; color: #f2e9df; font-family: -apple-system, system-ui, sans-serif; text-align: center; }
  main { padding: 32px; max-width: 26em; }
  p { color: #b3a597; line-height: 1.5; }
  button { margin-top: 20px; padding: 14px 28px; font-size: 17px; font-weight: 600; border: 0;
    border-radius: 14px; background: #eba76f; color: #2b1c0e; }
</style></head><body><main>
<h1>Keine Verbindung</h1>
<p>Baby Tracker braucht kurz Internet zum Starten. Danach funktioniert das Öffnen auch offline.</p>
<p lang="en"><b>No connection.</b> Baby Tracker needs a moment online to start. After that it opens offline too.</p>
<button onclick="location.reload()">Nochmals versuchen · Try again</button>
</main></body></html>`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .catch(() => {
        /* installing while offline: lazy caching still fills the gap later */
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from older builds of this worker.
      for (const name of await caches.keys()) {
        if (name !== CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.includes('/api/') || url.pathname.endsWith('/api')) return;
  event.respondWith(staleWhileRevalidate(request));
});

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  // Navigations may carry query strings (?source=pwa etc.) — they are all the
  // same single-page shell.
  const cached = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });

  const refresh = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  if (cached) {
    refresh.catch(() => {});
    return cached;
  }
  const fresh = await refresh;
  if (fresh) return fresh;
  if (request.mode === 'navigate') {
    // Offline navigation: the precached shell, or the inline offline page.
    const shell = await cache.match('./', { ignoreSearch: true });
    if (shell) return shell;
    return new Response(OFFLINE_HTML, {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  return new Response('Offline', { status: 503, statusText: 'Offline' });
}
