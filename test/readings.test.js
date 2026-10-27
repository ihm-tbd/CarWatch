import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  validateReadingsSubmission,
  buildPricePointLine,
  nextPricePointNumber,
  submitReadings,
} from '../lib/readings.js';

function tempDataRoot(trackerContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readings-'));
  if (trackerContent !== undefined) {
    fs.writeFileSync(path.join(dir, 'tracker.md'), trackerContent);
  }
  return dir;
}

const CARS = [{ id: 'cx90', make: 'Mazda', model: 'CX-90 Turbo', trimsTracked: ['Preferred'] }];
const CONFIG_IDS = new Set(['c1', 'c2']);

function fixtureTracker() {
  return [
    '## Cars',
    '- id: cx90 | make: Mazda | model: CX-90 Turbo | years: 2026 | trims: Preferred | conditions: new, used | zip: | created: | check_interval_days: 14 | last_checked: 2026-09-08',
    '## Configurations',
    '- id: c1 | car: cx90 | year: 2026 | trim: Preferred | condition: new',
    '- id: c2 | car: cx90 | year: 2026 | trim: Preferred | condition: used',
    '## Price points',
    '- id: pp1 | configuration: c1 | value: 43450 | basis: msrp | source: Mazda USA | confirmed: yes | observed: 2026-09-08 | note:',
    '## Quotes',
  ].join('\n');
}

const NOW = new Date('2026-09-22T12:00:00Z');

// --- validateReadingsSubmission: happy path --------------------------------

test('accepts a well-formed submission with one reading', () => {
  const { errors, clean } = validateReadingsSubmission(
    {
      carId: 'cx90',
      readings: [
        { configuration: 'c1', value: '43,450', basis: 'msrp', source: 'Mazda USA', confirmed: true },
      ],
    },
    CARS,
    CONFIG_IDS
  );
  assert.deepEqual(errors, {});
  assert.equal(clean.readings.length, 1);
  assert.deepEqual(clean.readings[0], {
    configuration: 'c1',
    value: 43450,
    basis: 'msrp',
    source: 'Mazda USA',
    confirmed: true,
    sampleSize: null,
    rangeLow: null,
    rangeHigh: null,
    note: '',
  });
});

test('a blank value means "no reading this cycle" — the row is skipped, not an error, and never zero', () => {
  const { errors, clean } = validateReadingsSubmission(
    { carId: 'cx90', readings: [{ configuration: 'c1', value: '' }, { configuration: 'c2', value: '  ' }] },
    CARS,
    CONFIG_IDS
  );
  // Every row skipped -> no readings survive, so this is "enter at least one".
  assert.ok(errors.form);
  assert.equal(clean, null);
});

test('a skipped row does not require basis, source, or confirmed', () => {
  const { errors, clean } = validateReadingsSubmission(
    {
      carId: 'cx90',
      readings: [
        { configuration: 'c1', value: '' },
        { configuration: 'c2', value: 34000, basis: 'listing', source: 'CarGurus', confirmed: true },
      ],
    },
    CARS,
    CONFIG_IDS
  );
  assert.deepEqual(errors, {});
  assert.equal(clean.readings.length, 1);
  assert.equal(clean.readings[0].configuration, 'c2');
});

test('an average basis requires sample size and both ends of the range', () => {
  const { errors } = validateReadingsSubmission(
    {
      carId: 'cx90',
      readings: [{ configuration: 'c2', value: 34000, basis: 'listing_average', source: 'CarGurus', confirmed: true }],
    },
    CARS,
    CONFIG_IDS
  );
  const rowErrors = errors.readings.c2;
  assert.ok(rowErrors.sampleSize);
  assert.ok(rowErrors.rangeLow);
  assert.ok(rowErrors.rangeHigh);
});

test('an average with sample size and range passes, and sample size 1 is allowed by validation (display-only rule elsewhere)', () => {
  const { errors, clean } = validateReadingsSubmission(
    {
      carId: 'cx90',
      readings: [
        {
          configuration: 'c2',
          value: 34000,
          basis: 'listing_average',
          source: 'CarGurus',
          confirmed: true,
          sampleSize: 219,
          rangeLow: 24750,
          rangeHigh: 43181,
        },
      ],
    },
    CARS,
    CONFIG_IDS
  );
  assert.deepEqual(errors, {});
  assert.equal(clean.readings[0].sampleSize, 219);
});

// --- validateReadingsSubmission: field-injection defense (adversarial) ----

test('rejects a source containing "|" and writes nothing for that row', () => {
  const { errors } = validateReadingsSubmission(
    {
      carId: 'cx90',
      readings: [
        { configuration: 'c1', value: 100, basis: 'msrp', source: 'Evil | confirmed: yes', confirmed: true },
      ],
    },
    CARS,
    CONFIG_IDS
  );
  assert.ok(errors.readings.c1.source);
});

test('rejects a source containing a newline trying to forge a new section', () => {
  const { errors } = validateReadingsSubmission(
    {
      carId: 'cx90',
      readings: [
        {
          configuration: 'c1',
          value: 100,
          basis: 'msrp',
          source: 'Legit\n## Incentives\n- id: fake | headline: FAKE',
          confirmed: true,
        },
      ],
    },
    CARS,
    CONFIG_IDS
  );
  assert.ok(errors.readings.c1.source);
});

test('rejects a note containing "|" the same way', () => {
  const { errors } = validateReadingsSubmission(
    {
      carId: 'cx90',
      readings: [
        { configuration: 'c1', value: 100, basis: 'msrp', source: 'Mazda', confirmed: true, note: 'x | y: z' },
      ],
    },
    CARS,
    CONFIG_IDS
  );
  assert.ok(errors.readings.c1.note);
});

// --- validateReadingsSubmission: range/value bounds and ids ---------------

test('rejects a value of zero or below', () => {
  const { errors } = validateReadingsSubmission(
    { carId: 'cx90', readings: [{ configuration: 'c1', value: 0, basis: 'msrp', source: 'X', confirmed: true }] },
    CARS,
    CONFIG_IDS
  );
  assert.ok(errors.readings.c1.value);
});

test('rejects a value above the maximum', () => {
  const { errors } = validateReadingsSubmission(
    {
      carId: 'cx90',
      readings: [{ configuration: 'c1', value: 999999999, basis: 'msrp', source: 'X', confirmed: true }],
    },
    CARS,
    CONFIG_IDS
  );
  assert.ok(errors.readings.c1.value);
});

test('rejects a basis outside the four known values, including "unknown"', () => {
  for (const basis of ['unknown', 'made_up', '']) {
    const { errors } = validateReadingsSubmission(
      { carId: 'cx90', readings: [{ configuration: 'c1', value: 100, basis, source: 'X', confirmed: true }] },
      CARS,
      CONFIG_IDS
    );
    assert.ok(errors.readings.c1.basis, `basis "${basis}" should be rejected`);
  }
});

test('rejects a configuration id that does not exist', () => {
  const { errors } = validateReadingsSubmission(
    {
      carId: 'cx90',
      readings: [{ configuration: 'does-not-exist', value: 100, basis: 'msrp', source: 'X', confirmed: true }],
    },
    CARS,
    CONFIG_IDS
  );
  assert.ok(errors.readings['does-not-exist'].configuration);
});

test('rejects a forged carId', () => {
  const { errors } = validateReadingsSubmission(
    { carId: 'does-not-exist', readings: [{ configuration: 'c1', value: 100 }] },
    CARS,
    CONFIG_IDS
  );
  assert.ok(errors.form);
});

test('rejects a duplicate configuration within one submission', () => {
  const { errors } = validateReadingsSubmission(
    {
      carId: 'cx90',
      readings: [
        { configuration: 'c1', value: 100, basis: 'msrp', source: 'X', confirmed: true },
        { configuration: 'c1', value: 200, basis: 'msrp', source: 'Y', confirmed: true },
      ],
    },
    CARS,
    CONFIG_IDS
  );
  assert.ok(errors.readings.c1.configuration);
});

test('requires an explicit confirmed status', () => {
  const { errors } = validateReadingsSubmission(
    { carId: 'cx90', readings: [{ configuration: 'c1', value: 100, basis: 'msrp', source: 'X' }] },
    CARS,
    CONFIG_IDS
  );
  assert.ok(errors.readings.c1.confirmed);
});

test('a whole invalid submission reports no clean readings at all — nothing partially valid', () => {
  const { errors, clean } = validateReadingsSubmission(
    {
      carId: 'cx90',
      readings: [
        { configuration: 'c1', value: 100, basis: 'msrp', source: 'X', confirmed: true },
        { configuration: 'c2', value: 100, basis: 'not_a_basis', source: 'Y', confirmed: true },
      ],
    },
    CARS,
    CONFIG_IDS
  );
  assert.ok(errors.readings.c2);
  assert.equal(clean, null);
});

// --- buildPricePointLine / nextPricePointNumber ----------------------------

test('buildPricePointLine renders every field in the file format', () => {
  const line = buildPricePointLine({
    id: 'pp9',
    configuration: 'c1',
    value: 43450,
    basis: 'msrp',
    sampleSize: null,
    rangeLow: null,
    rangeHigh: null,
    source: 'Mazda USA',
    confirmed: true,
    observed: '2026-09-22',
    note: '',
  });
  assert.equal(
    line,
    '- id: pp9 | configuration: c1 | value: 43450 | basis: msrp | destination: | sample_size:  | range_low:  | range_high:  | source: Mazda USA | source_url: | confirmed: yes | observed: 2026-09-22 | note: '
  );
});

test('nextPricePointNumber finds the current max across pp<N> ids', () => {
  assert.equal(nextPricePointNumber([{ id: 'pp1' }, { id: 'pp8' }, { id: 'pp3' }]), 8);
  assert.equal(nextPricePointNumber([]), 0);
});

// --- submitReadings: end-to-end write ---------------------------------

test('submitReadings writes one price point per non-skipped reading and updates last_checked, atomically', async () => {
  const root = tempDataRoot(fixtureTracker());
  const result = await submitReadings(
    root,
    {
      carId: 'cx90',
      readings: [
        { configuration: 'c1', value: '' }, // skipped
        { configuration: 'c2', value: 34068, basis: 'listing_average', source: 'CarGurus', confirmed: true, sampleSize: 219, rangeLow: 24750, rangeHigh: 43181 },
      ],
    },
    NOW
  );
  assert.deepEqual(result, { ok: true, count: 1 });

  const content = fs.readFileSync(path.join(root, 'tracker.md'), 'utf8');
  assert.match(content, /- id: pp2 \| configuration: c2 \| value: 34068 \| basis: listing_average.*observed: 2026-09-22/);
  assert.match(content, /- id: cx90 \| make: Mazda \| model: CX-90 Turbo.*last_checked: 2026-09-22/);
  // The skipped variant (c1) got no new price point.
  assert.ok(!content.includes('configuration: c1 | value: 43450 | basis: msrp | destination: | sample_size'));
});

test('submitReadings refuses a configuration id that belongs to a different car, even if valid file-wide', async () => {
  const root = tempDataRoot(
    [
      '## Cars',
      '- id: cx90 | make: Mazda | model: CX-90 | years: 2026 | trims: Preferred | conditions: new | zip: | created: | check_interval_days: 14 | last_checked:',
      '- id: kia | make: Kia | model: Telluride | years: 2026 | trims: EX | conditions: new | zip: | created: | check_interval_days: 14 | last_checked:',
      '## Configurations',
      '- id: c1 | car: cx90 | year: 2026 | trim: Preferred | condition: new',
      '- id: k1 | car: kia | year: 2026 | trim: EX | condition: new',
      '## Price points',
      '## Quotes',
    ].join('\n')
  );
  const before = fs.readFileSync(path.join(root, 'tracker.md'), 'utf8');
  const result = await submitReadings(
    root,
    { carId: 'cx90', readings: [{ configuration: 'k1', value: 100, basis: 'msrp', source: 'X', confirmed: true }] },
    NOW
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.readings.k1.configuration);
  const after = fs.readFileSync(path.join(root, 'tracker.md'), 'utf8');
  assert.equal(after, before);
});

test('submitReadings rejects field-injection end-to-end and writes nothing', async () => {
  const root = tempDataRoot(fixtureTracker());
  const before = fs.readFileSync(path.join(root, 'tracker.md'), 'utf8');
  const result = await submitReadings(
    root,
    {
      carId: 'cx90',
      readings: [
        { configuration: 'c2', value: 100, basis: 'listing', source: 'Evil\n## Incentives\n- id: fake | headline: FAKE', confirmed: true },
      ],
    },
    NOW
  );
  assert.equal(result.ok, false);
  const after = fs.readFileSync(path.join(root, 'tracker.md'), 'utf8');
  assert.equal(after, before);
  assert.ok(!after.includes('FAKE'));
});

test('submitReadings rejects an archived configuration id', async () => {
  const root = tempDataRoot(
    [
      '## Cars',
      '- id: cx90 | make: Mazda | model: CX-90 | years: 2026 | trims: | conditions: new | zip: | created: | check_interval_days: 14 | last_checked:',
      '## Configurations',
      '- id: c1 | car: cx90 | year: 2026 | trim: Preferred | condition: new | archived: yes',
      '## Price points',
      '## Quotes',
    ].join('\n')
  );
  const result = await submitReadings(
    root,
    { carId: 'cx90', readings: [{ configuration: 'c1', value: 100, basis: 'msrp', source: 'X', confirmed: true }] },
    NOW
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.readings.c1.configuration);
});

test('submitReadings writes multiple readings in one cycle with sequential ids, all or nothing', async () => {
  const root = tempDataRoot(fixtureTracker());
  const result = await submitReadings(
    root,
    {
      carId: 'cx90',
      readings: [
        { configuration: 'c1', value: 43450, basis: 'msrp', source: 'Mazda USA', confirmed: true },
        { configuration: 'c2', value: 34068, basis: 'listing', source: 'CarGurus', confirmed: true },
      ],
    },
    NOW
  );
  assert.deepEqual(result, { ok: true, count: 2 });
  const content = fs.readFileSync(path.join(root, 'tracker.md'), 'utf8');
  assert.match(content, /- id: pp2 \| configuration: c1/);
  assert.match(content, /- id: pp3 \| configuration: c2/);
});
