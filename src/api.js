// Tiny JSON fetch wrapper. Resolves with parsed JSON, throws Error(message)
// (with .status set, and .code when the server named one) on any failure —
// callers surface those via toast(). The server's error envelope is
// {error, code?, params?} (api/lib/http.php): when the app has a translation
// of the code (src/i18n/locales/<lang>/api.js) the message is that, in the
// app's language; otherwise the server's German text as it is.
// A 401 additionally notifies authEvents.onUnauthorized so the shell can swap
// to the login screen no matter which view was active (the shell ignores it
// while the login screen itself is showing, so a wrong password just shows
// its error inline).

import { t, hasKey } from './i18n/index.js';

export const authEvents = { onUnauthorized: null };

const TIMEOUT_MS = 15000;

/** options: fetch init plus `timeoutMs` (default 15 s; sync pages pass 60 s). */
async function request(path, { timeoutMs = TIMEOUT_MS, ...options } = {}) {
  // Abort hung requests: a stalled fetch would otherwise pin the store's
  // shared in-flight promise and freeze every future refresh (radio handoffs,
  // iOS freezing sockets while the PWA is backgrounded).
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(path, { ...options, signal: ctl.signal });
  } catch {
    // Distinguish "your phone is offline" from "the server is unreachable" —
    // navigator.onLine === false is reliable in exactly that direction.
    throw new Error(t(navigator.onLine === false ? 'api.network.offline' : 'api.network.unreachable'));
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON body (proxy error page etc.) — fall through to status handling.
  }
  if (!res.ok) {
    if (res.status === 401 && typeof authEvents.onUnauthorized === 'function') {
      authEvents.onUnauthorized();
    }
    const code = data && typeof data.code === 'string' ? data.code : null;
    const params = data && data.params && typeof data.params === 'object' ? data.params : undefined;
    let message = data && typeof data.error === 'string' ? data.error : '';
    if (code && hasKey(`api.${code}`)) message = t(`api.${code}`, params);
    const err = new Error(message || t('api.request.failed', { status: res.status }));
    err.status = res.status;
    if (code) err.code = code;
    throw err;
  }
  return data;
}

const jsonBody = (body) => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  get: (path, opts) => request(path, opts),
  post: (path, body) => request(path, { method: 'POST', ...jsonBody(body) }),
  patch: (path, body) => request(path, { method: 'PATCH', ...jsonBody(body) }),
  /** DELETE, with a JSON body only when one is given (e.g. {ifSeq} — the
   *  server then requires the JSON content type, exactly like POST/PATCH). */
  del: (path, body) => request(path, { method: 'DELETE', ...(body === undefined ? {} : jsonBody(body)) }),
};
