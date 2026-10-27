import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  validateQuote,
  buildQuoteLine,
  nextQuoteId,
  appendQuoteLine,
  submitQuote,
} from '../lib/quotes.js';

function tempDataRoot(trackerContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quotes-'));
  if (trackerContent !== undefined) {
    fs.writeFileSync(path.join(dir, 'tracker.md'), trackerContent);
  }
  return dir;
}

const CONFIG_IDS = new Set(['c1', 'c2']);

// --- validateQuote: happy path ------------------------------------------

test('validateQuote accepts a well-formed submission and trims whitespace', () => {
  const { errors, clean } = validateQuote(
    { configuration: ' c1 ', value: ' 42,000 ', dealer: ' Smith Mazda ', note: ' out-the-door ' },
    CONFIG_IDS
  );
  assert.deepEqual(errors, {});
  assert.deepEqual(clean, { configuration: 'c1', value: 42000, dealer: 'Smith Mazda', note: 'out-the-door' });
});

test('validateQuote accepts a missing note as empty', () => {
  const { errors, clean } = validateQuote({ configuration: 'c1', value: 100, dealer: 'X' }, CONFIG_IDS);
  assert.deepEqual(errors, {});
  assert.equal(clean.note, '');
});

// --- validateQuote: field-injection defense (adversarial) ---------------

test('rejects a dealer name that tries to forge extra fields with a "|"', () => {
  const { errors } = validateQuote(
    { configuration: 'c1', value: 100, dealer: 'Evil Motors | confirmed: yes | source: forged' },
    CONFIG_IDS
  );
  assert.ok(errors.dealer);
});

test('rejects a note that tries to forge extra fields with a "|"', () => {
  const { errors } = validateQuote(
    { configuration: 'c1', value: 100, dealer: 'Honest Motors', note: 'great deal | confirmed: yes' },
    CONFIG_IDS
  );
  assert.ok(errors.note);
});

test('rejects a dealer name that tries to forge a whole new record with a newline', () => {
  const { errors } = validateQuote(
    {
      configuration: 'c1',
      value: 100,
      dealer: 'Evil Motors\n- id: fake | configuration: c1 | value: 1 | dealer: forged | quoted: 2099-01-01',
    },
    CONFIG_IDS
  );
  assert.ok(errors.dealer);
});

test('rejects a note that tries to forge an entire new section with a newline', () => {
  const { errors } = validateQuote(
    {
      configuration: 'c1',
      value: 100,
      dealer: 'Honest Motors',
      note: 'fine print\n## Incentives\n- id: fake | car: cx90 | headline: FAKE $50,000 off | expires: 2099-01-01',
    },
    CONFIG_IDS
  );
  assert.ok(errors.note);
});

test('rejects a dealer name using a carriage return instead of a bare newline', () => {
  const { errors } = validateQuote({ configuration: 'c1', value: 100, dealer: 'Evil\rMotors' }, CONFIG_IDS);
  assert.ok(errors.dealer);
});

// --- validateQuote: everything else the server must not trust the browser for --

test('rejects a configuration id that does not exist', () => {
  const { errors } = validateQuote({ configuration: 'does-not-exist', value: 100, dealer: 'X' }, CONFIG_IDS);
  assert.ok(errors.configuration);
});

test('rejects a missing configuration id', () => {
  const { errors } = validateQuote({ value: 100, dealer: 'X' }, CONFIG_IDS);
  assert.ok(errors.configuration);
});

test('rejects a non-numeric value', () => {
  const { errors } = validateQuote({ configuration: 'c1', value: 'lots', dealer: 'X' }, CONFIG_IDS);
  assert.ok(errors.value);
});

test('rejects a zero or negative value', () => {
  assert.ok(validateQuote({ configuration: 'c1', value: 0, dealer: 'X' }, CONFIG_IDS).errors.value);
  assert.ok(validateQuote({ configuration: 'c1', value: -500, dealer: 'X' }, CONFIG_IDS).errors.value);
});

test('rejects a value outside sane bounds for a car price', () => {
  const { errors } = validateQuote({ configuration: 'c1', value: 5_000_000, dealer: 'X' }, CONFIG_IDS);
  assert.ok(errors.value);
});

test('rejects a missing dealer name', () => {
  const { errors } = validateQuote({ configuration: 'c1', value: 100, dealer: '   ' }, CONFIG_IDS);
  assert.ok(errors.dealer);
});

test('rejects a dealer name over the length cap', () => {
  const { errors } = validateQuote({ configuration: 'c1', value: 100, dealer: 'x'.repeat(201) }, CONFIG_IDS);
  assert.ok(errors.dealer);
});

test('rejects a note over the length cap', () => {
  const { errors } = validateQuote({ configuration: 'c1', value: 100, dealer: 'X', note: 'x'.repeat(501) }, CONFIG_IDS);
  assert.ok(errors.note);
});

test('a rejected submission reports every invalid field at once, not just the first', () => {
  const { errors } = validateQuote({ configuration: 'nope', value: 'abc', dealer: '' }, CONFIG_IDS);
  assert.deepEqual(Object.keys(errors).sort(), ['configuration', 'dealer', 'value']);
});

// --- buildQuoteLine / nextQuoteId ----------------------------------------

test('buildQuoteLine formats a pipe-delimited line matching the parser', () => {
  const line = buildQuoteLine({
    id: 'q1',
    configuration: 'c1',
    value: 42000,
    dealer: 'Smith Mazda',
    quoted: '2026-09-22',
    note: 'out-the-door',
  });
  assert.equal(
    line,
    '- id: q1 | configuration: c1 | value: 42000 | dealer: Smith Mazda | quoted: 2026-09-22 | note: out-the-door'
  );
});

test('nextQuoteId starts at q1 with no existing quotes', () => {
  assert.equal(nextQuoteId([]), 'q1');
});

test('nextQuoteId increments past the highest existing q<N> id', () => {
  assert.equal(nextQuoteId([{ id: 'q1' }, { id: 'q3' }, { id: 'q2' }]), 'q4');
});

test('nextQuoteId ignores non-numeric or oddly-shaped ids rather than crashing', () => {
  assert.equal(nextQuoteId([{ id: 'q1' }, { id: 'custom-quote' }, { id: 'q-weird' }]), 'q2');
});

// --- appendQuoteLine (pure string transform) -----------------------------

test('appendQuoteLine inserts at the end of an existing Quotes section, before the next heading', () => {
  const text = ['## Quotes', '- id: q1 | configuration: c1 | value: 1', '## Incentives', '- id: inc1'].join('\n');
  const result = appendQuoteLine(text, '- id: q2 | configuration: c1 | value: 2');
  assert.equal(
    result,
    ['## Quotes', '- id: q1 | configuration: c1 | value: 1', '- id: q2 | configuration: c1 | value: 2', '## Incentives', '- id: inc1'].join(
      '\n'
    )
  );
});

test('appendQuoteLine inserts after descriptive prose in the section, skipping trailing blank lines before the next heading', () => {
  const text = [
    '## Quotes',
    '',
    'No dealer quotes logged yet.',
    '`- id: <id> | configuration: <id> | ...`',
    '',
    '## Incentives',
  ].join('\n');
  const result = appendQuoteLine(text, '- id: q1 | configuration: c1 | value: 1');
  assert.equal(
    result,
    [
      '## Quotes',
      '',
      'No dealer quotes logged yet.',
      '`- id: <id> | configuration: <id> | ...`',
      '- id: q1 | configuration: c1 | value: 1',
      '',
      '## Incentives',
    ].join('\n')
  );
});

test('appendQuoteLine appends at end of file when the Quotes section is the last section', () => {
  const text = ['## Quotes', '- id: q1 | configuration: c1 | value: 1'].join('\n');
  const result = appendQuoteLine(text, '- id: q2 | configuration: c1 | value: 2');
  assert.equal(result, ['## Quotes', '- id: q1 | configuration: c1 | value: 1', '- id: q2 | configuration: c1 | value: 2'].join('\n'));
});

test('appendQuoteLine creates a Quotes section at the end of the file if one is missing entirely', () => {
  const text = ['## Cars', '- id: cx90 | make: Mazda | model: CX-90'].join('\n');
  const result = appendQuoteLine(text, '- id: q1 | configuration: c1 | value: 1');
  assert.equal(result, '## Cars\n- id: cx90 | make: Mazda | model: CX-90\n\n## Quotes\n- id: q1 | configuration: c1 | value: 1\n');
});

// --- submitQuote: the full read-validate-write cycle ----------------------

function fixtureTracker() {
  return ['## Cars', '- id: cx90 | make: Mazda | model: CX-90', '## Configurations', '- id: c1 | car: cx90 | year: 2026 | trim: Preferred | condition: new', '## Quotes'].join(
    '\n'
  );
}

test('submitQuote writes an atomically-appended line and leaves no temp file behind', async () => {
  const root = tempDataRoot(fixtureTracker());
  const result = await submitQuote(root, { configuration: 'c1', value: 42000, dealer: 'Smith Mazda', note: '' }, new Date('2026-09-22T12:00:00Z'));
  assert.deepEqual(result, { ok: true });

  const content = fs.readFileSync(path.join(root, 'tracker.md'), 'utf8');
  assert.match(content, /- id: q1 \| configuration: c1 \| value: 42000 \| dealer: Smith Mazda \| quoted: 2026-09-22 \| note: $/m);

  const leftover = fs.readdirSync(root).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftover, []);
});

test('submitQuote rejects an unknown configuration id and writes nothing', async () => {
  const root = tempDataRoot(fixtureTracker());
  const before = fs.readFileSync(path.join(root, 'tracker.md'), 'utf8');
  const result = await submitQuote(root, { configuration: 'does-not-exist', value: 100, dealer: 'X' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.configuration);
  assert.equal(fs.readFileSync(path.join(root, 'tracker.md'), 'utf8'), before);
});

test('submitQuote rejects an adversarial dealer field and the attempted injection never reaches the file', async () => {
  const root = tempDataRoot(fixtureTracker());
  const before = fs.readFileSync(path.join(root, 'tracker.md'), 'utf8');
  const result = await submitQuote(root, {
    configuration: 'c1',
    value: 100,
    dealer: 'Evil Motors\n## Incentives\n- id: fake | car: cx90 | headline: FAKE | expires: 2099-01-01',
  });
  assert.equal(result.ok, false);
  const after = fs.readFileSync(path.join(root, 'tracker.md'), 'utf8');
  assert.equal(after, before);
  assert.ok(!after.includes('FAKE'));
});

test('submitQuote reports a missing data file rather than throwing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quotes-missing-'));
  const result = await submitQuote(root, { configuration: 'c1', value: 100, dealer: 'X' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.form);
});

test('two near-simultaneous submissions are serialized: both are written, with distinct ids, nothing lost', async () => {
  const root = tempDataRoot(fixtureTracker());
  const [a, b] = await Promise.all([
    submitQuote(root, { configuration: 'c1', value: 100, dealer: 'Dealer A' }),
    submitQuote(root, { configuration: 'c1', value: 200, dealer: 'Dealer B' }),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);

  const content = fs.readFileSync(path.join(root, 'tracker.md'), 'utf8');
  const quoteLines = content.split('\n').filter((l) => l.startsWith('- id: q'));
  assert.equal(quoteLines.length, 2);
  const ids = quoteLines.map((l) => /id: (q\d+)/.exec(l)[1]);
  assert.deepEqual(new Set(ids).size, 2);
  assert.ok(content.includes('Dealer A'));
  assert.ok(content.includes('Dealer B'));
});
