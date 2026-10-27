import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  slugify,
  parseYearsRange,
  validateNewCar,
  nextCarId,
  buildNewCarRecord,
  buildCarLine,
  buildConfigurationLine,
  submitNewCar,
} from '../lib/cars.js';

function tempDataRoot(trackerContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cars-'));
  if (trackerContent !== undefined) {
    fs.writeFileSync(path.join(dir, 'tracker.md'), trackerContent);
  }
  return dir;
}

function fixtureTracker() {
  return ['## Cars', '- id: cx90 | make: Mazda | model: CX-90 Turbo', '## Configurations', '## Quotes'].join('\n');
}

// --- slugify ---------------------------------------------------------

test('slugify lowercases and hyphenates', () => {
  assert.equal(slugify('Mazda CX-90'), 'mazda-cx-90');
});

test('slugify falls back to "x" for text with no alphanumeric characters', () => {
  assert.equal(slugify('!!!'), 'x');
  assert.equal(slugify(''), 'x');
});

// --- parseYearsRange ---------------------------------------------------

test('parseYearsRange accepts a blank value as "no years given"', () => {
  assert.deepEqual(parseYearsRange(''), { years: '', yearList: [] });
  assert.deepEqual(parseYearsRange('   '), { years: '', yearList: [] });
});

test('parseYearsRange accepts a single year', () => {
  assert.deepEqual(parseYearsRange('2026'), { years: '2026', yearList: ['2026'] });
});

test('parseYearsRange accepts a range and expands every year in it', () => {
  assert.deepEqual(parseYearsRange('2025-2026'), { years: '2025-2026', yearList: ['2025', '2026'] });
});

test('parseYearsRange accepts an en-dash range', () => {
  assert.deepEqual(parseYearsRange('2025–2026'), { years: '2025-2026', yearList: ['2025', '2026'] });
});

test('parseYearsRange rejects an unrecognized format with years: null, distinct from blank', () => {
  const result = parseYearsRange('sometime soon');
  assert.equal(result.years, null);
});

test('parseYearsRange rejects a reversed range', () => {
  assert.equal(parseYearsRange('2026-2020').years, null);
});

test('parseYearsRange rejects a range wider than the max span', () => {
  assert.equal(parseYearsRange('2000-2026').years, null);
});

// --- validateNewCar: happy path ---------------------------------------

test('validateNewCar accepts a well-formed submission and trims whitespace', () => {
  const { errors, clean } = validateNewCar({
    make: ' Kia ',
    model: ' Telluride ',
    years: ' 2025-2026 ',
    zip: ' 90210 ',
    trims: [' EX ', ' SX '],
    conditions: ['new', 'used'],
  });
  assert.deepEqual(errors, {});
  assert.equal(clean.make, 'Kia');
  assert.equal(clean.model, 'Telluride');
  assert.equal(clean.years, '2025-2026');
  assert.deepEqual(clean.yearList, ['2025', '2026']);
  assert.equal(clean.zip, '90210');
  assert.deepEqual(clean.trims, ['EX', 'SX']);
  assert.deepEqual(clean.conditions, ['new', 'used']);
});

test('validateNewCar accepts an empty trims list — empty means every trim', () => {
  const { errors, clean } = validateNewCar({ make: 'Kia', model: 'Telluride', conditions: ['new'] });
  assert.deepEqual(errors, {});
  assert.deepEqual(clean.trims, []);
});

test('validateNewCar deduplicates trims case-insensitively, keeping the first spelling', () => {
  const { clean } = validateNewCar({ make: 'Kia', model: 'Telluride', trims: ['EX', 'ex', 'EX '], conditions: ['new'] });
  assert.deepEqual(clean.trims, ['EX']);
});

test('validateNewCar filters unknown conditions and orders known ones consistently', () => {
  const { clean } = validateNewCar({ make: 'Kia', model: 'Telluride', conditions: ['used', 'bogus', 'new'] });
  assert.deepEqual(clean.conditions, ['new', 'used']);
});

// --- validateNewCar: required fields -----------------------------------

test('rejects a missing make', () => {
  const { errors } = validateNewCar({ model: 'Telluride', conditions: ['new'] });
  assert.ok(errors.make);
});

test('rejects a missing model', () => {
  const { errors } = validateNewCar({ make: 'Kia', conditions: ['new'] });
  assert.ok(errors.model);
});

test('rejects zero conditions selected', () => {
  const { errors } = validateNewCar({ make: 'Kia', model: 'Telluride', conditions: [] });
  assert.ok(errors.conditions);
});

test('a rejected submission reports every invalid field at once', () => {
  const { errors } = validateNewCar({ conditions: [] });
  assert.deepEqual(Object.keys(errors).sort(), ['conditions', 'make', 'model']);
});

// --- validateNewCar: length caps ----------------------------------------

test('rejects a make over the length cap', () => {
  assert.ok(validateNewCar({ make: 'x'.repeat(81), model: 'Telluride', conditions: ['new'] }).errors.make);
});

test('rejects a model over the length cap', () => {
  assert.ok(validateNewCar({ make: 'Kia', model: 'x'.repeat(81), conditions: ['new'] }).errors.model);
});

test('rejects a zip over the length cap', () => {
  assert.ok(validateNewCar({ make: 'Kia', model: 'Telluride', zip: 'x'.repeat(13), conditions: ['new'] }).errors.zip);
});

test('rejects a trim over the length cap', () => {
  assert.ok(
    validateNewCar({ make: 'Kia', model: 'Telluride', trims: ['x'.repeat(61)], conditions: ['new'] }).errors.trims
  );
});

test('rejects more than the maximum number of trims', () => {
  const trims = Array.from({ length: 21 }, (_, i) => `Trim ${i}`);
  assert.ok(validateNewCar({ make: 'Kia', model: 'Telluride', trims, conditions: ['new'] }).errors.trims);
});

// --- validateNewCar: field-injection defense (adversarial) ---------------

test('rejects a make that tries to forge extra fields with a "|"', () => {
  const { errors } = validateNewCar({ make: 'Kia | model: Forged', model: 'Telluride', conditions: ['new'] });
  assert.ok(errors.make);
});

test('rejects a model that tries to forge extra fields with a "|"', () => {
  const { errors } = validateNewCar({ make: 'Kia', model: 'Telluride | trims: EX', conditions: ['new'] });
  assert.ok(errors.model);
});

test('rejects a zip that tries to forge extra fields with a "|"', () => {
  const { errors } = validateNewCar({ make: 'Kia', model: 'Telluride', zip: '90210 | created: 2020-01-01', conditions: ['new'] });
  assert.ok(errors.zip);
});

test('rejects a trim that tries to forge extra fields with a "|"', () => {
  const { errors } = validateNewCar({ make: 'Kia', model: 'Telluride', trims: ['EX | condition: used'], conditions: ['new'] });
  assert.ok(errors.trims);
});

test('rejects a years field that tries to forge extra fields with a "|"', () => {
  const { errors } = validateNewCar({ make: 'Kia', model: 'Telluride', years: '2026 | zip: 00000', conditions: ['new'] });
  assert.ok(errors.years);
});

test('rejects a make that tries to forge a whole new record with a newline', () => {
  const { errors } = validateNewCar({
    make: 'Kia\n- id: forged | make: Evil | model: Forgery',
    model: 'Telluride',
    conditions: ['new'],
  });
  assert.ok(errors.make);
});

test('rejects a model that tries to forge a whole new section with a newline', () => {
  const { errors } = validateNewCar({
    make: 'Kia',
    model: 'Telluride\n## Incentives\n- id: fake | headline: FAKE',
    conditions: ['new'],
  });
  assert.ok(errors.model);
});

test('rejects a make using a carriage return instead of a bare newline', () => {
  const { errors } = validateNewCar({ make: 'Kia\rEvil', model: 'Telluride', conditions: ['new'] });
  assert.ok(errors.make);
});

// --- nextCarId -----------------------------------------------------------

test('nextCarId slugifies make and model with no collision', () => {
  assert.equal(nextCarId(new Set(['cx90']), 'Kia', 'Telluride'), 'kia-telluride');
});

test('nextCarId appends a numeric suffix on collision', () => {
  assert.equal(nextCarId(new Set(['kia-telluride']), 'Kia', 'Telluride'), 'kia-telluride-2');
  assert.equal(nextCarId(new Set(['kia-telluride', 'kia-telluride-2']), 'Kia', 'Telluride'), 'kia-telluride-3');
});

// --- buildNewCarRecord ----------------------------------------------------

test('buildNewCarRecord creates no Configurations when trims are empty — no build-up without a trim', () => {
  const { clean } = validateNewCar({ make: 'Kia', model: 'Telluride', years: '2026', conditions: ['new'] });
  const { car, configurations } = buildNewCarRecord(clean, 'kia-telluride', new Date('2026-09-24T00:00:00Z'));
  assert.equal(car.id, 'kia-telluride');
  assert.equal(car.checkIntervalDays, 14);
  assert.equal(car.lastCheckedAt, null);
  assert.equal(car.created, '2026-09-24');
  assert.deepEqual(configurations, []);
});

test('buildNewCarRecord creates one Configuration per year x trim x condition', () => {
  const { clean } = validateNewCar({
    make: 'Kia',
    model: 'Telluride',
    years: '2025-2026',
    trims: ['EX'],
    conditions: ['new', 'used'],
  });
  const { configurations } = buildNewCarRecord(clean, 'kia-telluride', new Date('2026-09-24T00:00:00Z'));
  assert.equal(configurations.length, 4);
  assert.ok(configurations.every((c) => c.archived === false));
  assert.deepEqual(
    configurations.map((c) => c.id).sort(),
    ['kia-telluride-2025-ex-new', 'kia-telluride-2025-ex-used', 'kia-telluride-2026-ex-new', 'kia-telluride-2026-ex-used'].sort()
  );
});

// --- buildCarLine / buildConfigurationLine --------------------------------

test('buildCarLine formats a pipe-delimited line matching the parser', () => {
  const line = buildCarLine({
    id: 'kia-telluride',
    make: 'Kia',
    model: 'Telluride',
    years: '2026',
    trimsTracked: ['EX', 'SX'],
    conditions: ['new'],
    zip: '90210',
    created: '2026-09-24',
    checkIntervalDays: 14,
    lastCheckedAt: null,
  });
  assert.equal(
    line,
    '- id: kia-telluride | make: Kia | model: Telluride | years: 2026 | trims: EX, SX | conditions: new | zip: 90210 | created: 2026-09-24 | check_interval_days: 14 | last_checked: '
  );
});

test('buildConfigurationLine omits the archived field when not archived', () => {
  const line = buildConfigurationLine({ id: 'c1', car: 'kia-telluride', year: '2026', trim: 'EX', condition: 'new', archived: false });
  assert.equal(line, '- id: c1 | car: kia-telluride | year: 2026 | trim: EX | condition: new');
});

test('buildConfigurationLine includes the archived field when archived', () => {
  const line = buildConfigurationLine({ id: 'c1', car: 'kia-telluride', year: '2026', trim: 'EX', condition: 'new', archived: true });
  assert.equal(line, '- id: c1 | car: kia-telluride | year: 2026 | trim: EX | condition: new | archived: yes');
});

// --- submitNewCar: the full read-validate-write cycle ----------------------

test('submitNewCar writes a Car line and its Configuration lines, atomically, with no temp file left behind', async () => {
  const root = tempDataRoot(fixtureTracker());
  const result = await submitNewCar(
    root,
    { make: 'Kia', model: 'Telluride', years: '2026', zip: '90210', trims: ['EX'], conditions: ['new'] },
    new Date('2026-09-24T12:00:00Z')
  );
  assert.equal(result.ok, true);
  assert.equal(result.carId, 'kia-telluride');

  const content = fs.readFileSync(path.join(root, 'tracker.md'), 'utf8');
  assert.match(content, /- id: kia-telluride \| make: Kia \| model: Telluride/);
  assert.match(content, /- id: kia-telluride-2026-ex-new \| car: kia-telluride \| year: 2026 \| trim: EX \| condition: new/);

  const leftover = fs.readdirSync(root).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftover, []);
});

test('submitNewCar with no trims writes only the Car line and no Configurations', async () => {
  const root = tempDataRoot(fixtureTracker());
  const result = await submitNewCar(root, { make: 'Kia', model: 'Telluride', conditions: ['new'] });
  assert.equal(result.ok, true);
  const content = fs.readFileSync(path.join(root, 'tracker.md'), 'utf8');
  assert.match(content, /- id: kia-telluride \| make: Kia/);
  assert.ok(!content.includes('kia-telluride-'));
});

test('submitNewCar rejects an invalid submission and writes nothing', async () => {
  const root = tempDataRoot(fixtureTracker());
  const before = fs.readFileSync(path.join(root, 'tracker.md'), 'utf8');
  const result = await submitNewCar(root, { make: '', model: 'Telluride', conditions: ['new'] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.make);
  assert.equal(fs.readFileSync(path.join(root, 'tracker.md'), 'utf8'), before);
});

test('submitNewCar rejects an adversarial make field and the attempted injection never reaches the file', async () => {
  const root = tempDataRoot(fixtureTracker());
  const before = fs.readFileSync(path.join(root, 'tracker.md'), 'utf8');
  const result = await submitNewCar(root, {
    make: 'Kia\n## Incentives\n- id: fake | car: cx90 | headline: FAKE | expires: 2099-01-01',
    model: 'Telluride',
    conditions: ['new'],
  });
  assert.equal(result.ok, false);
  const after = fs.readFileSync(path.join(root, 'tracker.md'), 'utf8');
  assert.equal(after, before);
  assert.ok(!after.includes('FAKE'));
});

test('submitNewCar assigns a distinct suffixed id on a make/model collision', async () => {
  const root = tempDataRoot(['## Cars', '- id: kia-telluride | make: Kia | model: Telluride', '## Configurations'].join('\n'));
  const result = await submitNewCar(root, { make: 'Kia', model: 'Telluride', conditions: ['new'] });
  assert.equal(result.ok, true);
  assert.equal(result.carId, 'kia-telluride-2');
});

test('submitNewCar reports a missing data file rather than throwing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cars-missing-'));
  const result = await submitNewCar(root, { make: 'Kia', model: 'Telluride', conditions: ['new'] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.form);
});

test('two near-simultaneous new-car submissions are serialized: both are written, nothing lost', async () => {
  const root = tempDataRoot(fixtureTracker());
  const [a, b] = await Promise.all([
    submitNewCar(root, { make: 'Kia', model: 'Telluride', conditions: ['new'] }),
    submitNewCar(root, { make: 'Honda', model: 'Pilot', conditions: ['new'] }),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  const content = fs.readFileSync(path.join(root, 'tracker.md'), 'utf8');
  assert.ok(content.includes('kia-telluride'));
  assert.ok(content.includes('honda-pilot'));
});
