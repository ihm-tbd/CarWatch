// The app's only write path (requirement 003, stage 3): validating and
// appending a user-entered Quote to data/tracker.md. Every acceptance
// criterion under "Security notes" in
// docs/requirements/003-car-tracker-v2-detail.md is implemented here or in
// server.js's POST /quotes handler — see the module comment there for the
// Origin/header checks, which happen before any of this runs.
//
// Field injection is the main risk: tracker.md is `|`-delimited with one
// record per line, and lib/parse-tracker.js has no escape syntax. A dealer
// name or note containing "|" could forge extra fields; one containing a
// newline could forge an entire extra record (even a fake `## Incentives`
// section). Both are rejected outright — not escaped — because there is no
// unescaping step on the read side to pair it with, and a silent
// transformation of what the user typed would violate "loses nothing the
// user typed" as much as a silent rejection would.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { safeJoin, PathTraversalError } from './safe-path.js';
import { parseTracker } from './parse-tracker.js';
import { serialize } from './write-queue.js';

const MAX_VALUE = 500000;
const MAX_DEALER_LEN = 200;
const MAX_NOTE_LEN = 500;

// Both characters that give tracker.md its structure. Anything containing
// either is refused, whole-quote, with a field-level error — never
// stripped or replaced, so the rejection is visible and the user knows
// exactly what to remove.
const FORBIDDEN_CHARS_RE = /[|\r\n]/;

const SECTION_RE = /^##\s+(.*)$/;

function parseAmount(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const cleaned = String(raw).replace(/[$,]/g, '').trim();
  if (cleaned === '' || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const amount = Number(cleaned);
  return Number.isFinite(amount) ? amount : null;
}

function todayUtc(now) {
  return now.toISOString().slice(0, 10);
}

// Pure validator — no I/O. `configurationIds` is the set of Configuration
// ids that actually exist in the current file, so a stale or invented id
// (the browser's copy of the page going stale, or a direct forged request)
// is rejected server-side rather than trusted from the client.
export function validateQuote(input, configurationIds) {
  const raw = input && typeof input === 'object' ? input : {};
  const errors = {};

  const configuration = typeof raw.configuration === 'string' ? raw.configuration.trim() : '';
  if (!configuration) {
    errors.configuration = 'Choose a configuration.';
  } else if (!(configurationIds instanceof Set ? configurationIds.has(configuration) : false)) {
    errors.configuration = 'That configuration was not found — reload the page and try again.';
  }

  const value = parseAmount(raw.value);
  if (value === null) {
    errors.value = 'Enter a number.';
  } else if (value <= 0) {
    errors.value = 'Value must be greater than zero.';
  } else if (value > MAX_VALUE) {
    errors.value = `Value must be ${MAX_VALUE.toLocaleString()} or less.`;
  }

  const dealer = typeof raw.dealer === 'string' ? raw.dealer.trim() : '';
  if (!dealer) {
    errors.dealer = 'Enter a dealer name.';
  } else if (dealer.length > MAX_DEALER_LEN) {
    errors.dealer = `Keep the dealer name under ${MAX_DEALER_LEN} characters.`;
  } else if (FORBIDDEN_CHARS_RE.test(dealer)) {
    errors.dealer = 'Dealer name can’t contain a "|" or a line break.';
  }

  const note = typeof raw.note === 'string' ? raw.note.trim() : '';
  if (note.length > MAX_NOTE_LEN) {
    errors.note = `Keep the note under ${MAX_NOTE_LEN} characters.`;
  } else if (FORBIDDEN_CHARS_RE.test(note)) {
    errors.note = 'Note can’t contain a "|" or a line break.';
  }

  return { errors, clean: { configuration, value, dealer, note } };
}

export function buildQuoteLine({ id, configuration, value, dealer, quoted, note }) {
  return `- id: ${id} | configuration: ${configuration} | value: ${value} | dealer: ${dealer} | quoted: ${quoted} | note: ${note}`;
}

// Next id following the file's existing `q<N>` convention (see
// README.md's worked example) — plain incrementing integers, not a
// timestamp or random string, so the file stays easy to hand-read. Falls
// back to q1 when there are no numbered quote ids yet.
export function nextQuoteId(existingQuotes) {
  let max = 0;
  for (const q of existingQuotes) {
    const match = /^q(\d+)$/.exec(String(q.id ?? ''));
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `q${max + 1}`;
}

// Inserts `line` at the end of the "## Quotes" section (before the next
// `##` heading, or end of file), trimming back over trailing blank lines
// so the new line sits right after the section's existing content rather
// than after a blank gap. Creates the section at the end of the file if
// it's missing entirely. Pure string transform — no I/O — so it's cheap
// to test exhaustively against odd section layouts.
export function appendQuoteLine(text, line) {
  const lines = text.split(/\r?\n/);
  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].trim().match(SECTION_RE);
    if (heading && heading[1].trim().toLowerCase() === 'quotes') {
      headingIdx = i;
      break;
    }
  }

  if (headingIdx === -1) {
    const trimmed = text.replace(/\s+$/, '');
    return `${trimmed}\n\n## Quotes\n${line}\n`;
  }

  let endIdx = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (SECTION_RE.test(lines[i].trim())) {
      endIdx = i;
      break;
    }
  }

  let insertAt = endIdx;
  while (insertAt > headingIdx + 1 && lines[insertAt - 1].trim() === '') insertAt--;

  lines.splice(insertAt, 0, line);
  return lines.join('\n');
}

// Temp-file-then-rename so a process killed mid-write can never leave
// tracker.md truncated or half-written — the rename is atomic on the same
// filesystem, and until it completes the original file is untouched.
async function atomicWrite(target, content) {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.tracker.md.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  await fsp.writeFile(tmp, content, 'utf8');
  await fsp.rename(tmp, target);
}

// Serializes every write to tracker.md through lib/write-queue.js's one
// shared chain (requirement 004: this stopped being the app's only write
// path once lib/cars.js and lib/trims.js arrived, and two different
// endpoints racing on the same read-validate-write cycle would be the same
// lost-update hazard a single quotes-only queue used to prevent). A
// single-process in-memory queue is enough here because this Node process
// is the only writer of tracker.md there will ever be.
export function submitQuote(dataRoot, input, now = new Date()) {
  return serialize(() => submitQuoteLocked(dataRoot, input, now));
}

async function submitQuoteLocked(dataRoot, input, now) {
  let target;
  try {
    target = safeJoin(dataRoot, 'tracker.md');
  } catch (err) {
    if (err instanceof PathTraversalError) {
      return { ok: false, errors: { form: 'Refused to write outside the data directory.' } };
    }
    throw err;
  }

  let content;
  try {
    content = await fsp.readFile(target, 'utf8');
  } catch {
    return { ok: false, errors: { form: 'tracker.md could not be read.' } };
  }

  let parsed;
  try {
    parsed = parseTracker(content);
  } catch {
    return { ok: false, errors: { form: 'tracker.md could not be parsed.' } };
  }

  const configurationIds = new Set(parsed.configurations.map((c) => c.id));
  const { errors, clean } = validateQuote(input, configurationIds);
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  const line = buildQuoteLine({
    id: nextQuoteId(parsed.quotes),
    configuration: clean.configuration,
    value: clean.value,
    dealer: clean.dealer,
    quoted: todayUtc(now),
    note: clean.note,
  });

  const updated = appendQuoteLine(content, line);
  await atomicWrite(target, updated);
  return { ok: true };
}
