// The SVG builders of Verlauf › Grafik (src/charts.js): axis maths and the
// shape of the markup — bars per value, scale, guide, labels, escaping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { niceStep, niceScale, niceRange, barChart, lineChart, CHART_W, CHART_H } from '../charts.js';

const count = (s, re) => (s.match(re) || []).length;

test('niceStep / niceScale / niceRange', () => {
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

test('the stylesheet keeps a line chart a line: the path rule outranks the series fill', () => {
  // A class-only `.chart-line { fill: none }` lost to `.chart .measure { fill }`, and a
  // three-point weight line closed into a filled polygon.
  const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  assert.match(css, /\.chart path\.chart-line\s*\{[^}]*fill:\s*none/);
});
