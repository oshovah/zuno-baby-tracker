// The SVG behind «Verlauf › Grafik»: a bar chart per day (stacked or
// grouped, with an optional guide line) and a line chart over time (weight,
// temperature). Pure string builders — geometry in a fixed viewBox that the
// stylesheet scales to the card's width; every colour is a class the
// stylesheet maps to a design token (.milk, .diaper, .sleep, .measure,
// .second). Node-tested in tests/charts.test.mjs.

import { escapeHtml } from './ui.js';

export const CHART_W = 320;
export const CHART_H = 150;
const PAD = { l: 36, r: 10, t: 12, b: 20 };
/** About the advance of one 10 px glyph — the axis margin follows the longest label. */
const GLYPH_W = 5.6;
/** … and of a 9 px one: the value labels above the bars (.chart-bar-value). */
const VALUE_GLYPH_W = 5;
/** A value label is drawn only where it fits its bar (or its day's slot). */
const fits = (label, width) => String(label).length * VALUE_GLYPH_W + 2 <= width;

const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

/** The "nice" step ≥ raw: 1, 2, 5 × 10^k. */
export function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

/** An axis from 0 to a nice top ≥ max in about `count` steps: { max, step }. */
export function niceScale(max, count = 4) {
  const step = niceStep((max > 0 ? max : 1) / count);
  return { max: Math.max(step, Math.ceil(max / step) * step), step };
}

/**
 * An axis around [lo, hi] (a measurement series): { min, max, step } on
 * nice bounds, at least `minStep` apart (100 g for a weight, half a degree
 * for a temperature — a single reading gets a sensible band, not a
 * 2–4 kg one), with headroom above the top reading for its value label.
 */
export function niceRange(lo, hi, count = 3, minStep = 0) {
  const span = hi - lo;
  const step = Math.max(niceStep((span > 0 ? span : minStep || Math.abs(hi) || 1) / count), minStep);
  let min = Math.floor(lo / step) * step;
  let max = Math.ceil(hi / step) * step;
  if (max === min || hi >= max) max += step;
  return { min: round(min, step), max: round(max, step), step };
}

const round = (v, step) => {
  const d = step < 1 ? Math.ceil(-Math.log10(step)) : 0;
  return Number(v.toFixed(d));
};

/** The plot area, its left margin wide enough for `yLabels` («150 Min.»). */
const plot = (yLabels = []) => {
  const l = Math.max(PAD.l, Math.ceil(Math.max(0, ...yLabels.map((s) => String(s).length)) * GLYPH_W) + 9);
  return { x: l, y: PAD.t, w: CHART_W - l - PAD.r, h: CHART_H - PAD.t - PAD.b };
};

const tickValues = (min, max, step) => {
  const out = [];
  for (let v = min; v <= max + step / 1e6; v += step) out.push(round(v, step));
  return out;
};

function gridHtml(p, scaleY, ticks, yFormat) {
  return ticks
    .map((v) => {
      const y = scaleY(v);
      return `<line class="chart-grid" x1="${p.x}" x2="${p.x + p.w}" y1="${fmt(y)}" y2="${fmt(y)}"/>` +
        `<text class="chart-axis" x="${p.x - 5}" y="${fmt(y + 3.5)}" text-anchor="end">${escapeHtml(yFormat(v))}</text>`;
    })
    .join('');
}

function guideHtml(p, scaleY, guide) {
  if (!guide || !(guide.v > 0)) return '';
  const y = scaleY(guide.v);
  return `<line class="chart-guide" x1="${p.x}" x2="${p.x + p.w}" y1="${fmt(y)}" y2="${fmt(y)}"/>` +
    (guide.label ? `<text class="chart-guide-label" x="${p.x + p.w}" y="${fmt(y - 3)}" text-anchor="end">${escapeHtml(guide.label)}</text>` : '');
}

/**
 * Bars per day. `days` = the x slots (labels through `xLabel`, every k-th
 * shown so at most ~7 fit), `series` = [{ label, values, cls }] with one
 * value per day — stacked on top of each other (`mode: 'stacked'`) or side
 * by side (`'grouped'`). `guide` = { v, label } draws a dashed line;
 * `yFormat` labels the axis, `valueFormat` the per-bar tooltip, `labelFormat`
 * the number written above a bar — a phone has no hover, so the bars carry
 * their values: the day's total above a stack, each bar's own number above
 * grouped bars — wherever the number fits (a stack's total fits a 7-day and a
 * 14-day slot, a grouped bar only takes one or two digits; a 28-day range
 * shows one-digit counts). A number above a bar is always THAT bar's value:
 * no total above a grouped pair, it would read as the taller bar's.
 * `values: false` leaves them out.
 */
export function barChart({ days, series, mode = 'stacked', guide = null, yFormat = fmt, valueFormat = fmt, labelFormat = fmt, xLabel = (d) => d, title = '', values = true }) {
  const n = days.length;
  const totals = days.map((_, i) => (mode === 'stacked' ? series.reduce((s, sr) => s + (sr.values[i] || 0), 0) : Math.max(...series.map((sr) => sr.values[i] || 0), 0)));
  const dataMax = Math.max(0, ...totals, guide && guide.v > 0 ? guide.v : 0);
  const { max, step } = niceScale(dataMax);
  const ticks = tickValues(0, max, step);
  const p = plot(ticks.map(yFormat));
  const scaleY = (v) => p.y + p.h - (v / max) * p.h;
  const slot = p.w / Math.max(n, 1);
  const bars = [];
  const valueLabels = [];
  const bw = mode === 'stacked' ? slot * 0.62 : (slot * 0.72) / Math.max(series.length, 1);
  const valueText = (x, y, label) =>
    `<text class="chart-bar-value" x="${fmt(x)}" y="${fmt(y - 3)}" text-anchor="middle">${escapeHtml(label)}</text>`;
  // Grouped: one rule for the whole chart — the widest number decides for all.
  const widest = Math.max(0, ...series.flatMap((sr) => sr.values.filter((v) => v > 0).map((v) => String(labelFormat(v)).length)));
  const perBar = mode === 'grouped' && widest * VALUE_GLYPH_W + 2 <= bw;
  days.forEach((day, i) => {
    let stackTop = 0;
    series.forEach((sr, si) => {
      const v = sr.values[i] || 0;
      if (!(v > 0)) return;
      const x = mode === 'stacked' ? p.x + i * slot + (slot - bw) / 2 : p.x + i * slot + (slot - bw * series.length) / 2 + si * bw;
      const y1 = scaleY(mode === 'stacked' ? stackTop + v : v);
      const y0 = scaleY(mode === 'stacked' ? stackTop : 0);
      if (mode === 'stacked') stackTop += v;
      bars.push(
        `<rect class="chart-bar ${escapeHtml(sr.cls || '')}" x="${fmt(x)}" y="${fmt(y1)}" width="${fmt(bw)}" height="${fmt(Math.max(1, y0 - y1))}"><title>${escapeHtml(`${xLabel(day)} · ${sr.label}: ${valueFormat(v)}`)}</title></rect>`
      );
      if (values && perBar) valueLabels.push(valueText(x + bw / 2, y1, labelFormat(v)));
    });
    if (values && mode === 'stacked' && stackTop > 0) {
      const label = labelFormat(stackTop);
      if (fits(label, slot)) valueLabels.push(valueText(p.x + i * slot + slot / 2, scaleY(stackTop), label));
    }
  });
  const every = Math.ceil(n / 7);
  const labels = days
    .map((day, i) => (i % every === 0 || i === n - 1 ? `<text class="chart-axis" x="${fmt(p.x + i * slot + slot / 2)}" y="${CHART_H - 6}" text-anchor="middle">${escapeHtml(xLabel(day))}</text>` : ''))
    .join('');
  return `<svg viewBox="0 0 ${CHART_W} ${CHART_H}" role="img" aria-label="${escapeHtml(title)}">` +
    gridHtml(p, scaleY, ticks, yFormat) + guideHtml(p, scaleY, guide) + bars.join('') + valueLabels.join('') + labels + '</svg>';
}

/**
 * A line over time: `points` = [{ ms, v }] oldest first, drawn between
 * `fromMs` and `toMs`; `xTicks` = [{ ms, label }]; the last point carries
 * its value (`valueFormat`). `guide` as for the bars.
 */
export function lineChart({ points, fromMs, toMs, xTicks = [], yFormat = fmt, valueFormat = fmt, cls = 'measure', guide = null, minStep = 0, title = '' }) {
  const vs = points.map((pt) => pt.v);
  const lo = Math.min(...vs, guide && guide.v ? guide.v : Infinity);
  const hi = Math.max(...vs, guide && guide.v ? guide.v : -Infinity);
  const { min, max, step } = niceRange(lo, hi, 3, minStep);
  const ticks = tickValues(min, max, step);
  const p = plot(ticks.map(yFormat));
  const span = Math.max(1, toMs - fromMs);
  const scaleX = (ms) => p.x + ((ms - fromMs) / span) * p.w;
  const scaleY = (v) => p.y + p.h - ((v - min) / (max - min)) * p.h;
  const path = points.map((pt, i) => `${i ? 'L' : 'M'}${fmt(scaleX(pt.ms))} ${fmt(scaleY(pt.v))}`).join(' ');
  const dots = points
    .map((pt) => `<circle class="chart-point ${escapeHtml(cls)}" cx="${fmt(scaleX(pt.ms))}" cy="${fmt(scaleY(pt.v))}" r="3"><title>${escapeHtml(valueFormat(pt.v))}</title></circle>`)
    .join('');
  const last = points[points.length - 1];
  const lastX = scaleX(last.ms);
  const label = `<text class="chart-value" x="${fmt(Math.min(lastX, p.x + p.w - 2))}" y="${fmt(scaleY(last.v) - 7)}" text-anchor="${lastX > p.x + p.w * 0.8 ? 'end' : 'middle'}">${escapeHtml(valueFormat(last.v))}</text>`;
  const labels = xTicks
    .map((tk) => `<text class="chart-axis" x="${fmt(scaleX(tk.ms))}" y="${CHART_H - 6}" text-anchor="middle">${escapeHtml(tk.label)}</text>`)
    .join('');
  return `<svg viewBox="0 0 ${CHART_W} ${CHART_H}" role="img" aria-label="${escapeHtml(title)}">` +
    gridHtml(p, scaleY, ticks, yFormat) + guideHtml(p, scaleY, guide) +
    (points.length > 1 ? `<path class="chart-line ${escapeHtml(cls)}" d="${path}"/>` : '') + dots + label + labels + '</svg>';
}
