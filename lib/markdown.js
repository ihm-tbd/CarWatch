// Deliberately tiny, hand-rolled markdown handling for the limited
// formatting our docs actually use. Not a general-purpose parser.
//
// Everything is escaped first; the "markdown" step only ever re-introduces
// a fixed, safe set of tags around already-escaped text. There is no path
// by which raw HTML in a doc file (or in web-sourced content later) can
// reach the page unescaped.

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(input) {
  return String(input ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

// Supports **bold** and `code` only. Anything else — including literal
// angle brackets or stray asterisks — is shown as plain escaped text.
export function renderInline(input) {
  const escaped = escapeHtml(input);
  return escaped
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+?)`/g, '<code>$1</code>');
}
