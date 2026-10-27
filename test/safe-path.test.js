import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { safeJoin, PathTraversalError } from '../lib/safe-path.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'safe-path-'));
}

test('resolves a normal path inside the root', () => {
  const root = tempRoot();
  assert.equal(safeJoin(root, 'status.md'), path.join(root, 'status.md'));
});

test('resolves a nested path inside the root', () => {
  const root = tempRoot();
  assert.equal(
    safeJoin(root, 'requirements', '001-agent-dashboard.md'),
    path.join(root, 'requirements', '001-agent-dashboard.md')
  );
});

test('rejects relative traversal that escapes the root', () => {
  const root = tempRoot();
  assert.throws(() => safeJoin(root, '..', 'secret.txt'), PathTraversalError);
});

test('rejects deep relative traversal that escapes the root', () => {
  const root = tempRoot();
  assert.throws(
    () => safeJoin(root, 'requirements', '..', '..', 'etc', 'passwd'),
    PathTraversalError
  );
});

test('rejects an absolute path that replaces the root entirely', () => {
  const root = tempRoot();
  assert.throws(() => safeJoin(root, '/etc/passwd'), PathTraversalError);
});

test('does not reject the root itself', () => {
  const root = tempRoot();
  assert.equal(safeJoin(root), root);
});
