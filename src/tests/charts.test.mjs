// The SVG builders of Verlauf › Grafik (src/charts.js): axis maths and the
// shape of the markup — bars per value, scale, guide, labels, escaping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { niceStep, niceScale, niceRange, barChart, lineChart, soloSeries, toggleSolo, CHART_W, CHART_H } from '../charts.js';

const count = (s, re) => (s.match(re) || []).length;

test('niceStep / niceScale / niceRange', () => {
  // A count's axis never steps below one: two a day → 0, 1, 2.
  assert.deepEqual(niceScale(2, 4, 1), { max: 2, step: 1 });
  assert.deepEqual(niceScale(3, 4, 1), { max: 3, step: 1 });
  assert.deepEqual(niceScale(0, 4, 1), { max: 1, step: 1 });
  assert.deepEqual(niceScale(2), { max: 2, step: 0.5 });
  assert.ok(barChart({ days: ['2026-09-01'], series: [{ label: 'Gaggi', values: [2], cls: 'measure' }], minStep: 1 }).includes('>1</text>'));
  assert.ok(!barChart({ days: ['2026-09-01'], series: [{ label: 'Gaggi', values: [2], cls: 'measure' }], minStep: 1 }).includes('>0.5</text>'));
  assert.deepEqual([0.3, 3, 37, 120].map(niceStep), [0.5, 5, 50, 200]);
  assert.equal(niceStep(0), 1);
  assert.deepEqual(niceScale(9), { max: 10, step: 5 });
  assert.deepEqual(niceScale(6), { max: 6, step: 2 });
  assert.deepEqual(niceScale(13), { max: 15, step: 5 });
  // A single reading gets a band of the minimum step, with headroom above it.
  assert.deepEqual(niceRange(3500, 3500, 3, 100), { min: 3500, max: 3600, step: 100 });
  assert.deepEqual(niceRange(3450, 3620, 3, 100), { min: 3400, max: 3700, step: 100 });
  assert.deepEqual(niceRange(36.6, 38, 3, 0.5), { min: 36.5, max: 38.5, step: 0.5 });
});

test('barChart: one rect per positive value, stacked heights add up, guide and labels present', () => {
  const days = ['2026-09-01', '2026-09-02', '2026-09-03'];
  const svg = barChart({
    days,
    series: [
      { label: 'Links', values: [10, 0, 5], cls: 'milk' },
      { label: 'Rechts', values: [5, 8, 0], cls: 'milk second' },
    ],
    guide: { v: 20, label: 'Ziel 20' },
    xLabel: (d) => `${Number(d.slice(8))}.`,
    yFormat: (v) => `${v} Min.`,
    title: 'Stillen',
  });
  assert.ok(svg.startsWith(`<svg viewBox="0 0 ${CHART_W} ${CHART_H}"`));
  assert.equal(count(svg, /<rect/g), 4);
  assert.ok(svg.includes('class="chart-guide"') && svg.includes('Ziel 20'));
  assert.ok(svg.includes('aria-label="Stillen"'));
  assert.ok(svg.includes('>1.</text>') && svg.includes('>3.</text>'));
  assert.ok(svg.includes('20 Min.'));
  // Day 1: the two bars stack to 15 of the axis top 20 → three quarters of the plot height.
  const heights = [...svg.matchAll(/<rect[^>]*height="([\d.]+)"/g)].map((m) => Number(m[1]));
  const plotH = CHART_H - 12 - 20;
  assert.ok(Math.abs(heights[0] + heights[1] - plotH * 0.75) < 0.6, `stacked ${heights[0] + heights[1]} vs ${plotH * 0.75}`);
  // Tooltips carry day, series and value.
  assert.ok(svg.includes('<title>1. · Links: 10</title>'));
  // The day's total above each stack (a phone has no hover): 15, 8, 5.
  const values = [...svg.matchAll(/<text class="chart-bar-value"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  assert.deepEqual(values, ['15', '8', '5']);
  assert.ok(!barChart({ days, series: [{ label: 'x', values: [1, 2, 3], cls: 'milk' }], values: false }).includes('chart-bar-value'));
});

test('barChart: a value label only where it fits — one-digit counts on 28 days, three digits on 7 and 14 days, not on 28', () => {
  const days = (n) => Array.from({ length: n }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);
  const labelsOf = (svg) => [...svg.matchAll(/<text class="chart-bar-value"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  const counts = (n) => barChart({ days: days(n), series: [{ label: 'm', values: days(n).map(() => 6), cls: 'milk' }] });
  assert.equal(labelsOf(counts(28)).length, 28, 'a «6» fits a 28-day slot');
  const ml = (n, mode) => barChart({ days: days(n), series: [{ label: 'b', values: days(n).map(() => 120), cls: 'milk' }, { label: 'f', values: days(n).map(() => 40), cls: 'formula' }], mode });
  assert.deepEqual(labelsOf(ml(7, 'stacked')).slice(0, 2), ['160', '160']);
  assert.equal(labelsOf(ml(14, 'stacked')).length, 14, '«160» fits a 14-day slot');
  assert.equal(labelsOf(ml(28, 'stacked')).length, 0, 'not a 28-day one');
  // Grouped: each bar its own number — wider than the bar is fine, wider
  // than the day is not, and a label that would sit on one already placed
  // (side by side, about the same height) is left out. Never a total above
  // a pair: it would read as the taller bar's value.
  const grouped = (n, a, b) => barChart({ days: days(n), series: [{ label: 'w', values: days(n).map(() => a), cls: 'diaper' }, { label: 's', values: days(n).map(() => b), cls: 'measure' }], mode: 'grouped' });
  assert.deepEqual(labelsOf(grouped(7, 5, 2)).slice(0, 2), ['5', '2']);
  assert.deepEqual(labelsOf(grouped(14, 5, 2)).slice(0, 2), ['5', '2']);
  assert.deepEqual(labelsOf(grouped(14, 10, 2)).slice(0, 2), ['10', '2'], 'a two-digit count on 14 days: heights differ, both stay');
  assert.deepEqual(labelsOf(grouped(14, 10, 10)), days(14).map(() => '10'), 'the same height: the later one is left out');
  assert.deepEqual(labelsOf(grouped(28, 5, 2)).slice(0, 2), ['5', '2'], 'one digit on 28 days, at different heights');
  assert.equal(labelsOf(grouped(28, 6, 6)).length, 28, 'the same height on 28 days: one per day');
  assert.deepEqual([...new Set(labelsOf(grouped(28, 12, 3)))], ['3'], 'two digits are wider than a 28-day slot, the one-digit neighbour still shows');
  assert.deepEqual(labelsOf(ml(7, 'grouped')).slice(0, 2), ['120', '40'], 'three digits on 7 days: wider than the bar, narrower than the day');
  assert.deepEqual(labelsOf(ml(14, 'grouped')).slice(0, 2), ['120', '40'], '… and on 14 days, the heights differ');
  assert.equal(labelsOf(ml(28, 'grouped')).length, 0);
});

test('barChart: grouped bars sit side by side, nothing for zero, labels escaped', () => {
  const svg = barChart({
    days: ['2026-09-01'],
    series: [
      { label: 'a<b>', values: [3], cls: 'diaper' },
      { label: 'b', values: [0], cls: 'measure' },
    ],
    mode: 'grouped',
    title: 'x & y',
  });
  assert.equal(count(svg, /<rect/g), 1);
  assert.ok(svg.includes('a&lt;b&gt;') && svg.includes('aria-label="x &amp; y"'));
});

test('lineChart: a path through the points, a dot each, the last value labelled, x ticks', () => {
  const day = 86400000;
  const svg = lineChart({
    points: [
      { ms: 0, v: 3450 },
      { ms: 2 * day, v: 3620 },
    ],
    fromMs: 0,
    toMs: 4 * day,
    xTicks: [{ ms: 0, label: '1.9.' }, { ms: 4 * day, label: '5.9.' }],
    valueFormat: (v) => `${v / 1000} kg`,
    minStep: 100,
    cls: 'measure',
  });
  assert.equal(count(svg, /<circle/g), 2);
  assert.equal(count(svg, /<path class="chart-line measure"/g), 1);
  assert.ok(svg.includes('>3.62 kg</text>'));
  assert.ok(svg.includes('>1.9.</text>') && svg.includes('>5.9.</text>'));
  // One point: no path, still a dot and its label.
  const one = lineChart({ points: [{ ms: day, v: 37.2 }], fromMs: 0, toMs: 2 * day, minStep: 0.5, guide: { v: 38, label: '38 °C' } });
  assert.equal(count(one, /<path/g), 0);
  assert.equal(count(one, /<circle/g), 1);
  assert.ok(one.includes('38 °C'));
});

test('soloSeries / toggleSolo: one series alone on a legend tap, the same tap lifts it, a stray index counts as none', () => {
  const series = [{ label: 'Pipi' }, { label: 'Gaggi' }];
  assert.deepEqual(soloSeries(series, null), { series, solo: null, dimmed: [false, false] });
  assert.deepEqual(soloSeries(series, undefined), { series, solo: null, dimmed: [false, false] });
  assert.deepEqual(soloSeries(series, 1), { series: [series[1]], solo: 1, dimmed: [true, false] });
  assert.deepEqual(soloSeries(series, 0), { series: [series[0]], solo: 0, dimmed: [false, true] });
  assert.equal(soloSeries(series, 2).solo, null, 'an index the list does not have');
  assert.equal(soloSeries(series, '1').solo, null, 'no number');
  assert.equal(toggleSolo(null, 1), 1);
  assert.equal(toggleSolo(undefined, 0), 0);
  assert.equal(toggleSolo(1, 1), null, 'the item already alone lifts the solo');
  assert.equal(toggleSolo(1, 0), 0, 'the other item takes it');
  // A single series drawn grouped still gets its bars and their numbers.
  const one = barChart({ days: ['2026-09-01', '2026-09-02'], series: soloSeries([{ label: 'Pipi', values: [5, 6], cls: 'diaper' }, { label: 'Gaggi', values: [2, 1], cls: 'measure' }], 0).series, mode: 'grouped' });
  assert.equal((one.match(/<rect/g) || []).length, 2);
  assert.ok(one.includes('>5</text>') && one.includes('>6</text>') && !one.includes('Gaggi'));
});

test('the stylesheet keeps a line chart a line: the path rule outranks the series fill', () => {
  // A class-only `.chart-line { fill: none }` lost to `.chart .measure { fill }`, and a
  // three-point weight line closed into a filled polygon.
  const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  assert.match(css, /\.chart path\.chart-line\s*\{[^}]*fill:\s*none/);
});
