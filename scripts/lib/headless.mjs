// Shared by the headless scripts (make-screenshots.mjs, e2e-offline.mjs):
// a scratch PHP API on a free port, a Vite dev server in front of it, headless
// Chrome over the DevTools protocol (Node's own WebSocket — no puppeteer), and
// the page-side helpers. Nothing here touches data/ or a running `npm run dev`.
//
// Needs: php on the PATH, Google Chrome (or CHROME_PATH=/path/to/chrome),
// Node ≥ 22 (global WebSocket).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function fail(msg, tag = 'headless') {
  console.error(`[${tag}] ${msg}`);
  process.exit(1);
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export async function startApi(dbPath) {
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

export async function startVite(apiPort) {
  const server = await createServer({
    root,
    configFile: false, // vite.config.js proxies to the dev API on :8788 — this one goes to the scratch API
    base: './',
    logLevel: 'error',
    // no watcher, no HMR: the pictures a screenshot run writes are part of the page's module graph (login.js globs src/shots/)
    server: { host: '127.0.0.1', port: await freePort(), strictPort: true, hmr: false, watch: null, proxy: { '/api': `http://127.0.0.1:${apiPort}` } },
  });
  await server.listen();
  return { url: `http://127.0.0.1:${server.config.server.port}/`, stop: () => server.close() };
}

export function chromePath() {
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

export function startChrome(profileDir) {
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

/** The DevTools protocol, as much of it as the scripts need: send(), and
 *  on(method, fn) for events (the session id is in the event). */
export function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const listeners = new Map();
    let nextId = 0;
    ws.addEventListener('error', () => reject(new Error('DevTools socket failed')));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === undefined) {
        for (const fn of listeners.get(msg.method) || []) fn(msg.params, msg.sessionId);
        return;
      }
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
        on(method, fn) {
          if (!listeners.has(method)) listeners.set(method, new Set());
          listeners.get(method).add(fn);
          return () => listeners.get(method).delete(fn);
        },
        close: () => ws.close(),
      })
    );
  });
}

/**
 * One page in its own browser context (its own cookies and storage — one
 * phone): a 390 × 844 phone at 2x, Europe/Zurich, dark scheme. Returns the
 * helpers the scripts drive it with. `bootScript` runs before any script of
 * the app on every navigation.
 */
export async function openPhone(cdp, { bootScript = null, viewport = { width: 390, height: 844, deviceScaleFactor: 2 } } = {}) {
  const { browserContextId } = await cdp.send('Target.createBrowserContext');
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { ...viewport, mobile: true });
  await send('Emulation.setTimezoneOverride', { timezoneId: 'Europe/Zurich' });
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  if (bootScript) await send('Page.addScriptToEvaluateOnNewDocument', { source: bootScript });

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) {
      const ex = res.exceptionDetails.exception;
      throw new Error(`in the page: ${(ex && (ex.description || ex.value)) || res.exceptionDetails.text}`);
    }
    return res.result.value;
  };
  const call = (fn, arg) => evaluate(`(${fn.toString()})(${JSON.stringify(arg === undefined ? null : arg)})`);
  const waitFor = async (selector, what = selector, tries = 100) => {
    for (let i = 0; i < tries; i++) {
      if (await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)) return;
      await sleep(100);
    }
    throw new Error(`${what}: «${selector}» never showed up`);
  };
  const open = async (url, ready, what) => {
    await send('Page.navigate', { url: 'about:blank' });
    await send('Page.navigate', { url });
    if (ready) await waitFor(ready, what);
  };
  const click = async (selector) => {
    await waitFor(selector);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  };
  const text = (selector) => evaluate(`(document.querySelector(${JSON.stringify(selector)}) || {}).innerText || ''`);
  const screenshot = async (file, { format = 'png', quality } = {}) => {
    const { data } = await send('Page.captureScreenshot', { format, ...(quality ? { quality } : {}) });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  };
  const offline = (on) =>
    send('Network.emulateNetworkConditions', { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const close = () => cdp.send('Target.disposeBrowserContext', { browserContextId });
  return { sessionId, send, evaluate, call, waitFor, open, click, text, screenshot, offline, close };
}
