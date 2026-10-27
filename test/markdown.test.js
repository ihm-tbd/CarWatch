import { test } from 'node:test';
import assert from 'node:assert/strict';

import { escapeHtml, renderInline } from '../lib/markdown.js';

test('escapes HTML special characters', () => {
  assert.equal(
    escapeHtml('<script>alert(1)</script>'),
    '&lt;script&gt;alert(1)&lt;/script&gt;'
  );
});

test('renders bold and code without ever letting raw HTML through', () => {
  const result = renderInline('**bold** and `code` but <img onerror=alert(1)>');
  assert.equal(
    result,
    '<strong>bold</strong> and <code>code</code> but &lt;img onerror=alert(1)&gt;'
  );
});

test('handles null/undefined input without throwing', () => {
  assert.equal(escapeHtml(undefined), '');
  assert.equal(renderInline(null), '');
});
