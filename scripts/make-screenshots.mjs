#!/usr/bin/env node
/**
 * make-screenshots.mjs — re-shoot the screenshot slider of the login page
 * (src/views/login.js shotsHtml; ids, order and languages in src/shots.js):
 * the REAL app with invented data, no mock-ups. Run it again whenever a
 * screen in the slider changes visibly.
 *
 *   npm run screenshots                  every language → src/shots/<lang>-<id>.webp
 *   npm run screenshots -- --out <dir>   somewhere else (a look before replacing them)
 *
 * What it does, per language:
 *   1. a scratch SQLite file + `php -S` on a free port (BABY_DB_PATH), a Vite
 *      dev server in front of it — nothing touches data/ or a running `npm run dev`
 *   2. headless Chrome (DevTools protocol over Node's own WebSocket — no
 *      puppeteer), a 390 × 844 phone at 2x, dark scheme, Europe/Zurich
 *   3. the page registers «papa», who creates the family, then «mama», who
 *      joins it — through src/session.js, like the forms do — and both log a
 *      week of a newborn through store.entries.create: every row is validated
 *      and encrypted exactly as in the app
 *   4. the screens of SHOTS are opened and captured as WebP
 *
 * The clock: the page's Date is shifted so that "now" is today 15:11 in
 * Zurich, whenever the script runs — the day is always two thirds full. The
 * store corrects its clock against `serverNow` of every sync page, so the
 * shim rewrites that field too (in the page only; the API is untouched).
 *
 * Needs: php on the PATH, Google Chrome (or CHROME_PATH=/path/to/chrome),
 * Node ≥ 22 (global WebSocket). The data is invented: Mama / Papa /
 * Testfamilie, a baby born eight days ago.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { zurichDateOf, zurichTimeUtc, shiftZurichDate } from '../src/tz.js';
import { SHOTS, SHOT_LANGS, SHOT_SIZE } from '../src/shots.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const outArg = argv.indexOf('--out');
const outDir = outArg >= 0 && argv[outArg + 1] ? path.resolve(argv[outArg + 1]) : path.join(root, 'src', 'shots');

const SCALE = 2;
const VIEWPORT = { width: SHOT_SIZE.width / SCALE, height: SHOT_SIZE.height / SCALE, deviceScaleFactor: SCALE };
const WEBP_QUALITY = 82;
const NOW_WALL = '15:11'; // the app's "now" (Zurich) on the day the script runs: two hours after the last meal, the next one not begun
const BIRTH_DAYS_AGO = 8; // Lebenstag 9: the Schoppen form still shows the rule-of-thumb target
const HISTORY_DAYS = 6; // full days before today — stays under the API's 300 writes / 15 min

const WORDS = {
  de: { mama: 'Mama', papa: 'Papa', vitamin: 'Vitamin D', vitaminNote: '1 Tropfen', iron: 'Eisentablette' },
  en: { mama: 'Mom', papa: 'Dad', vitamin: 'Vitamin D', vitaminNote: '1 drop', iron: 'Iron tablet' },
};

/**
 * How each screen of the slider (SHOTS in src/shots.js — ids, order and
 * languages live there) is brought up: `ready` = the view is there, `click` =
 * taps in order, `then` = what the taps bring up. Taken in THIS order:
 * `timer` starts a Stillen timer that stays open, so «Verlauf» comes before
 * it (no open row) and the Schoppen form after it — its meal then has a
 * Stillen side, and the form shows the top-up («Gestillt – … noch 20 ml»).
 */
const RECIPES = {
  home: { hash: '#/', ready: '.quick-grid' },
  history: { hash: '#/verlauf', ready: '[data-view="charts"]' },
  charts: { hash: '#/verlauf', ready: '[data-view="charts"]', click: ['[data-view="charts"]', '[data-range="7"]'], then: '.chart-card svg' },
  timer: { hash: '#/', ready: '.quick-grid', timer: true, then: '[data-timer]' },
  bottle: { hash: '#/', ready: '[data-timer]', click: ['[data-bottle]'], then: '.sheet-body form, .sheet-body input' },
};

const log = (msg) => console.log(`[screenshots] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg) {
  console.error(`[screenshots] ${msg}`);
  process.exit(1);
}

// --- the invented week ---------------------------------------------------------

/** Small seeded generator: the same week on every run. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const MEAL_TIMES = ['01:25', '04:20', '07:05', '09:55', '12:45', '15:35', '18:25', '21:15'];
// No two days alike: a night the baby slept through (7 meals), an evening of
// cluster feeding (9) — by day, oldest first.
const DAY_VARIANTS = [{}, { skip: '04:20' }, { extra: '19:50' }, {}, { skip: '04:20' }, { extra: '16:55' }, {}];
const DIAPERS = ['pee', 'both', 'pee', 'poop', 'pee', 'both', 'pee', 'pee'];
const WEIGHTS = { [-8]: 3420, [-6]: 3190, [-4]: 3240, [-2]: 3330, 0: 3410 }; // day offset → grams
const TEMPS = { [-5]: 37.1, [-3]: 36.9, [-1]: 37.2 };

const addMin = (iso, min) => new Date(Date.parse(iso) + min * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Entries as {by: 'mama'|'papa', type, startedAt, endedAt?, details}, all
 * closed and not after `nowIso`. Mama nurses; Papa gives the night and the
 * evening bottle, changes most diapers and puts the baby down every other
 * time — so «Verlauf» shows both names on one screen.
 */
function inventWeek(today, nowIso) {
  const rand = rng(20260918);
  const between = (a, b) => a + Math.floor(rand() * (b - a + 1));
  const out = [];
  const add = (by, type, startedAt, endedAt, details) => {
    if (startedAt > nowIso || (endedAt && endedAt > nowIso)) return false;
    out.push({ by, type, startedAt, ...(endedAt ? { endedAt } : {}), details });
    return true;
  };

  const meals = []; // {start, end} in time order, for the naps in between
  let side = 'L';
  let diaper = 0;
  for (let d = -HISTORY_DAYS; d <= 0; d++) {
    const date = shiftZurichDate(today, d);
    const variant = DAY_VARIANTS[(d + HISTORY_DAYS) % DAY_VARIANTS.length];
    const times = MEAL_TIMES.filter((t) => t !== variant.skip).concat(variant.extra || []).sort();
    times.forEach((time) => {
      const i = MEAL_TIMES.indexOf(time); // -1 = the extra, a short one-sided feed
      const start = addMin(zurichTimeUtc(date, time), between(-18, 18));
      if (start > nowIso) return;
      let end;
      if (i === 0 || i === 7) {
        // Papa's bottle: breast milk from the fridge, topped up with formula
        add('papa', 'bottle', start, null, { colostrum_ml: between(7, 10) * 5, amount_ml: between(2, 5) * 5 });
        end = addMin(start, 15);
      } else {
        const first = i < 0 ? between(6, 9) : between(9, 16);
        add('mama', 'breastfeed', start, addMin(start, first), { side });
        end = addMin(start, first);
        side = side === 'L' ? 'R' : 'L';
        // Mostly both sides; either way the next meal leads with the side
        // this one ended on (or never reached).
        if (i >= 0 && rand() < 0.75) {
          const again = addMin(end, between(1, 3));
          const second = between(6, 12);
          if (add('mama', 'breastfeed', again, addMin(again, second), { side })) end = addMin(again, second);
        }
        if (i === 5 && rand() < 0.6) {
          const top = addMin(end, between(3, 7));
          if (add('papa', 'bottle', top, null, { amount_ml: between(4, 7) * 5 })) end = addMin(top, 8);
        }
      }
      meals.push({ start, end });
      // a diaper after most meals
      if (rand() < 0.85) {
        const kind = DIAPERS[diaper++ % DIAPERS.length];
        add(diaper % 3 ? 'papa' : 'mama', 'diaper', addMin(end, between(2, 9)), null, { kind });
      }
    });
    if (WEIGHTS[d]) add('papa', 'weight', zurichTimeUtc(date, '10:15'), null, { grams: WEIGHTS[d] });
    if (TEMPS[d]) add('mama', 'temperature', zurichTimeUtc(date, '19:40'), null, { celsius: TEMPS[d] });
  }
  add('papa', 'weight', zurichTimeUtc(shiftZurichDate(today, -8), '14:30'), null, { grams: WEIGHTS[-8] });

  // naps between the meals (a newborn sleeps most of the gaps)
  for (let i = 0; i < meals.length - 1; i++) {
    const from = addMin(meals[i].end, between(14, 30));
    const to = addMin(meals[i + 1].start, -between(4, 12));
    if (Date.parse(to) - Date.parse(from) > 40 * 60000) add(i % 2 ? 'papa' : 'mama', 'sleep', from, to, {});
  }
  // the nap before "now": awake for a good half hour
  const last = meals[meals.length - 1];
  add('papa', 'sleep', addMin(last.end, 22), addMin(nowIso, -37), {});
  return out.sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
}

// --- processes -------------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startApi(dbPath) {
  const port = await freePort();
  const proc = spawn('php', ['-S', `127.0.0.1:${port}`, path.join('scripts', 'dev-router.php')], {
    cwd: root,
    env: { ...process.env, BABY_DB_PATH: dbPath, BABY_BCRYPT_COST: '4' },
    stdio: 'ignore',
  });
  proc.on('error', () => fail('could not start php — is it on the PATH?'));
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/me`);
      if (res.status < 500) return { port, stop: () => proc.kill() };
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  proc.kill();
  return fail('the PHP API did not come up');
}

async function startVite(apiPort) {
  const server = await createServer({
    root,
    configFile: false, // vite.config.js proxies to the dev API on :8788 — this one goes to the scratch API
    base: './',
    logLevel: 'error',
    // no watcher, no HMR: the pictures this run writes are part of the page's module graph (login.js globs src/shots/)
    server: { host: '127.0.0.1', port: await freePort(), strictPort: true, hmr: false, watch: null, proxy: { '/api': `http://127.0.0.1:${apiPort}` } },
  });
  await server.listen();
  return { url: `http://127.0.0.1:${server.config.server.port}/`, stop: () => server.close() };
}

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || fail('no Chrome found — set CHROME_PATH');
}

function startChrome(profileDir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      chromePath(),
      ['--headless=new', `--user-data-dir=${profileDir}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
        '--disable-extensions', '--hide-scrollbars', '--mute-audio', 'about:blank'],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    let err = '';
    const timer = setTimeout(() => reject(new Error('Chrome did not announce its DevTools port')), 15000);
    proc.stderr.on('data', (chunk) => {
      err += chunk;
      const m = err.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ wsUrl: m[1], stop: () => proc.kill() });
      }
    });
    proc.on('error', reject);
  });
}

/** The DevTools protocol, as much of it as this script needs. */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 0;
    ws.addEventListener('error', () => reject(new Error('DevTools socket failed')));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
    });
    ws.addEventListener('open', () =>
      resolve({
        send(method, params = {}, sessionId) {
          const id = ++nextId;
          ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
          return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej, method }));
        },
        close: () => ws.close(),
      })
    );
  });
}

// --- in the page -------------------------------------------------------------------

/** Before any script of the app: the shifted clock and the device's prefs. */
function bootScript(lang, offsetMs) {
  return `(() => {
    const RealDate = Date;
    const OFFSET = ${offsetMs};
    class ShiftedDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) super(RealDate.now() + OFFSET);
        else super(...args);
      }
      static now() { return RealDate.now() + OFFSET; }
    }
    window.Date = ShiftedDate;
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const res = await realFetch(input, init);
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (!/(^|\\/)api\\/sync/.test(url)) return res;
      try {
        const body = await res.clone().json();
        if (body && typeof body.serverNow === 'string') {
          body.serverNow = new RealDate(RealDate.now() + OFFSET).toISOString().replace(/\\.\\d{3}Z$/, 'Z');
          return new Response(JSON.stringify(body), { status: res.status, statusText: res.statusText, headers: res.headers });
        }
      } catch { /* not JSON: hand it on untouched */ }
      return res;
    };
    try {
      localStorage.setItem('bt.lang', ${JSON.stringify(lang)});
      localStorage.setItem('bt.homeCard', 'both');
      localStorage.setItem('bt.whatsNewSeen', '9999-12-31');
    } catch { /* about:blank */ }
  })();`;
}

/** Runs in the page: both accounts, the settings, the reminders, the week. */
async function seedInPage({ words, entries, birthDate, today, ticks }) {
  const session = await import('/src/session.js');
  const { store } = await import('/src/store.js');
  const PASSWORD = 'nur fuer die bildschirmfotos';
  const FAMILY_PASSWORD = 'testfamilie laedt mama ein';
  const write = async (list) => {
    for (const { by, ...entry } of list) await store.entries.create(entry);
  };

  await session.registerCreate({
    username: 'papa', password: PASSWORD, displayName: words.papa, familyName: 'Testfamilie', familyPassword: FAMILY_PASSWORD,
  });
  await store.settings.save({ birthDate, mealsPerDay: 8, nursingMl: 40 });
  await write(entries.filter((e) => e.by === 'papa'));
  await session.logout();

  await session.registerJoin({
    username: 'mama', password: PASSWORD, displayName: words.mama, familyName: 'Testfamilie', familyPassword: FAMILY_PASSWORD,
  });
  await store.refresh();
  const vitamin = await store.entries.create({
    type: 'reminder', details: { title: words.vitamin, who: 'baby', note: words.vitaminNote, times: ['18:00'] },
  });
  const iron = await store.entries.create({ type: 'reminder', details: { title: words.iron, who: 'mama', times: ['08:00'] } });
  for (const { reminder, due, at } of ticks) {
    const r = reminder === 'vitamin' ? vitamin : iron;
    await store.entries.create({
      type: 'task', startedAt: at, details: { title: r.details.title, who: r.details.who, reminderEid: r.eid, due },
    });
  }
  await write(entries.filter((e) => e.by === 'mama'));
  await store.refresh();
  return { today, rows: entries.length + ticks.length + 3 };
}

/** Runs in the page: the running Stillen timer of the «timer» shot. */
async function startTimerInPage(startedAt) {
  const { store } = await import('/src/store.js');
  await store.entries.create({ type: 'breastfeed', startedAt, details: { side: 'L' } });
  await store.refresh();
}

// --- one language -------------------------------------------------------------------

async function shootLanguage(cdp, lang, tmp) {
  const api = await startApi(path.join(tmp, `${lang}.db`));
  const vite = await startVite(api.port);
  try {
    const realNow = Date.now();
    const today = zurichDateOf(new Date(realNow).toISOString().replace(/\.\d{3}Z$/, 'Z'));
    const nowIso = zurichTimeUtc(today, NOW_WALL);
    const offsetMs = Date.parse(nowIso) - realNow;

    const { browserContextId } = await cdp.send('Target.createBrowserContext');
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => cdp.send(method, params, sessionId);
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, mobile: true });
    await send('Emulation.setTimezoneOverride', { timezoneId: 'Europe/Zurich' });
    await send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: bootScript(lang, offsetMs) });

    const evaluate = async (expression) => {
      const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (res.exceptionDetails) {
        const ex = res.exceptionDetails.exception;
        throw new Error(`in the page: ${(ex && (ex.description || ex.value)) || res.exceptionDetails.text}`);
      }
      return res.result.value;
    };
    const call = (fn, arg) => evaluate(`(${fn.toString()})(${JSON.stringify(arg)})`);
    const waitFor = async (selector, what) => {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)) return;
        await sleep(100);
      }
      throw new Error(`${lang}/${what}: «${selector}» never showed up`);
    };
    const open = async (hash, ready, what) => {
      await send('Page.navigate', { url: 'about:blank' });
      await send('Page.navigate', { url: vite.url + hash });
      await waitFor(ready, what);
    };

    // 1. the login page, then both accounts and the week
    await open('', '.auth-form', 'login');
    const ticks = [];
    for (let d = -HISTORY_DAYS; d <= 0; d++) {
      const date = shiftZurichDate(today, d);
      ticks.push({ reminder: 'iron', due: zurichTimeUtc(date, '08:00'), at: addMin(zurichTimeUtc(date, '08:00'), 12 + ((d + 9) % 5) * 7) });
      if (d < 0) ticks.push({ reminder: 'vitamin', due: zurichTimeUtc(date, '18:00'), at: addMin(zurichTimeUtc(date, '18:00'), 5 + ((d + 9) % 4) * 9) });
    }
    const seeded = await call(seedInPage, {
      words: WORDS[lang],
      entries: inventWeek(today, nowIso),
      birthDate: shiftZurichDate(today, -BIRTH_DAYS_AGO),
      today,
      ticks,
    });
    log(`${lang}: ${seeded.rows} rows written for ${seeded.today}`);

    // 2. the screens
    for (const [id, shot] of Object.entries(RECIPES)) {
      await open(shot.hash, shot.ready, id);
      if (shot.timer) await call(startTimerInPage, addMin(nowIso, -6));
      for (const selector of shot.click || []) {
        await waitFor(selector, id);
        await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
      }
      if (shot.then) await waitFor(shot.then, id);
      await evaluate(`document.fonts.ready.then(() => { const t = document.getElementById('toasts'); if (t) t.hidden = true; })`);
      await sleep(700); // the sheet's slide-up, the first sync's re-render
      const { data } = await send('Page.captureScreenshot', { format: 'webp', quality: WEBP_QUALITY });
      const file = path.join(outDir, `${lang}-${id}.webp`);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      log(`${path.relative(root, file)}  ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
    }
    await cdp.send('Target.disposeBrowserContext', { browserContextId });
  } finally {
    await vite.stop();
    api.stop();
  }
}

// --- main ---------------------------------------------------------------------------

if (typeof WebSocket !== 'function') fail('needs Node ≥ 22 (global WebSocket)');
const unknown = SHOTS.filter((id) => !RECIPES[id]).concat(Object.keys(RECIPES).filter((id) => !SHOTS.includes(id)));
if (unknown.length) fail(`SHOTS (src/shots.js) and RECIPES disagree about: ${unknown.join(', ')}`);
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-shots-'));
const chrome = await startChrome(path.join(tmp, 'chrome')).catch((e) => fail(e.message));
let failed = null;
try {
  const cdp = await connect(chrome.wsUrl);
  for (const lang of SHOT_LANGS) await shootLanguage(cdp, lang, tmp);
  cdp.close();
} catch (err) {
  failed = err;
} finally {
  chrome.stop();
  await sleep(300); // Chrome lets go of its profile
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (failed) fail(failed.stack || failed.message);
log(`done — ${SHOT_LANGS.length * SHOTS.length} pictures in ${path.relative(root, outDir) || '.'}`);
process.exit(0);
