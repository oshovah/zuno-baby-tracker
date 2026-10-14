// "Verlauf" — reverse-chronological entries grouped by day, in one of three
// views switched in the head. Every visit starts on «Einträge»: leaving the
// tab drops the choice (the view's closure holds it, nothing is stored).
//   «Einträge»    every day unfolded — a day head with the summary chips,
//                 the rows below it (a week per page)
//   «Tage»        one row per day — the day and its summary — with the rows
//                 folded below it; a tap unfolds a day, a second folds it
//                 again (four weeks per page, the open days survive a sync's
//                 re-render)
//   «Mahlzeiten»  the feeds only: under each day head one folded row per
//                 meal — its total, its parts and its span — that a tap
//                 unfolds into the sides (each still tappable to edit); a
//                 week per page, the open meals survive a re-render
//   «Grafik»      charts over the last 7, 14 or 28 days — or, «∞», over
//                 everything since the birth date (the oldest entry when it
//                 lies earlier or there is no date): bars per day on the
//                 short ranges, lines without numbers on «∞» (chips in place
//                 of the paging button): weight since the first reading, meals
//                 against the family's meals a day, nursing minutes per
//                 side, bottle ml (breast milk beside formula), diapers against the ~6
//                 guide, sleep hours, temperature — each only when there is
//                 data (stats.js counts, charts.js draws). The filter button
//                 beside the chips hides charts for this phone
//                 (prefs.hiddenCharts, a sheet of switches; the button
//                 itself never changes its look). A tap on a legend item
//                 of a two-series chart (Stillen, Schoppen, Windeln) draws
//                 that series alone, the average in the head follows; the
//                 same item again brings both back — the visit's choice,
//                 like the view (charts.soloSeries).
// Tapping an entry opens the edit sheet. The list is read from the store's
// decrypted model (store.entries.range) once store.ready resolves — no
// request of its own; the store's sync notifications re-render it.
//
// Feeds are shown as Mahlzeiten (model.groupMeals): sides at most 20 minutes
// apart share one card — a head with the total, the sides indented below it,
// each still its own tappable entry. A meal of one entry is a plain row.

import { store, prefs } from '../store.js';
import { t, tn } from '../i18n/index.js';
import { openSheet } from '../sheet.js';
import { historyItems, mealSummary, mealPartsLabel, mealClockRange, dayCounts, dayMilk, dayMilkParts, wetCountLabel, WET_PER_DAY_GUIDE } from '../meals.js';
import { lastDays, daysBetween, dailyStats, measurementSeries, avgPerDay } from '../stats.js';
import { barChart, dayLineChart, lineChart, soloSeries, toggleSolo } from '../charts.js';
import { doseFor, lastWeight, dayTargetMl } from '../dose.js';
import { openEntryForm } from '../entry-form.js';
import {
  escapeHtml,
  toast,
  errorBlock,
  entrySummary,
  entryDetail,
  entryIcon,
  icon,
  fmtClock,
  fmtDayHeading,
  fmtDurationMin,
  localDateOf,
  localToday,
  shiftDate,
  nowMs,
  isoNow,
  fmtGrams,
} from '../ui.js';
import { localeMeta } from '../i18n/index.js';

/** The four views: every day unfolded (the default), one folded row per
 *  day, one folded row per meal, or the charts. Rendered in reverse in the
 *  head, so «Einträge» sits last. */
const HISTORY_VIEWS = ['entries', 'days', 'meals', 'charts'];
/** Days per page: a week of rows, four weeks of folded days, a week of
 *  meals; the charts' range is the view's own choice (CHART_RANGES). */
const PAGE_DAYS = { entries: 7, days: 28, meals: 7 };
/** The «∞» chip: everything since the birth — lines instead of bars. */
const ALL_RANGE = 'all';
const ALL_RANGE_SIGN = '∞';
const CHART_RANGES = [7, 14, 28, ALL_RANGE];
const DEFAULT_CHART_RANGE = 14;
/** The charts in their order; the filter sheet lists them, prefs.hiddenCharts names the hidden ones. */
const CHART_KEYS = ['weight', 'meals', 'nursing', 'bottleMl', 'diapers', 'sleep', 'temperature'];
/** The filter button's pictogram: three sliders (inline, like the tab bar's icons). */
const FILTER_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
  <path d="M4 7h6.5M14.5 7H20M4 12h10.5M18.5 12H20M4 17h3.5M11.5 17H20" />
  <circle cx="12.5" cy="7" r="2" /><circle cx="16.5" cy="12" r="2" /><circle cx="9.5" cy="17" r="2" />
</svg>`;
/** The temperature chart's dashed line. */
const TEMPERATURE_GUIDE_C = 38;
// Labels per view, read in the active language at render time (getters,
// so a language switch shows on the next render).
const VIEW_LABELS = {
  get charts() { return t('history.view.charts'); },
  get meals() { return t('history.view.meals'); },
  get days() { return t('history.view.days'); },
  get entries() { return t('history.view.entries'); },
};
const MORE_LABELS = {
  get entries() { return t('history.loadMore.entries'); },
  get days() { return t('history.loadMore.days'); },
  get meals() { return t('history.loadMore.meals'); },
};
const EMPTY_LABELS = {
  get entries() { return t('history.empty.entries'); },
  get days() { return t('history.empty.days'); },
  get meals() { return t('history.empty.meals'); },
  get charts() { return t('history.empty.charts'); },
};

/** The earliest day a fresh page of `days` days shows. */
function firstDayFor(days) {
  return shiftDate(localToday(), -(days - 1));
}

/** «16.9.» / «16/09» — the short date of a local day for a chart's time axis. */
function shortDate(localDate) {
  const [y, m, d] = localDate.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(localeMeta().dateLocale, { day: 'numeric', month: 'numeric' });
}

/** Local midnight of a local date, in ms. */
function dayStartMs(localDate) {
  const [y, m, d] = localDate.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

/**
 * The summary chips of one day — «🍼 6 · 💧 5/~6 · 💩 2 · 😴 4 Std. · ✅ 1» —
 * every chip kept on one line (they wrap at the separators in the «Tage»
 * row); the wet count against the ~6-a-day guide (meals.wetCountLabel).
 */
function daySummaryHtml(dayItems, day, allEntries) {
  const c = dayCounts(dayItems, day, allEntries, nowMs());
  const parts = [];
  if (c.meals) parts.push(`${icon('bottle')} ${c.meals}`);
  if (c.wet) parts.push(`${icon('pee')} ${wetCountLabel(c.wet)}`);
  if (c.soiled) parts.push(`${icon('poop')} ${c.soiled}`);
  if (c.sleepMinutes) parts.push(`${icon('sleep')} ${fmtDurationMin(c.sleepMinutes)}`);
  if (c.tasks) parts.push(`${icon('task')} ${c.tasks}`);
  return parts.map((p) => `<span class="nobr">${p}</span>`).join(' · ');
}

/** A day with nothing the chips count (a weight, say): «1 Eintrag» / «3 Einträge». */
function countLabel(n) {
  return tn('history.entryCount', n);
}

export function renderHistory(el) {
  let view = 'entries';
  let chartRange = DEFAULT_CHART_RANGE;
  /** The earliest day a fresh page of view `v` shows. */
  const firstDayOf = (v) => (v === 'charts' ? chartFirstDay() : firstDayFor(PAGE_DAYS[v]));
  let fromDate = firstDayOf(view);
  let entries = null;
  let loading = false;
  let lastJson = null;
  /** The days unfolded in the «Tage» view (local dates) — kept across re-renders. */
  const openDays = new Set();
  /** The meals unfolded in the «Mahlzeiten» view (the first entry's eid). */
  const openMeals = new Set();
  /** «Grafik»: per two-series chart (its CHART_KEYS key) the index of the series drawn alone (charts.soloSeries) — this visit's choice. */
  const solo = new Map();

  /** Nothing to list yet: the placeholder, or the first sync's failure with a retry. */
  function renderPlaceholder(err) {
    if (err) {
      el.innerHTML = errorBlock(err.message);
      el.querySelector('[data-retry]')?.addEventListener('click', () => {
        store.refresh().catch((e) => toast(e.message));
      });
    } else {
      el.innerHTML = `<div class="empty"><p>${t('history.loading')}</p></div>`;
    }
  }

  async function load(opts = {}) {
    if (loading) return;
    loading = true;
    try {
      // No key on this device: main.js swaps in the unlock screen; the
      // notification after unlocking runs load() again.
      if (store.keyState === 'locked') return;
      await store.ready;
      // «∞» follows the data: an entry older than the first day may have
      // arrived (the partner's, or one re-dated) since the chip was tapped.
      const from = opts.from || (view === 'charts' && chartRange === ALL_RANGE ? chartFirstDay() : fromDate);
      // One day more than shown, so a meal that began the evening before the
      // first day is grouped with its later sides instead of showing them as
      // a meal of their own; meals.historyItems drops that day again.
      const list = store.entries.range(shiftDate(from, -1), localToday());
      if (list.length === 0 && !store.snapshot) {
        // No local rows and no sync yet (fresh device): "Laden …" — or the
        // sync error — rather than a misleading "Keine Einträge".
        if (entries === null) renderPlaceholder(store.lastError);
        return;
      }
      fromDate = from; // only advance the range once the read succeeded
      // The seq is not rendered (a write landing must not rebuild the list
      // under a finger); the outbox state only as far as the row shows it.
      const j = JSON.stringify(list, (k, v) => (k === 'seq' ? undefined : k === 'pending' ? (v === 'parked' ? v : v ? 'pending' : v) : v));
      // Unchanged data: skip the rebuild — the 60 s poll must not replace the
      // row under the user's finger for nothing.
      if (entries === null || j !== lastJson || opts.forceRender) {
        entries = list;
        lastJson = j;
        render();
      }
    } catch (err) {
      if (entries === null) {
        renderPlaceholder(err);
      } else if (opts.userInitiated || err.status) {
        toast(err.message);
      }
    } finally {
      loading = false;
    }
  }

  /**
   * The first day the charts show: the range's own, or — «∞» — the birth
   * date, pulled back to the oldest entry when one lies before it; without
   * a birth date the oldest entry's day, without any today.
   */
  function chartFirstDay() {
    if (chartRange !== ALL_RANGE) return firstDayFor(chartRange);
    const today = localToday();
    let first = today;
    const birth = store.settings.current.birthDate;
    if (birth && birth < first) first = birth;
    for (const e of store.entries.range('2000-01-01', today)) {
      const d = localDateOf(e.startedAt);
      if (d < first) first = d;
    }
    return first;
  }

  /** The head's switch: widen the range when the new view's page is longer —
   *  except after the charts' «∞»: a list goes back to its own page, not
   *  every day since the birth unfolded. */
  async function switchView(next) {
    if (!HISTORY_VIEWS.includes(next) || next === view) return;
    const fromAll = view === 'charts' && chartRange === ALL_RANGE;
    view = next;
    const first = firstDayOf(next);
    if (first < fromDate || fromAll) await load({ from: first, forceRender: true, userInitiated: true });
    else render();
  }

  /**
   * «Grafik»: the range chips, then one card per figure that has data in
   * the range — the weight since its first reading, the rest per day.
   */
  function chartsHtml() {
    const today = localToday();
    const all = chartRange === ALL_RANGE;
    // «∞»: every day from the first one load() settled on (chartFirstDay).
    const days = all ? daysBetween(fromDate, today) : lastDays(today, chartRange);
    const stats = dailyStats(entries, days, isoNow());
    const fam = store.settings.current;
    // The day number alone on a week or a month; «∞» crosses months, so its
    // axis says «16.9.» like the weight chart's.
    const dayNum = all ? shortDate : (d) => t('history.chart.dayLabel', { n: Number(d.slice(8)) });
    // Bars per day on the short ranges; on «∞» a bar a day would be a hair's
    // breadth, so the same figures go as lines without numbers (the
    // options a line has no use for — the grouping, the value format — it
    // ignores).
    const bars = all ? dayLineChart : barChart;
    const has = (pick) => stats.some((r) => pick(r) > 0);
    // «Ø 5,3 pro Tag» over the days that have the figure — without today,
    // which is not over yet (stats.avgPerDay).
    const avgSub = (pick, unit = '', digits = 1) => {
      const a = avgPerDay(stats, pick, today, digits);
      if (a === null) return '';
      const value = String(a).replace('.', localeMeta().decimalSeparator);
      return t('history.chart.avg', { value: unit ? `${value} ${unit}` : value });
    };
    // The legend of a two-series chart: one button per series — a tap draws
    // that series alone and dims the other's item, a tap on the item already
    // alone brings both back (charts.soloSeries / toggleSolo).
    const legendHtml = ({ key, items, dimmed, solo: only }) =>
      `<div class="chart-legend" role="group" aria-label="${escapeHtml(t('history.legend.label'))}">${items
        .map(
          ([cls, label], i) =>
            `<button type="button"${dimmed[i] ? ' class="dimmed"' : ''} data-legend="${key}" data-series="${i}" aria-pressed="${only === i}"><i class="${cls}"></i>${escapeHtml(label)}</button>`
        )
        .join('')}</div>`;
    // A chart of two series, each { id, label, cls, pick }: what the legend's
    // solo leaves in, as the series to draw, the average's pick over exactly
    // those, the legend with its dimmed item, and whether a given id is shown.
    const twoSeries = (key, parts) => {
      const s = soloSeries(parts, solo.get(key));
      return {
        series: s.series.map((p) => ({ label: p.label, values: stats.map(p.pick), cls: p.cls })),
        pick: (r) => s.series.reduce((sum, p) => sum + p.pick(r), 0),
        legend: { key, items: parts.map((p) => [p.cls, p.label]), dimmed: s.dimmed, solo: s.solo },
        shown: (id) => s.series.some((p) => p.id === id),
      };
    };
    const card = (title, svg, { sub = '', legend = null } = {}) => `
      <section class="card chart-card">
        <div class="chart-head"><h2 class="chart-title">${escapeHtml(title)}</h2>${sub ? `<span class="chart-sub">${escapeHtml(sub)}</span>` : ''}</div>
        ${legend ? legendHtml(legend) : ''}
        <div class="chart">${svg}</div>
      </section>`;
    // The temperature chart's ticks on the same days as the bar charts'
    // labels: every k-th day so about seven fit, and the last; the lines'
    // short dates are wider — about five, without the last (it could sit on
    // the one before).
    const every = Math.ceil(days.length / (all ? 5 : 7));
    const dayTicks = days.filter((_, i) => i % every === 0 || (!all && i === days.length - 1)).map((d) => ({ ms: dayStartMs(d) + 43200000, label: dayNum(d) }));
    const cards = []; // [key, html]

    // Weight: every reading there is, from the first one's day to today.
    const weight = measurementSeries(store.entries.range('2000-01-01', today), 'weight');
    if (weight.length) {
      const firstDay = localDateOf(weight[0].t);
      const fromMs = dayStartMs(firstDay);
      // Through the end of today — or past a reading dated ahead by mistake,
      // so it still sits inside the plot instead of half off its edge.
      const toMs = Math.max(dayStartMs(today) + 86400000, weight[weight.length - 1].ms + 3600000);
      const spanDays = Math.max(1, Math.round((toMs - fromMs) / 86400000));
      const k = Math.ceil(spanDays / 5);
      const xTicks = [];
      for (let i = 0; i < spanDays; i += k) xTicks.push({ ms: fromMs + i * 86400000 + 43200000, label: shortDate(shiftDate(firstDay, i)) });
      cards.push([
        'weight',
        card(
          t('history.chart.weight'),
          lineChart({ points: weight, fromMs, toMs, xTicks, yFormat: fmtGrams, valueFormat: fmtGrams, minStep: 100, cls: 'measure', title: t('history.chart.weight') }),
          { sub: t('history.chart.since', { date: shortDate(firstDay) }) }
        ),
      ]);
    }
    const title = (key) => t(`history.chart.${key}`);
    if (has((r) => r.meals)) {
      const guide = fam.mealsPerDay ? { v: fam.mealsPerDay, label: t('history.chart.target', { n: fam.mealsPerDay }) } : null;
      cards.push(['meals', card(title('meals'), bars({ days, series: [{ label: title('meals'), values: stats.map((r) => r.meals), cls: 'milk' }], guide, xLabel: dayNum, title: title('meals'), minStep: 1 }), { sub: avgSub((r) => r.meals) })]);
    }
    if (has((r) => r.nursingMin.L + r.nursingMin.R)) {
      const unit = (v) => `${v} ${t('common.unit.min')}`;
      const two = twoSeries('nursing', [
        { id: 'L', label: t('history.chart.left'), cls: 'milk', pick: (r) => r.nursingMin.L },
        { id: 'R', label: t('history.chart.right'), cls: 'milk second', pick: (r) => r.nursingMin.R },
      ]);
      cards.push([
        'nursing',
        card(
          title('nursing'),
          bars({ days, series: two.series, xLabel: dayNum, yFormat: unit, valueFormat: unit, title: title('nursing'), minStep: 1 }),
          { legend: two.legend, sub: avgSub(two.pick, t('common.unit.min'), 0) }
        ),
      ]);
    }
    if (has((r) => r.bottleMl.breast + r.bottleMl.formula)) {
      const unit = (v) => `${v} ml`;
      const two = twoSeries('bottleMl', [
        { id: 'breast', label: t('common.milk.breast'), cls: 'milk', pick: (r) => r.bottleMl.breast },
        { id: 'formula', label: t('common.milk.formula'), cls: 'formula', pick: (r) => r.bottleMl.formula },
      ]);
      cards.push([
        'bottleMl',
        card(
          title('bottleMl'),
          bars({
            days,
            // Stacked in two colours: the split shows in the bar, the number
            // above it is the day's total — three digits fit a 14-day slot,
            // never a grouped half bar (the exact split per day is on the
            // «Mahlzeiten» view). One series alone carries its own numbers.
            series: two.series,
            xLabel: dayNum,
            yFormat: unit,
            valueFormat: unit,
            title: title('bottleMl'),
            minStep: 1,
          }),
          { legend: two.legend, sub: avgSub(two.pick, 'ml', 0) }
        ),
      ]);
    }
    if (has((r) => r.wet + r.soiled)) {
      const two = twoSeries('diapers', [
        { id: 'wet', label: t('common.diaper.wet'), cls: 'diaper', pick: (r) => r.wet },
        { id: 'soiled', label: t('common.diaper.soiled'), cls: 'measure', pick: (r) => r.soiled },
      ]);
      cards.push([
        'diapers',
        card(
          title('diapers'),
          bars({
            days,
            series: two.series,
            mode: 'grouped',
            // The ~6 guide is about wet diapers: gone while «Gaggi» stands alone.
            guide: two.shown('wet') ? { v: WET_PER_DAY_GUIDE, label: t('history.chart.guide', { n: WET_PER_DAY_GUIDE }) } : null,
            xLabel: dayNum,
            title: title('diapers'),
            minStep: 1,
          }),
          { legend: two.legend, sub: avgSub(two.pick) }
        ),
      ]);
    }
    if (has((r) => r.sleepMin)) {
      const hours = (v) => `${v} ${t('common.unit.hour')}`;
      cards.push([
        'sleep',
        card(
          title('sleep'),
          bars({
            days,
            series: [{ label: title('sleep'), values: stats.map((r) => Math.round((r.sleepMin / 60) * 10) / 10), cls: 'sleep' }],
            xLabel: dayNum,
            yFormat: hours,
            valueFormat: (v) => fmtDurationMin(Math.round(v * 60)),
            title: title('sleep'),
          }),
          { sub: avgSub((r) => r.sleepMin / 60, t('common.unit.hour')) }
        ),
      ]);
    }
    const fromMs = dayStartMs(days[0]);
    const toMs = dayStartMs(today) + 86400000;
    const temps = measurementSeries(entries, 'temperature').filter((pt) => pt.ms >= fromMs && pt.ms < toMs);
    if (temps.length) {
      const deg = (v) => `${String(v).replace('.', localeMeta().decimalSeparator)} °C`;
      cards.push([
        'temperature',
        card(
          title('temperature'),
          lineChart({
            points: temps,
            fromMs,
            toMs,
            xTicks: dayTicks,
            yFormat: deg,
            valueFormat: deg,
            minStep: 0.5,
            cls: 'measure',
            guide: { v: TEMPERATURE_GUIDE_C, label: deg(TEMPERATURE_GUIDE_C) },
            title: title('temperature'),
          })
        ),
      ]);
    }

    // This phone's filter: the hidden ones stay out (the button looks the same either way).
    const hidden = new Set(prefs.hiddenCharts);
    const shown = cards.filter(([key]) => !hidden.has(key)).map(([, html]) => html);
    // «∞» shows the sign and carries its name for a screen reader.
    const chips = `<div class="range-chips" role="radiogroup" aria-label="${escapeHtml(t('history.range.label'))}">${CHART_RANGES.map(
      (r) =>
        `<button type="button" class="chip${r === chartRange ? ' active' : ''}" role="radio" aria-checked="${r === chartRange}" data-range="${r}"${r === ALL_RANGE ? ` aria-label="${escapeHtml(t('history.range.all'))}"` : ''}>${r === ALL_RANGE ? ALL_RANGE_SIGN : escapeHtml(t('history.range.days', { n: r }))}</button>`
    ).join('')}<button type="button" class="chart-filter" data-chart-filter aria-label="${escapeHtml(t('history.filter.label'))}">${FILTER_ICON}</button></div>`;
    const empty = cards.length ? (hidden.size ? t('history.empty.filtered') : '') : EMPTY_LABELS.charts;
    return chips + (shown.join('') || `<div class="empty"><p>${escapeHtml(empty)}</p></div>`);
  }

  /** The filter sheet: one switch per chart; a change saves and repaints at once. */
  function openChartFilter() {
    openSheet(t('history.filter.title'), (body) => {
      const hidden = new Set(prefs.hiddenCharts);
      body.innerHTML = `
        <p class="hint">${escapeHtml(t('history.filter.hint'))}</p>
        ${CHART_KEYS.map(
          (key) => `<label class="confirm-row switch-row">
          <input type="checkbox" data-chart-key="${key}" ${hidden.has(key) ? '' : 'checked'} />
          <span>${escapeHtml(t(`history.chart.${key}`))}</span>
        </label>`
        ).join('')}`;
      body.querySelectorAll('[data-chart-key]').forEach((box) =>
        box.addEventListener('change', () => {
          const next = new Set(prefs.hiddenCharts);
          if (box.checked) next.delete(box.dataset.chartKey);
          else next.add(box.dataset.chartKey);
          prefs.hiddenCharts = CHART_KEYS.filter((k) => next.has(k));
          if (view === 'charts' && entries) render();
        })
      );
    });
  }

  function render() {
    // Every feed folded into its meal, everything else as itself, the extra
    // day dropped again (meals.historyItems).
    const { items } = historyItems(entries, fromDate, isoNow());

    // Group by local day (newest first).
    const groups = new Map();
    for (const it of items) {
      const day = localDateOf(it.startedAt);
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push(it);
    }

    // The row's second line: what was in a Schoppen (ui.entryDetail), then
    // who logged it — and, for a write still in the outbox, that it waits for
    // the network (or that the server refused it).
    const pendingMark = (e) =>
      e.pending === 'waiting' || e.pending === 'sending'
        ? `<span class="pending">${t('history.pending.waiting')}</span>`
        : e.pending === 'parked'
          ? `<span class="pending parked">${t('history.pending.parked')}</span>`
          : '';
    const subLine = (e) => {
      const parts = [entryDetail(e), e.loggedBy || ''].filter(Boolean).map(escapeHtml);
      const mark = pendingMark(e);
      if (mark) parts.push(mark);
      return parts.length ? `<span class="e-by">${parts.join(' · ')}</span>` : '';
    };
    const rowHtml = (e, cls = '') => `
          <button type="button" class="entry-row${cls}" data-eid="${e.eid}">
            <span class="e-time">${fmtClock(e.startedAt)}</span>
            ${entryIcon(e, 'e-emoji')}
            <span class="e-text">
              <span class="e-summary">${escapeHtml(entrySummary(e))}</span>
              ${subLine(e)}
            </span>
            <span class="e-chevron" aria-hidden="true">›</span>
          </button>`;
    const mealHtml = (m) => `
          <div class="meal-group">
            <div class="entry-row meal-head">
              <span class="e-time">${fmtClock(m.startedAt)}</span>
              ${icon(m.entries.some((e) => e.type === 'breastfeed') ? 'breastfeed' : 'bottle', 'e-emoji')}
              <span class="e-text">
                <span class="e-summary">${escapeHtml(mealSummary(m))}</span>
                <span class="e-by">${escapeHtml(mealPartsLabel(m))} · ${mealClockRange(m)}</span>
              </span>
            </div>
            ${m.entries.map((e) => rowHtml(e, ' sub')).join('')}
          </div>`;
    const dayRowsHtml = (dayItems) =>
      dayItems
        .map((it) => (it.meal && it.meal.entries.length > 1 ? mealHtml(it.meal) : rowHtml(it.entry)))
        .join('');

    // «Einträge»: the day head with its chips, the rows below.
    const unfolded = ([day, dayItems]) => `
          <section class="day-group">
            <header class="day-head">
              <h2>${fmtDayHeading(day)}</h2>
              <span class="day-summary">${daySummaryHtml(dayItems, day, entries)}</span>
            </header>
            ${dayRowsHtml(dayItems)}
          </section>`;
    // «Tage»: the day as a row — its name, its chips, a chevron — and the
    // same rows folded below it.
    const folded = ([day, dayItems]) => {
      const open = openDays.has(day);
      return `
          <section class="day-fold${open ? ' open' : ''}" data-day="${day}">
            <button type="button" class="entry-row day-row" aria-expanded="${open}" aria-controls="day-${day}">
              <span class="e-text">
                <span class="day-name">${fmtDayHeading(day)}</span>
                <span class="day-stats">${daySummaryHtml(dayItems, day, entries) || countLabel(dayItems.length)}</span>
              </span>
              <span class="e-chevron" aria-hidden="true">›</span>
            </button>
            <div class="day-rows" id="day-${day}"${open ? '' : ' hidden'}>${dayRowsHtml(dayItems)}</div>
          </section>`;
    };

    // «Mahlzeiten»: the day head with its chips, then one folded row per
    // meal — the same head a meal card has, as a button — with the sides
    // below it once unfolded. Days without a feed are left out.
    const foldedMeal = (m) => {
      const key = m.entries[0].eid;
      const open = openMeals.has(key);
      return `
          <section class="meal-group meal-fold${open ? ' open' : ''}" data-meal="${key}">
            <button type="button" class="entry-row meal-head meal-toggle" aria-expanded="${open}" aria-controls="meal-${key}">
              <span class="e-time">${fmtClock(m.startedAt)}</span>
              ${icon(m.entries.some((e) => e.type === 'breastfeed') ? 'breastfeed' : 'bottle', 'e-emoji')}
              <span class="e-text">
                <span class="e-summary">${escapeHtml(mealSummary(m))}</span>
                <span class="e-by">${escapeHtml(mealPartsLabel(m))} · ${mealClockRange(m)}</span>
              </span>
              <span class="e-chevron" aria-hidden="true">›</span>
            </button>
            <div class="meal-rows" id="meal-${key}"${open ? '' : ' hidden'}>${m.entries.map((e) => rowHtml(e, ' sub')).join('')}</div>
          </section>`;
    };
    // Under the head: the day's milk — the bottles by kind, the nursed meals
    // with their minutes and the estimated amount, the total — and beside
    // the total the day's target (meals.dayMilk): the drinking rule for THAT
    // day over the weight known then (dose.doseFor, dose.dayTargetMl — the
    // day and the weight the Schoppen form went by), or the midwife's amount
    // times the meals a day. Every weight there is, read once per render.
    const fam = store.settings.current;
    const weights = view === 'meals' ? store.entries.range('2000-01-01', localToday()).filter((e) => e.type === 'weight') : [];
    let targetShown = false;
    const milkLine = (day, dayItems) => {
      const milk = dayMilk(dayItems, fam, dayTargetMl(doseFor(fam, day, lastWeight(weights, day))));
      if (milk.targetMl) targetShown = true;
      // The first part (the bottles, the long one) may wrap inside; the rest
      // wrap at the separators only, so a number never parts from its unit.
      const parts = dayMilkParts(milk);
      return parts.length ? `<p class="day-milk">${parts.map((p, i) => `<span${i ? ' class="nobr"' : ''}>${p}</span>`).join('<span class="sep"> · </span>')}</p>` : '';
    };
    const mealsOnly = ([day, dayItems]) => {
      const meals = dayItems.filter((it) => it.meal);
      if (!meals.length) return '';
      return `
          <section class="day-group">
            <header class="day-head">
              <h2>${fmtDayHeading(day)}</h2>
              <span class="day-summary">${daySummaryHtml(dayItems, day, entries)}</span>
            </header>
            ${milkLine(day, dayItems)}
            ${meals.map((it) => foldedMeal(it.meal)).join('')}
          </section>`;
    };

    const sectionOf = { entries: unfolded, days: folded, meals: mealsOnly }[view];
    const charts = view === 'charts';
    let sections = charts ? chartsHtml() : [...groups.entries()].map(sectionOf).join('');
    // «Mahlzeiten»: say once that the nursing amount is an estimate (with
    // one in play) and where the day's target comes from (with one shown).
    if (view === 'meals' && sections) {
      const hints = [];
      if (fam.breastfeeding !== false && Number.isInteger(fam.nursingMl) && fam.nursingMl >= 1) hints.push(t('history.milk.hint'));
      if (targetShown) hints.push(t('history.milk.targetHint'));
      if (hints.length) sections += `<p class="hint milk-hint">${hints.join(' ')}</p>`;
    }

    el.innerHTML = `
      <header class="view-head has-seg">
        <h1>${t('history.title')}</h1>
        <div class="segmented compact" role="radiogroup" aria-label="${t('history.viewSwitch.label')}">
          ${HISTORY_VIEWS.slice()
            .reverse()
            .map(
              (v) => `<button type="button" class="seg${v === view ? ' active' : ''}" role="radio"
                aria-checked="${v === view}" data-view="${v}">${VIEW_LABELS[v]}</button>`
            )
            .join('')}
        </div>
      </header>
      ${sections || `<div class="empty"><p>${EMPTY_LABELS[view]}</p></div>`}
      ${charts ? '' : `<button type="button" class="btn wide" data-more>${MORE_LABELS[view]}</button>`}`;

    el.querySelectorAll('[data-view]').forEach((btn) =>
      btn.addEventListener('click', () => {
        switchView(btn.dataset.view).catch(() => {});
      })
    );
    el.querySelector('[data-chart-filter]')?.addEventListener('click', openChartFilter);
    // «Grafik»: the range chips re-read the list for the new span.
    el.querySelectorAll('[data-range]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const r = btn.dataset.range === ALL_RANGE ? ALL_RANGE : Number(btn.dataset.range);
        if (!CHART_RANGES.includes(r) || r === chartRange) return;
        chartRange = r;
        load({ from: chartFirstDay(), forceRender: true, userInitiated: true }).catch(() => {});
      })
    );
    // «Grafik»: a legend item draws its series alone, the same item again both.
    el.querySelectorAll('[data-legend]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const key = btn.dataset.legend;
        solo.set(key, toggleSolo(solo.get(key), Number(btn.dataset.series)));
        render();
      })
    );
    el.querySelectorAll('.day-row').forEach((btn) =>
      btn.addEventListener('click', () => {
        const sec = btn.closest('.day-fold');
        const day = sec.dataset.day;
        const open = !openDays.has(day);
        if (open) openDays.add(day);
        else openDays.delete(day);
        sec.classList.toggle('open', open);
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        sec.querySelector('.day-rows').hidden = !open;
      })
    );
    el.querySelectorAll('.meal-toggle').forEach((btn) =>
      btn.addEventListener('click', () => {
        const sec = btn.closest('.meal-fold');
        const key = sec.dataset.meal;
        const open = !openMeals.has(key);
        if (open) openMeals.add(key);
        else openMeals.delete(key);
        sec.classList.toggle('open', open);
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        sec.querySelector('.meal-rows').hidden = !open;
      })
    );
    el.querySelectorAll('.entry-row[data-eid]').forEach((row) =>
      row.addEventListener('click', () => {
        // The local entry as rendered, seq included: the form sends that seq
        // as ifSeq, so an edit made on the other phone meanwhile is a 409.
        const entry = entries.find((e) => e.eid === row.dataset.eid);
        if (!entry) return;
        openEntryForm({
          type: entry.type,
          entry,
          // The write already re-rendered this view through the store's
          // notification; the refresh only picks up the other phone.
          onSaved: () => store.refreshAfterWrite().catch(() => {}),
        });
      })
    );
    el.querySelector('[data-more]')?.addEventListener('click', async (e) => {
      if (loading) return;
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = t('history.loading');
      await load({ from: shiftDate(fromDate, -PAGE_DAYS[view]), userInitiated: true, forceRender: true });
      // On success render() replaced the button; after a failure restore this one.
      const cur = el.querySelector('[data-more]');
      if (cur && cur.disabled) {
        cur.disabled = false;
        cur.textContent = MORE_LABELS[view];
      }
    });
  }

  renderPlaceholder(null);
  load();
  // Re-read whenever the store notifies (sync, local write, unlock) — the
  // other phone may have logged something. Unchanged lists skip the
  // re-render (see load()).
  const unsubscribe = store.subscribe(() => load());

  return () => unsubscribe();
}
