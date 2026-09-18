// Bottom sheet: the one overlay pattern in the app (quick entries + editing).
// openSheet(title, build) -> close function; build(body, close, setGuard)
// fills the content. Backdrop tap, Esc, and the hardware/gesture Back all
// close it — and all three respect a dirty-form guard (two-step discard), so
// a stray 3am tap can't throw away half-filled input.

import { escapeHtml, toast } from './ui.js';
import { t } from './i18n/index.js';

let active = null; // close function of the currently open sheet, if any

/** Force-close whatever sheet is open (e.g. before swapping to the login view). */
export function closeActiveSheet() {
  if (active) active();
}

export function openSheet(title, build) {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true" tabindex="-1" aria-label="${escapeHtml(title)}">
      <div class="sheet-head">
        <h2>${escapeHtml(title)}</h2>
        <button type="button" class="sheet-close" aria-label="${escapeHtml(t('shell.sheet.close'))}">✕</button>
      </div>
      <div class="sheet-body"></div>
    </div>`;

  const openedAt = Date.now();
  const prevFocus = document.activeElement;
  let guard = null; // () => false while closing would discard unsaved input
  let confirmUntil = 0;
  let closed = false;
  let awaitingPop = false; // we called history.back() and wait for its popstate
  let popFallback = null;

  function reallyClose() {
    if (closed) return;
    closed = true;
    clearTimeout(popFallback);
    active = null;
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('popstate', onPop);
    backdrop.classList.add('closing');
    document.body.classList.remove('sheet-open');
    setTimeout(() => backdrop.remove(), 180);
    if (prevFocus && typeof prevFocus.focus === 'function') {
      try {
        prevFocus.focus();
      } catch {
        /* the opener may be gone */
      }
    }
  }

  /**
   * UI close = consume our history entry and let ITS popstate remove the DOM.
   * History stays the single source of truth: the sheet never sits "closed"
   * while a pending traversal could still swallow the user's next navigation.
   */
  function performClose() {
    if (closed || awaitingPop) return;
    awaitingPop = true;
    history.back();
    // Safety net for embedders that never deliver the popstate.
    popFallback = setTimeout(() => {
      if (!closed) reallyClose();
    }, 400);
  }

  /** Dismissal (backdrop/Esc/Back/✕): needs a second attempt when dirty. */
  function requestClose(viaPop) {
    if (guard && !guard() && Date.now() > confirmUntil) {
      confirmUntil = Date.now() + 3000;
      if (viaPop) {
        // Back already popped our entry — restore it so the sheet stays.
        history.pushState({ btSheet: 1 }, '');
      }
      toast(t('shell.sheet.discardAgain'), 'info');
      return;
    }
    if (viaPop) reallyClose();
    else performClose();
  }

  const close = () => performClose();

  const onKey = (e) => {
    if (e.key === 'Escape') {
      requestClose(false);
      return;
    }
    if (e.key === 'Tab') {
      // Keep Tab inside the dialog — aria-modal promises as much.
      const focusables = [...backdrop.querySelectorAll('button, input, select, textarea, a[href]')].filter(
        (el) => !el.disabled && el.offsetParent !== null
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  const onPop = () => {
    if (awaitingPop) {
      // The traversal we started in performClose() — finish the close.
      reallyClose();
    } else {
      // The user pressed Back/edge-swiped: dismiss (guarded when dirty).
      requestClose(true);
    }
  };

  // Close only taps that START and END on the backdrop (a text-selection drag
  // released outside the sheet fires a backdrop click otherwise), and never
  // within 300 ms of opening (the second half of a double-tap on the row that
  // opened the sheet lands on the backdrop).
  let downOnBackdrop = false;
  backdrop.addEventListener('pointerdown', (e) => {
    downOnBackdrop = e.target === backdrop;
  });
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop && downOnBackdrop && Date.now() - openedAt > 300) {
      requestClose(false);
    }
  });
  backdrop.querySelector('.sheet-close').addEventListener('click', () => requestClose(false));
  document.addEventListener('keydown', onKey);
  window.addEventListener('popstate', onPop);

  document.body.appendChild(backdrop);
  document.body.classList.add('sheet-open');
  history.pushState({ btSheet: 1 }, '');
  // Force-close must not be blocked by the dirty guard (401 -> login swap).
  active = () => {
    guard = null;
    performClose();
  };

  build(backdrop.querySelector('.sheet-body'), close, (fn) => {
    guard = fn;
  });

  // Focus the dialog itself: reachable for keyboard/VoiceOver without popping
  // the iOS keyboard the way focusing the first input would.
  backdrop.querySelector('.sheet').focus();

  return close;
}
