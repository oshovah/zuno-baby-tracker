// Tests for src/feedback.js: the draft checks, what a message carries (the
// sender only when not anonymous, the technical details only when chosen)
// and how the inbox reads back whatever a blob held.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FEEDBACK_KINDS,
  FEEDBACK_MAX_TEXT,
  normaliseText,
  draftError,
  techInfo,
  techLines,
  buildMessage,
  readMessage,
  senderParts,
} from '../feedback.js';
import { t, hasKey } from '../i18n/index.js';

const USER = { username: 'mama', familyName: 'Testfamilie', displayName: 'Mama', kdf: { salt: 'x', iter: 600000 } };
const NOW = '2026-09-27T08:00:00Z';

test('draftError: a kind, a text, at most FEEDBACK_MAX_TEXT characters (emoji count once)', () => {
  assert.deepEqual(FEEDBACK_KINDS, ['idea', 'bug', 'other']);
  assert.equal(draftError({ kind: 'idea', text: 'Bitte ein Dark Mode' }), null);
  assert.equal(draftError({ kind: 'nope', text: 'x' }), 'feedback.form.errorKind');
  assert.equal(draftError({ kind: 'bug', text: '   \n ' }), 'feedback.form.errorEmpty');
  assert.equal(draftError({ kind: 'bug', text: 'x'.repeat(FEEDBACK_MAX_TEXT) }), null);
  assert.equal(draftError({ kind: 'bug', text: 'x'.repeat(FEEDBACK_MAX_TEXT + 1) }), 'feedback.form.errorLong');
  assert.equal(draftError({ kind: 'bug', text: '🐛'.repeat(FEEDBACK_MAX_TEXT) }), null, 'code points, not UTF-16 units');
  assert.equal(normaliseText('  a\r\nb\rc  '), 'a\nb\nc');
});

test('buildMessage: named carries the account, anonymous carries nothing about it', () => {
  const named = buildMessage({ kind: 'idea', text: ' Hallo ', anonymous: false, user: USER, app: null, nowIso: NOW });
  assert.deepEqual(named, {
    kind: 'idea',
    text: 'Hallo',
    from: { username: 'mama', familyName: 'Testfamilie', displayName: 'Mama' },
    sentAt: NOW,
    app: null,
  });
  assert.equal(JSON.stringify(named).includes('kdf'), false, 'never more of prefs.user than the names');

  const anon = buildMessage({ kind: 'bug', text: 'Hallo', anonymous: true, user: USER, app: null, nowIso: NOW });
  assert.equal(anon.from, null);
  const json = JSON.stringify(anon);
  for (const leak of ['mama', 'Mama', 'Testfamilie']) assert.equal(json.includes(leak), false, `no "${leak}"`);

  assert.throws(() => buildMessage({ kind: 'bug', text: '', anonymous: true, nowIso: NOW }), /errorEmpty/);
});

test('techInfo / techLines: only the known fields, capped; the lines the form shows', () => {
  const app = techInfo({ version: '2026-09-27', lang: 'de', theme: 'nursery', standalone: true, screen: '390×844 @3x', ua: 'U'.repeat(500), extra: 'no' });
  assert.deepEqual(Object.keys(app), ['version', 'lang', 'theme', 'standalone', 'screen', 'ua']);
  assert.equal(app.ua.length, 300);
  assert.deepEqual(
    techLines(app).map((l) => l.label),
    ['version', 'lang', 'theme', 'standalone', 'screen', 'ua']
  );
  assert.deepEqual(techLines(null), []);
  assert.deepEqual(techLines(techInfo({})).map((l) => l.label), ['standalone'], 'empty strings are left out');
});

test('readMessage: whatever the blob held becomes something showable', () => {
  const ok = readMessage({ v: 2, kind: 'bug', text: 'Fehler', from: { username: 'papa', familyName: 'F' }, sentAt: NOW, app: { lang: 'en' } });
  assert.equal(ok.kind, 'bug');
  assert.deepEqual(ok.from, { username: 'papa', familyName: 'F', displayName: '' });
  assert.equal(ok.sentAt, NOW);
  assert.equal(ok.app.lang, 'en');

  const odd = readMessage({ kind: 'spam', text: 42, from: { username: '' }, sentAt: 'soon', app: 'x' });
  assert.deepEqual(odd, { kind: 'other', text: '', from: null, sentAt: null, app: null });
  assert.deepEqual(readMessage(null), { kind: 'other', text: '', from: null, sentAt: null, app: null });
});

test('senderParts: the name first, then username and family', () => {
  assert.deepEqual(senderParts({ username: 'mama', familyName: 'Testfamilie', displayName: 'Mama' }), { name: 'Mama', detail: 'mama · Testfamilie' });
  assert.deepEqual(senderParts({ username: 'papa', familyName: 'Testfamilie', displayName: '' }), { name: 'papa', detail: 'Testfamilie' });
  assert.equal(senderParts(null), null);
});

test('the draft errors and the kinds have German copy (the feedback namespace is registered)', () => {
  for (const key of ['feedback.form.errorKind', 'feedback.form.errorEmpty', 'feedback.form.errorLong']) assert.ok(hasKey(key), key);
  assert.equal(t('feedback.form.errorLong', { max: FEEDBACK_MAX_TEXT }), 'Höchstens 3000 Zeichen');
  assert.deepEqual(['idea', 'bug', 'misc'].map((k) => t(`feedback.kind.${k}`)), ['Wunsch', 'Fehler', 'Sonstiges']);
});
