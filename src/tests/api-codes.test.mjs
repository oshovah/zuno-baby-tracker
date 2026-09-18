// Every error code the server can answer with has a German locale entry whose
// text IS the server's message, and every entry is thrown somewhere: a new
// throw site in api/index.php or api/lib/*.php without a key in
// locales/de/api.js — or a stale key — fails npm test. (src/api.js shows the
// translation of a code when it has one, the server's message otherwise; in
// German both must read the same.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import de from '../i18n/locales/de/api.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const libDir = path.join(root, 'api', 'lib');
const sources = ['api/index.php', ...fs.readdirSync(libDir).filter((f) => f.endsWith('.php')).sort().map((f) => `api/lib/${f}`)];
const CODE = /^[a-z]+(\.[A-Za-z0-9]+)+$/;

/** The top-level arguments of the call whose '(' (or '[') is at src[open], as raw trimmed strings. */
function splitArgs(src, open) {
  const args = [];
  let depth = 0;
  let cur = '';
  let quote = null;
  for (let i = open + 1; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      cur += ch;
      if (ch === '\\') cur += src[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '(' || ch === '[') {
      depth++;
    } else if (ch === ')' || ch === ']') {
      if (depth === 0) {
        args.push(cur.trim());
        return args;
      }
      depth--;
    } else if (ch === ',' && depth === 0) {
      args.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  throw new Error(`unbalanced call at offset ${open}`);
}

/** A PHP single-quoted literal → its text, else null. */
function literal(arg) {
  const m = /^'((?:[^'\\]|\\.)*)'$/.exec(arg);
  return m ? m[1].replace(/\\(['\\])/g, '$1') : null;
}

/** A literal, a BT_ constant or a bare integer → its value; anything else → null. */
function scalar(arg, consts) {
  const lit = literal(arg);
  if (lit !== null) return lit;
  if (/^\d+$/.test(arg)) return arg;
  if (Object.prototype.hasOwnProperty.call(consts, arg)) return consts[arg];
  return null;
}

/** 'a' . BT_X . 'b' → the joined text when every part is a scalar, else null (a runtime value: no text check). */
function concat(arg, consts) {
  const parts = arg.split(/\s*\.\s*(?=(?:[^']*'[^']*')*[^']*$)/).map((p) => p.trim());
  let out = '';
  for (const p of parts) {
    const v = scalar(p, consts);
    if (v === null) return null;
    out += v;
  }
  return out;
}

/** ['k' => v, …] → {k: v} when every value is a scalar; {} without params; null when a value is a runtime expression. */
function params(arg, consts) {
  if (arg === undefined) return {};
  if (!arg.startsWith('[') || !arg.endsWith(']')) return null;
  const out = {};
  for (const pair of splitArgs(arg, 0)) {
    if (pair === '') continue;
    const m = /^'(\w+)'\s*=>\s*([\s\S]+)$/.exec(pair);
    if (!m) return null;
    const v = scalar(m[2].trim(), consts);
    if (v === null) return null;
    out[m[1]] = v;
  }
  return out;
}

const fill = (s, p) => s.replace(/\{(\w+)\}/g, (m, name) => (Object.prototype.hasOwnProperty.call(p, name) ? String(p[name]) : m));

/** Every `new HttpError(status, message, code, params)` and `bt_error_body(message, code, params)` in the sources. */
function throwSites() {
  const files = sources.map((f) => [f, fs.readFileSync(path.join(root, f), 'utf8')]);
  const consts = {};
  for (const [, src] of files) {
    for (const m of src.matchAll(/^const\s+(BT_\w+)\s*=\s*('(?:[^'\\]|\\.)*'|\d+)\s*;/gm)) consts[m[1]] = scalar(m[2], {});
  }
  const sites = [];
  for (const [file, src] of files) {
    for (const m of src.matchAll(/(?<!function )\b(new HttpError|bt_error_body)\s*\(/g)) {
      const args = splitArgs(src, m.index + m[0].length - 1);
      if (args.length < 2) continue; // the docblock's `bt_error_body()`
      const where = `${file}:${src.slice(0, m.index).split('\n').length}`;
      const [message, code, rest] = m[1] === 'new HttpError' ? args.slice(1) : args;
      if (m[1] === 'bt_error_body' && code !== undefined && code.startsWith('$')) continue; // bt_handle's pass-through
      sites.push({ where, message, code, params: rest, consts });
    }
  }
  return sites;
}

const sites = throwSites();
const keysInClient = new Set([...fs.readFileSync(path.join(root, 'src', 'api.js'), 'utf8').matchAll(/'api\.([A-Za-z0-9.]+)'/g)].map((m) => m[1]));

test('the scan finds the throw sites', () => {
  assert.ok(sites.length >= 40, `only ${sites.length} throw sites found — did the scan break?`);
  const codes = new Set(sites.map((s) => literal(s.code || '')));
  for (const known of ['request.badJson', 'auth.badCredentials', 'entries.notFound', 'server.internal']) {
    assert.ok(codes.has(known), `${known} not found among the throw sites`);
  }
});

test('every throw site names a dotted code that de/api.js has', () => {
  for (const s of sites) {
    const code = s.code === undefined ? null : literal(s.code);
    assert.ok(code !== null, `${s.where}: HttpError without a literal code (message ${s.message})`);
    assert.match(code, CODE, `${s.where}: "${code}" is not a dotted code`);
    assert.ok(Object.prototype.hasOwnProperty.call(de, code), `${s.where}: code "${code}" has no entry in src/i18n/locales/de/api.js`);
  }
});

test('every key of de/api.js is thrown by the server or used by src/api.js', () => {
  const thrown = new Set(sites.map((s) => literal(s.code || '')));
  const stale = Object.keys(de).filter((k) => !thrown.has(k) && !keysInClient.has(k));
  assert.deepEqual(stale, [], `keys nothing uses any more: ${stale.join(', ')}`);
});

test("the German locale text is the server's own message", () => {
  let checked = 0;
  for (const s of sites) {
    const code = literal(s.code || '');
    const message = concat(s.message, s.consts);
    const p = params(s.params, s.consts);
    if (message === null || p === null || !de[code]) continue; // a runtime value in the text: not checkable here
    assert.equal(fill(de[code], p), message, `${s.where}: de "${code}" differs from the server's message`);
    checked++;
  }
  assert.ok(checked >= 30, `only ${checked} sites had a literal message to compare`);
});

// The two sites whose message is concatenated at run time slip through the
// comparison above (a runtime value in the text): pin their templates here.
test('the concatenated server messages match their de templates', () => {
  const idx = fs.readFileSync(path.join(root, 'api', 'index.php'), 'utf8');
  const http = fs.readFileSync(path.join(root, 'api', 'lib', 'http.php'), 'utf8');
  assert.ok(idx.includes(`'"' . $name . '" muss eine ganze Zahl sein', 'request.notAnInteger', ['field' => $name]`));
  assert.equal(fill(de['request.notAnInteger'], { field: 'x' }), '"x" muss eine ganze Zahl sein');
  assert.ok(http.includes(`'Ungültiger JSON-Body: ' . $reason, 'request.badJson', ['reason' => $reason]`));
  assert.equal(fill(de['request.badJson'], { reason: 'Syntax error' }), 'Ungültiger JSON-Body: Syntax error');
});
