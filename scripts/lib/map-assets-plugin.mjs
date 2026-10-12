// Vite plugin: serves the basemap folder (basemap/, gitignored — the
// archive `npm run map:basemap` cuts plus its index.json and licence) at
// /basemap/* in `npm run dev` and in the headless runs (scripts/lib/headless.mjs
// starts Vite with configFile:false, so it adds this plugin itself).
//
// Why not public/basemap/: Vite copies public/ into dist/ on every build —
// 600 MB per `npm run package` — and the archive is uploaded once, by
// `npm run deploy:basemap`, not with the app. Why a plugin and not a symlink
// in public/: Vite follows symlinks when it copies.
//
// Range requests are the point: pmtiles reads the archive in byte ranges and
// gives up on a 200 — Vite's own static server would answer one for a file
// outside public/. The same rule in PHP: scripts/preview-router.php.

import fs from 'node:fs';
import path from 'node:path';
import { parseRange } from './range.mjs';

const MIME = {
  '.pmtiles': 'application/octet-stream',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * @param {string} dir   absolute path of the folder to serve
 * @param {string} mount URL prefix (default /basemap)
 */
export function basemapPlugin(dir, mount = '/basemap') {
  const base = path.resolve(dir);
  return {
    name: 'bt-basemap',
    configureServer(server) {
      server.middlewares.use(mount, (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        let rel;
        try {
          rel = decodeURIComponent((req.url || '/').split('?')[0]);
        } catch {
          return next();
        }
        const file = path.resolve(base, `.${rel}`);
        if (file !== base && !file.startsWith(base + path.sep)) return next(); // no ../ escapes
        let stat;
        try {
          stat = fs.statSync(file);
        } catch {
          return next(); // not here: Vite answers (404, or public/ if it has the path)
        }
        if (!stat.isFile()) return next();
        const size = stat.size;
        const range = parseRange(req.headers.range, size);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store');
        if (range === 'invalid') {
          res.statusCode = 416;
          res.setHeader('Content-Range', `bytes */${size}`);
          return res.end();
        }
        const { start, end } = range || { start: 0, end: size - 1 };
        if (range) {
          res.statusCode = 206;
          res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        } else {
          res.statusCode = 200;
        }
        res.setHeader('Content-Length', String(end - start + 1));
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(file, { start, end }).pipe(res);
      });
    },
  };
}
