// The general-purpose stopwatch behind the hero's timer chip. Strictly local:
// state lives in this device's localStorage (survives reloads, never syncs to
// the other phone) and nothing is ever logged to the server.
//
// Start begins counting, "Neu starten" resets to zero (keeps running),
// "Timer beenden" stops it. Closing the sheet (✕/backdrop/Back) just puts the
// overlay away — a running timer keeps counting in the chip.

import { prefs } from './store.js';
import { openSheet } from './sheet.js';
import { fmtTimer } from './ui.js';
import { t } from './i18n/index.js';

export function openTimerSheet(onChange = () => {}) {
  openSheet(t('home.timer.title'), (body) => {
    function render() {
      const start = prefs.timerStartedAt;
      body.innerHTML = `
        <div class="timer-pane">
          <p class="timer-display${start ? '' : ' idle'}" data-timer-display>
            ${fmtTimer(start ? (Date.now() - start) / 1000 : 0)}
          </p>
          <div class="form-actions">
            ${start
              ? `<button type="button" class="btn" data-timer-reset>${t('home.timer.restart')}</button>
                 <button type="button" class="btn primary" data-timer-stop>${t('home.timer.stop')}</button>`
              : `<button type="button" class="btn primary" data-timer-start>${t('home.timer.start')}</button>`}
          </div>
        </div>`;
      body.querySelector('[data-timer-start]')?.addEventListener('click', () => {
        prefs.timerStartedAt = Date.now();
        onChange();
        render();
      });
      body.querySelector('[data-timer-reset]')?.addEventListener('click', () => {
        prefs.timerStartedAt = Date.now();
        onChange();
        render();
      });
      body.querySelector('[data-timer-stop]')?.addEventListener('click', () => {
        prefs.timerStartedAt = null;
        onChange();
        render();
      });
    }

    render();

    // Self-cleaning tick: stops itself once the sheet is gone from the DOM.
    const interval = setInterval(() => {
      if (!document.body.contains(body)) {
        clearInterval(interval);
        return;
      }
      const d = body.querySelector('[data-timer-display]');
      const start = prefs.timerStartedAt;
      if (d && start) d.textContent = fmtTimer((Date.now() - start) / 1000);
    }, 1000);
  });
}
