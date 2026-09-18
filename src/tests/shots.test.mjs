// The login page's screenshot slider ships complete: one picture per screen
// and language with pictures, a caption for every screen in every language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SHOTS, SHOT_LANGS, shotFile } from '../shots.js';
import { LOCALES } from '../i18n/locales/index.js';

const dir = fileURLToPath(new URL('../shots/', import.meta.url));

test('every screen has a WebP picture in every language with pictures — and nothing else lies around', () => {
  const expected = SHOT_LANGS.flatMap((lang) => SHOTS.map((id) => shotFile(id, lang))).sort();
  assert.deepEqual(fs.readdirSync(dir).filter((f) => !f.startsWith('.')).sort(), expected, 'run `npm run screenshots`');
  for (const file of expected) {
    const head = fs.readFileSync(dir + file).subarray(0, 12).toString('latin1');
    assert.ok(head.startsWith('RIFF') && head.endsWith('WEBP'), `${file} is not a WebP file`);
  }
});

test('languages with pictures are shipped languages; the others fall back to English', () => {
  for (const lang of SHOT_LANGS) assert.ok(LOCALES[lang], `${lang} has pictures but is not a language of the app`);
  assert.equal(shotFile('home', 'de'), 'de-home.webp');
  assert.equal(shotFile('home', 'xx'), 'en-home.webp');
});

test('every screen has a caption in every language', () => {
  for (const [lang, { messages }] of Object.entries(LOCALES)) {
    for (const id of SHOTS) {
      assert.ok(typeof messages[`login.shots.${id}`] === 'string', `${lang} lacks login.shots.${id}`);
      assert.ok(!/[<>]/.test(messages[`login.shots.${id}`]), `${lang}: login.shots.${id} is the alt text too — plain text only`);
    }
  }
});
