#!/usr/bin/env node
/**
 * e2e-offline.mjs — the offline outbox in the REAL app: two phones (two
 * browser contexts) on a scratch server, one of them without network.
 *
 *   npm run e2e:offline              run the checks
 *   npm run e2e:offline -- --shots   … and keep screenshots of the key moments in .e2e/
 *
 * What it does:
 *   1. scratch DB + php -S + Vite (scripts/lib/headless.mjs), papa registers
 *      the family, mama joins, both log in on their own phone
 *   2. papa goes OFFLINE (Network.emulateNetworkConditions) and taps «Pipi»,
 *      starts a Schlaf, stops a Stillen that mama also stops meanwhile, edits
 *      a Gewicht that mama deletes meanwhile; the chip on «Jetzt» counts, the
 *      Verlauf rows say «wartet auf Netz», the sheet lists them
 *   3. papa's app is reloaded while the API is blocked: everything survives
 *   4. papa is back online: the queue drains by itself — the chip goes, the
 *      conflicts are announced, mama sees every entry exactly once
 *   5. a lost answer (the request lands, the response is dropped) makes one
 *      row, not two; a phone killed mid-request sends once
 *
 * Every check that fails ends the run with exit 1.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { root, sleep, startApi, startVite, startChrome, connect, openPhone } from './lib/headless.mjs';

const argv = process.argv.slice(2);
const SHOTS = argv.includes('--shots');
const shotDir = path.join(root, '.e2e');
const log = (msg) => console.log(`[e2e-offline] ${msg}`);
let checks = 0;
function check(name, ok, detail = '') {
  checks += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) throw new Error(`check failed: ${name}`);
}

const PASSWORD = 'nur fuer den test';
const FAMILY_PASSWORD = 'testfamilie laedt mama ein';

/** Runs in the page (serialised — no closures): create the family (papa). */
async function registerPapa(c) {
  const session = await import('/src/session.js');
  await session.registerCreate({ username: 'papa', password: c.password, displayName: 'Papa', familyName: 'Testfamilie', familyPassword: c.familyPassword });
  const { store } = await import('/src/store.js');
  await store.settings.save({ breastfeeding: true });
  await store.outbox.idle();
  return true;
}

/** Runs in the page: join it (mama). */
async function registerMama(c) {
  const session = await import('/src/session.js');
  await session.registerJoin({ username: 'mama', password: c.password, displayName: 'Mama', familyName: 'Testfamilie', familyPassword: c.familyPassword });
  return true;
}

/** Runs in the page: what the store holds (arg.refresh: sync + drain the outbox first). */
async function snapshot(arg) {
  const { store } = await import('/src/store.js');
  await store.ready;
  if (arg && arg.refresh) {
    await store.refresh().catch(() => {});
    await store.outbox.idle();
  }
  const s = store.snapshot ? store.snapshot.data : null;
  return {
    outbox: store.outbox.count,
    parked: store.outbox.parked,
    list: store.outbox.list(),
    today: s ? s.today : null,
    open: s ? s.openTimers.map((e) => ({ eid: e.eid, type: e.type, pending: e.pending || null })) : [],
    entries: store.entries
      .range('2000-01-01', new Date().toISOString().slice(0, 10))
      .map((e) => ({ eid: e.eid, type: e.type, endedAt: e.endedAt, details: e.details, pending: e.pending || null, seq: e.seq, deletedAt: e.deletedAt })),
  };
}

/** Runs in the page: mama's side of the conflicts. */
async function mamaWrites(arg) {
  const { store } = await import('/src/store.js');
  await store.ready;
  await store.refresh();
  const feed = store.snapshot.data.openTimers.find((e) => e.type === 'breastfeed');
  await store.entries.update(feed.eid, { endedAt: new Date(Date.now() - 60000).toISOString().replace(/\.\d{3}Z$/, 'Z') });
  await store.entries.remove(arg.weightEid);
  await store.outbox.idle();
  return { stopped: feed.eid };
}

/** Runs in the page: what papa does on the plane. */
async function papaCreatesBefore() {
  const { store } = await import('/src/store.js');
  await store.ready;
  const feed = await store.entries.create({ type: 'breastfeed', details: { side: 'L' }, startedAt: new Date(Date.now() - 600000).toISOString().replace(/\.\d{3}Z$/, 'Z') });
  const weight = await store.entries.create({ type: 'weight', details: { grams: 3500 }, startedAt: new Date(Date.now() - 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z') });
  await store.outbox.idle();
  return { feedEid: feed.eid, weightEid: weight.eid };
}

async function papaOfflineWrites(arg) {
  const { store } = await import('/src/store.js');
  await store.ready;
  const stop = await store.entries.update(arg.feedEid, { endedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), ifOpen: true }, { guard: 'open' });
  const edit = await store.entries.update(arg.weightEid, { details: { grams: 3550 } });
  return { stop: stop.pending, edit: edit.pending };
}

const toasts = () => `[...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent)`;

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-e2e-'));
  if (SHOTS) fs.mkdirSync(shotDir, { recursive: true });
  const api = await startApi(path.join(tmp, 'e2e.db'));
  const vite = await startVite(api.port);
  const chrome = await startChrome(path.join(tmp, 'chrome'));
  const cdp = await connect(chrome.wsUrl);
  const shot = async (page, name) => {
    if (SHOTS) await page.screenshot(path.join(shotDir, `${name}.png`));
  };
  try {
    const boot = `try { localStorage.setItem('bt.lang', 'de'); localStorage.setItem('bt.whatsNewSeen', '9999-12-31'); } catch {}`;
    const papa = await openPhone(cdp, { bootScript: boot });
    const mama = await openPhone(cdp, { bootScript: boot });

    // 1. two accounts, two phones
    await papa.open(vite.url, '.auth-form', 'login');
    const creds = { password: PASSWORD, familyPassword: FAMILY_PASSWORD };
    await papa.call(registerPapa, creds);
    await mama.open(vite.url, '.auth-form', 'login');
    await mama.call(registerMama, creds);
    await papa.open(vite.url + '#/', '.quick-grid', 'papa home');
    await mama.open(vite.url + '#/', '.quick-grid', 'mama home');
    const before = await papa.call(papaCreatesBefore);
    log('both phones are in; papa has a running Stillen and a Gewicht');

    // 2. papa goes offline
    await papa.offline(true);
    await papa.click('[data-diaper="pee"]');
    await sleep(400);
    await papa.click('[data-sleep]');
    await sleep(400);
    const off = await papa.call(papaOfflineWrites, before);
    check('offline stop and edit resolve as waiting', off.stop === 'waiting' && off.edit === 'waiting', JSON.stringify(off));
    const toastsOff = await papa.evaluate(toasts());
    check('the save toast says it waits for the network', toastsOff.some((x) => x.includes('wartet auf Netz')), toastsOff.join(' | '));
    let s = await papa.call(snapshot);
    check('four entries wait in the outbox', s.outbox === 4, `count=${s.outbox}`);
    check('the home state has the diaper and the sleep', s.today.diapers === 1 && s.open.some((e) => e.type === 'sleep' && e.pending === 'waiting'), JSON.stringify(s.today));
    await sleep(1200); // the 1 s tick paints the chip
    const chip = await papa.text('[data-outbox-chip]');
    check('the chip on «Jetzt» counts', /^4 ungesendet$/.test(chip.trim()), chip);
    await shot(papa, '1-offline-home');
    // Offline there is no reload (the service worker only runs in production): switch views by hash, as a tap does.
    await papa.evaluate(`location.hash = '#/verlauf'`);
    await papa.waitFor('.entry-row', 'verlauf');
    const marks = await papa.evaluate(`[...document.querySelectorAll('.e-by .pending')].map((n) => n.textContent)`);
    check('Verlauf rows say «wartet auf Netz»', marks.length >= 3 && marks.every((m) => m === 'wartet auf Netz'), marks.join(', '));
    await shot(papa, '2-offline-verlauf');
    await papa.evaluate(`location.hash = '#/'`);
    await papa.waitFor('.quick-grid', 'home');
    await sleep(1200);
    await papa.click('[data-outbox-chip]');
    await papa.waitFor('.outbox-list .outbox-row', 'the sheet');
    const rows = await papa.evaluate(`[...document.querySelectorAll('.outbox-row .e-summary')].map((n) => n.textContent)`);
    check('the sheet lists them', rows.length === 4, rows.join(' | '));
    await shot(papa, '3-offline-sheet');

    // mama meanwhile: stops the same Stillen, deletes the Gewicht
    const m = await mama.call(mamaWrites, before);
    log(`mama stopped ${m.stopped.slice(0, 6)}… and deleted the Gewicht`);

    // 3. papa's app reloaded while the API is unreachable: everything survives
    await papa.send('Network.setBlockedURLs', { urls: ['*/api/*'] }); // BEFORE the radio comes back: its `online` event kicks the flusher
    await papa.offline(false);
    await papa.open(vite.url + '#/', '.quick-grid', 'home after reload');
    s = await papa.call(snapshot);
    check('after a reload with the API blocked the four still wait', s.outbox === 4, `count=${s.outbox}`);
    check('… decrypted from the outbox records', s.entries.some((e) => e.type === 'diaper' && e.pending === 'waiting'));
    await papa.send('Network.setBlockedURLs', { urls: [] });

    // 4. back online: the queue drains by itself
    await papa.evaluate(`window.dispatchEvent(new Event('online'))`);
    s = await papa.call(snapshot, { refresh: true });
    check('the outbox is empty', s.outbox === 0 && s.parked === 0, JSON.stringify({ count: s.outbox, parked: s.parked }));
    await sleep(1200);
    check('the chip is gone', await papa.evaluate(`document.querySelector('[data-outbox-chip]').hidden`));
    const toastsOn = await papa.evaluate(toasts());
    check('the conflicts are announced', toastsOn.some((x) => x.startsWith('Nicht übernommen: Stillen')) && toastsOn.some((x) => x.startsWith('Nicht übernommen: Gewicht')), toastsOn.join(' | '));
    check('the drained queue is announced', toastsOn.some((x) => /^\d+ gesendet$/.test(x)), toastsOn.join(' | '));
    const feedNow = s.entries.find((e) => e.eid === before.feedEid);
    check("mama's end of the Stillen stands", feedNow && feedNow.endedAt && feedNow.pending === null && feedNow.seq < 2 ** 52, JSON.stringify(feedNow));
    check('the deleted Gewicht stays deleted', !s.entries.some((e) => e.eid === before.weightEid));
    await shot(papa, '4-online-home');
    const ms = await mama.call(snapshot, { refresh: true });
    const diapers = ms.entries.filter((e) => e.type === 'diaper');
    const sleeps = ms.entries.filter((e) => e.type === 'sleep');
    check('mama sees the diaper once and the sleep once', diapers.length === 1 && sleeps.length === 1 && sleeps[0].endedAt === null, JSON.stringify({ diapers: diapers.length, sleeps: sleeps.length }));

    // 5. a lost answer: the request lands, the response is dropped
    await papa.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/entries', requestStage: 'Response' }] });
    let dropped = 0;
    const off2 = cdp.on('Fetch.requestPaused', (params, sid) => {
      if (sid !== papa.sessionId) return;
      dropped += 1;
      cdp.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'ConnectionReset' }, sid).catch(() => {});
    });
    const lost = await papa.evaluate(`import('/src/store.js').then(({ store }) => store.entries.create({ type: 'diaper', details: { kind: 'poop' } })).then((e) => ({ eid: e.eid, pending: e.pending || null }))`);
    await papa.send('Fetch.disable');
    off2();
    check('the answer was dropped', dropped === 1 && lost.pending === 'waiting', JSON.stringify({ dropped, lost }));
    s = await papa.call(snapshot, { refresh: true });
    const poops = s.entries.filter((e) => e.type === 'diaper' && e.details.kind === 'poop');
    check('one row, confirmed, no duplicate', poops.length === 1 && poops[0].pending === null && poops[0].seq < 2 ** 52, JSON.stringify(poops));
    const ms2 = await mama.call(snapshot, { refresh: true });
    check('mama sees it once', ms2.entries.filter((e) => e.type === 'diaper' && e.details.kind === 'poop').length === 1);

    // 6. killed mid-request: the request is held, the page closed, a new one sends once
    await papa.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/entries', requestStage: 'Request' }] });
    const held = new Promise((resolve) => {
      const off3 = cdp.on('Fetch.requestPaused', (params, sid) => {
        if (sid !== papa.sessionId) return;
        off3();
        resolve(params.requestId);
      });
    });
    papa.evaluate(`import('/src/store.js').then(({ store }) => store.entries.create({ type: 'diaper', details: { kind: 'both' } })).catch(() => null)`).catch(() => {});
    await held;
    await papa.send('Fetch.disable').catch(() => {});
    await papa.open(vite.url + '#/', '.quick-grid', 'home after the kill'); // the navigation abandons the held request
    s = await papa.call(snapshot, { refresh: true });
    const boths = s.entries.filter((e) => e.type === 'diaper' && e.details.kind === 'both');
    check('the killed write is sent once after the reload', boths.length === 1 && boths[0].pending === null, JSON.stringify(boths));
    const ms3 = await mama.call(snapshot, { refresh: true });
    check('mama sees it once', ms3.entries.filter((e) => e.type === 'diaper' && e.details.kind === 'both').length === 1);

    await papa.close();
    await mama.close();
    log(`done — ${checks} checks passed${SHOTS ? `, pictures in ${path.relative(root, shotDir)}` : ''}`);
  } finally {
    cdp.close();
    chrome.stop();
    await vite.stop();
    api.stop();
    await sleep(300);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (typeof WebSocket !== 'function') {
  console.error('[e2e-offline] needs Node ≥ 22 (global WebSocket)');
  process.exit(1);
}
main().then(
  () => process.exit(0),
  (err) => {
    console.error(`[e2e-offline] ${err.stack || err.message}`);
    process.exit(1);
  }
);
