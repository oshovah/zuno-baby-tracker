// HTTP Range parsing for the local servers that hand out the basemap archive
// (scripts/lib/map-assets-plugin.mjs in dev and the headless runs,
// scripts/preview-router.php mirrors it in PHP). pmtiles reads the archive
// in byte ranges and refuses a whole-file 200, so these servers must answer
// 206 like Apache does. Pure — node-tested in src/tests/map-range.test.mjs.

/**
 * The byte span a `Range` header asks for, for a file of `size` bytes:
 *   null              no (usable) range: send the whole file, 200
 *   { start, end }    inclusive byte positions, both inside the file: 206
 *   'invalid'         unsatisfiable: 416 with `Content-Range: bytes * /size`
 * Only a single `bytes=` range is honoured; several ranges, another unit or
 * a malformed header get the whole file, as the spec allows.
 */
export function parseRange(header, size) {
  if (typeof header !== 'string') return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  if (m[1] === '' && m[2] === '') return null;
  if (!Number.isInteger(size) || size <= 0) return 'invalid';
  let start;
  let end;
  if (m[1] === '') {
    // suffix range: the last n bytes
    const n = Number(m[2]);
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}
