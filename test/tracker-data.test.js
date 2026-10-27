import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildCarDetail,
  buildAppData,
  computeSummary,
  buildIncentivesRail,
  buildTrimSummaries,
  buildReadingsForm,
  findIncentiveConflicts,
  daysRemaining,
  formatShortDate,
  formatYearsLabel,
} from '../lib/tracker-data.js';

function emptyDataRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-data-'));
}

function writeTracker(root, content) {
  fs.writeFileSync(path.join(root, 'tracker.md'), content);
}

const NOW = new Date('2026-09-22T12:00:00Z');

// One car, three model years, three conditions — enough to exercise every
// grouping rule (current-year new, prior-year new, combined pre-owned).
function fixture() {
  return [
    '## Cars',
    '- id: cx90 | make: Mazda | model: CX-90 Turbo | years: 2025-2026',
    '## Configurations',
    '- id: c26-pref | car: cx90 | year: 2026 | trim: Preferred | condition: new',
    '- id: c26-prem | car: cx90 | year: 2026 | trim: Premium Sport | condition: new',
    '- id: c25-pref-new | car: cx90 | year: 2025 | trim: Preferred | condition: new',
    '- id: c25-pref-used | car: cx90 | year: 2025 | trim: Preferred | condition: used',
    '- id: c25-pref-cpo | car: cx90 | year: 2025 | trim: Preferred | condition: cpo',
    '## Price points',
    '- id: pp1 | configuration: c26-pref | value: 43450 | basis: msrp | destination: excluded | source: Mazda USA | confirmed: no | observed: 2026-09-17',
    '- id: pp2 | configuration: c26-prem | value: 47480 | basis: msrp | destination: excluded | source: Mazda USA | confirmed: no | observed: 2026-09-17',
    '- id: pp3 | configuration: c25-pref-new | value: 43025 | basis: listing | sample_size: 1 | source: KBB | confirmed: yes | observed: 2026-09-18',
    '- id: pp4 | configuration: c25-pref-used | value: 34068 | basis: listing_average | sample_size: 219 | range_low: 24750 | range_high: 43181 | source: CarGurus | confirmed: yes | observed: 2026-09-18',
    '- id: pp5 | configuration: c25-pref-cpo | value: 30694 | basis: listing | sample_size: 1 | source: CarGurus | confirmed: yes | observed: 2026-09-18 | note: Lakeland, FL',
    '## Incentives',
    '- id: inc1 | car: cx90 | kind: apr | headline: 0% APR for 36 months | apr_terms: 0% APR for 36 months | provider: Mazda Financial Services | confirmed: yes | expires: 2026-09-30 | applies_to: c26-pref, c26-prem',
    '- id: inc2 | car: cx90 | kind: customer_cash | headline: $4,500 customer cash | amount: $4,500 | source: KBB | confirmed: no | expires: 2026-09-30 | applies_to: c26-pref',
    '- id: inc3 | car: cx90 | kind: customer_cash | headline: $3,500 customer cash | amount: $3,500 | source: RealCarTips | confirmed: no | expires: 2026-09-30 | applies_to: c26-pref, c26-prem',
  ].join('\n');
}

test('returns a placeholder-friendly error when tracker.md is missing', async () => {
  const result = await buildCarDetail(emptyDataRoot(), NOW);
  assert.equal(result.error, 'missing');
  assert.equal(result.car, null);
});

test('degrades to a null car instead of crashing on a malformed file', async () => {
  const root = emptyDataRoot();
  writeTracker(root, 'not the expected format at all, just prose');
  const result = await buildCarDetail(root, NOW);
  assert.equal(result.error, null);
  assert.equal(result.car, null);
});

test('buildCarDetail returns the car, groups, summary and incentives rail for a populated file', async () => {
  const root = emptyDataRoot();
  writeTracker(root, fixture());
  const result = await buildCarDetail(root, NOW);
  assert.equal(result.error, null);
  assert.deepEqual(result.car, { id: 'cx90', make: 'Mazda', model: 'CX-90 Turbo', yearsLabel: '2025–2026' });
  assert.equal(result.groups.length, 3);
  assert.deepEqual(result.tabCounts, { all: 5, new: 3, preowned: 2 });
});

// Requirement 004, stage 4a: buildCarDetail's carId param is additive —
// routing to a specific car falls back to the first car in the file when
// omitted or unknown, so every pre-existing call site (and test) above
// keeps working unchanged.
test('buildCarDetail selects the requested car by id, and falls back to the first car otherwise', async () => {
  const root = emptyDataRoot();
  writeTracker(
    root,
    [
      '## Cars',
      '- id: cx90 | make: Mazda | model: CX-90 Turbo',
      '- id: telluride | make: Kia | model: Telluride',
      '## Configurations',
      '- id: c1 | car: cx90 | year: 2026 | trim: Preferred | condition: new',
      '- id: c2 | car: telluride | year: 2026 | trim: SX | condition: new',
    ].join('\n')
  );
  const forTelluride = await buildCarDetail(root, NOW, 'telluride');
  assert.equal(forTelluride.car.id, 'telluride');

  const unknownId = await buildCarDetail(root, NOW, 'nonexistent');
  assert.equal(unknownId.car.id, 'cx90');

  const omitted = await buildCarDetail(root, NOW);
  assert.equal(omitted.car.id, 'cx90');
});

// Requirement 004 (Car Watch V2), stage 1: archived records are excluded
// from every view but stay in the file. This exercises the join at
// buildCarDetail's boundary (lib/model.js#visibleConfigurations etc.),
// not lib/archive.js's transition functions directly — see
// test/archive.test.js for those and the full archive/restore round trip.
test('buildCarDetail excludes an archived configuration, its price point, and its quote from every view', async () => {
  const root = emptyDataRoot();
  writeTracker(
    root,
    [
      '## Cars',
      '- id: cx90 | make: Mazda | model: CX-90 Turbo',
      '## Configurations',
      '- id: c26-pref | car: cx90 | year: 2026 | trim: Preferred | condition: new',
      '- id: c26-plus | car: cx90 | year: 2026 | trim: Premium Plus | condition: new | archived: yes',
      '## Price points',
      '- id: pp1 | configuration: c26-pref | value: 43450 | basis: msrp | observed: 2026-09-17',
      '- id: pp2 | configuration: c26-plus | value: 50270 | basis: msrp | observed: 2026-09-17',
      '## Quotes',
      '- id: q1 | configuration: c26-plus | value: 49000 | dealer: Archived Motors | quoted: 2026-09-20',
    ].join('\n')
  );
  const result = await buildCarDetail(root, NOW);

  // Only the non-archived configuration shows up anywhere.
  assert.equal(result.tabCounts.all, 1);
  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.groups[0].rows.map((r) => r.configurationId), ['c26-pref']);

  // Only the visible $43,450 price is ever considered for the summary
  // tile — the archived configuration's $50,270 price never leaks in.
  assert.equal(result.summary.lowestPrice.value, 43450);

  // The archived configuration's quote is not counted anywhere.
  assert.equal(result.summary.quotesLogged.count, 0);

  // buildTrimSummaries: only the visible trim is represented at all, and
  // the archived trim's variant, price point and quote never appear —
  // this is exactly what the remove-trim dialog reads its real counts
  // from.
  assert.deepEqual(Object.keys(result.trimSummaries), ['Preferred']);
  assert.deepEqual(result.trimSummaries.Preferred, { variantCount: 1, historyMonths: 1, quoteCount: 0 });
});

test('buildTrimSummaries counts variants, distinct months and quotes per trim, across model years and conditions', async () => {
  const root = emptyDataRoot();
  writeTracker(root, fixture());
  const result = await buildCarDetail(root, NOW);

  // "Preferred" spans three model years and three conditions (2026 new,
  // 2025 new, 2025 used, 2025 cpo) — the dialog's "variant" count is
  // Configurations, not price points or years, so this must be 4.
  assert.equal(result.trimSummaries.Preferred.variantCount, 4);
  // Every Preferred price point in the fixture falls in September 2026 —
  // one distinct calendar month, even though there are four readings.
  assert.equal(result.trimSummaries.Preferred.historyMonths, 1);
  assert.equal(result.trimSummaries.Preferred.quoteCount, 0);

  // "Premium Sport" has a single variant and no quotes.
  assert.deepEqual(result.trimSummaries['Premium Sport'], { variantCount: 1, historyMonths: 1, quoteCount: 0 });
});

test('buildTrimSummaries counts a quote against its own trim only, and distinct months across different calendar months', async () => {
  const root = emptyDataRoot();
  writeTracker(
    root,
    [
      '## Cars',
      '- id: cx90 | make: Mazda | model: CX-90 Turbo',
      '## Configurations',
      '- id: c25-pref-used | car: cx90 | year: 2025 | trim: Preferred | condition: used',
      '- id: c26-plus | car: cx90 | year: 2026 | trim: Premium Plus | condition: new',
      '## Price points',
      '- id: pp1 | configuration: c25-pref-used | value: 34068 | basis: listing | observed: 2026-08-18',
      '- id: pp2 | configuration: c25-pref-used | value: 33500 | basis: listing | observed: 2026-09-18',
      '- id: pp3 | configuration: c26-plus | value: 50270 | basis: msrp | observed: 2026-09-17',
      '## Quotes',
      '- id: q1 | configuration: c25-pref-used | value: 33900 | dealer: A | quoted: 2026-09-20',
      '- id: q2 | configuration: c25-pref-used | value: 33200 | dealer: B | quoted: 2026-09-21',
    ].join('\n')
  );
  const result = await buildCarDetail(root, NOW);

  assert.deepEqual(result.trimSummaries.Preferred, { variantCount: 1, historyMonths: 2, quoteCount: 2 });
  assert.deepEqual(result.trimSummaries['Premium Plus'], { variantCount: 1, historyMonths: 1, quoteCount: 0 });
});

test('groups order as current-year new, prior-year new, then combined pre-owned', async () => {
  const root = emptyDataRoot();
  writeTracker(root, fixture());
  const { groups: g } = await buildCarDetail(root, NOW);
  assert.deepEqual(
    g.map((group) => group.heading),
    ['2026 · New', '2025 · New leftover', '2025 · Pre-owned']
  );
  assert.equal(g[0].rows.length, 2);
  assert.equal(g[1].rows.length, 1);
  assert.equal(g[2].rows.length, 2);
});

test('pre-owned group sorts by trim then CPO before USED', async () => {
  const root = emptyDataRoot();
  writeTracker(root, fixture());
  const { groups } = await buildCarDetail(root, NOW);
  const preowned = groups.find((g) => g.heading.includes('Pre-owned'));
  assert.deepEqual(
    preowned.rows.map((r) => r.condition),
    ['cpo', 'used']
  );
});

test('a configuration with no price point reports "No prices yet", never zero or blank', async () => {
  const root = emptyDataRoot();
  writeTracker(
    root,
    [
      '## Cars',
      '- id: cx90 | make: Mazda | model: CX-90 Turbo',
      '## Configurations',
      '- id: c26-pref | car: cx90 | year: 2026 | trim: Preferred | condition: new',
    ].join('\n')
  );
  const { groups } = await buildCarDetail(root, NOW);
  const row = groups[0].rows[0];
  assert.equal(row.price, null);
  assert.equal(row.noPriceReason, 'No prices yet');
});

test('group subtitle names the shared basis when every price point agrees', async () => {
  const root = emptyDataRoot();
  writeTracker(root, fixture());
  const { groups } = await buildCarDetail(root, NOW);
  assert.equal(groups[0].subtitle, 'MSRP, excludes destination');
  assert.equal(groups[1].subtitle, 'Dealer listing prices · no incentives on file');
});

test('a condition category with mixed bases falls back to a condition-based subtitle', async () => {
  const root = emptyDataRoot();
  writeTracker(root, fixture());
  const { groups } = await buildCarDetail(root, NOW);
  const preowned = groups.find((g) => g.heading.includes('Pre-owned'));
  // c25-pref-used is listing_average, c25-pref-cpo is listing — mixed, so
  // the subtitle falls back to naming the conditions present instead of
  // guessing at one basis.
  assert.equal(preowned.subtitle, 'Certified and used · no incentives on file');
});

test('a group covered by unexpired incentives gets a chip instead of a "no incentives" subtitle', async () => {
  const root = emptyDataRoot();
  writeTracker(root, fixture());
  const { groups } = await buildCarDetail(root, NOW);
  assert.deepEqual(groups[0].chip, { text: 'Incentives apply · 8 days left' });
  assert.equal(groups[1].chip, null);
});

test('daysRemaining computes signed day counts across a UTC date boundary', () => {
  assert.equal(daysRemaining('2026-09-30', NOW), 8);
  assert.equal(daysRemaining('2026-09-22', NOW), 0);
  assert.equal(daysRemaining('2026-09-01', NOW), -21);
});

test('formatShortDate renders month + day with no year, no leading zero', () => {
  assert.equal(formatShortDate('2026-09-30'), 'Sep 30');
  assert.equal(formatShortDate('2026-01-05'), 'Jan 5');
});

test('formatYearsLabel turns a hyphenated range into an en dash, passes through anything else', () => {
  assert.equal(formatYearsLabel('2025-2026'), '2025–2026');
  assert.equal(formatYearsLabel('2026'), '2026');
  assert.equal(formatYearsLabel(''), '');
});

test('computeSummary: lowest price tracked is the cheapest price point on file, any condition', async () => {
  const { parseTracker } = await import('../lib/parse-tracker.js');
  const parsed = parseTracker(fixture());
  const summary = computeSummary(parsed.cars[0], parsed.configurations, parsed.pricePoints, parsed.quotes, parsed.incentives, NOW);
  assert.equal(summary.lowestPrice.value, 30694);
  assert.equal(summary.lowestPrice.label, '2025 Preferred · Certified pre-owned · Lakeland, FL');
});

test('computeSummary: new-year-start tile picks the cheapest new configuration of the newest year', async () => {
  const { parseTracker } = await import('../lib/parse-tracker.js');
  const parsed = parseTracker(fixture());
  const summary = computeSummary(parsed.cars[0], parsed.configurations, parsed.pricePoints, parsed.quotes, parsed.incentives, NOW);
  assert.equal(summary.newYearStart.value, 43450);
  assert.equal(summary.newYearStart.year, '2026');
  assert.equal(summary.newYearStart.label, 'Preferred MSRP · before destination');
});

test('computeSummary: countdown tile is urgent within 14 days, normal beyond it', async () => {
  const { parseTracker } = await import('../lib/parse-tracker.js');
  const parsed = parseTracker(fixture());
  const summary = computeSummary(parsed.cars[0], parsed.configurations, parsed.pricePoints, parsed.quotes, parsed.incentives, NOW);
  assert.equal(summary.countdown.days, 8);
  assert.equal(summary.countdown.urgent, true);
  assert.equal(summary.countdown.subtitle, 'Sep 30 · 3 offers on 2026 trims');

  const far = new Date('2026-08-01T12:00:00Z');
  const summaryFar = computeSummary(parsed.cars[0], parsed.configurations, parsed.pricePoints, parsed.quotes, parsed.incentives, far);
  assert.equal(summaryFar.countdown.urgent, false);
});

test('computeSummary: with no incentives on file, countdown reports a reason, not zero', () => {
  const car = { id: 'cx90' };
  const summary = computeSummary(car, [], [], [], [], NOW);
  assert.equal(summary.countdown.days, null);
  assert.equal(summary.countdown.reason, 'No incentives on file');
});

test('computeSummary: quotes tile counts real quotes and reports the trend-start hint at zero', () => {
  const car = { id: 'cx90' };
  const configs = [{ id: 'c1', car: 'cx90', year: '2026', trim: 'Preferred', condition: 'new' }];
  const zero = computeSummary(car, configs, [], [], [], NOW);
  assert.equal(zero.quotesLogged.count, 0);
  assert.equal(zero.quotesLogged.subtitle, 'Log 2 on a trim to start its trend');

  const quotes = [
    { id: 'q1', configuration: 'c1', value: 42000, dealer: 'A', quoted: '2026-09-01' },
    { id: 'q2', configuration: 'c1', value: 41500, dealer: 'B', quoted: '2026-09-10' },
  ];
  const withQuotes = computeSummary(car, configs, [], quotes, [], NOW);
  assert.equal(withQuotes.quotesLogged.count, 2);
  assert.equal(withQuotes.quotesLogged.subtitle, '2 quotes across 1 trim');
});

test('trend threshold: fewer than two quotes reports the count with no sparkline data, two or more sorts ascending', async () => {
  const root = emptyDataRoot();
  writeTracker(
    root,
    [
      '## Cars',
      '- id: cx90 | make: Mazda | model: CX-90 Turbo',
      '## Configurations',
      '- id: c1 | car: cx90 | year: 2026 | trim: Preferred | condition: new',
      '## Quotes',
      '- id: q1 | configuration: c1 | value: 43000 | dealer: A | quoted: 2026-09-10',
    ].join('\n')
  );
  const oneQuote = await buildCarDetail(root, NOW);
  assert.equal(oneQuote.groups[0].rows[0].trend.quoteCount, 1);
  assert.equal(oneQuote.groups[0].rows[0].trend.quotes.length, 1);

  writeTracker(
    root,
    [
      '## Cars',
      '- id: cx90 | make: Mazda | model: CX-90 Turbo',
      '## Configurations',
      '- id: c1 | car: cx90 | year: 2026 | trim: Preferred | condition: new',
      '## Quotes',
      '- id: q1 | configuration: c1 | value: 43000 | dealer: A | quoted: 2026-09-10',
      '- id: q2 | configuration: c1 | value: 41500 | dealer: B | quoted: 2026-09-01',
    ].join('\n')
  );
  const twoQuotes = await buildCarDetail(root, NOW);
  const trend = twoQuotes.groups[0].rows[0].trend;
  assert.equal(trend.quoteCount, 2);
  assert.deepEqual(trend.quotes.map((q) => q.value), [41500, 43000]); // ascending by date
});

test('findIncentiveConflicts flags same kind + expiry + overlapping configuration with different amounts', async () => {
  const { parseTracker } = await import('../lib/parse-tracker.js');
  const parsed = parseTracker(fixture());
  const conflicts = findIncentiveConflicts(parsed.incentives);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].configIds, ['c26-pref']);
  assert.deepEqual([conflicts[0].amountA, conflicts[0].amountB].sort(), ['$3,500', '$4,500']);
});

test('findIncentiveConflicts does not flag incentives with no overlapping configuration or matching amounts', () => {
  const incentives = [
    { id: 'a', kind: 'customer_cash', expires: '2026-09-30', amount: '$1,000', appliesTo: ['x'] },
    { id: 'b', kind: 'customer_cash', expires: '2026-09-30', amount: '$2,000', appliesTo: ['y'] }, // no overlap
    { id: 'c', kind: 'apr', expires: '2026-09-30', aprTerms: '0% APR', appliesTo: ['x'] }, // different kind
    { id: 'd', kind: 'customer_cash', expires: '2026-09-30', amount: '$1,000', appliesTo: ['x'] }, // same amount as a
  ];
  assert.deepEqual(findIncentiveConflicts(incentives), []);
});

test('buildIncentivesRail countdown subtitle says "All N" when every unexpired offer shares the soonest expiry', async () => {
  const { parseTracker } = await import('../lib/parse-tracker.js');
  const parsed = parseTracker(fixture());
  const rail = buildIncentivesRail(parsed.cars[0], parsed.configurations, parsed.incentives, NOW);
  assert.equal(rail.countdown.days, 8);
  assert.equal(rail.countdown.subtitle, 'All 3 offers expire Sep 30');
  assert.equal(rail.blocks.length, 3);
  assert.equal(rail.conflicts.length, 1);
});

test('buildIncentivesRail resolves appliesTo configuration ids into year + trim, dropping unknown ids', async () => {
  const { parseTracker } = await import('../lib/parse-tracker.js');
  const parsed = parseTracker(fixture());
  const rail = buildIncentivesRail(parsed.cars[0], parsed.configurations, parsed.incentives, NOW);
  const apr = rail.blocks.find((b) => b.id === 'inc1');
  assert.deepEqual(apr.appliesTo, [
    { id: 'c26-pref', year: '2026', trim: 'Preferred' },
    { id: 'c26-prem', year: '2026', trim: 'Premium Sport' },
  ]);
});

// --- buildAppData (requirement 004, stage 4a) --------------------------------

function twoCarsFixture() {
  return [
    '## Cars',
    '- id: cx90 | make: Mazda | model: CX-90 Turbo',
    '- id: telluride | make: Kia | model: Telluride',
    '## Configurations',
    '- id: c1 | car: cx90 | year: 2026 | trim: Preferred | condition: new',
    '- id: c2 | car: cx90 | year: 2025 | trim: Preferred | condition: used',
    '- id: c3 | car: telluride | year: 2026 | trim: SX | condition: new',
    '## Price points',
    '- id: pp1 | configuration: c1 | value: 43450 | basis: msrp | observed: 2026-09-17',
    '- id: pp2 | configuration: c2 | value: 34068 | basis: listing | observed: 2026-09-18',
    '## Quotes',
    '## Incentives',
    '- id: inc1 | car: cx90 | kind: apr | headline: 0% APR | apr_terms: 0% APR | confirmed: yes | expires: 2026-09-30 | applies_to: c1',
  ].join('\n');
}

test('buildAppData returns the nav car list, a watchlist, and a detail view-model per car', async () => {
  const root = emptyDataRoot();
  writeTracker(root, twoCarsFixture());
  const result = await buildAppData(root, NOW);

  assert.equal(result.error, null);
  assert.deepEqual(result.cars, [
    { id: 'cx90', make: 'Mazda', model: 'CX-90 Turbo' },
    { id: 'telluride', make: 'Kia', model: 'Telluride' },
  ]);
  assert.equal(result.watchlist.carCount, 2);
  assert.ok(result.details.cx90);
  assert.ok(result.details.telluride);
  assert.equal(result.details.cx90.car.model, 'CX-90 Turbo');
  assert.equal(result.details.telluride.car.model, 'Telluride');

  // Telluride has one priced new configuration and no incentives — its
  // own detail view-model reflects that, unaffected by cx90's data.
  assert.equal(result.details.telluride.summary.lowestPrice.value, null);
  assert.equal(result.details.cx90.summary.lowestPrice.value, 34068);
});

test('buildAppData returns the same missing/malformed error shapes as buildCarDetail', async () => {
  const missing = await buildAppData(emptyDataRoot(), NOW);
  assert.equal(missing.error, 'missing');
  assert.deepEqual(missing.cars, []);
  assert.equal(missing.watchlist, null);

  const root = emptyDataRoot();
  writeTracker(root, 'not the expected format at all');
  const malformed = await buildAppData(root, NOW);
  assert.equal(malformed.error, null);
  assert.deepEqual(malformed.cars, []);
});

// --- buildReadingsForm (requirement 004, stage 4c) --------------------------

test('buildReadingsForm derives the due date and checkDue from lastCheckedAt + checkIntervalDays', () => {
  const car = { id: 'cx90', checkIntervalDays: 14, lastCheckedAt: '2026-09-08' };
  const dueSoon = buildReadingsForm(car, [], [], new Date('2026-09-21T00:00:00Z'));
  assert.equal(dueSoon.dueDate, '2026-09-22');
  assert.equal(dueSoon.checkDue, false);

  const due = buildReadingsForm(car, [], [], new Date('2026-09-22T00:00:00Z'));
  assert.equal(due.checkDue, true);

  const overdue = buildReadingsForm(car, [], [], new Date('2026-09-30T00:00:00Z'));
  assert.equal(overdue.checkDue, true);
});

test('buildReadingsForm reports checkDue for a car that has never been checked', () => {
  const car = { id: 'cx90', checkIntervalDays: 14, lastCheckedAt: null };
  const form = buildReadingsForm(car, [], [], NOW);
  assert.equal(form.dueDate, null);
  assert.equal(form.checkDue, true);
});

// fix/002: "if there is a check date, it should also list the next date
// that can be checked" — lastCheckedLabel and dueDateLabel must both be set
// together whenever a date exists at all, whether it came straight off the
// car (explicit) or was derived from the most recent reading (blank
// last_checked, real price history).
test('buildReadingsForm sets both lastCheckedLabel and dueDateLabel together when last_checked is explicit', () => {
  const car = { id: 'cx90', checkIntervalDays: 14, lastCheckedAt: '2026-09-08' };
  const form = buildReadingsForm(car, [], [], NOW);
  assert.equal(form.lastCheckedLabel, 'Sep 8');
  assert.equal(form.dueDateLabel, 'Sep 22');
});

test('buildReadingsForm derives last-checked from the most recent reading when last_checked is blank, and still sets both labels', () => {
  const car = { id: 'cx90', checkIntervalDays: 14, lastCheckedAt: null };
  const configurations = [{ id: 'c1', car: 'cx90', year: '2026', trim: 'Preferred', condition: 'new' }];
  const pricePoints = [
    { id: 'pp1', configuration: 'c1', value: 40000, basis: 'msrp', observed: '2026-09-01' },
    { id: 'pp2', configuration: 'c1', value: 41000, basis: 'msrp', observed: '2026-09-18' },
  ];
  const form = buildReadingsForm(car, configurations, pricePoints, NOW);
  assert.equal(form.effectiveLastCheckedAt, '2026-09-18', 'should pick the latest observed date, not the first');
  assert.equal(form.lastCheckedLabel, 'Sep 18');
  assert.equal(form.dueDateLabel, 'Oct 2');
});

test('buildReadingsForm reports "no check on file" (both labels null) for a car with no readings and no last_checked at all', () => {
  const car = { id: 'cx90', checkIntervalDays: 14, lastCheckedAt: null };
  const form = buildReadingsForm(car, [], [], NOW);
  assert.equal(form.effectiveLastCheckedAt, null);
  assert.equal(form.lastCheckedLabel, null);
  assert.equal(form.dueDateLabel, null);
});

test('buildReadingsForm ignores an unrelated car\'s readings when deriving last-checked (does not leak dates across cars)', () => {
  const car = { id: 'cx90', checkIntervalDays: 14, lastCheckedAt: null };
  const configurations = [{ id: 'other-c1', car: 'other-car', year: '2026', trim: 'Base', condition: 'new' }];
  const pricePoints = [{ id: 'pp1', configuration: 'other-c1', value: 30000, basis: 'msrp', observed: '2026-09-20' }];
  const form = buildReadingsForm(car, configurations, pricePoints, NOW);
  assert.equal(form.effectiveLastCheckedAt, null);
  assert.equal(form.lastCheckedLabel, null);
});

test('buildReadingsForm lists visible configurations in year -> trim -> condition order, each with its previous reading or null', () => {
  const car = { id: 'cx90', checkIntervalDays: 14, lastCheckedAt: '2026-09-08', trimsTracked: ['Preferred', 'Premium Sport'] };
  const configurations = [
    { id: 'c26-prem', car: 'cx90', year: '2026', trim: 'Premium Sport', condition: 'new' },
    { id: 'c25-pref-used', car: 'cx90', year: '2025', trim: 'Preferred', condition: 'used' },
    { id: 'c26-pref', car: 'cx90', year: '2026', trim: 'Preferred', condition: 'new' },
    { id: 'c25-pref-new', car: 'cx90', year: '2025', trim: 'Preferred', condition: 'new' },
  ];
  const pricePoints = [
    { id: 'pp1', configuration: 'c25-pref-used', value: 34068, basis: 'listing_average', source: 'CarGurus', confirmed: true, sampleSize: 219, rangeLow: 24750, rangeHigh: 43181, note: '', observed: '2026-09-08' },
  ];
  const form = buildReadingsForm(car, configurations, pricePoints, NOW);
  assert.deepEqual(
    form.variants.map((v) => v.configurationId),
    ['c25-pref-new', 'c25-pref-used', 'c26-pref', 'c26-prem']
  );
  assert.equal(form.variants.find((v) => v.configurationId === 'c26-pref').previous, null);
  const used = form.variants.find((v) => v.configurationId === 'c25-pref-used').previous;
  assert.equal(used.value, 34068);
  assert.equal(used.basis, 'listing_average');
  assert.equal(used.sampleSize, 219);
});
