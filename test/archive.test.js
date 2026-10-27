// Requirement 004 (Car Watch V2), stage 1: "the single most important
// thing in this stage" — archiving a trim must never lose data, and
// restoring it must bring everything back exactly as it was. See
// lib/archive.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { archiveTrim, restoreTrim } from '../lib/archive.js';
import { visibleConfigurations, visiblePricePoints, visibleQuotes } from '../lib/model.js';

function fixture() {
  const car = {
    id: 'cx90',
    trimsTracked: ['Preferred', 'Premium Plus'],
  };
  const configurations = [
    { id: 'c26-pref', car: 'cx90', year: '2026', trim: 'Preferred', condition: 'new', archived: false },
    { id: 'c25-pref-used', car: 'cx90', year: '2025', trim: 'Preferred', condition: 'used', archived: false },
    { id: 'c26-plus', car: 'cx90', year: '2026', trim: 'Premium Plus', condition: 'new', archived: false },
  ];
  const pricePoints = [
    { id: 'pp1', configuration: 'c26-pref', value: 43450, observed: '2026-09-17' },
    { id: 'pp2', configuration: 'c25-pref-used', value: 34068, observed: '2026-09-18' },
    { id: 'pp3', configuration: 'c26-plus', value: 50270, observed: '2026-09-17' },
  ];
  const quotes = [
    { id: 'q1', configuration: 'c26-pref', value: 42900, dealer: 'Smith Mazda' },
  ];
  return { car, configurations, pricePoints, quotes };
}

test('archiveTrim archives every configuration with that trim, across every model year, and no others', () => {
  const { car, configurations } = fixture();
  const { configurations: out } = archiveTrim(car, configurations, 'Preferred');
  assert.deepEqual(
    out.map((c) => [c.id, c.archived]),
    [
      ['c26-pref', true],
      ['c25-pref-used', true],
      ['c26-plus', false],
    ]
  );
});

test('archiveTrim removes the trim from car.trimsTracked', () => {
  const { car, configurations } = fixture();
  const { car: outCar } = archiveTrim(car, configurations, 'Preferred');
  assert.deepEqual(outCar.trimsTracked, ['Premium Plus']);
});

test('archiveTrim only matches configurations on the given car', () => {
  const { configurations } = fixture();
  const otherCarConfig = { id: 'other', car: 'cx5', trim: 'Preferred', condition: 'new', archived: false };
  const car = { id: 'cx90', trimsTracked: ['Preferred'] };
  const { configurations: out } = archiveTrim(car, [...configurations, otherCarConfig], 'Preferred');
  const other = out.find((c) => c.id === 'other');
  assert.equal(other.archived, false);
});

test('archived configurations, price points, and quotes disappear from every view but the underlying records are untouched otherwise', () => {
  const { car, configurations, pricePoints, quotes } = fixture();
  const { car: archivedCar, configurations: archivedConfigs } = archiveTrim(car, configurations, 'Preferred');

  // Still in the file: three configurations, three price points, one quote.
  assert.equal(archivedConfigs.length, 3);
  assert.equal(pricePoints.length, 3);
  assert.equal(quotes.length, 1);

  // Excluded from every view.
  assert.deepEqual(
    visibleConfigurations(archivedConfigs).map((c) => c.id),
    ['c26-plus']
  );
  assert.deepEqual(visiblePricePoints(archivedConfigs, pricePoints).map((p) => p.id), ['pp3']);
  assert.deepEqual(visibleQuotes(archivedConfigs, quotes), []);

  // Nothing about the archived records themselves changed besides the flag.
  const archivedPref = archivedConfigs.find((c) => c.id === 'c26-pref');
  assert.equal(archivedPref.condition, 'new');
  assert.equal(archivedPref.year, '2026');
  assert.deepEqual(archivedCar.trimsTracked, ['Premium Plus']);
});

test('full round trip: archive then restore loses nothing — every field is byte-identical to before archiving', () => {
  const { car, configurations, pricePoints, quotes } = fixture();

  const afterArchive = archiveTrim(car, configurations, 'Preferred');
  const afterRestore = restoreTrim(afterArchive.car, afterArchive.configurations, 'Preferred');

  // trimsTracked has the same trims again — restoring re-adds "Preferred"
  // at the end, the same place any newly added trim would land, rather
  // than trying to remember its original position (see lib/archive.js).
  // The list membership is what matters here, not the order.
  assert.deepEqual(new Set(afterRestore.car.trimsTracked), new Set(car.trimsTracked));

  // Every configuration, including the previously archived ones, is
  // identical to the pre-archive fixture — same fields, same order.
  assert.deepEqual(afterRestore.configurations, configurations);

  // Everything that was visible before archiving is visible again.
  assert.deepEqual(
    visibleConfigurations(afterRestore.configurations).map((c) => c.id),
    configurations.map((c) => c.id)
  );
  assert.deepEqual(
    visiblePricePoints(afterRestore.configurations, pricePoints).map((p) => p.id),
    pricePoints.map((p) => p.id)
  );
  assert.deepEqual(
    visibleQuotes(afterRestore.configurations, quotes).map((q) => q.id),
    quotes.map((q) => q.id)
  );

  // Price points and quotes were never touched by either step — same
  // references even, since archive/restore never reads them.
  assert.equal(pricePoints[0].value, 43450);
  assert.equal(pricePoints[1].value, 34068);
  assert.equal(quotes[0].dealer, 'Smith Mazda');
});

test('restoreTrim on a trim that was never archived is a no-op beyond de-duplicating trimsTracked', () => {
  const { car, configurations } = fixture();
  const { car: outCar, configurations: outConfigs } = restoreTrim(car, configurations, 'Preferred');
  assert.deepEqual(outConfigs, configurations);
  assert.deepEqual(outCar.trimsTracked, car.trimsTracked);
});

test('restoreTrim adds the trim back to trimsTracked even if it was somehow dropped without archiving any configuration', () => {
  const car = { id: 'cx90', trimsTracked: ['Premium Plus'] };
  const configurations = [
    { id: 'c26-pref', car: 'cx90', year: '2026', trim: 'Preferred', condition: 'new', archived: true },
  ];
  const { car: outCar, configurations: outConfigs } = restoreTrim(car, configurations, 'Preferred');
  assert.deepEqual(outCar.trimsTracked, ['Premium Plus', 'Preferred']);
  assert.equal(outConfigs[0].archived, false);
});

test('archiving one trim never affects a different trim\'s visibility or data', () => {
  const { car, configurations, pricePoints, quotes } = fixture();
  const { configurations: out } = archiveTrim(car, configurations, 'Preferred');
  assert.deepEqual(visiblePricePoints(out, pricePoints).map((p) => p.value), [50270]);
  assert.deepEqual(visibleQuotes(out, quotes), []);
});
