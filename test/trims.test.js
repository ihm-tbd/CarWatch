import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { validateTrimAction, submitArchiveTrim, submitAddTrim } from '../lib/trims.js';

function tempDataRoot(trackerContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trims-'));
  if (trackerContent !== undefined) {
    fs.writeFileSync(path.join(dir, 'tracker.md'), trackerContent);
  }
  return dir;
}

const CARS = [
  { id: 'cx90', make: 'Mazda', model: 'CX-90', trimsTracked: ['Preferred', 'Premium Sport'], conditions: ['new'] },
];

// --- validateTrimAction: happy path --------------------------------------

test('validateTrimAction accepts a well-formed submission and trims whitespace', () => {
  const { errors, clean } = validateTrimAction({ carId: 'cx90', trim: ' Preferred ' }, CARS);
  assert.deepEqual(errors, {});
  assert.equal(clean.carId, 'cx90');
  assert.equal(clean.trim, 'Preferred');
  assert.equal(clean.car.id, 'cx90');
});

// --- validateTrimAction: everything the server must not trust the browser for --

test('rejects a missing carId', () => {
  assert.ok(validateTrimAction({ trim: 'Preferred' }, CARS).errors.carId);
});

test('rejects a carId that does not exist — a stale or forged id', () => {
  const { errors } = validateTrimAction({ carId: 'does-not-exist', trim: 'Preferred' }, CARS);
  assert.ok(errors.carId);
});

test('rejects a missing trim', () => {
  assert.ok(validateTrimAction({ carId: 'cx90', trim: '   ' }, CARS).errors.trim);
});

test('rejects a trim name over the length cap', () => {
  assert.ok(validateTrimAction({ carId: 'cx90', trim: 'x'.repeat(61) }, CARS).errors.trim);
});

// --- validateTrimAction: field-injection defense (adversarial) -----------

test('rejects a trim name that tries to forge extra fields with a "|"', () => {
  const { errors } = validateTrimAction({ carId: 'cx90', trim: 'Preferred | archived: no | car: forged' }, CARS);
  assert.ok(errors.trim);
});

test('rejects a trim name that tries to forge a whole new record with a newline', () => {
  const { errors } = validateTrimAction(
    { carId: 'cx90', trim: 'Preferred\n- id: forged | car: cx90 | year: 2026 | trim: Forged | condition: new' },
    CARS
  );
  assert.ok(errors.trim);
});

test('rejects a trim name using a carriage return instead of a bare newline', () => {
  assert.ok(validateTrimAction({ carId: 'cx90', trim: 'Evil\rTrim' }, CARS).errors.trim);
});

test('a rejected submission reports every invalid field at once', () => {
  const { errors } = validateTrimAction({ carId: '', trim: '' }, CARS);
  assert.deepEqual(Object.keys(errors).sort(), ['carId', 'trim']);
});

// --- submitArchiveTrim: the full read-validate-write cycle -----------------

function fixtureTracker() {
  return [
    '## Cars',
    '- id: cx90 | make: Mazda | model: CX-90 | years: 2025-2026 | trims: Preferred, Premium Sport | conditions: new | zip: | created: | check_interval_days: 14 | last_checked:',
    '## Configurations',
    '- id: cx90-2026-preferred | car: cx90 | year: 2026 | trim: Preferred | condition: new',
    '- id: cx90-2025-preferred | car: cx90 | year: 2025 | trim: Preferred | condition: new',
    '- id: cx90-2026-premium-sport | car: cx90 | year: 2026 | trim: Premium Sport | condition: new',
    '## Price points',
    '- id: pp1 | configuration: cx90-2026-preferred | value: 43450 | basis: msrp',
    '## Quotes',
  ].join('\n');
}

test('submitArchiveTrim archives every Configuration for that trim across every model year, and no others', async () => {
  const root = tempDataRoot(fixtureTracker());
  const result = await submitArchiveTrim(root, { carId: 'cx90', trim: 'Preferred' });
  assert.equal(result.ok, true);

  const content = fs.readFileSync(path.join(root, 'tracker.md'), 'utf8');
  assert.match(content, /- id: cx90-2026-preferred \| car: cx90 \| year: 2026 \| trim: Preferred \| condition: new \| archived: yes/);
  assert.match(content, /- id: cx90-2025-preferred \| car: cx90 \| year: 2025 \| trim: Preferred \| condition: new \| archived: yes/);
  // Premium Sport, a different trim, is untouched.
  assert.match(content, /- id: cx90-2026-premium-sport \| car: cx90 \| year: 2026 \| trim: Premium Sport \| condition: new$/m);
  // Price points are never touched by archiving.
  assert.match(content, /- id: pp1 \| configuration: cx90-2026-preferred \| value: 43450 \| basis: msrp/);
  // The Car's trimsTracked drops the archived trim.
  assert.match(content, /trims: Premium Sport \|/);

  const leftover = fs.readdirSync(root).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftover, []);
});

test('submitArchiveTrim rejects a trim not currently on the watch, and writes nothing', async () => {
  const root = tempDataRoot(fixtureTracker());
  const before = fs.readFileSync(path.join(root, 'tracker.md'), 'utf8');
  const result = await submitArchiveTrim(root, { carId: 'cx90', trim: 'Signature' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.trim);
  assert.equal(fs.readFileSync(path.join(root, 'tracker.md'), 'utf8'), before);
});

test('submitArchiveTrim rejects a forged carId and writes nothing', async () => {
  const root = tempDataRoot(fixtureTracker());
  const before = fs.readFileSync(path.join(root, 'tracker.md'), 'utf8');
  const result = await submitArchiveTrim(root, { carId: 'does-not-exist', trim: 'Preferred' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.carId);
  assert.equal(fs.readFileSync(path.join(root, 'tracker.md'), 'utf8'), before);
});

test('submitArchiveTrim rejects an adversarial trim field and the attempted injection never reaches the file', async () => {
  const root = tempDataRoot(fixtureTracker());
  const before = fs.readFileSync(path.join(root, 'tracker.md'), 'utf8');
  const result = await submitArchiveTrim(root, {
    carId: 'cx90',
    trim: 'Preferred\n## Incentives\n- id: fake | car: cx90 | headline: FAKE | expires: 2099-01-01',
  });
  assert.equal(result.ok, false);
  const after = fs.readFileSync(path.join(root, 'tracker.md'), 'utf8');
  assert.equal(after, before);
  assert.ok(!after.includes('FAKE'));
});

// --- submitAddTrim: restore path -------------------------------------------

test('submitAddTrim restores every archived Configuration for a previously-removed trim, intact', async () => {
  const root = tempDataRoot(fixtureTracker());
  const archived = await submitArchiveTrim(root, { carId: 'cx90', trim: 'Preferred' });
  assert.equal(archived.ok, true);

  const restored = await submitAddTrim(root, { carId: 'cx90', trim: 'Preferred' });
  assert.equal(restored.ok, true);
  assert.equal(restored.restored, true);

  const content = fs.readFileSync(path.join(root, 'tracker.md'), 'utf8');
  // Both years restored, and the original price point (history) is still there, untouched throughout.
  assert.match(content, /- id: cx90-2026-preferred \| car: cx90 \| year: 2026 \| trim: Preferred \| condition: new$/m);
  assert.match(content, /- id: cx90-2025-preferred \| car: cx90 \| year: 2025 \| trim: Preferred \| condition: new$/m);
  assert.match(content, /- id: pp1 \| configuration: cx90-2026-preferred \| value: 43450 \| basis: msrp/);
  assert.match(content, /trims: Premium Sport, Preferred \|/);
});

test('submitAddTrim creates fresh Configurations, with no price points, for a genuinely new trim', async () => {
  const root = tempDataRoot(fixtureTracker());
  const result = await submitAddTrim(root, { carId: 'cx90', trim: 'Signature' });
  assert.equal(result.ok, true);
  assert.notEqual(result.restored, true);

  const content = fs.readFileSync(path.join(root, 'tracker.md'), 'utf8');
  assert.match(content, /- id: cx90-2026-signature-new \| car: cx90 \| year: 2026 \| trim: Signature \| condition: new$/m);
  assert.match(content, /- id: cx90-2025-signature-new \| car: cx90 \| year: 2025 \| trim: Signature \| condition: new$/m);
  assert.match(content, /trims: Preferred, Premium Sport, Signature \|/);
});

test('submitAddTrim rejects a trim already on the watch, and writes nothing', async () => {
  const root = tempDataRoot(fixtureTracker());
  const before = fs.readFileSync(path.join(root, 'tracker.md'), 'utf8');
  const result = await submitAddTrim(root, { carId: 'cx90', trim: 'Preferred' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.trim);
  assert.equal(fs.readFileSync(path.join(root, 'tracker.md'), 'utf8'), before);
});

test('submitAddTrim rejects a forged carId and writes nothing', async () => {
  const root = tempDataRoot(fixtureTracker());
  const before = fs.readFileSync(path.join(root, 'tracker.md'), 'utf8');
  const result = await submitAddTrim(root, { carId: 'does-not-exist', trim: 'Signature' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.carId);
  assert.equal(fs.readFileSync(path.join(root, 'tracker.md'), 'utf8'), before);
});

test('submitAddTrim rejects an adversarial trim field and the attempted injection never reaches the file', async () => {
  const root = tempDataRoot(fixtureTracker());
  const before = fs.readFileSync(path.join(root, 'tracker.md'), 'utf8');
  const result = await submitAddTrim(root, {
    carId: 'cx90',
    trim: 'Signature | condition: used\n## Incentives\n- id: fake | car: cx90 | headline: FAKE',
  });
  assert.equal(result.ok, false);
  const after = fs.readFileSync(path.join(root, 'tracker.md'), 'utf8');
  assert.equal(after, before);
  assert.ok(!after.includes('FAKE'));
});

test('two near-simultaneous trim actions on the same car are serialized, nothing lost', async () => {
  const root = tempDataRoot(fixtureTracker());
  const [a, b] = await Promise.all([
    submitAddTrim(root, { carId: 'cx90', trim: 'Signature' }),
    submitArchiveTrim(root, { carId: 'cx90', trim: 'Premium Sport' }),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  const content = fs.readFileSync(path.join(root, 'tracker.md'), 'utf8');
  assert.ok(content.includes('cx90-2026-signature'));
  assert.match(content, /- id: cx90-2026-premium-sport \| car: cx90 \| year: 2026 \| trim: Premium Sport \| condition: new \| archived: yes/);
});
