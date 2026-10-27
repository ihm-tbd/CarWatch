// Covers the pure, DOM-free rendering-support functions in public/app.js
// for the car detail screen (requirement 004, stage 2): the price-basis
// text, the (i) popover copy generator, currency/estimate formatting, the
// condition chip label, incentive tag labels, appliesTo formatting, and
// day-count phrasing. public/app.js guards every DOM/EventSource access
// behind `typeof document/window !== 'undefined'` specifically so it can
// be imported here under plain Node — see the same pattern in
// lib/parse-tracker.js's tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatCurrency,
  basisLineText,
  popoverCopy,
  priceDisplayText,
  incentiveTagLabel,
  formatAppliesTo,
  conditionChipLabel,
  daysParts,
  removeTrimCopy,
  removeWatchCopy,
  isSafeHttpUrl,
  sampleListingLine,
  sampleListingLines,
} from '../public/app.js';

test('formatCurrency renders whole dollars with thousands separators, no cents', () => {
  assert.equal(formatCurrency(43450), '$43,450');
  assert.equal(formatCurrency(0), '$0');
});

test('basisLineText: exactly one of the four phrases, nothing more', () => {
  assert.equal(basisLineText({ basis: 'msrp', destination: false }), 'MSRP');
  assert.equal(basisLineText({ basis: 'msrp', destination: true }), 'MSRP');
  assert.equal(basisLineText({ basis: 'listing', sampleSize: 1 }), 'Single listing');
  assert.equal(basisLineText({ basis: 'listing_average', sampleSize: 219 }), 'Average of 219 listings');
  assert.equal(basisLineText({ basis: 'valuation_estimate' }), 'Estimate, not a listing');
});

test('basisLineText: an average is never shown where the sample size is 1', () => {
  assert.equal(basisLineText({ basis: 'listing_average', sampleSize: 1 }), 'Single listing');
  assert.equal(basisLineText({ basis: 'listing_average', sampleSize: null }), 'Single listing');
});

test('basisLineText: an unrecognized basis says so rather than guessing', () => {
  assert.equal(basisLineText({ basis: 'unknown' }), 'Basis not recorded');
  assert.equal(basisLineText(null), '');
});

test('priceDisplayText prefixes ≈ for an estimate and nothing else', () => {
  assert.equal(priceDisplayText({ value: 31110, basis: 'valuation_estimate' }), '≈$31,110');
  assert.equal(priceDisplayText({ value: 43450, basis: 'msrp' }), '$43,450');
});

test('popoverCopy: MSRP explains the acronym and states the destination-charge status', () => {
  assert.deepEqual(popoverCopy({ basis: 'msrp', destination: false, note: '' }), [
    "Manufacturer's suggested price.",
    'Excludes the destination charge, so a dealer invoice will read higher.',
  ]);
  assert.deepEqual(popoverCopy({ basis: 'msrp', destination: true, note: '' }), [
    "Manufacturer's suggested price.",
    'Includes the destination charge.',
  ]);
  assert.deepEqual(popoverCopy({ basis: 'msrp', destination: null, note: '' }), [
    "Manufacturer's suggested price.",
    'Whether this includes the destination charge is not recorded.',
  ]);
});

test('popoverCopy: a listing average states the range, not the sample size line 1 already gave', () => {
  const copy = popoverCopy({ basis: 'listing_average', sampleSize: 219, rangeLow: 24750, rangeHigh: 43181, note: '' });
  assert.deepEqual(copy, ['Asking prices ranged $24,750 to $43,181.']);
});

test('popoverCopy: an estimate gives the range midpoint and says no listing confirms it', () => {
  const copy = popoverCopy({ basis: 'valuation_estimate', rangeLow: 29660, rangeHigh: 32560, note: '' });
  assert.deepEqual(copy, ['Midpoint of a $29,660 to $32,560 valuation.', 'No listing was found to confirm it.']);
});

test('popoverCopy: a single listing with no range falls back to the stored note', () => {
  const copy = popoverCopy({ basis: 'listing', sampleSize: 1, note: 'Lakeland, FL' });
  assert.deepEqual(copy, ['Lakeland, FL']);
});

test('popoverCopy: with nothing on file, says so rather than showing an empty panel', () => {
  const copy = popoverCopy({ basis: 'listing', sampleSize: 1, note: '' });
  assert.deepEqual(copy, ['No further detail on file for this price.']);
});

test('popoverCopy: never repeats the basis phrase (line 1) or a confirmed/source fact (line 2)', () => {
  const copy = popoverCopy({ basis: 'msrp', destination: false, note: '' }).join(' ');
  assert.ok(!copy.includes('MSRP'));
  const avgCopy = popoverCopy({ basis: 'listing_average', sampleSize: 219, rangeLow: 1, rangeHigh: 2, note: '' }).join(' ');
  assert.ok(!avgCopy.includes('219'));
});

test('popoverCopy returns [] for a row with no price at all', () => {
  assert.deepEqual(popoverCopy(null), []);
});

test('isSafeHttpUrl: only http/https URLs are safe to render as a clickable href', () => {
  assert.equal(isSafeHttpUrl('https://www.cargurus.com/Cars/l-Used-2025'), true);
  assert.equal(isSafeHttpUrl('http://example.com'), true);
  assert.equal(isSafeHttpUrl('javascript:alert(1)'), false);
  assert.equal(isSafeHttpUrl('data:text/html,<script>alert(1)</script>'), false);
  assert.equal(isSafeHttpUrl('not a url'), false);
  assert.equal(isSafeHttpUrl(''), false);
  assert.equal(isSafeHttpUrl(null), false);
  assert.equal(isSafeHttpUrl(undefined), false);
});

test('sampleListingLine formats price, mileage, and location, omitting mileage when absent', () => {
  assert.equal(
    sampleListingLine({ price: 30691, mileage: 41972, location: 'Haverhill, MA' }),
    '$30,691 · 41,972 mi · Haverhill, MA'
  );
  assert.equal(sampleListingLine({ price: 30691, mileage: null, location: '' }), '$30,691');
});

test('sampleListingLines is only populated for listing_average, and [] when none on file', () => {
  const withListings = {
    basis: 'listing_average',
    sampleListings: [
      { price: 30691, mileage: 41972, location: 'Haverhill, MA' },
      { price: 32869, mileage: 19815, location: 'Bountiful, UT' },
    ],
  };
  assert.deepEqual(sampleListingLines(withListings), [
    '$30,691 · 41,972 mi · Haverhill, MA',
    '$32,869 · 19,815 mi · Bountiful, UT',
  ]);
  assert.deepEqual(sampleListingLines({ basis: 'listing_average', sampleListings: [] }), []);
  assert.deepEqual(sampleListingLines({ basis: 'listing_average' }), []);
  assert.deepEqual(sampleListingLines({ basis: 'listing', sampleListings: [{ price: 1, mileage: 1, location: 'x' }] }), []);
  assert.deepEqual(sampleListingLines(null), []);
});

test('incentiveTagLabel extracts a leading "N% APR" from the headline, falls back generically', () => {
  assert.equal(incentiveTagLabel({ kind: 'apr', headline: '0% APR for 36 months + 90 days no payment' }), '0% APR');
  assert.equal(incentiveTagLabel({ kind: 'apr', headline: 'Special financing available' }), 'APR offer');
  assert.equal(incentiveTagLabel({ kind: 'customer_cash', headline: 'anything' }), 'Cash offer');
  assert.equal(incentiveTagLabel({ kind: 'lease', headline: 'anything' }), 'Lease offer');
});

test('formatAppliesTo groups trims under a shared year instead of repeating it', () => {
  assert.equal(
    formatAppliesTo([
      { year: '2026', trim: 'Preferred' },
      { year: '2026', trim: 'Premium Sport' },
      { year: '2026', trim: 'Premium Plus' },
    ]),
    '2026 Preferred, Premium Sport, Premium Plus'
  );
});

test('formatAppliesTo separates configurations from different years with a semicolon', () => {
  assert.equal(
    formatAppliesTo([
      { year: '2026', trim: 'Preferred' },
      { year: '2025', trim: 'Preferred' },
    ]),
    '2026 Preferred; 2025 Preferred'
  );
});

test('conditionChipLabel: the single leftmost chip for each of the three conditions, plus a safe fallback', () => {
  assert.equal(conditionChipLabel('new'), 'New');
  assert.equal(conditionChipLabel('cpo'), 'CPO');
  assert.equal(conditionChipLabel('used'), 'Used');
  assert.equal(conditionChipLabel(null), 'Unknown');
});

test('daysParts: singular/plural for upcoming, expired, and today', () => {
  assert.deepEqual(daysParts(8), { number: 8, unit: 'days left' });
  assert.deepEqual(daysParts(1), { number: 1, unit: 'day left' });
  assert.deepEqual(daysParts(0), { number: 0, unit: 'today' });
  assert.deepEqual(daysParts(-1), { number: 1, unit: 'day ago — expired' });
  assert.deepEqual(daysParts(-16), { number: 16, unit: 'days ago — expired' });
});

// Requirement 004: "the mockup's copy is wrong — do not copy it. It says
// history starts over. It doesn't." removeTrimCopy must never claim loss —
// archiving hides, a restore brings everything back intact.
test('removeTrimCopy never claims history is lost or starts over', () => {
  const copy = removeTrimCopy('Premium Plus', { variantCount: 1, historyMonths: 1, quoteCount: 2 });
  const allText = [copy.title, copy.lede, copy.note, ...copy.lines.map((l) => l.label)].join(' ').toLowerCase();
  assert.ok(!allText.includes('starts over'));
  assert.ok(!allText.includes('lost'));
  assert.ok(!allText.includes('deleted') || allText.includes('nothing is deleted'));
});

test('removeTrimCopy states the trim name and that it can be restored intact', () => {
  const copy = removeTrimCopy('Premium Plus', { variantCount: 1, historyMonths: 1, quoteCount: 2 });
  assert.equal(copy.title, 'Remove Premium Plus from this watch?');
  assert.match(copy.note, /back.*any time/i);
  assert.match(copy.note, /exactly as they were/i);
});

test('removeTrimCopy pulls real counts from the record, singular/plural correctly', () => {
  const copy = removeTrimCopy('Preferred', { variantCount: 1, historyMonths: 0, quoteCount: 3 });
  assert.deepEqual(copy.lines, [
    { count: 1, label: '1 variant tracked' },
    { count: 0, label: '0 months of price history' },
    { count: 3, label: '3 quotes logged' },
  ]);
});

test('removeTrimCopy falls back to all-zero counts when no summary is on file', () => {
  const copy = removeTrimCopy('Preferred', undefined);
  assert.deepEqual(copy.lines.map((l) => l.count), [0, 0, 0]);
});

// Requirement 004: "Removing a whole watch follows the same
// archive-and-confirm pattern." Same non-destructive framing as
// removeTrimCopy above — archiving a car only flips a flag
// (lib/archive.js#archiveCar), it never deletes anything underneath it.
test('removeWatchCopy never claims history is lost or starts over', () => {
  const copy = removeWatchCopy(
    { make: 'Mazda', model: 'CX-90' },
    { trimCount: 2, variantCount: 4, historyMonths: 3, quoteCount: 5 }
  );
  const allText = [copy.title, copy.lede, copy.note, ...copy.lines.map((l) => l.label)].join(' ').toLowerCase();
  assert.ok(!allText.includes('starts over'));
  assert.ok(!allText.includes('lost'));
  assert.ok(!allText.includes('deleted') || allText.includes('nothing is deleted'));
});

test('removeWatchCopy states the car name and that the record stays intact', () => {
  const copy = removeWatchCopy(
    { make: 'Mazda', model: 'CX-90' },
    { trimCount: 2, variantCount: 4, historyMonths: 3, quoteCount: 5 }
  );
  assert.equal(copy.title, 'Remove Mazda CX-90 from your watches?');
  assert.match(copy.note, /stays on file/i);
  assert.match(copy.note, /exactly as it was/i);
});

test('removeWatchCopy pulls real counts from the record, singular/plural correctly', () => {
  const copy = removeWatchCopy({ make: 'Kia', model: 'Telluride' }, { trimCount: 1, variantCount: 1, historyMonths: 0, quoteCount: 1 });
  assert.deepEqual(copy.lines, [
    { count: 1, label: '1 trim tracked' },
    { count: 1, label: '1 variant tracked' },
    { count: 0, label: '0 months of price history' },
    { count: 1, label: '1 quote logged' },
  ]);
});

test('removeWatchCopy falls back to all-zero counts and a generic name when nothing is on file', () => {
  const copy = removeWatchCopy(undefined, undefined);
  assert.deepEqual(copy.lines.map((l) => l.count), [0, 0, 0, 0]);
  assert.equal(copy.title, 'Remove this car from your watches?');
});

// The two dialogs describe the same underlying behaviour (archive, not
// delete) and must not contradict each other about it — e.g. one saying
// data is "deleted" while the other says "nothing is deleted" would be a
// real inconsistency, not just a copy nit.
test('removeTrimCopy and removeWatchCopy agree that archiving never deletes anything', () => {
  const trimCopy = removeTrimCopy('Preferred', { variantCount: 1, historyMonths: 1, quoteCount: 1 });
  const watchCopy = removeWatchCopy({ make: 'Mazda', model: 'CX-90' }, { trimCount: 1, variantCount: 1, historyMonths: 1, quoteCount: 1 });
  assert.match(trimCopy.lede, /nothing is deleted/i);
  assert.match(watchCopy.lede, /nothing is deleted/i);
});
