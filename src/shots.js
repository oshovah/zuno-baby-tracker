// The screenshot slider on the login page (views/login.js shotsHtml): which
// screens it shows, in which order, and for which languages pictures exist.
// Pure, so the generator (scripts/make-screenshots.mjs — it takes the
// pictures of the REAL app with invented data) and the node test read the
// same list. The pictures sit next to this file, src/shots/<lang>-<id>.webp,
// and not in public/: the view imports them through Vite, which puts a
// content hash into their URLs — the packaged .htaccess serves images as
// immutable for a month, so a re-shot picture needs a new address.
//
// A new screen: add its id here, a recipe for it in the generator's RECIPES,
// a caption `shots.<id>` in every language's login.js, then `npm run
// screenshots`. A new language: add it here and re-shoot — until then its
// visitors see the English pictures.

/** Screen ids in the order the slider shows them. */
export const SHOTS = ['home', 'timer', 'bottle', 'history', 'charts'];

/** Languages with their own set of pictures. */
export const SHOT_LANGS = ['de', 'en'];

const FALLBACK_LANG = 'en';

/** The pixels of every picture: a 390 × 844 phone at 2x. */
export const SHOT_SIZE = { width: 780, height: 1688 };

/** File name (inside src/shots/) of screen `id` for `locale`. */
export function shotFile(id, locale) {
  const lang = SHOT_LANGS.includes(locale) ? locale : FALLBACK_LANG;
  return `${lang}-${id}.webp`;
}
