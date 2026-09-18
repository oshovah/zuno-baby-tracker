#!/usr/bin/env node
/**
 * make-icons.mjs — draw the app's icon set: a crescent moon and stars in the
 * night-nursery palette. Original artwork made of plain geometry, so the
 * public repo carries no third-party image; this script IS the source.
 *
 *   public/img/icon-512.png, icon-192.png   manifest icons ("any" + "maskable":
 *                                           everything sits inside the safe zone)
 *   public/img/apple-touch-icon.png         180 px
 *   public/img/favicon.png                  64 px
 *   public/img/zuno.png                     the badge on the login screen — no
 *                                           ring, the page crops it to a circle
 *
 * Usage: node scripts/make-icons.mjs [--svg-only]
 *   Writes the two SVGs to scripts/icons/ and rasterizes them with ImageMagick
 *   (`magick` on the PATH; its built-in SVG renderer is enough — no masks, no
 *   gradients, no strokes in the drawing). PNGs are palette images without any
 *   metadata chunk.
 *
 * An installation may show other artwork to ONE family without publishing
 * it: see "Private artwork" in the README (private-art/, gitignored).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svgDir = path.join(root, 'scripts', 'icons');
const imgDir = path.join(root, 'public', 'img');

const NIGHT = '#171310'; // --bg (dark)
const SKY = '#221b15';
const PEACH = '#eba76f'; // --milk (dark)
const MOON = '#f6e3c0';
const LILAC = '#a49dd6'; // --sleep (dark)
const ROSE = '#cfa89b'; // --measure (dark)

const f2 = (n) => n.toFixed(2);

/** A crescent as ONE path of two arcs: the disc c1/R minus the disc c2/r2. */
function crescent([x1, y1], R, [x2, y2], r2) {
  const d = Math.hypot(x2 - x1, y2 - y1);
  const a = (R * R - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(R * R - a * a);
  const mx = x1 + (a * (x2 - x1)) / d;
  const my = y1 + (a * (y2 - y1)) / d;
  const p1 = [mx + (h * (y2 - y1)) / d, my - (h * (x2 - x1)) / d];
  const p2 = [mx - (h * (y2 - y1)) / d, my + (h * (x2 - x1)) / d];
  return `M${f2(p1[0])} ${f2(p1[1])} A${R} ${R} 0 1 0 ${f2(p2[0])} ${f2(p2[1])} A${r2} ${r2} 0 0 1 ${f2(p1[0])} ${f2(p1[1])} Z`;
}

/** A four-pointed star: eight points alternating between r and its waist. */
function sparkle(cx, cy, r, waist = 0.26) {
  const pts = [];
  for (let i = 0; i < 8; i++) {
    const ang = (Math.PI / 4) * i - Math.PI / 2;
    const rr = i % 2 === 0 ? r : r * waist;
    pts.push(`${f2(cx + rr * Math.cos(ang))},${f2(cy + rr * Math.sin(ang))}`);
  }
  return pts.join(' ');
}

/** The drawing in a 512 box; `ring` = the app icon, without = the login badge. */
function svg(ring) {
  const out = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">',
    `<rect width="512" height="512" fill="${NIGHT}"/>`,
  ];
  if (ring) {
    // Two filled discs instead of a stroke; r 192 stays inside the maskable safe zone (r 205).
    out.push(`<circle cx="256" cy="256" r="192" fill="${PEACH}"/>`, `<circle cx="256" cy="256" r="179" fill="${SKY}"/>`);
  } else {
    out.push(`<rect width="512" height="512" fill="${SKY}"/>`);
  }
  out.push(
    `<g transform="translate(256 256) scale(${ring ? 0.8 : 1}) translate(-256 -256)">`,
    `<path d="${crescent([236, 268], 108, [288, 232], 93)}" fill="${MOON}"/>`,
    `<polygon points="${sparkle(356, 172, 48)}" fill="${PEACH}"/>`,
    `<polygon points="${sparkle(412, 268, 21)}" fill="${LILAC}"/>`,
    `<circle cx="372" cy="356" r="7.5" fill="${LILAC}"/>`,
    `<circle cx="146" cy="148" r="6.5" fill="${ROSE}"/>`,
    '</g></svg>'
  );
  return out.join('\n') + '\n';
}

fs.mkdirSync(svgDir, { recursive: true });
fs.writeFileSync(path.join(svgDir, 'app-icon.svg'), svg(true));
fs.writeFileSync(path.join(svgDir, 'badge.svg'), svg(false));
console.log('scripts/icons/app-icon.svg, badge.svg written');

if (!process.argv.includes('--svg-only')) {
  const targets = [
    ['app-icon.svg', 'icon-512.png', 512],
    ['app-icon.svg', 'icon-192.png', 192],
    ['app-icon.svg', 'apple-touch-icon.png', 180],
    ['app-icon.svg', 'favicon.png', 64],
    ['badge.svg', 'zuno.png', 288],
  ];
  for (const [src, name, size] of targets) {
    const res = spawnSync(
      'magick',
      [
        '-density', '384', path.join(svgDir, src),
        '-resize', `${size}x${size}`,
        '-strip', '-depth', '8', '-colors', '64',
        '-define', 'png:compression-level=9',
        '-define', 'png:exclude-chunk=all',
        `PNG8:${path.join(imgDir, name)}`,
      ],
      { stdio: 'inherit' }
    );
    if (res.error || res.status !== 0) {
      console.error(`magick failed for ${name} — is ImageMagick installed? (--svg-only skips this step)`);
      process.exit(1);
    }
    console.log(`public/img/${name}  ${size} px`);
  }
}
