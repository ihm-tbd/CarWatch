// Requirement 004 (Car Watch V2), stage 1: pure data-model functions —
// the derived check-due date, trend eligibility, reading order, and the
// archived/visible join. See lib/model.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  dueDate,
  hasTrend,
  orderedReadings,
  visibleConfigurations,
  visiblePricePoints,
  visibleQuotes,
} from '../lib/model.js';

// --- dueDate ---------------------------------------------------------------

test('dueDate is null when there is no last-checked date yet, regardless of interval', () => {
  assert.equal(dueDate(null, 14), null);
  assert.equal(dueDate(undefined, 14), null);
  assert.equal(dueDate('', 14), null);
});

test('dueDate adds the interval in whole days, across a month boundary', () => {
  assert.equal(dueDate('2026-09-18', 14), '2026-10-02');
  assert.equal(dueDate('2026-09-01', 7), '2026-09-08');
});

test('dueDate falls back to the 14-day default when the interval is missing or not a positive number', () => {
  assert.equal(dueDate('2026-09-18', undefined), '2026-10-02');
  assert.equal(dueDate('2026-09-18', 0), '2026-10-02');
  assert.equal(dueDate('2026-09-18', -5), '2026-10-02');
  assert.equal(dueDate('2026-09-18', NaN), '2026-10-02');
});

test('dueDate is never stored — it is fully determined by its two inputs, so calling it twice with the same inputs agrees', () => {
  assert.equal(dueDate('2026-09-18', 14), dueDate('2026-09-18', 14));
});

// --- hasTrend ----------------------------------------------------------------

test('hasTrend: new never has a trend, no matter how many readings', () => {
  assert.equal(hasTrend('new', 0), false);
  assert.equal(hasTrend('new', 1), false);
  assert.equal(hasTrend('new', 2), false);
  assert.equal(hasTrend('new', 50), false);
});

test('hasTrend: used and cpo need at least two readings', () => {
  assert.equal(hasTrend('used', 0), false);
  assert.equal(hasTrend('used', 1), false);
  assert.equal(hasTrend('used', 2), true);
  assert.equal(hasTrend('used', 3), true);
  assert.equal(hasTrend('cpo', 1), false);
  assert.equal(hasTrend('cpo', 2), true);
});

test('hasTrend: an unset or unrecognized condition never has a trend', () => {
  assert.equal(hasTrend(null, 5), false);
  assert.equal(hasTrend(undefined, 5), false);
  assert.equal(hasTrend('unknown-condition', 5), false);
});

// --- orderedReadings -----------------------------------------------------

test('orderedReadings sorts one configuration\'s price points oldest first by observed date', () => {
  const pricePoints = [
    { configuration: 'c1', id: 'pp3', observed: '2026-09-18' },
    { configuration: 'c1', id: 'pp1', observed: '2026-08-25' },
    { configuration: 'c1', id: 'pp2', observed: '2026-09-08' },
  ];
  assert.deepEqual(
    orderedReadings('c1', pricePoints).map((p) => p.id),
    ['pp1', 'pp2', 'pp3']
  );
});

test('orderedReadings only includes price points for the requested configuration', () => {
  const pricePoints = [
    { configuration: 'c1', id: 'pp1', observed: '2026-09-01' },
    { configuration: 'c2', id: 'pp2', observed: '2026-09-02' },
  ];
  assert.deepEqual(
    orderedReadings('c1', pricePoints).map((p) => p.id),
    ['pp1']
  );
});

test('orderedReadings puts undated price points after every dated one, keeping their file order', () => {
  const pricePoints = [
    { configuration: 'c1', id: 'undated-a', observed: null },
    { configuration: 'c1', id: 'dated', observed: '2026-09-01' },
    { configuration: 'c1', id: 'undated-b', observed: null },
  ];
  assert.deepEqual(
    orderedReadings('c1', pricePoints).map((p) => p.id),
    ['dated', 'undated-a', 'undated-b']
  );
});

test('orderedReadings keeps file order for two readings on the same date (stable sort)', () => {
  const pricePoints = [
    { configuration: 'c1', id: 'first', observed: '2026-09-01' },
    { configuration: 'c1', id: 'second', observed: '2026-09-01' },
  ];
  assert.deepEqual(
    orderedReadings('c1', pricePoints).map((p) => p.id),
    ['first', 'second']
  );
});

// --- visible* (archive join) ----------------------------------------------

const configurations = [
  { id: 'c1', car: 'cx90', trim: 'Preferred', archived: false },
  { id: 'c2', car: 'cx90', trim: 'Premium Plus', archived: true },
];

test('visibleConfigurations drops archived configurations, keeps the rest', () => {
  assert.deepEqual(
    visibleConfigurations(configurations).map((c) => c.id),
    ['c1']
  );
});

test('visiblePricePoints drops price points belonging to an archived configuration', () => {
  const pricePoints = [
    { id: 'pp1', configuration: 'c1' },
    { id: 'pp2', configuration: 'c2' },
  ];
  assert.deepEqual(
    visiblePricePoints(configurations, pricePoints).map((p) => p.id),
    ['pp1']
  );
});

test('visibleQuotes drops quotes belonging to an archived configuration', () => {
  const quotes = [
    { id: 'q1', configuration: 'c1' },
    { id: 'q2', configuration: 'c2' },
  ];
  assert.deepEqual(
    visibleQuotes(configurations, quotes).map((q) => q.id),
    ['q1']
  );
});

test('visiblePricePoints and visibleQuotes pass through records whose configuration id is unknown (not this join\'s problem)', () => {
  assert.deepEqual(
    visiblePricePoints(configurations, [{ id: 'pp1', configuration: 'ghost' }]).map((p) => p.id),
    ['pp1']
  );
});
