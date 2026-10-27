import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { insertSectionLines, replaceRecordLine, atomicWrite } from '../lib/tracker-sections.js';

// --- insertSectionLines --------------------------------------------------

test('insertSectionLines appends at the end of an existing section, before the next heading', () => {
  const text = ['## Cars', '- id: cx90 | make: Mazda', '## Configurations', '- id: c1'].join('\n');
  const result = insertSectionLines(text, 'Cars', ['- id: kia1 | make: Kia']);
  assert.equal(
    result,
    ['## Cars', '- id: cx90 | make: Mazda', '- id: kia1 | make: Kia', '## Configurations', '- id: c1'].join('\n')
  );
});

test('insertSectionLines skips trailing blank lines before the next heading', () => {
  const text = ['## Cars', '- id: cx90 | make: Mazda', '', '## Configurations'].join('\n');
  const result = insertSectionLines(text, 'Cars', ['- id: kia1 | make: Kia']);
  assert.equal(result, ['## Cars', '- id: cx90 | make: Mazda', '- id: kia1 | make: Kia', '', '## Configurations'].join('\n'));
});

test('insertSectionLines appends at end of file when the section is the last one', () => {
  const text = ['## Cars', '- id: cx90 | make: Mazda'].join('\n');
  const result = insertSectionLines(text, 'Cars', ['- id: kia1 | make: Kia']);
  assert.equal(result, ['## Cars', '- id: cx90 | make: Mazda', '- id: kia1 | make: Kia'].join('\n'));
});

test('insertSectionLines creates the section at end of file if missing entirely', () => {
  const text = ['## Cars', '- id: cx90 | make: Mazda'].join('\n');
  const result = insertSectionLines(text, 'Configurations', ['- id: c1 | car: cx90']);
  assert.equal(result, '## Cars\n- id: cx90 | make: Mazda\n\n## Configurations\n- id: c1 | car: cx90\n');
});

test('insertSectionLines is a no-op for an empty lines array', () => {
  const text = ['## Cars', '- id: cx90 | make: Mazda'].join('\n');
  assert.equal(insertSectionLines(text, 'Cars', []), text);
});

test('insertSectionLines matches the section heading case-insensitively', () => {
  const text = ['## cars', '- id: cx90 | make: Mazda'].join('\n');
  const result = insertSectionLines(text, 'Cars', ['- id: kia1 | make: Kia']);
  assert.equal(result, ['## cars', '- id: cx90 | make: Mazda', '- id: kia1 | make: Kia'].join('\n'));
});

test('insertSectionLines never touches a different section with a similarly-named heading', () => {
  const text = ['## Cars', '- id: cx90 | make: Mazda', '## Configurations', '- id: c1'].join('\n');
  const result = insertSectionLines(text, 'Configurations', ['- id: c2']);
  assert.equal(result, ['## Cars', '- id: cx90 | make: Mazda', '## Configurations', '- id: c1', '- id: c2'].join('\n'));
});

// --- replaceRecordLine ----------------------------------------------------

test('replaceRecordLine replaces only the matching id line inside the named section', () => {
  const text = ['## Cars', '- id: cx90 | make: Mazda', '- id: kia1 | make: Kia', '## Configurations', '- id: cx90-1'].join('\n');
  const { text: result, found } = replaceRecordLine(text, 'Cars', 'kia1', '- id: kia1 | make: Kia Motors');
  assert.equal(found, true);
  assert.equal(result, ['## Cars', '- id: cx90 | make: Mazda', '- id: kia1 | make: Kia Motors', '## Configurations', '- id: cx90-1'].join('\n'));
});

test('replaceRecordLine reports found: false and leaves text untouched when the id is not in that section', () => {
  const text = ['## Cars', '- id: cx90 | make: Mazda', '## Configurations', '- id: c1'].join('\n');
  const { text: result, found } = replaceRecordLine(text, 'Cars', 'does-not-exist', '- id: does-not-exist | make: Forged');
  assert.equal(found, false);
  assert.equal(result, text);
});

test('replaceRecordLine never matches an id that only appears in a different section', () => {
  // A Configuration with id "cx90" existing alongside a Car with the same id must not cross-match.
  const text = ['## Cars', '- id: cx90 | make: Mazda', '## Configurations', '- id: cx90 | car: cx90'].join('\n');
  const { found } = replaceRecordLine(text, 'Configurations', 'cx90', '- id: cx90 | car: forged');
  assert.equal(found, true);
  const { text: result } = replaceRecordLine(text, 'Configurations', 'cx90', '- id: cx90 | car: forged');
  // The Cars section line must be untouched.
  assert.ok(result.includes('- id: cx90 | make: Mazda'));
  assert.ok(result.includes('- id: cx90 | car: forged'));
});

// --- atomicWrite ------------------------------------------------------

test('atomicWrite writes the file and leaves no temp file behind', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-sections-'));
  const target = path.join(dir, 'tracker.md');
  await atomicWrite(target, 'hello world');
  assert.equal(fs.readFileSync(target, 'utf8'), 'hello world');
  const leftover = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftover, []);
});
