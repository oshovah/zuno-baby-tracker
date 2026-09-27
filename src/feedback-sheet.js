// Feedback in the bottom sheet (opened from Mehr › Anleitung):
//   openFeedbackForm()   a parent writes to the operator — kind, text,
//                        «Anonym senden», «Technische Angaben» (shown before
//                        sending); sealed and sent by store.feedback.send
//   openFeedbackInbox()  the operator reads: newest first, «Neu» on what was
//                        unread when the sheet opened (marked read on the
//                        server as it is shown), mark unread again, delete
//                        for good (two taps), older pages on demand
// The message's shape and checks are the pure src/feedback.js. Everything a
// message carries is user text: escaped before it reaches innerHTML.

import { store, prefs } from './store.js';
import { t, getLocale, localeMeta } from './i18n/index.js';
import { openSheet } from './sheet.js';
import { segmented, wireSegmented, segValue } from './entry-form.js';
import { escapeHtml, toast, isoNow } from './ui.js';
import { newestWhatsNewId } from './whats-new.js';
import {
  FEEDBACK_KINDS,
  FEEDBACK_MAX_TEXT,
  draftError,
  normaliseText,
  techInfo,
  techLines,
  buildMessage,
  senderParts,
} from './feedback.js';

const ARM_MS = 3000;

// 'other' is not a key suffix: '.other' reads as a plural form (i18n test).
const KIND_KEYS = { idea: 'feedback.kind.idea', bug: 'feedback.kind.bug', other: 'feedback.kind.misc' };
const kindLabel = (kind) => t(KIND_KEYS[kind] || KIND_KEYS.other);

/** What the page knows about itself — the «Technische Angaben». */
function currentTech() {
  const standalone =
    (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  return techInfo({
    version: newestWhatsNewId() || '',
    lang: getLocale(),
    theme: prefs.theme || document.documentElement.dataset.theme || '',
    standalone,
    screen: `${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio || 1}x`,
    ua: navigator.userAgent || '',
  });
}

function techListHtml(app) {
  return techLines(app)
    .map((l) => `<li><span class="fb-tech-key">${escapeHtml(l.label)}</span> ${escapeHtml(String(l.value))}</li>`)
    .join('');
}

/** A parent's message to the operator. */
export function openFeedbackForm() {
  openSheet(t('feedback.form.title'), (body, close, setGuard) => {
    const user = prefs.user;
    const name = user ? user.displayName || user.username : '';
    const tech = currentTech();
    body.innerHTML = `
      <form class="entry-form feedback-form" novalidate>
        <p class="hint">${escapeHtml(t('feedback.form.intro'))}</p>
        <div class="field"><span>${escapeHtml(t('feedback.form.kindLabel'))}</span>
          ${segmented('kind', t('feedback.form.kindLabel'), FEEDBACK_KINDS.map((k) => ({ value: k, label: kindLabel(k) })), 'idea')}
        </div>
        <label class="field"><span>${escapeHtml(t('feedback.form.textLabel'))}
            <small data-count>${escapeHtml(t('feedback.form.count', { n: 0, max: FEEDBACK_MAX_TEXT }))}</small></span>
          <textarea name="text" class="fb-text" rows="6" maxlength="${FEEDBACK_MAX_TEXT + 200}"
            placeholder="${escapeHtml(t('feedback.form.placeholder'))}"></textarea>
        </label>
        <label class="confirm-row switch-row">
          <input type="checkbox" data-anonymous />
          <span>${escapeHtml(t('feedback.form.anonymous'))}</span>
        </label>
        <p class="hint" data-who-hint></p>
        <label class="confirm-row switch-row">
          <input type="checkbox" data-tech />
          <span>${escapeHtml(t('feedback.form.tech'))}</span>
        </label>
        <div class="hint" data-tech-list hidden>
          <p>${escapeHtml(t('feedback.form.techHint'))}</p>
          <ul class="fb-tech">${techListHtml(tech)}</ul>
        </div>
        <p class="form-error" aria-live="polite"></p>
        <div class="form-actions">
          <button type="submit" class="btn primary" data-send>${escapeHtml(t('feedback.form.send'))}</button>
        </div>
      </form>`;

    wireSegmented(body);
    const form = body.querySelector('form');
    const textEl = form.querySelector('[name="text"]');
    const countEl = body.querySelector('[data-count]');
    const anonEl = body.querySelector('[data-anonymous]');
    const whoHint = body.querySelector('[data-who-hint]');
    const techEl = body.querySelector('[data-tech]');
    const techList = body.querySelector('[data-tech-list]');
    const errEl = body.querySelector('.form-error');
    const sendBtn = body.querySelector('[data-send]');

    let dirty = false;
    let techTouched = false;
    setGuard(() => !dirty);

    function syncWho() {
      whoHint.textContent = anonEl.checked || !name ? t('feedback.form.anonymousHint') : t('feedback.form.namedHint', { name });
    }
    function syncTech() {
      techList.hidden = !techEl.checked;
    }
    function syncCount() {
      const n = [...normaliseText(textEl.value)].length;
      countEl.textContent = t('feedback.form.count', { n, max: FEEDBACK_MAX_TEXT });
      countEl.classList.toggle('over', n > FEEDBACK_MAX_TEXT);
    }
    // A bug report brings the details by default; the writer's own choice sticks.
    function kindChanged() {
      if (!techTouched) {
        techEl.checked = segValue(body, 'kind') === 'bug';
        syncTech();
      }
    }

    textEl.addEventListener('input', () => {
      dirty = true;
      errEl.textContent = '';
      syncCount();
    });
    body.querySelector('.segmented[data-name="kind"]').addEventListener('click', () => {
      dirty = true;
      kindChanged();
    });
    anonEl.addEventListener('change', syncWho);
    techEl.addEventListener('change', () => {
      techTouched = true;
      syncTech();
    });
    syncWho();
    syncTech();
    syncCount();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const draft = { kind: segValue(body, 'kind'), text: textEl.value };
      const error = draftError(draft);
      if (error) {
        errEl.textContent = t(error, { max: FEEDBACK_MAX_TEXT });
        return;
      }
      errEl.textContent = '';
      sendBtn.disabled = true;
      sendBtn.textContent = t('feedback.form.sending');
      try {
        const message = buildMessage({
          ...draft,
          anonymous: anonEl.checked,
          user,
          app: techEl.checked ? tech : null,
          nowIso: isoNow(),
        });
        await store.feedback.send(message);
        dirty = false;
        toast(t('feedback.form.sent'), 'success');
        close();
      } catch (err) {
        // Nothing was stored: the text stays, the button comes back.
        errEl.textContent = err && err.code === 'feedback.unavailable' ? t('feedback.form.unavailable') : err.message;
        sendBtn.disabled = false;
        sendBtn.textContent = t('feedback.form.send');
      }
    });
  });
}

/** «27. Sep. 2026, 08:14» in the active language; the row's day when the message has no time. */
function sentLabel(item) {
  const iso = item.message && item.message.sentAt;
  try {
    if (iso) {
      return new Date(iso).toLocaleString(localeMeta().dateLocale, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    }
    const [y, m, d] = String(item.createdAt).split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(localeMeta().dateLocale, { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return String(item.createdAt || '');
  }
}

function itemHtml(item, { fresh, armedId }) {
  const msg = item.message;
  const armed = armedId === item.id;
  const actions = `
    <span class="fb-actions">
      ${msg ? `<button type="button" class="chip" data-toggle-read="${item.id}">${escapeHtml(t(item.readAt ? 'feedback.inbox.markUnread' : 'feedback.inbox.markRead'))}</button>` : ''}
      <button type="button" class="chip${armed ? ' danger' : ''}" data-delete="${item.id}">${escapeHtml(t(armed ? 'feedback.inbox.deleteConfirm' : 'feedback.inbox.delete'))}</button>
    </span>`;
  if (!msg) {
    return `<article class="fb-item unreadable"><p class="hint">${escapeHtml(t('feedback.inbox.unreadable'))} · ${escapeHtml(sentLabel(item))}</p>${actions}</article>`;
  }
  const sender = senderParts(msg.from);
  const who = sender
    ? `<strong>${escapeHtml(sender.name)}</strong>${sender.detail ? ` <span class="fb-detail">${escapeHtml(sender.detail)}</span>` : ''}`
    : `<strong>${escapeHtml(t('feedback.inbox.anonymous'))}</strong>`;
  const tech = techListHtml(msg.app);
  return `
    <article class="fb-item${fresh ? ' fresh' : ''}${item.readAt ? '' : ' unread'}">
      <p class="fb-head">
        <span class="fb-kind">${escapeHtml(kindLabel(msg.kind))}</span>
        ${fresh ? `<span class="fb-new">${escapeHtml(t('feedback.inbox.new'))}</span>` : ''}
        <span class="fb-when">${escapeHtml(sentLabel(item))}</span>
      </p>
      <p class="fb-from">${who}</p>
      <p class="fb-body">${escapeHtml(msg.text)}</p>
      ${tech ? `<details class="fb-tech-box"><summary>${escapeHtml(t('feedback.inbox.tech'))}</summary><ul class="fb-tech">${tech}</ul></details>` : ''}
      ${actions}
    </article>`;
}

/** The operator's inbox. */
export function openFeedbackInbox() {
  openSheet(t('feedback.inbox.title'), (body) => {
    let items = [];
    let next = null;
    let loading = true;
    let armedId = null;
    let armTimer = null;
    const fresh = new Set(); // unread when shown — keeps its «Neu» for this viewing

    function render() {
      const list = items.map((it) => itemHtml(it, { fresh: fresh.has(it.id), armedId })).join('');
      body.innerHTML = `
        <div class="fb-inbox">
          ${loading && !items.length ? `<p class="hint">${escapeHtml(t('feedback.inbox.loading'))}</p>` : ''}
          ${!loading && !items.length ? `<p class="hint">${escapeHtml(t('feedback.inbox.empty'))}</p>` : ''}
          ${list}
          ${next ? `<button type="button" class="btn wide" data-more ${loading ? 'disabled' : ''}>${escapeHtml(t('feedback.inbox.more'))}</button>` : ''}
        </div>`;
    }

    /** Everything shown unread goes read on the server; the «Neu» stays until the sheet closes. */
    async function markShown(page) {
      for (const it of page) {
        if (it.readAt || !it.message) continue;
        try {
          it.readAt = await store.feedback.setRead(it, true);
        } catch {
          /* stays unread — the next opening tries again */
        }
      }
    }

    async function load(before = 0) {
      loading = true;
      render();
      try {
        const page = await store.feedback.inbox(before);
        items = before ? [...items, ...page.items] : page.items;
        next = page.next;
        page.items.forEach((it) => {
          if (!it.readAt && it.message) fresh.add(it.id);
        });
        loading = false;
        render();
        await markShown(page.items);
        render();
      } catch (err) {
        loading = false;
        render();
        toast(err.message);
      }
    }

    function disarm() {
      clearTimeout(armTimer);
      armTimer = null;
      armedId = null;
    }

    body.addEventListener('click', async (e) => {
      const more = e.target.closest('[data-more]');
      if (more && next && !loading) {
        load(next);
        return;
      }
      const toggle = e.target.closest('[data-toggle-read]');
      if (toggle) {
        const item = items.find((it) => it.id === Number(toggle.dataset.toggleRead));
        if (!item) return;
        toggle.disabled = true;
        try {
          item.readAt = await store.feedback.setRead(item, !item.readAt);
          fresh.delete(item.id);
        } catch (err) {
          toast(err.message);
        }
        render();
        return;
      }
      const del = e.target.closest('[data-delete]');
      if (del) {
        const id = Number(del.dataset.delete);
        if (armedId !== id) {
          disarm();
          armedId = id;
          armTimer = setTimeout(() => {
            disarm();
            render();
          }, ARM_MS);
          render();
          return;
        }
        disarm();
        const item = items.find((it) => it.id === id);
        if (!item) return;
        try {
          await store.feedback.remove(item);
          items = items.filter((it) => it.id !== id);
          toast(t('feedback.inbox.deleted'), 'success');
        } catch (err) {
          toast(err.message);
        }
        render();
      }
    });

    load();
  });
}
