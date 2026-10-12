// The CSV reader of the data files under scripts/ (scripts/lib/csv.mjs):
// the extra places of the map are hand-edited, so quotes, commas inside a
// note, Windows line ends and comment lines must all come through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../../scripts/lib/csv.mjs';

test('columns from the first row, one object per row, empty cells as empty strings', () => {
  const rows = parseCsv('id,name,note\na,Alpha,\nb,,second\n');
  assert.deepEqual(rows, [
    { id: 'a', name: 'Alpha', note: '' },
    { id: 'b', name: '', note: 'second' },
  ]);
});

test('quoted fields keep commas, doubled quotes and line breaks', () => {
  const rows = parseCsv('id,note\nx,"one, two"\ny,"she said ""hi"""\nz,"first line\nsecond line"\n');
  assert.deepEqual(
    rows.map((r) => r.note),
    ['one, two', 'she said "hi"', 'first line\nsecond line']
  );
});

test('CRLF, a BOM, comment lines, blank lines, a missing last newline', () => {
  const rows = parseCsv('﻿# a comment\r\nid,v\r\n\r\n# another\r\na,1\r\nb,2');
  assert.deepEqual(rows, [
    { id: 'a', v: '1' },
    { id: 'b', v: '2' },
  ]);
});

test('a short row leaves the rest empty, extra cells are dropped, a # inside a field is data', () => {
  const rows = parseCsv('id,a,b\nx\ny,1,2,3\nz,#notacomment,"#neither"\n');
  assert.deepEqual(rows, [
    { id: 'x', a: '', b: '' },
    { id: 'y', a: '1', b: '2' },
    { id: 'z', a: '#notacomment', b: '#neither' },
  ]);
});

test('nothing in, nothing out', () => {
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('# only a comment\n'), []);
  assert.deepEqual(parseCsv('id,a\n'), []);
});
