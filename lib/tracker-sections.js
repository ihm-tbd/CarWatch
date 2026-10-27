// Shared, low-level line-editing primitives for tracker.md's `## Section`
// / `- id: ... | ...` format (requirement 004, stages 4b+: lib/cars.js and
// lib/trims.js both need to append new records and rewrite existing ones).
// Every function here treats the file as plain text lines and only ever
// touches the specific line(s) it's asked to — a section's prose, blank
// lines, and every other section are carried through byte-for-byte. There
// is no general re-serialization of the whole file, on purpose: tracker.md
// carries hand-written comments above each section that a full parse/
// rebuild would have no way to preserve.

import fsp from 'node:fs/promises';
import path from 'node:path';

const SECTION_RE = /^##\s+(.*)$/;
const ITEM_RE = /^-\s+(.*)$/;
const ID_FIELD_RE = /(?:^|\|)\s*id:\s*([^|]*)/;

function itemId(itemText) {
  const match = ID_FIELD_RE.exec(itemText);
  return match ? match[1].trim() : null;
}

// Appends `lines` at the end of the named section's existing content
// (before the next `##` heading, or end of file), trimming back over
// trailing blank lines the same way lib/quotes.js#appendQuoteLine does.
// Creates the section at the end of the file if it doesn't exist yet.
export function insertSectionLines(text, sectionName, lines) {
  if (lines.length === 0) return text;
  const body = text.split(/\r?\n/);
  const target = sectionName.trim().toLowerCase();
  let headingIdx = -1;
  for (let i = 0; i < body.length; i++) {
    const heading = body[i].trim().match(SECTION_RE);
    if (heading && heading[1].trim().toLowerCase() === target) {
      headingIdx = i;
      break;
    }
  }

  if (headingIdx === -1) {
    const trimmed = text.replace(/\s+$/, '');
    return `${trimmed}\n\n## ${sectionName}\n${lines.join('\n')}\n`;
  }

  let endIdx = body.length;
  for (let i = headingIdx + 1; i < body.length; i++) {
    if (SECTION_RE.test(body[i].trim())) {
      endIdx = i;
      break;
    }
  }

  let insertAt = endIdx;
  while (insertAt > headingIdx + 1 && body[insertAt - 1].trim() === '') insertAt--;

  body.splice(insertAt, 0, ...lines);
  return body.join('\n');
}

// Finds the `- id: <id> | ...` line for `id` inside the named section and
// replaces the whole line with `newLine`. Returns `{ text, found }` —
// callers must check `found`, since a stale or forged id must never be
// silently ignored (it means the client's copy of the record is out of
// date, or the request was forged). Only the exact matching line changes;
// nothing else in the file moves.
export function replaceRecordLine(text, sectionName, id, newLine) {
  const body = text.split(/\r?\n/);
  const target = sectionName.trim().toLowerCase();
  let section = null;
  let found = false;

  for (let i = 0; i < body.length; i++) {
    const line = body[i].trim();
    const heading = line.match(SECTION_RE);
    if (heading) {
      section = heading[1].trim().toLowerCase();
      continue;
    }
    if (section !== target) continue;
    const item = line.match(ITEM_RE);
    if (!item) continue;
    if (itemId(item[1]) === id) {
      body[i] = newLine;
      found = true;
      break;
    }
  }

  return { text: body.join('\n'), found };
}

// Temp-file-then-rename so a process killed mid-write can never leave
// tracker.md truncated or half-written — same technique and reasoning as
// lib/quotes.js#atomicWrite, duplicated here rather than imported since
// that function isn't exported (this module is quotes.js's sibling, not
// its dependent).
export async function atomicWrite(target, content) {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.tracker.md.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  await fsp.writeFile(tmp, content, 'utf8');
  await fsp.rename(tmp, target);
}
