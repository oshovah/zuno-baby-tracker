// A small CSV reader for the data files under scripts/ (the extra places of
// the map): RFC 4180 — commas, "quoted fields" with "" for a quote inside,
// line breaks inside quotes, CRLF or LF, a UTF-8 BOM — plus lines that START
// with # as comments. Node-tested in src/tests/csv.test.mjs.

/**
 * The rows of a CSV text as objects keyed by the first row's column names.
 * A short row leaves its missing columns empty, extra cells are dropped,
 * empty lines and comment lines are skipped.
 */
export function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const records = [];
  let row = [];
  let field = '';
  let quoted = false;
  let atLineStart = true;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (atLineStart && c === '#') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    atLineStart = false;
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      if (row.length > 1 || row[0] !== '') records.push(row);
      row = [];
      field = '';
      atLineStart = true;
    } else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') records.push(row);
  }
  const [head, ...body] = records;
  if (!head) return [];
  const columns = head.map((h) => h.trim());
  return body.map((cells) => Object.fromEntries(columns.map((name, i) => [name, cells[i] === undefined ? '' : cells[i]])));
}
