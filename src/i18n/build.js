// Assembles one language from its meta and namespace tables: every key
// becomes '<namespace>.<key>' in one flat map. Throws on a key defined twice
// (the completeness test in src/tests/i18n.test.mjs runs every language
// through this, so a collision fails `npm test`, never a phone).

const NAMESPACES = ['common', 'shell', 'home', 'history', 'more', 'login', 'authInfo', 'howto', 'forms', 'errors', 'api'];

export { NAMESPACES };

export function buildLocale(meta, namespaces) {
  if (!meta || typeof meta.id !== 'string') throw new Error('locale meta needs an id');
  const messages = {};
  for (const ns of NAMESPACES) {
    const table = namespaces[ns];
    if (!table || typeof table !== 'object') throw new Error(`locale ${meta.id}: namespace "${ns}" missing`);
    for (const [k, v] of Object.entries(table)) {
      const key = `${ns}.${k}`;
      if (Object.prototype.hasOwnProperty.call(messages, key)) throw new Error(`locale ${meta.id}: duplicate key ${key}`);
      messages[key] = v;
    }
  }
  return { meta, messages };
}
