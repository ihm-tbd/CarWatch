// Covers lib/watchlist.js (requirement 004, stage 4a: "the watchlist
// screen") — the shared price-spread axis and its clamping, per-tab row
// building, attention tiles (including the "keeps its place and shows a
// zero" rule), and the sort comparator. Fixtures are plain arrays in the
// same shape lib/parse-tracker.js produces, matching the style of
// test/trend-chart.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeAxisBounds,
  buildSpreadBar,
  conditionCategoryOf,
  filterConfigsByTab,
  buildCarRow,
  buildWatchlistTab,
  buildAttentionTiles,
  sortRows,
  buildWatchlistData,
} from '../lib/watchlist.js';

const NOW = new Date('2026-09-22T12:00:00Z');

function car(id, model, overrides = {}) {
  return { id, make: 'Mazda', model, years: '2025-2026', trimsTracked: [], checkIntervalDays: 14, ...overrides };
}

function config(id, car, year, trim, condition) {
  return { id, car, year, trim, condition };
}

function price(configuration, value, observed) {
  return { configuration, value, observed, basis: 'listing' };
}

// --- computeAxisBounds -------------------------------------------------------

test('computeAxisBounds rounds the global min down and max up to the nearest $5,000', () => {
  const axis = computeAxisBounds([{ low: 30694, high: 34068 }, { low: 42675, high: 50270 }]);
  assert.deepEqual(axis, { min: 30000, max: 55000 });
});

test('computeAxisBounds returns null when nothing is priced', () => {
  assert.equal(computeAxisBounds([null, { low: null, high: null }]), null);
  assert.equal(computeAxisBounds([]), null);
});

test('computeAxisBounds widens a degenerate single-value axis rather than a zero-span range', () => {
  const axis = computeAxisBounds([{ low: 30000, high: 30000 }]);
  assert.deepEqual(axis, { min: 25000, max: 35000 });
});

test('computeAxisBounds never rounds a degenerate axis below zero', () => {
  const axis = computeAxisBounds([{ low: 2000, high: 2000 }]);
  assert.equal(axis.min, 0);
  assert.equal(axis.max, 5000);
});

// --- buildSpreadBar ----------------------------------------------------------

test('buildSpreadBar places a spread fully inside the axis without clipping', () => {
  const bar = buildSpreadBar(30694, 50270, 30000, 55000);
  assert.ok(bar.leftPct > 0 && bar.leftPct < 10);
  assert.ok(bar.rightPct > 80 && bar.rightPct < 100);
  assert.equal(bar.clippedLeft, false);
  assert.equal(bar.clippedRight, false);
});

test('buildSpreadBar clamps a spread whose low sits below the axis, and flags it clipped', () => {
  const bar = buildSpreadBar(10000, 40000, 30000, 55000);
  assert.equal(bar.leftPct, 0);
  assert.equal(bar.clippedLeft, true);
  assert.equal(bar.clippedRight, false);
});

test('buildSpreadBar clamps a spread whose high sits above the axis, and flags it clipped', () => {
  const bar = buildSpreadBar(35000, 90000, 30000, 55000);
  assert.equal(bar.rightPct, 100);
  assert.equal(bar.clippedRight, true);
  assert.equal(bar.clippedLeft, false);
});

test('buildSpreadBar never draws outside the 0-100 track even when both ends fall outside the axis', () => {
  const bar = buildSpreadBar(-5000, 200000, 30000, 55000);
  assert.equal(bar.leftPct, 0);
  assert.equal(bar.rightPct, 100);
  assert.equal(bar.clippedLeft, true);
  assert.equal(bar.clippedRight, true);
  assert.equal(bar.widthPct, 100);
});

// --- filter tabs ---------------------------------------------------------------

test('conditionCategoryOf groups cpo and used together as pre-owned', () => {
  assert.equal(conditionCategoryOf('new'), 'new');
  assert.equal(conditionCategoryOf('cpo'), 'preowned');
  assert.equal(conditionCategoryOf('used'), 'preowned');
});

test('filterConfigsByTab: all returns everything, new/preowned restrict by condition', () => {
  const configs = [config('a', 'c', 2026, 'Preferred', 'new'), config('b', 'c', 2025, 'Preferred', 'used')];
  assert.equal(filterConfigsByTab(configs, 'all').length, 2);
  assert.deepEqual(filterConfigsByTab(configs, 'new').map((c) => c.id), ['a']);
  assert.deepEqual(filterConfigsByTab(configs, 'preowned').map((c) => c.id), ['b']);
});

// --- buildCarRow ---------------------------------------------------------------

function cx90Fixture() {
  const c = car('cx90', 'CX-90 Turbo', { trimsTracked: ['Preferred', 'Premium Sport'] });
  const configs = [
    config('c26-pref', 'cx90', '2026', 'Preferred', 'new'),
    config('c25-pref-cpo', 'cx90', '2025', 'Preferred', 'cpo'),
    config('c25-pref-used', 'cx90', '2025', 'Preferred', 'used'),
  ];
  const prices = [
    price('c26-pref', 43450, '2026-09-17'),
    price('c25-pref-cpo', 30694, '2026-09-18'),
    price('c25-pref-used', 34068, '2026-09-18'),
  ];
  const quotes = [{ configuration: 'c26-pref' }, { configuration: 'c25-pref-cpo' }];
  const incentives = [{ id: 'i1', car: 'cx90', expires: '2026-09-30', appliesTo: ['c26-pref'] }];
  return { car: c, configs, prices, quotes, incentives };
}

test('buildCarRow: lowest price and its configuration label, restricted to the tab', () => {
  const { car: c, configs, prices, quotes, incentives } = cx90Fixture();
  const row = buildCarRow(c, configs, prices, quotes, incentives, NOW, 'all');
  assert.equal(row.lowestPrice.value, 30694);
  assert.equal(row.lowestPrice.label, '2025 CPO');
  assert.deepEqual(row.spread, { low: 30694, high: 43450 });
});

test('buildCarRow: the New tab restricts the lowest price and spread to new configurations only', () => {
  const { car: c, configs, prices, quotes, incentives } = cx90Fixture();
  const row = buildCarRow(c, configs, prices, quotes, incentives, NOW, 'new');
  assert.equal(row.lowestPrice.value, 43450);
  assert.deepEqual(row.spread, { low: 43450, high: 43450 });
});

test('buildCarRow: a tab with no priced configurations reads "No prices yet", not a pending-check phrase', () => {
  const c = car('empty', 'Empty Car');
  const configs = [config('e1', 'empty', '2026', 'Preferred', 'new')];
  const row = buildCarRow(c, configs, [], [], [], NOW, 'all');
  assert.equal(row.lowestPrice.value, null);
  assert.equal(row.lowestPrice.reason, 'No prices yet');
  assert.equal(row.spread, null);
});

test('buildCarRow: quotes and the incentive summary are whole-car, unaffected by the tab', () => {
  const { car: c, configs, prices, quotes, incentives } = cx90Fixture();
  const allTab = buildCarRow(c, configs, prices, quotes, incentives, NOW, 'all');
  const newTab = buildCarRow(c, configs, prices, quotes, incentives, NOW, 'new');
  assert.equal(allTab.quoteCount, 2);
  assert.equal(newTab.quoteCount, 2);
  assert.equal(allTab.incentiveSummary.count, 1);
  assert.equal(newTab.incentiveSummary.count, 1);
});

test('buildCarRow: subtitle names trim count, variant count and years, independent of tab', () => {
  const { car: c, configs, prices, quotes, incentives } = cx90Fixture();
  const row = buildCarRow(c, configs, prices, quotes, incentives, NOW, 'new');
  assert.equal(row.subtitle, '1 trim · 3 variants · 2025–2026');
});

// --- buildWatchlistTab ----------------------------------------------------------

test('buildWatchlistTab derives one shared axis from every row in the tab', () => {
  const carA = car('a', 'A');
  const carB = car('b', 'B');
  const configs = [config('ca', 'a', '2026', 'X', 'used'), config('cb', 'b', '2026', 'X', 'used')];
  const prices = [price('ca', 20500, '2026-09-01'), price('cb', 61000, '2026-09-02')];
  const { axis, rows } = buildWatchlistTab([carA, carB], configs, prices, [], [], NOW, 'all');
  assert.deepEqual(axis, { min: 20000, max: 65000 });
  assert.equal(rows.length, 2);
  assert.ok(rows[0].spreadBar);
  assert.equal(rows[0].spreadBar.clippedLeft, false);
});

test('buildWatchlistTab: a row with no data in the tab gets a null spreadBar, never a crash', () => {
  const carA = car('a', 'A');
  const configs = [config('ca', 'a', '2026', 'X', 'new')];
  const { rows } = buildWatchlistTab([carA], configs, [], [], [], NOW, 'preowned');
  assert.equal(rows[0].spreadBar, null);
});

// --- attention tiles -------------------------------------------------------------

test('buildAttentionTiles: a tile with nothing to report keeps its place and shows a zero', () => {
  const tiles = buildAttentionTiles([], [], [], [], [], NOW);
  assert.equal(tiles.expiry.days, 0);
  assert.equal(tiles.expiry.subtitle, 'No incentives on file');
  assert.equal(tiles.awaitingFirstPrice.count, 0);
  assert.equal(tiles.quotesLogged.count, 0);
  assert.equal(tiles.quotesLogged.subtitle, 'Yours only · not in the trend');
});

test('buildAttentionTiles: expiry names the soonest car and the number of offers sharing its date', () => {
  const cars = [car('cx90', 'CX-90 Turbo')];
  const incentives = [
    { id: 'i1', car: 'cx90', expires: '2026-09-30', appliesTo: [] },
    { id: 'i2', car: 'cx90', expires: '2026-09-30', appliesTo: [] },
  ];
  const tiles = buildAttentionTiles(cars, [], [], [], incentives, NOW);
  assert.equal(tiles.expiry.days, 8);
  assert.equal(tiles.expiry.subtitle, 'CX-90 Turbo · 2 offers end Sep 30');
});

test('buildAttentionTiles: counts cars with zero price points as awaiting a first price', () => {
  const cars = [car('a', 'A'), car('b', 'B')];
  const configs = [config('ca', 'a', '2026', 'X', 'new'), config('cb', 'b', '2026', 'X', 'new')];
  const prices = [price('ca', 30000, '2026-09-01')];
  const tiles = buildAttentionTiles(cars, configs, prices, [], [], NOW);
  assert.equal(tiles.awaitingFirstPrice.count, 1);
  assert.equal(tiles.awaitingFirstPrice.subtitle, 'B has no prices yet');
});

// --- sortRows ----------------------------------------------------------------

test('sortRows: lowest-price ascending, rows with no price sort last', () => {
  const rows = [
    { carId: 'a', lowestPrice: { value: 40000 }, deadlineDays: null, lastUpdatedDate: null },
    { carId: 'b', lowestPrice: { value: null }, deadlineDays: null, lastUpdatedDate: null },
    { carId: 'c', lowestPrice: { value: 20000 }, deadlineDays: null, lastUpdatedDate: null },
  ];
  assert.deepEqual(sortRows(rows, 'lowest-price').map((r) => r.carId), ['c', 'a', 'b']);
});

test('sortRows: deadline-soonest ascending, cars with no incentive sort last', () => {
  const rows = [
    { carId: 'a', lowestPrice: { value: null }, deadlineDays: 20, lastUpdatedDate: null },
    { carId: 'b', lowestPrice: { value: null }, deadlineDays: null, lastUpdatedDate: null },
    { carId: 'c', lowestPrice: { value: null }, deadlineDays: 5, lastUpdatedDate: null },
  ];
  assert.deepEqual(sortRows(rows, 'deadline-soonest').map((r) => r.carId), ['c', 'a', 'b']);
});

test('sortRows: recently-updated puts the newest observation first, undated last', () => {
  const rows = [
    { carId: 'a', lowestPrice: { value: null }, deadlineDays: null, lastUpdatedDate: '2026-09-01' },
    { carId: 'b', lowestPrice: { value: null }, deadlineDays: null, lastUpdatedDate: null },
    { carId: 'c', lowestPrice: { value: null }, deadlineDays: null, lastUpdatedDate: '2026-09-18' },
  ];
  assert.deepEqual(sortRows(rows, 'recently-updated').map((r) => r.carId), ['c', 'a', 'b']);
});

// --- buildWatchlistData ---------------------------------------------------------

test('buildWatchlistData builds all three tabs plus tiles from one call', () => {
  const { car: c, configs, prices, quotes, incentives } = cx90Fixture();
  const data = buildWatchlistData([c], configs, prices, quotes, incentives, NOW);
  assert.deepEqual(Object.keys(data.tabs).sort(), ['all', 'new', 'preowned']);
  assert.equal(data.carCount, 1);
  assert.equal(data.variantCount, 3);
  assert.ok(data.tiles);
});
