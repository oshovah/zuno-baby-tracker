// The Range parsing of the local basemap servers (scripts/lib/range.mjs):
// pmtiles reads the archive by byte ranges, a wrong span would hand it
// garbage, a 200 makes it give up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRange } from '../../scripts/lib/range.mjs';

test('no header, another unit or several ranges: the whole file', () => {
  assert.equal(parseRange(undefined, 100), null);
  assert.equal(parseRange('', 100), null);
  assert.equal(parseRange('items=0-9', 100), null);
  assert.equal(parseRange('bytes=0-9,20-29', 100), null);
  assert.equal(parseRange('bytes=-', 100), null);
  assert.equal(parseRange('bytes=a-b', 100), null);
});

test('a closed range, clamped to the file', () => {
  assert.deepEqual(parseRange('bytes=0-15', 100), { start: 0, end: 15 });
  assert.deepEqual(parseRange(' bytes=10-10 ', 100), { start: 10, end: 10 });
  assert.deepEqual(parseRange('bytes=90-200', 100), { start: 90, end: 99 });
});

test('an open range runs to the end, a suffix range takes the last n bytes', () => {
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-500', 100), { start: 0, end: 99 });
});

test('unsatisfiable: start past the end, start after end, an empty file', () => {
  assert.equal(parseRange('bytes=100-', 100), 'invalid');
  assert.equal(parseRange('bytes=50-40', 100), 'invalid');
  assert.equal(parseRange('bytes=-0', 100), 'invalid');
  assert.equal(parseRange('bytes=0-1', 0), 'invalid');
});
