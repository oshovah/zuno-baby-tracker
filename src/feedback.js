// Feedback to the operator — the pure half (node-tested): what a message
// holds, its checks, and how the inbox reads one back. The sheet
// (feedback-sheet.js) collects the input, the store seals and sends it.
//
// A message is a plain object sealed to the operator's inbox key
// (crypto.sealFeedback adds v: 2):
//   { kind: 'idea' | 'bug' | 'other', text, from, sentAt, app }
//   from  { username, familyName, displayName? } — or null: ANONYMOUS. The
//         server stores no sender either (api/lib/feedback.php), so an
//         anonymous message says nothing about who wrote it.
//   app   { version, lang, theme, standalone, screen, ua } — or null when the
//         writer unticked «Technische Angaben»; the form shows it before
//         sending (techLines).
// The inbox never trusts a decrypted message's shape: readMessage folds
// anything odd into something showable.

export const FEEDBACK_KINDS = ['idea', 'bug', 'other'];
export const FEEDBACK_MAX_TEXT = 3000;

const cap = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

/** The text as it will be sent (trimmed, line ends normalised). */
export function normaliseText(text) {
  return typeof text === 'string' ? text.replace(/\r\n?/g, '\n').trim() : '';
}

/**
 * Why a draft cannot be sent, as an i18n key — or null when it can.
 * `text` is the raw textarea value.
 */
export function draftError({ kind, text }) {
  if (!FEEDBACK_KINDS.includes(kind)) return 'feedback.form.errorKind';
  const clean = normaliseText(text);
  if (clean === '') return 'feedback.form.errorEmpty';
  if ([...clean].length > FEEDBACK_MAX_TEXT) return 'feedback.form.errorLong';
  return null;
}

/**
 * The technical details a bug report may carry. `env` is what the page
 * knows — the caller passes it in (no DOM here): { version, lang, theme,
 * standalone, screen, ua }.
 */
export function techInfo(env = {}) {
  return {
    version: cap(env.version, 32),
    lang: cap(env.lang, 8),
    theme: cap(env.theme, 32),
    standalone: env.standalone === true,
    screen: cap(env.screen, 32),
    ua: cap(env.ua, 300),
  };
}

/** The lines the form shows under «Technische Angaben» (and the inbox under a message). */
export function techLines(app) {
  if (!app || typeof app !== 'object') return [];
  const lines = [];
  const add = (label, value) => {
    if (typeof value === 'string' && value !== '') lines.push({ label, value });
  };
  add('version', app.version);
  add('lang', app.lang);
  add('theme', app.theme);
  if (typeof app.standalone === 'boolean') lines.push({ label: 'standalone', value: app.standalone });
  add('screen', app.screen);
  add('ua', app.ua);
  return lines;
}

/**
 * The message object for a valid draft. `user` = prefs.user ({username,
 * familyName, displayName}); ignored when `anonymous`. `app` = techInfo(…)
 * or null. Throws on an invalid draft — check draftError first.
 */
export function buildMessage({ kind, text, anonymous, user, app, nowIso }) {
  const error = draftError({ kind, text });
  if (error) throw new Error(error);
  let from = null;
  if (!anonymous && user && typeof user.username === 'string') {
    from = { username: cap(user.username, 64), familyName: cap(user.familyName, 64) };
    if (typeof user.displayName === 'string' && user.displayName !== '') from.displayName = cap(user.displayName, 64);
  }
  return {
    kind,
    text: normaliseText(text),
    from,
    sentAt: typeof nowIso === 'string' ? nowIso : new Date().toISOString(),
    app: app && typeof app === 'object' ? app : null,
  };
}

/**
 * A decrypted message as the inbox shows it: every field checked, unknown
 * kinds read as 'other', the text capped. Never throws.
 */
export function readMessage(plain) {
  const p = plain && typeof plain === 'object' ? plain : {};
  const f = p.from && typeof p.from === 'object' ? p.from : null;
  const from =
    f && typeof f.username === 'string' && f.username !== ''
      ? { username: cap(f.username, 64), familyName: cap(f.familyName, 64), displayName: cap(f.displayName, 64) }
      : null;
  return {
    kind: FEEDBACK_KINDS.includes(p.kind) ? p.kind : 'other',
    text: cap(p.text, FEEDBACK_MAX_TEXT * 2),
    from,
    sentAt: typeof p.sentAt === 'string' && Number.isFinite(Date.parse(p.sentAt)) ? p.sentAt : null,
    app: p.app && typeof p.app === 'object' ? techInfo(p.app) : null,
  };
}

/** «Mama (mama · Testfamilie)» — the sender line; null for an anonymous message. */
export function senderParts(from) {
  if (!from) return null;
  const name = from.displayName || from.username;
  const detail = [from.displayName ? from.username : '', from.familyName].filter(Boolean).join(' · ');
  return { name, detail };
}
