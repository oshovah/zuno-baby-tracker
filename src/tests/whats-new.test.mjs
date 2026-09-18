// The release notes ship complete and in order; the unseen logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WHATS_NEW, unseenWhatsNew, notesFor, newestWhatsNewId } from '../whats-new.js';
import { LOCALES } from '../i18n/locales/index.js';

const ID_RE = /^\d{4}-\d{2}-\d{2}(-[a-z])?$/;

test('every entry has a date id, unique, newest first', () => {
  const ids = WHATS_NEW.map((e) => e.id);
  for (const id of ids) assert.match(id, ID_RE, `${id} is not YYYY-MM-DD[-x]`);
  assert.equal(new Set(ids).size, ids.length, 'duplicate id');
  for (let i = 1; i < ids.length; i++) assert.ok(ids[i] < ids[i - 1], `${ids[i]} should come before ${ids[i - 1]}`);
});

test('every entry has a non-empty line in every language the app ships', () => {
  for (const e of WHATS_NEW) {
    for (const id of Object.keys(LOCALES)) {
      assert.ok(Array.isArray(e[id]) && e[id].length > 0, `${e.id} has no ${id} notes`);
      for (const line of e[id]) assert.ok(typeof line === 'string' && line.trim() !== '', `${e.id}.${id} has an empty line`);
    }
  }
});

const list = [
  { id: '2026-10-03', de: ['c'], en: ['C'] },
  { id: '2026-10-01-b', de: ['b2'] },
  { id: '2026-10-01', de: ['b'], en: ['B'] },
  { id: '2026-09-17', de: ['a'], en: ['A'] },
];

test('unseenWhatsNew: everything newer than the seen id, newest first, capped', () => {
  assert.deepEqual(unseenWhatsNew(list, '2026-10-01').map((e) => e.id), ['2026-10-03', '2026-10-01-b']);
  assert.deepEqual(unseenWhatsNew(list, '2026-10-03').map((e) => e.id), []);
  assert.deepEqual(unseenWhatsNew(list, '2020-01-01').map((e) => e.id), list.map((e) => e.id));
  assert.deepEqual(unseenWhatsNew(list, null).map((e) => e.id), list.map((e) => e.id));
  assert.deepEqual(unseenWhatsNew(list, null, 2).map((e) => e.id), ['2026-10-03', '2026-10-01-b']);
  assert.deepEqual(unseenWhatsNew([], null), []);
});

test('notesFor falls back to German, then to any language', () => {
  assert.deepEqual(notesFor(list[0], 'en'), ['C']);
  assert.deepEqual(notesFor(list[1], 'en'), ['b2']);
  assert.deepEqual(notesFor({ id: 'x', fr: ['f'] }, 'en'), ['f']);
  assert.deepEqual(notesFor({ id: 'x' }, 'en'), []);
});

test('newestWhatsNewId', () => {
  assert.equal(newestWhatsNewId(list), '2026-10-03');
  assert.equal(newestWhatsNewId([]), null);
  assert.equal(newestWhatsNewId(), WHATS_NEW[0].id);
});
