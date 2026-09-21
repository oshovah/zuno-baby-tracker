// Private artwork, the pure half of src/art.js: what to do for a kept copy
// and the server's version, and what counts as a kept copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { artStep, readKept, linkTargets, badgeSrc } from '../art.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const storageOf = (value) => ({ getItem: (k) => (k === 'bt.art' ? value : null) });

test('artStep: wait for the first sync, drop when the server says none, fetch only a new version', () => {
  assert.equal(artStep(null, undefined), 'wait');
  assert.equal(artStep('aaa111', undefined), 'wait', 'a kept copy stays until a sync has answered');
  assert.equal(artStep(null, null), 'none');
  assert.equal(artStep('aaa111', null), 'drop', 'left the family, feature switched off, another account');
  assert.equal(artStep('aaa111', 'aaa111'), 'keep');
  assert.equal(artStep('aaa111', 'bbb222'), 'fetch');
  assert.equal(artStep(null, 'bbb222'), 'fetch');
});

test('readKept: a version plus PNG data URLs; anything else reads as no copy', () => {
  assert.deepEqual(readKept(storageOf(JSON.stringify({ v: 'aaa111', icon: PNG, touch: PNG }))), { v: 'aaa111', icon: PNG, touch: PNG });
  assert.deepEqual(readKept(storageOf(JSON.stringify({ v: 'aaa111', icon: PNG }))), { v: 'aaa111', icon: PNG });
  // Only PNG data URLs ever reach an href: no http(s), no javascript:, no SVG.
  assert.deepEqual(
    readKept(storageOf(JSON.stringify({ v: 'aaa111', icon: 'https://example.com/x.png', touch: 'data:image/svg+xml;base64,AAAA' }))),
    { v: 'aaa111' }
  );
  for (const junk of [null, '', 'not json', '[]', '"text"', JSON.stringify({ icon: PNG }), JSON.stringify({ v: '' }), JSON.stringify({ v: 7 })]) {
    assert.equal(readKept(storageOf(junk)), null, String(junk));
  }
  assert.equal(readKept({ getItem: () => { throw new Error('blocked'); } }), null, 'storage that throws');
});

test('the capability key: kept only as 32 hex digits, and only then do the touch icon and the manifest become real URLs', () => {
  const K = '0123456789abcdef0123456789abcdef';
  assert.deepEqual(readKept(storageOf(JSON.stringify({ v: 'aaa111', icon: PNG, k: K, m: true }))), { v: 'aaa111', icon: PNG, k: K, m: true });
  assert.deepEqual(readKept(storageOf(JSON.stringify({ v: 'aaa111', icon: PNG, k: K }))), { v: 'aaa111', icon: PNG, k: K });
  // A key is a path segment of a URL the page sets itself: nothing but the hex shape gets there.
  for (const bad of ['../../x', K.toUpperCase(), K + '0', 'https://example.com', 7]) {
    assert.deepEqual(readKept(storageOf(JSON.stringify({ v: 'aaa111', icon: PNG, k: bad, m: true }))), { v: 'aaa111', icon: PNG }, String(bad));
  }

  assert.deepEqual(linkTargets(null), { icon: null, touch: null, manifest: null }, 'no copy: the public files');
  assert.deepEqual(linkTargets({ v: 'a', icon: PNG, touch: PNG }), { icon: PNG, touch: PNG, manifest: null }, 'no key: data URLs, the public manifest');
  assert.deepEqual(linkTargets({ v: 'a', icon: PNG, touch: PNG, k: K, m: true }), {
    icon: PNG,
    touch: `api/art/k/${K}/apple-touch-icon.png`,
    manifest: `api/art/k/${K}/manifest.webmanifest`,
  });
  assert.equal(linkTargets({ v: 'a', icon: PNG, k: K }).manifest, null, 'no keyed manifest on the server: the public one stays');
  assert.equal(linkTargets({ v: 'a', icon: PNG, k: K, m: true }).touch, null, 'no touch picture in the folder: the public one stays');
});

test('badgeSrc: the public badge wherever there is no kept copy (node has no localStorage)', () => {
  assert.equal(badgeSrc(), 'img/zuno.png');
});
