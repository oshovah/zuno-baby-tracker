// "Jetzt" — the 3am screen. Big "time since" answers on top, one-tap logging
// below. Everything renders instantly from the cached state; a stale stamp
// appears when the data is older than a couple of minutes.

import { store, prefs } from '../store.js';
import { openEntryForm } from '../entry-form.js';
import { openTimerSheet } from '../timer.js';
import { openTodoSheet, tickTodo, todoDetail } from '../todo-sheet.js';
import { openOutboxSheet } from '../outbox-sheet.js';
import { nextTodo, todoFlipAt, overdueCount } from '../reminders.js';
import {
  mealPartsLabel,
  mealClockRange,
  mealTotalShown,
  mealTotalText,
  mealSinceIso,
  sinceLabel,
  liveSideInMeal,
  startBackChips,
  nextSideFor,
  wetCountLabel,
} from '../meals.js';
import {
  escapeHtml,
  toast,
  errorBlock,
  TYPE_META,
  DIAPER_KINDS,
  SIDE_LABELS,
  bottleAmountLabel,
  fmtClock,
  fmtAgoShort,
  fmtAgoBareShort,
  fmtInShort,
  fmtTimer,
  fmtDurationMin,
  minutesBetween,
  agoParts,
  isoNow,
  nowMs,
  localDateOf,
  localToday,
  shiftDate,
  icon,
  QUICK_FEED_LIVE_MIN,
  pausedFeed,
  pauseEndsMs,
} from '../ui.js';
import { t, tn } from '../i18n/index.js';


// After the live window, a duration-less feed gets one quiet "Wie lange
// gestillt?" chip row on the hero — the phone usually reopens AFTER the feed,
// and the parent knows the duration, not the wall-clock end. One tap, honest
// data, optional. Gone after a few hours or once a duration exists.
const RETRO_DUR_CHIPS_MIN = [10, 15, 20, 30];
const RETRO_MAX_AGE_MIN = 180;

// Write preconditions for store.entries.update: on a 409 (the row moved on
// the other phone) the store syncs, re-reads the entry and retries once only
// while the condition still holds — otherwise "Der Timer wurde bereits
// beendet". Stopping a RUNNING timer needs it open; the retro chips and
// "Stillen beenden" on a quick feed need it still duration-less.
// Named (outbox.GUARDS), not functions: a write made without network waits
// in the outbox and is judged against the partner's fresh row when it is
// sent — the name survives a reload, a closure would not.
const IF_OPEN = { guard: 'open' };
const IF_DURATIONLESS = { guard: 'durationless' };
// The paused hero's «Stillen beenden» and the undo of a pause need the side
// still paused — the partner may have ended or resumed it meanwhile.
const IF_PAUSED = { guard: 'paused' };

/** The stop patch: `ifOpen` also rejects locally when the model already holds
 *  the partner's end (a sync applied mid-tap) — never overwrite it. */
const stopNow = () => ({ endedAt: isoNow(), ifOpen: true });

function agoPartsHtml(iso) {
  return agoParts(iso)
    .map((p) => `<b>${p.v}</b><i>${p.u}</i>`)
    .join('');
}

function elapsedSecs(iso) {
  return (nowMs() - new Date(iso)) / 1000;
}

/** "seit 14:32 ▾" on the live hero — the time is a button that unfolds the
 *  one-tap start corrections (meals.startBackChips: "the timer was started
 *  five minutes into the feed"), plus the full form for anything else. `open`
 *  keeps the row visible across a re-render. A later side's start must not be
 *  pushed back over the earlier feeds of its meal (`notBeforeMs`): those
 *  chips are left out, the form link on the label line stays. */
function startLineHtml(startedAt, open, notBeforeMs = 0) {
  const chips = startBackChips(new Date(startedAt).getTime(), notBeforeMs);
  const timeBtn = `<button type="button" class="linklike start-btn" data-adjust-start
      aria-expanded="${open ? 'true' : 'false'}">${fmtClock(startedAt)} <span class="start-caret" aria-hidden="true">▾</span></button>`;
  return `
    <p class="hero-sub">${t('home.hero.sinceTime', { time: timeBtn })}</p>
    <div class="retro-row start-row" data-start-row ${open ? '' : 'hidden'}>
      <span class="retro-label">${t('home.hero.startedEarlier')} ·
        <button type="button" class="linklike" data-edit-feed>${t('home.hero.adjust')}</button></span>
      ${chips.map(
        (m) => `<button type="button" class="chip" data-start-back="${m}">${t('home.hero.startBackChip', { n: m })}</button>`
      ).join('')}
    </div>`;
}

/** "Mahlzeit seit 13:02 · 18 Min." under the live timer when this side is the
 *  meal's second (or later) entry: the stored sides' minutes plus the live
 *  side's elapsed time, kept running by tick(). Without the total when an
 *  earlier side was never stopped — its minutes are unknown, and a running
 *  number would say the side took none. */
function mealLineHtml(meal, liveStartedAt, withTotal) {
  return `
    <p class="hero-sub meal-line">${t('home.hero.mealSince', { time: fmtClock(meal.startedAt) })}${withTotal
      ? ` · <span data-meal-total data-meal-base="${meal.minutes}" data-meal-live="${liveStartedAt}">${mealTotalText(meal.minutes, liveStartedAt, nowMs())}</span>`
      : ''}</p>`;
}

// --- Erinnerungen on the home screen ------------------------------------------
// With «Erinnerungen» chosen for the fourth slot (Mehr › Einstellungen ›
// Startbildschirm) the mini card next to the diaper card answers "what is
// next" (reminders.nextTodo) — and ticks that item off with one tap — while
// the sleep tile's place in the quick grid holds the «Erinnerungen» tile
// that opens today's checklist in the bottom sheet (todo-sheet.js), so the
// screen keeps its one-screen height whatever the day holds.

/** The mini card: the next to-do (tappable = tick it off), "everything done" or "none yet". */
function todoCardHtml(next, hasReminders, overdue = 0) {
  if (!next) {
    return hasReminders
      ? `<div class="mini card todo">
          <span class="mini-label">${t('home.todo.label')}</span>
          <span class="mini-value">${t('home.todo.allDoneCheck')}</span>
        </div>`
      : `<button type="button" class="mini card todo" data-goto-reminders>
          <span class="mini-label">${t('home.todo.label')}</span>
          <span class="mini-value muted">${t('home.card.noneYet')}</span>
          <span class="mini-hint">${t('home.todo.create')}</span>
        </button>`;
  }
  const o = next.item;
  const detail = todoDetail(o);
  let label = t('home.todo.nextUp');
  let when;
  // One short line: the clock time, then the coarse span (ui.fmtSpanShort)
  // — «15:00 · seit 3½ Std.» fits the half-width card on a narrow phone.
  if (next.day === 'tomorrow') {
    label = t('home.todo.allDone');
    when = t('home.todo.tomorrowAt', { time: o.time });
  } else if (next.status === 'upcoming') {
    when = `${o.time} · <span data-in-short="${o.due}">${fmtInShort(o.due)}</span>`;
  } else {
    // «2 Überfällig»: how many are past their hour, not just that this one is.
    label = next.status === 'overdue' ? tn('home.todo.overdueCount', overdue || 1) : t('home.todo.dueNow');
    when = t('home.todo.dueSince', {
      time: o.time,
      span: `<span data-ago-bare-short="${o.due}">${fmtAgoBareShort(o.due)}</span>`,
    });
  }
  const inner = `
    <span class="mini-label">${label}</span>
    <span class="mini-value">${escapeHtml(o.title)}${detail ? ` <span class="mini-detail">${escapeHtml(detail)}</span>` : ''}</span>
    <span class="mini-sub">${when}</span>`;
  const cls = `mini card todo${next.status === 'overdue' && next.day === 'today' ? ' overdue' : ''}`;
  // Today's item is one tap away from done; tomorrow's is information only.
  return next.day === 'today'
    ? `<button type="button" class="${cls}" data-tick-next aria-label="${t('home.todo.tickAria', { title: escapeHtml(o.title), time: o.time })}">
        ${inner}
        <span class="mini-hint">${t('home.todo.tick')}</span>
      </button>`
    : `<div class="${cls}">${inner}</div>`;
}

/** The «Erinnerungen» tile: how many are open today (red once one is overdue). */
function todoTileHtml(todos, hasReminders, next) {
  const open = (todos.today || []).filter((o) => !o.done).length;
  let pill;
  if (!hasReminders) pill = t('home.todo.create');
  else if (open === 0) pill = t('home.todo.doneCheck');
  else pill = t('home.todo.open', { n: open });
  const overdue = !!next && next.day === 'today' && next.status === 'overdue';
  return `
      <button type="button" class="quick todo" ${hasReminders ? 'data-todo-sheet' : 'data-goto-reminders'}>
        ${icon('reminder', 'q-emoji')}<span>${t('home.todo.label')}</span><span class="q-next todo-pill${overdue ? ' overdue' : ''}">${pill}</span>
      </button>`;
}

/** Write only when the text changed — keeps the 1 s tick from churning nodes. */
function setText(node, text) {
  if (node.dataset.last === text) return;
  node.dataset.last = text;
  node.textContent = text;
}

function setHtml(node, html) {
  if (node.dataset.last === html) return;
  node.dataset.last = html;
  node.innerHTML = html;
}

export function renderHome(el) {
  let tickTimer = null;
  let lastKey = null;
  let flipAtMs = 0; // next time-driven UI change (live hero ends / retro row expires)
  let startRowOpen = false; // the "Früher begonnen?" chips under the live hero
  let busy = false;

  function openTimer(state, type) {
    return state.openTimers.find((t) => t.type === type) || null;
  }

  /**
   * Run a write. On success, refresh AFTER the write (a GET already in flight
   * may carry pre-write state); on failure, toast only the write error — a
   * refresh hiccup right after a successful save must not read as "not saved".
   */
  async function act(fn, opts = {}) {
    if (busy) return;
    busy = true;
    if (opts.btn) opts.btn.disabled = true;
    try {
      // The cached snapshot paints before the local rows are decrypted; a
      // write needs them (the open-timer rule, the row an update merges
      // onto) — a tap in that first moment waits instead of failing.
      await store.ready;
      await fn();
    } catch (err) {
      (opts.onError || ((e) => toast(e.message)))(err);
      store.refresh().catch(() => {});
      busy = false;
      render(true); // re-enable buttons even when the state did not change
      return;
    }
    busy = false;
    store.refreshAfterWrite().catch(() => {});
  }

  function createQuick(type, details, message, extra = {}, btn = null) {
    return act(async () => {
      const entry = await store.entries.create({
        type,
        details,
        ...extra,
      });
      toast(message, 'success', {
        action: {
          label: t('common.action.undo'),
          onClick: () =>
            act(async () => {
              await store.entries.remove(entry.eid);
            }),
        },
      });
    }, { btn });
  }

  function stopTimer(entry, doneKey, btn) {
    return act(async () => {
      // A stale phone must not silently move an end time the other parent
      // already set — the store answers "Der Timer wurde bereits beendet"
      // (after syncing) and the refresh corrects us.
      const closed = await store.entries.update(entry.eid, stopNow(), IF_OPEN);
      const mins = minutesBetween(closed.startedAt, closed.endedAt);
      toast(t(doneKey, { span: fmtDurationMin(mins) }), 'success', {
        action: {
          label: t('common.action.undo'),
          onClick: () =>
            act(async () => {
              await store.entries.update(entry.eid, { endedAt: null });
              toast(t('home.toast.timerRunningAgain', { type: TYPE_META[entry.type].label }), 'success');
            }),
        },
      });
    }, { btn });
  }

  /**
   * «Weiter» after a pause: the same side starts again as a quick-logged
   * feed (Ende == Start, live for a while — exactly what «Wechseln» does for
   * the other side); the meal folds the two entries of the side together,
   * the pause between them is no feeding time.
   */
  function resumeSide(side, pausedEntry, btn) {
    return act(async () => {
      // Never before the pause's own end: the resumed row must sort as the
      // newer feed on both phones (a second of residual skew would
      // otherwise leave the paused row as the last feed).
      const now = new Date(Math.max(nowMs(), new Date(pausedEntry.endedAt).getTime() + 1000)).toISOString();
      const entry = await store.entries.create({
        type: 'breastfeed',
        details: { side },
        startedAt: now,
        endedAt: now,
      });
      toast(t('home.toast.resumed', { side: SIDE_LABELS[side] }), 'success', {
        action: {
          label: t('common.action.undo'),
          onClick: () =>
            act(async () => {
              await store.entries.remove(entry.eid);
            }),
        },
      });
    }, { btn });
  }

  function render(force = false) {
    const snap = store.snapshot;
    if (!snap) {
      const err = store.lastError;
      const key = 'empty:' + (err ? err.message : navigator.onLine === false ? 'offline' : 'loading');
      if (!force && key === lastKey) return;
      lastKey = key;
      el.innerHTML = err
        ? errorBlock(err.message)
        : navigator.onLine === false
          ? errorBlock(t('home.empty.offline'))
          : `<div class="empty"><p>${t('home.empty.loading')}</p></div>`;
      el.querySelector('[data-retry]')?.addEventListener('click', () => {
        store.refresh().catch((e) => toast(e.message));
      });
      return;
    }

    const state = snap.data;
    const feeding = openTimer(state, 'breastfeed');
    const sleeping = openTimer(state, 'sleep');
    const lastFeed = state.lastFeed;
    // The meal the last feed belongs to (model.groupMeals): sides at most
    // MEAL_GAP_MIN (20) minutes apart. Its entries end with lastFeed, and with the open timer
    // when one runs (a running timer keeps its meal open until now).
    const lastMeal = state.lastMeal || null;
    const mealEntries = lastMeal ? lastMeal.entries.length : 0;
    const lastDiaper = state.lastByType.diaper;
    const lastSleep = state.lastByType.sleep;
    const today = state.today;
    // The fourth slot (Mehr › Einstellungen › Startbildschirm): the sleep
    // card + tile, the reminders card + checklist, both, or nothing. A
    // running sleep timer stays visible regardless, so it can be stopped
    // here.
    const homeCard = prefs.homeCard;
    const showSleep = homeCard === 'sleep' || homeCard === 'both' || !!sleeping;
    const showTodos = homeCard === 'reminders' || homeCard === 'both';
    // Both («Beides», or a sleep timer running while the reminders are
    // chosen): the three cards share one row and the tiles below them do
    // too (Schoppen · Schlaf · Erinnerungen), so the screen keeps its height.
    const both = showSleep && showTodos;
    const todos = state.todos || { today: [], tomorrow: [] };
    const hasReminders = (state.reminders || []).length > 0;
    const next = showTodos ? nextTodo(todos, nowMs()) : null;
    const overdue = showTodos ? overdueCount(todos, nowMs()) : 0;
    // «Seit letzter Mahlzeit» counts from the meal's end — or from its start
    // when the family counts feeds start to start (Mehr › Einstellungen).
    const fromStart = store.settings.current.feedFromStart;

    // Quick-logged breastfeeds start with endedAt == startedAt; while young
    // they are treated as feeding-in-progress (live hero + stop button).
    const quickFeedStartMs = lastFeed ? new Date(lastFeed.startedAt).getTime() : 0;
    const quickFeedAgeMin = lastFeed ? (nowMs() - quickFeedStartMs) / 60000 : Infinity;
    const durationless =
      !feeding &&
      lastFeed &&
      lastFeed.type === 'breastfeed' &&
      lastFeed.endedAt === lastFeed.startedAt;
    const stoppable = durationless && quickFeedAgeMin <= QUICK_FEED_LIVE_MIN;
    // Opened after the feed already ended: offer the one-tap duration chips.
    const retro =
      durationless && quickFeedAgeMin > QUICK_FEED_LIVE_MIN && quickFeedAgeMin <= RETRO_MAX_AGE_MIN;
    // «Pause» closed the last side and marked it (ui.pausedFeed): the hero
    // offers «Weiter» on that side for PAUSE_MAX_MIN, then the pause was the
    // end of the meal. A paused side has a real end, so it is never
    // duration-less — no overlap with the live or retro states.
    const paused = pausedFeed(state, nowMs());
    const pausedSide = paused ? (paused.details || {}).side : null;

    // Which side next (meals.nextSideFor): the other side than the last meal
    // began with — or, while that meal may still continue, than the side
    // just fed. Nothing while a feed is live, and nothing beside «Weiter»
    // during a pause.
    const feedLocked = !!(feeding || stoppable);
    // «Stillen» off for the family (Einstellungen › Stillen): no side
    // buttons, so no next-side answer either — the Schoppen tile leads.
    const nursingOn = store.settings.current.breastfeeding !== false;
    // The «Heute» card's meals target (Einstellungen › Trinkmenge); read here
    // so the render key below sees it change.
    const mealsPerDay = store.settings.current.mealsPerDay;
    const { nextSide, flipAtMs: sideFlipMs } =
      paused || !nursingOn ? { nextSide: null, flipAtMs: 0 } : nextSideFor(state, feedLocked, nowMs());

    // The next time-driven change of this screen: the quick feed's live
    // window or retro row expiring, the pause running out, the next-side
    // answer flipping when the meal's join window closes.
    const flips = [];
    if (stoppable) flips.push(quickFeedStartMs + QUICK_FEED_LIVE_MIN * 60000);
    else if (retro) flips.push(quickFeedStartMs + RETRO_MAX_AGE_MIN * 60000);
    if (paused) flips.push(pauseEndsMs(state));
    if (sideFlipMs) flips.push(sideFlipMs);
    if (showTodos) {
      const todoFlip = todoFlipAt(todos, nowMs());
      if (todoFlip) flips.push(todoFlip);
    }
    flipAtMs = flips.length ? Math.min(...flips) : 0;

    // Two open timers of one type too far apart to auto-resolve: the store
    // keeps a persistent notice until a human closes one in Verlauf.
    const notice = store.notice;

    // Skip the rebuild when nothing it renders has changed — a re-render mid-
    // tap destroys the pressed button and silently swallows the tap. An
    // entry's seq and outbox state are not rendered here: a write landing
    // in the background (placeholder seq → real seq) must not rebuild.
    const skipMeta = (k, v) => (k === 'seq' || k === 'pending' ? undefined : v);
    const key = JSON.stringify([
      state.openTimers,
      state.lastFeed,
      lastMeal,
      state.lastByType.diaper,
      state.lastByType.sleep,
      state.today,
      !!stoppable,
      !!retro,
      paused ? paused.eid : null,
      nextSide,
      notice,
      showSleep,
      showTodos,
      nursingOn,
      mealsPerDay,
      showTodos ? [todos, hasReminders, next && next.status, overdue] : null,
      fromStart,
    ], skipMeta);
    if (!force && key === lastKey) return;
    lastKey = key;
    if (!feeding && !stoppable) startRowOpen = false;

    // --- hero: feeding now (real timer or fresh quick feed), or time since ---
    // The live feed inside its meal (meals.liveSideInMeal): "· 2. Seite" /
    // "· nochmals" on the label and the running meal line from the second
    // side on; a timer nobody stopped may sit outside the last meal, then
    // the hero shows it alone.
    const liveEid = feeding ? feeding.eid : stoppable ? lastFeed.eid : null;
    const live = liveSideInMeal(lastMeal, liveEid);
    const ordinalLabel = live.label;
    const mealLine = (liveIso) => (live.index > 0 ? mealLineHtml(lastMeal, liveIso, live.earlierKnown) : '');
    const startLine = (iso) => startLineHtml(iso, startRowOpen, live.notBeforeMs);
    // "Wie lange gestillt?" for a last side logged without a duration.
    const retroRow = retro
      ? `<div class="retro-row">
          <span class="retro-label">${t('home.hero.howLongNursed')}</span>
          ${RETRO_DUR_CHIPS_MIN.map(
            (m) => `<button type="button" class="chip" data-retro-min="${m}">${t('home.hero.minutesChip', { n: m })}</button>`
          ).join('')}
        </div>`
      : '';
    // «Pause» beside «Stillen beenden» under the live timer (the attribute
    // names which stop the primary button is). The slots keep their meaning
    // across the pause: LEFT is always «Pause» / «Weiter», RIGHT always
    // «Stillen beenden» — a second tap that lands after the re-render hits
    // «Weiter» (harmless, undoable), never the end of the meal.
    const liveActions = (stopAttr) => `
          <div class="hero-actions">
            <button type="button" class="btn big" data-pause-feed>${t('home.hero.pause')}</button>
            <button type="button" class="btn primary big" ${stopAttr}>${t('home.hero.stopNursing')}</button>
          </div>`;
    // "Links 12 · Rechts 8  20 Min." — the parts wrap only at the dots; the
    // total only where it sums several sides (meals.mealTotalShown).
    const mealSideLine = (meal) => {
      const parts = mealPartsLabel(meal)
        .split(' · ')
        .map((p) => `<span class="nobr">${p}</span>`)
        .join(' · ');
      return mealTotalShown(meal) ? `${parts} <span class="hero-dur">${fmtDurationMin(meal.minutes)}</span>` : parts;
    };
    let hero;
    if (feeding) {
      hero = `
        <section class="hero milk feeding">
          <p class="hero-label"><span class="live-dot"></span>${t('home.hero.nursingNow', { side: SIDE_LABELS[feeding.details.side] || '', place: ordinalLabel })}</p>
          <p class="hero-num timer" data-timer="${feeding.startedAt}">${fmtTimer(elapsedSecs(feeding.startedAt))}</p>
          ${startLine(feeding.startedAt)}
          ${mealLine(feeding.startedAt)}
          ${liveActions('data-stop-feed')}
        </section>`;
    } else if (stoppable) {
      const side = SIDE_LABELS[(lastFeed.details || {}).side] || '';
      hero = `
        <section class="hero milk feeding">
          <p class="hero-label"><span class="live-dot"></span>${t('home.hero.nursingSide', { side, place: ordinalLabel })}</p>
          <p class="hero-num timer" data-timer="${lastFeed.startedAt}">${fmtTimer(elapsedSecs(lastFeed.startedAt))}</p>
          ${startLine(lastFeed.startedAt)}
          ${mealLine(lastFeed.startedAt)}
          ${liveActions('data-stop-last')}
        </section>`;
    } else if (paused) {
      // The pause: how long the baby has been off the breast (the big
      // number — it ticks, muted: it is no feed), what the meal holds so
      // far, when the pause runs out, and the two ways on — the same side
      // again (the usual one, primary) or the end.
      const side = SIDE_LABELS[pausedSide] || '';
      const endsIso = new Date(pauseEndsMs(state)).toISOString();
      hero = `
        <section class="hero milk paused">
          <p class="hero-label">${t('home.hero.pausedSide', { side })}</p>
          <p class="hero-num timer" data-timer="${paused.endedAt}">${fmtTimer(elapsedSecs(paused.endedAt))}</p>
          <p class="hero-side multi">${mealSideLine(lastMeal)}</p>
          <p class="hero-sub">${mealClockRange(lastMeal)}</p>
          <p class="hero-sub">${t('home.hero.pauseEnds', { span: `<span data-in-short="${endsIso}">${fmtInShort(endsIso)}</span>` })}</p>
          <div class="hero-actions">
            <button type="button" class="btn primary big" data-resume-feed>${t('home.hero.resume')}</button>
            <button type="button" class="btn big" data-end-pause>${t('home.hero.stopNursing')}</button>
          </div>
        </section>`;
    } else if (lastFeed && mealEntries > 1) {
      // A whole meal: "Links 12 · Rechts 8  20 Min." and its span; the
      // interval counts from the meal's end (the last known instant of it),
      // or from its start (meals.mealSinceIso).
      const since = mealSinceIso(lastMeal, fromStart);
      hero = `
        <section class="hero milk">
          <p class="hero-label">${sinceLabel(fromStart)}</p>
          <p class="hero-num" data-agoparts="${since}">${agoPartsHtml(since)}</p>
          <p class="hero-side multi">${mealSideLine(lastMeal)}</p>
          <p class="hero-sub">${mealClockRange(lastMeal)}</p>
          ${retroRow}
        </section>`;
    } else if (lastFeed) {
      const side = SIDE_LABELS[(lastFeed.details || {}).side] || '';
      const what = lastFeed.type === 'breastfeed'
        ? side.charAt(0).toUpperCase() + side.slice(1)
        : t('common.type.bottle');
      // Once a feed has a real duration, "since last meal" counts from its
      // END — unless this phone counts from the start.
      const feedMins = lastFeed.endedAt ? minutesBetween(lastFeed.startedAt, lastFeed.endedAt) : 0;
      const since = fromStart || feedMins === 0 ? lastFeed.startedAt : lastFeed.endedAt;
      const sideLine = feedMins > 0
        ? `${what} <span class="hero-dur">${fmtDurationMin(feedMins)}</span>`
        : what;
      const sub = lastFeed.type === 'bottle'
        ? `${bottleAmountLabel(lastFeed.details)} · ${fmtClock(lastFeed.startedAt)}`
        : feedMins > 0
          ? `${fmtClock(lastFeed.startedAt)}–${fmtClock(lastFeed.endedAt)}`
          : fmtClock(lastFeed.startedAt);
      hero = `
        <section class="hero milk">
          <p class="hero-label">${sinceLabel(fromStart)}</p>
          <p class="hero-num" data-agoparts="${since}">${agoPartsHtml(since)}</p>
          <p class="hero-side">${sideLine}</p>
          <p class="hero-sub">${sub}</p>
          ${retroRow}
        </section>`;
    } else {
      hero = `
        <section class="hero milk">
          <p class="hero-label">${sinceLabel(fromStart)}</p>
          <p class="hero-num none">—</p>
          <p class="hero-sub">${t('home.hero.nothingYet')}</p>
        </section>`;
    }

    // --- mini cards: the day so far + sleep (the running sleep is tappable
    //     to fix "fell asleep earlier" without a trip through Verlauf) ---
    // «Heute»: meals against the family's meals a day (Einstellungen ›
    // Trinkmenge) and wet diapers against the guide («4/~6», like the Verlauf
    // day chips) — the midwife's two questions —, the soiled count beside
    // the wet one, and the last diaper on a line of its own that never
    // wraps. The row of three keeps the pictograms and numbers only. The
    // compact span (ui.fmtAgoShort): «vor 1½ Std.» keeps that line short —
    // the exact time is one tap away in Verlauf.
    const dk = today.diaperKinds || {};
    const wet = (dk.pee || 0) + (dk.both || 0);
    const soiled = (dk.poop || 0) + (dk.both || 0);
    // The last diaper («💧 Zuletzt vor 12 Min.» — its kind's pictogram, the
    // counts above say of what): the label may clip on a narrow phone, the
    // time never.
    const lastKind = lastDiaper && DIAPER_KINDS[(lastDiaper.details || {}).kind] ? lastDiaper.details.kind : 'pee';
    const lastDiaperLine = lastDiaper
      ? `${icon(lastKind)}<span class="mini-line-label">${t('home.card.lastDiaperAgo')}</span> <span data-ago-short="${lastDiaper.startedAt}">${fmtAgoShort(lastDiaper.startedAt)}</span>`
      : `<span class="mini-line-label">${t('home.card.noDiaperYet')}</span>`;
    const diaperMini = `<span class="mini-label">${t('common.today')}</span>
         <span class="mini-value">${icon('bottle')} ${today.meals}/${mealsPerDay} <span class="mini-word">${t('home.card.mealsWord')}</span></span>
         <span class="mini-value">${icon('pee')} ${wetCountLabel(wet)}<span class="trio-hide"> · ${icon('poop')} ${soiled}</span></span>
         <span class="mini-sub mini-line trio-hide">${lastDiaperLine}</span>`;
    // The sleep card carries the day's total (the «Heute» card has no room for a third line).
    const sleepTotal =
      today.sleepMinutes > 0
        ? `<span class="mini-sub trio-hide">${t('common.today')} ${t('home.today.sleep', { span: fmtDurationMin(today.sleepMinutes) })}</span>`
        : '';

    // «Schläft seit 1½ Std.» / «Wach seit 45 Min.» — the compact span, and
    // no «eingeschlafen» (the label says it): one line on a narrow phone.
    let sleepCard;
    if (sleeping) {
      sleepCard = `<button type="button" class="mini card sleep" data-edit-sleep>
        <span class="mini-label"><span class="live-dot"></span>${t('home.card.sleeping')}</span>
        <span class="mini-value">${t('home.card.forSpan', { span: `<span data-ago-bare-short="${sleeping.startedAt}">${fmtAgoBareShort(sleeping.startedAt)}</span>` })}</span>
        ${sleepTotal}
        <span class="mini-hint">${t('home.card.adjust')}</span>
      </button>`;
    } else if (lastSleep) {
      sleepCard = `<div class="mini card sleep">
        <span class="mini-label">${t('home.card.awake')}</span>
        <span class="mini-value">${t('home.card.forSpan', { span: `<span data-ago-bare-short="${lastSleep.endedAt}">${fmtAgoBareShort(lastSleep.endedAt)}</span>` })}</span>
        ${sleepTotal}
      </div>`;
    } else {
      sleepCard = `<div class="mini card sleep">
        <span class="mini-label">${t('common.type.sleep')}</span><span class="mini-value muted">${t('home.card.nothingYet')}</span>
      </div>`;
    }

    const todoCard = showTodos ? todoCardHtml(next, hasReminders, overdue) : '';

    // The likely next side (see nextSide above) is answered directly on the
    // button. While a feed is live, the OTHER side's button means "Seite
    // wechseln": close this feed now, start the other side — one tap for the
    // mid-feed switch.
    const activeSide = feeding
      ? (feeding.details || {}).side
      : stoppable
        ? (lastFeed.details || {}).side
        : null;
    // During a pause the paused side's button reads «Weiter» and does what
    // the hero's button does; the other side simply starts (a switch after
    // the pause, nothing left to close).
    const feedBtn = (s, label) => {
      const isSwitch = feedLocked && s !== activeSide;
      const isResume = !!paused && s === pausedSide;
      const pill = isSwitch ? t('home.tile.switchSide') : isResume ? t('home.hero.resume') : nextSide === s ? t('home.tile.nextUp') : null;
      return `
      <button type="button" class="quick milk${pill ? ' suggested' : ''}" data-feed="${s}"
        ${isSwitch ? 'data-switch="1"' : ''} ${isResume ? 'data-resume="1"' : ''} ${feedLocked && !isSwitch ? 'disabled' : ''}>
        ${icon('breastfeed', 'q-emoji')}<span>${label}</span>${pill ? `<span class="q-next">${pill}</span>` : ''}
      </button>`;
    };

    // Schoppen and the fourth slot's tile(s): next to the feed buttons, or
    // — with both the sleep and the reminders tile — as a row of three.
    const slotTiles = `
        <button type="button" class="quick milk${showSleep || showTodos ? '' : ' span-2'}" data-bottle>
          ${icon('bottle', 'q-emoji')}<span>${t('common.type.bottle')}</span>
        </button>
        ${showSleep
          ? `<button type="button" class="quick sleep" data-sleep>
          ${icon(sleeping ? 'wake' : 'sleep', 'q-emoji')}<span>${sleeping ? t('home.tile.wokeUp') : t('home.tile.startSleep')}</span>
        </button>`
          : ''}
        ${showTodos ? todoTileHtml(todos, hasReminders, next) : ''}`;

    el.innerHTML = `
      <div class="hero-wrap">
        ${hero}
        <button type="button" class="timer-chip" data-timer-chip aria-label="${t('home.timer.title')}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="8.25" />
            <path d="M12 7.5V12l3 2" />
          </svg><span data-timer-chip-time hidden></span>
        </button>
        <span class="stale-chip" data-stale-chip hidden title="${t('home.stale.title')}"></span>
        <button type="button" class="stale-chip outbox-chip" data-outbox-chip hidden aria-label="${t('home.outbox.chipAria')}"></button>
      </div>
      ${notice
        ? `<p class="notice" role="status" data-notice>${escapeHtml(notice)} ·
            <a class="link-btn" href="#/verlauf">${t('home.notice.toHistory')}</a></p>`
        : ''}
      <div class="duo${both ? ' trio' : showSleep || showTodos ? '' : ' solo'}">
        <div class="mini card diaper">${diaperMini}</div>
        ${showSleep ? sleepCard : ''}
        ${todoCard}
      </div>
      <h2 class="quick-title">${t('home.quick.title')}</h2>
      ${nursingOn
        ? `<div class="quick-grid">
        ${feedBtn('L', t('home.tile.nurseLeft'))}
        ${feedBtn('R', t('home.tile.nurseRight'))}
        ${both ? '' : slotTiles}
      </div>
      ${both ? `<div class="quick-grid three tiles">${slotTiles}</div>` : ''}`
        : `<div class="quick-grid${both ? ' three tiles' : ''}">${slotTiles}</div>`}
      <div class="quick-grid three">
        ${Object.entries(DIAPER_KINDS)
          .map(
            ([kind, k]) => `
          <button type="button" class="quick diaper small" data-diaper="${kind}">
            ${icon(kind, 'q-emoji')}<span>${k.label}</span>
          </button>`
          )
          .join('')}
      </div>`;

    tick(); // fill the stale chip immediately after a rebuild

    // --- wire actions ---
    el.querySelectorAll('[data-feed]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const side = btn.dataset.feed;
        const now = isoNow();
        if (btn.dataset.resume) {
          resumeSide(side, paused, btn);
          return;
        }
        if (btn.dataset.switch) {
          // Mid-feed side switch: end the current feed now, start the other
          // side — one tap instead of stop + new log.
          act(async () => {
            if (feeding) {
              await store.entries.update(feeding.eid, { endedAt: now, ifOpen: true }, IF_OPEN);
            } else {
              await store.entries.update(lastFeed.eid, { endedAt: now }, IF_DURATIONLESS);
            }
            const entry = await store.entries.create({
              type: 'breastfeed',
              details: { side },
              startedAt: now,
              endedAt: now,
            });
            toast(t('home.toast.switched', { side: SIDE_LABELS[side] }), 'success', {
              action: {
                label: t('common.action.undo'),
                onClick: () =>
                  act(async () => {
                    await store.entries.remove(entry.eid);
                    if (feeding) await store.entries.update(feeding.eid, { endedAt: null });
                    else await store.entries.update(lastFeed.eid, { endedAt: lastFeed.startedAt });
                  }),
              },
            });
          }, { btn });
          return;
        }
        // No timer: log a completed feed at "now" — the side is what matters.
        // While it is young, the hero above treats it as feeding-in-progress.
        createQuick(
          'breastfeed',
          { side },
          t('home.toast.nursingSaved', { side: SIDE_LABELS[side] }),
          { startedAt: now, endedAt: now },
          btn
        );
      })
    );
    // Retro duration: the feed already ended before the app was reopened —
    // one tap records how long it was (end = start + X).
    el.querySelectorAll('[data-retro-min]').forEach((chip) =>
      chip.addEventListener('click', () =>
        act(async () => {
          const mins = Number(chip.dataset.retroMin);
          const end = new Date(new Date(lastFeed.startedAt).getTime() + mins * 60000).toISOString();
          await store.entries.update(lastFeed.eid, { endedAt: end }, IF_DURATIONLESS);
          toast(t('home.toast.nursingDurationSaved', { span: fmtDurationMin(mins) }), 'success', {
            action: {
              label: t('common.action.undo'),
              onClick: () =>
                act(async () => {
                  await store.entries.update(lastFeed.eid, { endedAt: lastFeed.startedAt });
                }),
            },
          });
        }, { btn: chip })
      )
    );
    el.querySelector('[data-stop-feed]')?.addEventListener('click', (e) =>
      stopTimer(feeding, 'home.toast.nursingStopped', e.currentTarget)
    );
    // Start corrections on the live hero. A running timer moves its start; a
    // quick-logged feed (Ende == Start) moves both so it stays "in progress".
    const liveFeed = feeding || (stoppable ? lastFeed : null);
    el.querySelector('[data-adjust-start]')?.addEventListener('click', (e) => {
      startRowOpen = !startRowOpen;
      e.currentTarget.setAttribute('aria-expanded', startRowOpen ? 'true' : 'false');
      el.querySelector('[data-start-row]').hidden = !startRowOpen;
    });
    el.querySelectorAll('[data-start-back]').forEach((chip) =>
      chip.addEventListener('click', () =>
        act(async () => {
          const mins = Number(chip.dataset.startBack);
          const before = liveFeed.startedAt;
          const start = new Date(new Date(before).getTime() - mins * 60000).toISOString();
          const patch = feeding ? { startedAt: start } : { startedAt: start, endedAt: start };
          const guard = feeding ? IF_OPEN : IF_DURATIONLESS;
          startRowOpen = false; // before the write: the store re-renders on success
          await store.entries.update(liveFeed.eid, patch, guard);
          toast(t('home.toast.startSet', { time: fmtClock(start) }), 'success', {
            action: {
              label: t('common.action.undo'),
              onClick: () =>
                act(async () => {
                  const back = feeding ? { startedAt: before } : { startedAt: before, endedAt: before };
                  await store.entries.update(liveFeed.eid, back, guard);
                }),
            },
          });
        }, { btn: chip })
      )
    );
    el.querySelector('[data-edit-feed]')?.addEventListener('click', () => {
      startRowOpen = false; // the form's save re-renders the hero; the row stays folded
      openEntryForm({ type: 'breastfeed', entry: liveFeed, onSaved: () => store.refreshAfterWrite().catch(() => {}) });
    });
    el.querySelector('[data-edit-sleep]')?.addEventListener('click', () =>
      openEntryForm({ type: 'sleep', entry: sleeping, onSaved: () => store.refreshAfterWrite().catch(() => {}) })
    );
    el.querySelector('[data-stop-last]')?.addEventListener('click', (e) =>
      act(async () => {
        const closed = await store.entries.update(lastFeed.eid, { endedAt: isoNow() }, IF_DURATIONLESS);
        const mins = minutesBetween(closed.startedAt, closed.endedAt);
        toast(t('home.toast.nursingStopped', { span: fmtDurationMin(mins) }), 'success', {
          action: {
            label: t('common.action.undo'),
            onClick: () =>
              act(async () => {
                await store.entries.update(lastFeed.eid, { endedAt: lastFeed.startedAt });
              }),
          },
        });
      }, { btn: e.currentTarget })
    );
    // «Pause»: the live side ends now and is marked — a running timer closes
    // (IF_OPEN, like «Stillen beenden»), a quick-logged feed gets its end
    // (IF_DURATIONLESS). The undo puts it back the way it was.
    el.querySelector('[data-pause-feed]')?.addEventListener('click', (e) =>
      act(async () => {
        const side = (liveFeed.details || {}).side;
        const now = isoNow();
        const patch = feeding
          ? { endedAt: now, ifOpen: true, details: { side, paused: true } }
          : { endedAt: now, details: { side, paused: true } };
        const closed = await store.entries.update(liveFeed.eid, patch, feeding ? IF_OPEN : IF_DURATIONLESS);
        const mins = minutesBetween(closed.startedAt, closed.endedAt);
        toast(t('home.toast.paused', { side: SIDE_LABELS[side], span: fmtDurationMin(mins) }), 'success', {
          action: {
            label: t('common.action.undo'),
            onClick: () =>
              act(async () => {
                // Only while this side is still the paused one: after a
                // «Weiter» (or the partner's end) the timer must not come
                // back beside the row that followed it.
                const cur = pausedFeed(store.snapshot && store.snapshot.data, nowMs());
                if (!cur || cur.eid !== liveFeed.eid) throw new Error(t('home.error.pauseUndoGone'));
                const back = feeding
                  ? { endedAt: null, details: { side } }
                  : { endedAt: liveFeed.startedAt, details: { side } };
                await store.entries.update(liveFeed.eid, back, IF_PAUSED);
                toast(
                  feeding
                    ? t('home.toast.timerRunningAgain', { type: TYPE_META.breastfeed.label })
                    : t('home.toast.nursingRunningAgain'),
                  'success'
                );
              }),
          },
        });
      }, { btn: e.currentTarget })
    );
    el.querySelector('[data-resume-feed]')?.addEventListener('click', (e) => resumeSide(pausedSide, paused, e.currentTarget));
    // «Stillen beenden» on the paused hero: the side is closed already — the
    // mark goes, the pause was the end of the meal. Guarded: the partner
    // may have ended or resumed it meanwhile.
    el.querySelector('[data-end-pause]')?.addEventListener('click', (e) =>
      act(async () => {
        await store.entries.update(paused.eid, { details: { side: pausedSide } }, IF_PAUSED);
        const mins = minutesBetween(paused.startedAt, paused.endedAt);
        toast(t('home.toast.nursingStopped', { span: fmtDurationMin(mins) }), 'success', {
          action: {
            label: t('common.action.undo'),
            onClick: () =>
              act(async () => {
                await store.entries.update(paused.eid, { details: { side: pausedSide, paused: true } });
              }),
          },
        });
      }, { btn: e.currentTarget })
    );
    el.querySelector('[data-bottle]').addEventListener('click', () =>
      openEntryForm({ type: 'bottle', onSaved: () => store.refreshAfterWrite().catch(() => {}) })
    );
    el.querySelector('[data-sleep]')?.addEventListener('click', (e) => {
      const btn = e.currentTarget;
      if (sleeping) {
        stopTimer(sleeping, 'home.toast.slept', btn);
      } else {
        act(async () => {
          const created = await store.entries.create({
            type: 'sleep',
            details: {},
          });
          toast(t('home.toast.sleepStarted'), 'success', {
            action: {
              label: t('common.action.undo'),
              onClick: () =>
                act(async () => {
                  await store.entries.remove(created.eid);
                }),
            },
          });
        }, { btn });
      }
    });
    el.querySelectorAll('[data-diaper]').forEach((btn) =>
      btn.addEventListener('click', () =>
        createQuick('diaper', { kind: btn.dataset.diaper }, t('home.toast.diaperSaved', { kind: DIAPER_KINDS[btn.dataset.diaper].label }), {}, btn)
      )
    );
    // The next to-do, ticked off from the card (todo-sheet.tickTodo: the
    // task entry, the duplicate check, the undo toast); the tile opens the
    // whole checklist in the sheet.
    el.querySelector('[data-tick-next]')?.addEventListener('click', (e) => {
      const o = next && next.day === 'today' ? next.item : null;
      if (!o) return;
      act(() => tickTodo(o), { btn: e.currentTarget });
    });
    el.querySelector('[data-todo-sheet]')?.addEventListener('click', () => openTodoSheet());
    el.querySelectorAll('[data-goto-reminders]').forEach((btn) =>
      btn.addEventListener('click', () => {
        location.hash = '#/mehr';
      })
    );
    el.querySelector('[data-timer-chip]').addEventListener('click', () => openTimerSheet(tick));
    el.querySelector('[data-outbox-chip]').addEventListener('click', () => openOutboxSheet());
  }

  // Live tick: update elapsed texts in place (no re-render, so taps never
  // land on a button that was just rebuilt). Nodes are only written when the
  // rendered string actually changed.
  function tick() {
    el.querySelectorAll('[data-timer]').forEach((n) => {
      setText(n, fmtTimer(elapsedSecs(n.dataset.timer)));
    });
    el.querySelectorAll('[data-agoparts]').forEach((n) => {
      setHtml(n, agoPartsHtml(n.dataset.agoparts));
    });
    el.querySelectorAll('[data-in-short]').forEach((n) => {
      setText(n, fmtInShort(n.dataset.inShort));
    });
    el.querySelectorAll('[data-ago-short]').forEach((n) => {
      setText(n, fmtAgoShort(n.dataset.agoShort));
    });
    el.querySelectorAll('[data-ago-bare-short]').forEach((n) => {
      setText(n, fmtAgoBareShort(n.dataset.agoBareShort));
    });
    el.querySelectorAll('[data-meal-total]').forEach((n) => {
      setText(n, mealTotalText(n.dataset.mealBase, n.dataset.mealLive, nowMs()));
    });

    // The local stopwatch chip (device-only, never logged).
    const timerTime = el.querySelector('[data-timer-chip-time]');
    if (timerTime) {
      const start = prefs.timerStartedAt;
      timerTime.hidden = !start;
      if (start) setText(timerTime, fmtTimer((Date.now() - start) / 1000));
    }

    // Staleness is time-driven, so the chip lives here, not in render(); the
    // outbox chip takes its slot while something waits for the network.
    const chip = el.querySelector('[data-stale-chip]');
    const outboxChip = el.querySelector('[data-outbox-chip]');
    const waiting = store.outbox.count;
    const parked = store.outbox.parked;
    if (outboxChip) {
      const show = waiting + parked > 0;
      outboxChip.hidden = !show;
      if (show) {
        setText(outboxChip, waiting > 0 ? tn('home.outbox.waiting', waiting) : tn('home.outbox.parked', parked));
        outboxChip.classList.toggle('parked', waiting === 0 && parked > 0);
      }
    }
    if (chip) {
      const stale = !!(store.snapshot && store.isStale()) && waiting + parked === 0;
      chip.hidden = !stale;
      if (stale) {
        const ts = new Date(store.snapshot.ts).toISOString();
        const day = localDateOf(ts);
        const time = fmtClock(ts);
        setText(
          chip,
          day === localToday()
            ? t('home.stale.today', { time })
            : day === shiftDate(localToday(), -1)
              ? t('home.stale.yesterday', { time })
              : t('home.stale.onDate', { day: day.slice(8, 10), month: day.slice(5, 7), time })
        );
      }
    }

    // Time-driven UI flips (live hero ends, retro row expires) — re-render.
    if (flipAtMs && nowMs() > flipAtMs) {
      flipAtMs = 0;
      render(true);
    }
  }

  const unsubscribe = store.subscribe(() => render());
  render();
  tickTimer = setInterval(tick, 1000);

  return () => {
    unsubscribe();
    if (tickTimer) clearInterval(tickTimer);
  };
}
