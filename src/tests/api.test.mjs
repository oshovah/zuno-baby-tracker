// The JSON fetch wrapper (src/api.js) over a stubbed fetch: the API's
// envelope becomes an Error with status and code; anything that is not the
// API's JSON — the hoster's challenge page, a proxy's error page — is an
// Error WITHOUT a status, whatever the page's status says, and never logs
// anybody out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, authEvents } from '../api.js';

const realFetch = globalThis.fetch;
const answer = (status, body, type = 'application/json; charset=utf-8') => async () =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': type } });

async function rejects(promise) {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

test('api: JSON answers come back parsed; the error envelope becomes status + code + the German text', async (t) => {
  t.after(() => (globalThis.fetch = realFetch));
  globalThis.fetch = answer(200, { authenticated: false, user: null });
  assert.deepEqual(await api.get('api/me'), { authenticated: false, user: null });

  globalThis.fetch = answer(409, { error: 'Eintrag existiert bereits', code: 'entries.exists' });
  const e = await rejects(api.post('api/entries', { eid: 'x', blob: 'y' }));
  assert.equal(e.status, 409);
  assert.equal(e.code, 'entries.exists');
  assert.equal(e.message, 'Eintrag existiert bereits');

  globalThis.fetch = answer(429, { error: 'Zu viele Änderungen', code: 'request.writeBudget', params: { minutes: 15 } });
  const r = await rejects(api.post('api/entries', {}));
  assert.equal(r.code, 'request.writeBudget');
  assert.equal(r.message, 'Zu viele Änderungen in kurzer Zeit – bitte später nochmals versuchen', "the locale's text for the code");
});

test('api: a page that is not the API\'s JSON is no answer — no status, no code, no logout', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
    authEvents.onUnauthorized = null;
  });
  let loggedOut = 0;
  authEvents.onUnauthorized = () => (loggedOut += 1);

  // The hoster's «Anfrage wird geprüft» page: 403 + HTML.
  globalThis.fetch = answer(403, '<!doctype html><title>Anfrage wird geprüft</title>', 'text/html; charset=utf-8');
  const challenge = await rejects(api.post('api/entries', { eid: 'x', blob: 'y' }));
  assert.equal(challenge.status, undefined, 'no status: the outbox keeps the write and tries later');
  assert.equal(challenge.code, undefined);
  assert.equal(challenge.message, 'Unerwartete Antwort vom Server (403) – bitte gleich nochmals versuchen');

  // Such a page with a 401 must not throw the user out.
  globalThis.fetch = answer(401, '<html>login wall</html>', 'text/html');
  await rejects(api.get('api/sync?since=0&limit=1'));
  assert.equal(loggedOut, 0);
  // The API's own 401 does.
  globalThis.fetch = answer(401, { error: 'Nicht angemeldet', code: 'auth.notLoggedIn' });
  const real = await rejects(api.get('api/sync?since=0&limit=1'));
  assert.equal(real.status, 401);
  assert.equal(loggedOut, 1);

  // A 200 that is not JSON (a cached shell, a maintenance page) is no answer either — never `null` data.
  globalThis.fetch = answer(200, '<!doctype html>', 'text/html');
  const html = await rejects(api.get('api/me'));
  assert.equal(html.status, undefined);
  globalThis.fetch = answer(200, 'not json at all');
  const broken = await rejects(api.get('api/me'));
  assert.equal(broken.status, undefined);

  // No answer at all.
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  const none = await rejects(api.get('api/me'));
  assert.equal(none.status, undefined);
  assert.equal(none.message, 'Keine Verbindung zum Server');
});
