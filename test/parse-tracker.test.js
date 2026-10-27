import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseTracker } from '../lib/parse-tracker.js';

test('parses all five sections', () => {
  const md = [
    '## Cars',
    '- id: cx90 | make: Mazda | model: CX-90 Turbo | years: 2025-2026 | trims: Preferred, Premium Sport | conditions: new, used | zip: 33801 | created: 2026-09-17',
    '',
    '## Configurations',
    '- id: cfg1 | car: cx90 | year: 2026 | trim: Preferred | condition: new',
    '',
    '## Price points',
    '- id: pp1 | configuration: cfg1 | value: 43450 | basis: msrp | destination: excluded | sample_size: | range_low: | range_high: | source: Dealer A | source_url: https://example.com | confirmed: yes | observed: 2026-09-01 | note: test note',
    '',
    '## Quotes',
    '- id: q1 | configuration: cfg1 | value: 42000 | dealer: Smith Mazda | quoted: 2026-09-05 | note: friendly rep',
    '',
    '## Incentives',
    '- id: inc1 | car: cx90 | kind: apr | headline: 0% APR | terms: 36 months | amount: | apr_terms: 0% for 36mo | provider: Mazda Financial | source: Mazda | confirmed: yes | expires: 2026-09-30 | applies_to: cfg1',
    '',
  ].join('\n');

  const result = parseTracker(md);

  assert.deepEqual(result.cars, [
    {
      id: 'cx90',
      make: 'Mazda',
      model: 'CX-90 Turbo',
      years: '2025-2026',
      trimsTracked: ['Preferred', 'Premium Sport'],
      conditions: ['new', 'used'],
      zip: '33801',
      created: '2026-09-17',
      checkIntervalDays: 14,
      lastCheckedAt: null,
      archived: false,
    },
  ]);

  assert.deepEqual(result.configurations, [
    { id: 'cfg1', car: 'cx90', year: '2026', trim: 'Preferred', condition: 'new', archived: false },
  ]);

  assert.equal(result.pricePoints.length, 1);
  assert.deepEqual(result.pricePoints[0], {
    id: 'pp1',
    configuration: 'cfg1',
    value: 43450,
    basis: 'msrp',
    destination: false,
    sampleSize: null,
    rangeLow: null,
    rangeHigh: null,
    source: 'Dealer A',
    sourceUrl: 'https://example.com',
    confirmed: true,
    observed: '2026-09-01',
    note: 'test note',
    sampleListings: [],
  });

  assert.equal(result.quotes.length, 1);
  assert.deepEqual(result.quotes[0], {
    id: 'q1',
    configuration: 'cfg1',
    value: 42000,
    dealer: 'Smith Mazda',
    quoted: '2026-09-05',
    note: 'friendly rep',
  });

  assert.equal(result.incentives.length, 1);
  assert.deepEqual(result.incentives[0], {
    id: 'inc1',
    car: 'cx90',
    kind: 'apr',
    headline: '0% APR',
    terms: '36 months',
    amount: '',
    aprTerms: '0% for 36mo',
    provider: 'Mazda Financial',
    source: 'Mazda',
    confirmed: true,
    expires: '2026-09-30',
    appliesTo: ['cfg1'],
  });
});

test('price point value accepts $ and , and confirmed defaults to true when omitted', () => {
  const md = [
    '## Price points',
    '- id: pp1 | configuration: cfg1 | value: $43,000',
  ].join('\n');
  const result = parseTracker(md);
  assert.equal(result.pricePoints[0].value, 43000);
  assert.equal(result.pricePoints[0].confirmed, true);
});

test('confirmed: no is respected, case-insensitively, on price points and incentives', () => {
  const md = [
    '## Price points',
    '- id: pp1 | configuration: cfg1 | value: 100 | confirmed: NO',
    '## Incentives',
    '- id: inc1 | car: cx90 | headline: Cash back | expires: 2026-09-30 | confirmed: NO',
  ].join('\n');
  const result = parseTracker(md);
  assert.equal(result.pricePoints[0].confirmed, false);
  assert.equal(result.incentives[0].confirmed, false);
});

test('basis is inferred only from the four known values; anything else or missing comes back "unknown"', () => {
  const md = [
    '## Price points',
    '- id: pp1 | configuration: cfg1 | value: 100 | basis: msrp',
    '- id: pp2 | configuration: cfg1 | value: 100 | basis: listing',
    '- id: pp3 | configuration: cfg1 | value: 100 | basis: listing_average',
    '- id: pp4 | configuration: cfg1 | value: 100 | basis: valuation_estimate',
    '- id: pp5 | configuration: cfg1 | value: 100 | basis: MSRP',
    '- id: pp6 | configuration: cfg1 | value: 100',
    '- id: pp7 | configuration: cfg1 | value: 100 | basis: guess',
    '- id: pp8 | configuration: cfg1 | value: 100 | basis: unknown',
  ].join('\n');
  const result = parseTracker(md);
  assert.deepEqual(
    result.pricePoints.map((p) => p.basis),
    ['msrp', 'listing', 'listing_average', 'valuation_estimate', 'msrp', 'unknown', 'unknown', 'unknown']
  );
});

test('destination is true/false/null for included/excluded/anything else', () => {
  const md = [
    '## Price points',
    '- id: pp1 | configuration: cfg1 | value: 100 | destination: included',
    '- id: pp2 | configuration: cfg1 | value: 100 | destination: excluded',
    '- id: pp3 | configuration: cfg1 | value: 100 | destination: unknown',
    '- id: pp4 | configuration: cfg1 | value: 100',
  ].join('\n');
  const result = parseTracker(md);
  assert.deepEqual(
    result.pricePoints.map((p) => p.destination),
    [true, false, null, null]
  );
});

test('sample size and range parse as numbers, or null when blank or invalid', () => {
  const md = [
    '## Price points',
    '- id: pp1 | configuration: cfg1 | value: 100 | sample_size: 219 | range_low: 24750 | range_high: 43181',
    '- id: pp2 | configuration: cfg1 | value: 100 | sample_size: | range_low: | range_high:',
    '- id: pp3 | configuration: cfg1 | value: 100 | sample_size: not-a-number',
  ].join('\n');
  const result = parseTracker(md);
  assert.deepEqual(result.pricePoints[0], {
    id: 'pp1',
    configuration: 'cfg1',
    value: 100,
    basis: 'unknown',
    destination: null,
    sampleSize: 219,
    rangeLow: 24750,
    rangeHigh: 43181,
    source: '',
    sourceUrl: '',
    confirmed: true,
    observed: null,
    note: '',
    sampleListings: [],
  });
  assert.equal(result.pricePoints[1].sampleSize, null);
  assert.equal(result.pricePoints[1].rangeLow, null);
  assert.equal(result.pricePoints[2].sampleSize, null);
});

test('sample_listings parses price/mileage/location triples, drops ones with no price, and is [] when blank or missing', () => {
  const md = [
    '## Price points',
    '- id: pp1 | configuration: cfg1 | value: 100 | sample_listings: 30691/41972/Haverhill, MA; 32869/19815mi/Bountiful, UT',
    '- id: pp2 | configuration: cfg1 | value: 100 | sample_listings:',
    '- id: pp3 | configuration: cfg1 | value: 100',
    '- id: pp4 | configuration: cfg1 | value: 100 | sample_listings: not-a-price/41972/Nowhere, NA; 30691/41972/Somewhere, SW',
  ].join('\n');
  const result = parseTracker(md);
  assert.deepEqual(result.pricePoints[0].sampleListings, [
    { price: 30691, mileage: 41972, location: 'Haverhill, MA' },
    { price: 32869, mileage: 19815, location: 'Bountiful, UT' },
  ]);
  assert.deepEqual(result.pricePoints[1].sampleListings, []);
  assert.deepEqual(result.pricePoints[2].sampleListings, []);
  assert.deepEqual(result.pricePoints[3].sampleListings, [{ price: 30691, mileage: 41972, location: 'Somewhere, SW' }]);
});

test('skips price point lines missing id, configuration, or a valid value', () => {
  const md = [
    '## Price points',
    '- configuration: cfg1 | value: 100',
    '- id: pp1 | value: 100',
    '- id: pp1 | configuration: cfg1',
    '- id: pp1 | configuration: cfg1 | value: not-a-number',
    '- id: pp1 | configuration: cfg1 | value: 100',
  ].join('\n');
  const result = parseTracker(md);
  assert.equal(result.pricePoints.length, 1);
});

test('skips quote lines missing id, configuration, dealer, or a valid value', () => {
  const md = [
    '## Quotes',
    '- configuration: cfg1 | value: 100 | dealer: Smith Mazda',
    '- id: q1 | value: 100 | dealer: Smith Mazda',
    '- id: q1 | configuration: cfg1 | dealer: Smith Mazda',
    '- id: q1 | configuration: cfg1 | value: 100',
    '- id: q1 | configuration: cfg1 | value: not-a-number | dealer: Smith Mazda',
    '- id: q1 | configuration: cfg1 | value: 100 | dealer: Smith Mazda',
  ].join('\n');
  const result = parseTracker(md);
  assert.equal(result.quotes.length, 1);
});

test('skips incentive lines missing id, car, headline, or a valid expiry', () => {
  const md = [
    '## Incentives',
    '- car: cx90 | headline: Cash back | expires: 2026-09-30',
    '- id: inc1 | headline: Cash back | expires: 2026-09-30',
    '- id: inc1 | car: cx90 | expires: 2026-09-30',
    '- id: inc1 | car: cx90 | headline: Cash back',
    '- id: inc1 | car: cx90 | headline: Cash back | expires: not-a-date',
  ].join('\n');
  const result = parseTracker(md);
  assert.equal(result.incentives.length, 0);
});

test('incentive kind is normalized to the three known values, or null', () => {
  const md = [
    '## Incentives',
    '- id: i1 | car: cx90 | headline: A | expires: 2026-09-30 | kind: apr',
    '- id: i2 | car: cx90 | headline: B | expires: 2026-09-30 | kind: CUSTOMER_CASH',
    '- id: i3 | car: cx90 | headline: C | expires: 2026-09-30 | kind: lease',
    '- id: i4 | car: cx90 | headline: D | expires: 2026-09-30 | kind: rebate',
    '- id: i5 | car: cx90 | headline: E | expires: 2026-09-30',
  ].join('\n');
  const result = parseTracker(md);
  assert.deepEqual(
    result.incentives.map((i) => i.kind),
    ['apr', 'customer_cash', 'lease', null, null]
  );
});

test('applies_to splits on comma and trims whitespace; blank or missing gives an empty list', () => {
  const md = [
    '## Incentives',
    '- id: i1 | car: cx90 | headline: A | expires: 2026-09-30 | applies_to: cfg1, cfg2 ,cfg3',
    '- id: i2 | car: cx90 | headline: B | expires: 2026-09-30 | applies_to:',
    '- id: i3 | car: cx90 | headline: C | expires: 2026-09-30',
  ].join('\n');
  const result = parseTracker(md);
  assert.deepEqual(result.incentives[0].appliesTo, ['cfg1', 'cfg2', 'cfg3']);
  assert.deepEqual(result.incentives[1].appliesTo, []);
  assert.deepEqual(result.incentives[2].appliesTo, []);
});

test('configuration condition is normalized case-insensitively, and a missing/unrecognized one is null but the row still parses', () => {
  const md = [
    '## Configurations',
    '- id: cfg1 | car: cx90 | year: 2026 | trim: Preferred | condition: USED',
    '- id: cfg2 | car: cx90 | year: 2026 | trim: Premium Sport | condition: gently-loved',
    '- id: cfg3 | car: cx90 | year: 2026 | trim: Premium Plus',
  ].join('\n');
  const result = parseTracker(md);
  assert.deepEqual(
    result.configurations.map((c) => c.condition),
    ['used', null, null]
  );
});

test('configuration archived flag defaults to false, and only the literal "yes" (case-insensitive) sets it true', () => {
  const md = [
    '## Configurations',
    '- id: cfg1 | car: cx90 | year: 2026 | trim: Preferred | archived: yes',
    '- id: cfg2 | car: cx90 | year: 2026 | trim: Premium Sport | archived: YES',
    '- id: cfg3 | car: cx90 | year: 2026 | trim: Premium Plus | archived: no',
    '- id: cfg4 | car: cx90 | year: 2026 | trim: Base',
    '- id: cfg5 | car: cx90 | year: 2026 | trim: Touring | archived: nonsense',
  ].join('\n');
  const result = parseTracker(md);
  assert.deepEqual(
    result.configurations.map((c) => c.archived),
    [true, true, false, false, false]
  );
});

test('car checkIntervalDays defaults to 14 when missing, blank, zero, negative, or non-numeric; a valid positive integer is respected', () => {
  const md = [
    '## Cars',
    '- id: c1 | make: A | model: A',
    '- id: c2 | make: A | model: A | check_interval_days:',
    '- id: c3 | make: A | model: A | check_interval_days: 0',
    '- id: c4 | make: A | model: A | check_interval_days: -5',
    '- id: c5 | make: A | model: A | check_interval_days: not-a-number',
    '- id: c6 | make: A | model: A | check_interval_days: 30',
  ].join('\n');
  const result = parseTracker(md);
  assert.deepEqual(
    result.cars.map((c) => c.checkIntervalDays),
    [14, 14, 14, 14, 14, 30]
  );
});

test('car lastCheckedAt parses a valid date and is null when missing, blank, or malformed', () => {
  const md = [
    '## Cars',
    '- id: c1 | make: A | model: A | last_checked: 2026-09-18',
    '- id: c2 | make: A | model: A',
    '- id: c3 | make: A | model: A | last_checked:',
    '- id: c4 | make: A | model: A | last_checked: not-a-date',
  ].join('\n');
  const result = parseTracker(md);
  assert.deepEqual(
    result.cars.map((c) => c.lastCheckedAt),
    ['2026-09-18', null, null, null]
  );
});

test('skips configuration lines missing id, car, a valid 4-digit year, or trim', () => {
  const md = [
    '## Configurations',
    '- car: cx90 | year: 2026 | trim: Preferred',
    '- id: cfg1 | year: 2026 | trim: Preferred',
    '- id: cfg1 | car: cx90 | trim: Preferred',
    '- id: cfg1 | car: cx90 | year: 26 | trim: Preferred',
    '- id: cfg1 | car: cx90 | year: 2026',
    '- id: cfg1 | car: cx90 | year: 2026 | trim: Preferred',
  ].join('\n');
  const result = parseTracker(md);
  assert.equal(result.configurations.length, 1);
});

test('skips car lines missing id, make, or model', () => {
  const md = [
    '## Cars',
    '- make: Mazda | model: CX-90 Turbo',
    '- id: cx90 | model: CX-90 Turbo',
    '- id: cx90 | make: Mazda',
    '- id: cx90 | make: Mazda | model: CX-90 Turbo',
  ].join('\n');
  const result = parseTracker(md);
  assert.equal(result.cars.length, 1);
});

test('ignores bullet lines outside of any recognized section', () => {
  const md = ['# Car Tracker data', '- some prose bullet before any heading', '## Unknown section', '- ignored too'].join('\n');
  const result = parseTracker(md);
  assert.deepEqual(result, { cars: [], configurations: [], pricePoints: [], quotes: [], incentives: [] });
});

test('returns empty arrays for empty, garbage, or missing content instead of throwing', () => {
  const empty = { cars: [], configurations: [], pricePoints: [], quotes: [], incentives: [] };
  assert.deepEqual(parseTracker(''), empty);
  assert.deepEqual(parseTracker('just some unstructured text\nwith no headings'), empty);
  assert.deepEqual(parseTracker(undefined), empty);
  assert.deepEqual(parseTracker(null), empty);
});
