// Every language ships complete: the same keys as German, no empty text,
// the same {placeholders}; plus the lookup rules of t()/tn().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCALES } from '../i18n/locales/index.js';
import { NAMESPACES } from '../i18n/build.js';
import { t, tn, setLocale, getLocale, detectLocale, availableLocales, hasKey, DEFAULT_LOCALE } from '../i18n/index.js';

const ids = Object.keys(LOCALES);
const base = LOCALES[DEFAULT_LOCALE].messages;
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('the fallback language is registered and has keys', () => {
  assert.ok(ids.includes(DEFAULT_LOCALE));
  assert.ok(Object.keys(base).length > 0);
  assert.deepEqual(availableLocales().map((l) => l.id), ids);
});

for (const id of ids) {
  const { meta, messages } = LOCALES[id];
  test(`${id}: meta is complete`, () => {
    assert.equal(meta.id, id);
    assert.ok(typeof meta.name === 'string' && meta.name !== '');
    assert.ok(typeof meta.dateLocale === 'string' && meta.dateLocale !== '');
    assert.ok(meta.decimalSeparator === '.' || meta.decimalSeparator === ',');
  });
  test(`${id}: every key of ${DEFAULT_LOCALE} exists, nothing extra, nothing empty`, () => {
    const missing = Object.keys(base).filter((k) => !Object.prototype.hasOwnProperty.call(messages, k));
    const extra = Object.keys(messages).filter((k) => !Object.prototype.hasOwnProperty.call(base, k));
    assert.deepEqual(missing, [], `${id} lacks: ${missing.slice(0, 20).join(', ')}`);
    assert.deepEqual(extra, [], `${id} has keys ${DEFAULT_LOCALE} lacks: ${extra.slice(0, 20).join(', ')}`);
    for (const [k, v] of Object.entries(messages)) {
      assert.ok(typeof v === 'string', `${id}.${k} is not a string`);
      assert.notEqual(v.trim(), '', `${id}.${k} is empty`);
    }
  });
  test(`${id}: keys are namespaced and placeholders match ${DEFAULT_LOCALE}`, () => {
    for (const [k, v] of Object.entries(messages)) {
      assert.ok(NAMESPACES.includes(k.split('.')[0]), `${k} is outside the namespaces`);
      assert.equal(placeholders(v), placeholders(base[k]), `${id}.${k}: placeholders differ`);
    }
  });
  test(`${id}: plural keys come in pairs`, () => {
    for (const k of Object.keys(messages)) {
      if (k.endsWith('.one')) assert.ok(messages[`${k.slice(0, -4)}.other`], `${k} has no .other`);
      if (k.endsWith('.other')) assert.ok(messages[`${k.slice(0, -6)}.one`], `${k} has no .one`);
    }
  });
}

test('t() fills placeholders and leaves unknown ones visible', () => {
  setLocale('de');
  assert.equal(t('common.milk.formulaMl', { ml: 30 }), '30 ml Formula');
  assert.equal(t('common.milk.formulaMl'), '{ml} ml Formula');
});

test('a missing key falls back to the key itself', () => {
  setLocale('en');
  assert.equal(t('nope.nothing'), 'nope.nothing');
  assert.equal(hasKey('nope.nothing'), false);
  assert.equal(hasKey('common.today'), true);
  setLocale('de');
});

test('setLocale switches and rejects unknown ids', () => {
  assert.equal(setLocale('en'), 'en');
  assert.equal(getLocale(), 'en');
  assert.equal(t('common.today'), 'Today');
  assert.equal(setLocale('xx'), DEFAULT_LOCALE);
  assert.equal(t('common.today'), 'Heute');
});

test('detectLocale: stored choice, then the browser, then German', () => {
  assert.equal(detectLocale('en', ['de-CH']), 'en');
  assert.equal(detectLocale(null, ['fr-CH', 'en-US', 'de']), 'en');
  assert.equal(detectLocale('xx', ['fr', 'it']), DEFAULT_LOCALE);
  assert.equal(detectLocale(undefined, undefined), DEFAULT_LOCALE);
});

test('tn() picks .one for exactly 1 and fills {n}', () => {
  const sample = Object.keys(base).find((k) => k.endsWith('.one'));
  if (!sample) return; // no plural key yet — nothing to check
  const key = sample.slice(0, -4);
  setLocale('de');
  assert.equal(tn(key, 1), base[sample].replace('{n}', '1'));
  assert.equal(tn(key, 2), base[`${key}.other`].replace('{n}', '2'));
});
