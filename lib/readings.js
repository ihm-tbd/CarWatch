// Recording a check cycle's readings (requirement 004, stage 4c: "adaptation
// 1" — checks are manual, there is no fetcher, ever). Ian reads Stella's
// findings and types the numbers in; this module validates and writes them
// as new PricePoint records, one per variant (Configuration) that got a
// reading this cycle. A blank value on a variant means "no reading this
// cycle", not zero — that variant is simply skipped, never written.
//
// This is the write path that touches price data — "the most valuable data
// in the app" (requirement 004, "Security notes"). The whole submission
// either lands or doesn't: every reading is validated before any of them are
// written, and the file is only ever touched once, after every reading in
// the cycle has passed. A half-written cycle (some variants updated, others
// not, because one row failed halfway through) would corrupt the trend by
// making it look like a real check happened when it didn't.
//
// Same field-injection defense as lib/quotes.js, lib/cars.js and
// lib/trims.js: tracker.md is `|`-delimited with no escape syntax, so
// source text — long, free-form, and the field most likely to be pasted in
// from somewhere else — is rejected outright on "|" or a newline, never
// stripped.

import fsp from 'node:fs/promises';
import { safeJoin, PathTraversalError } from './safe-path.js';
import { parseTracker } from './parse-tracker.js';
import { buildCarLine } from './cars.js';
import { insertSectionLines, replaceRecordLine, atomicWrite } from './tracker-sections.js';
import { serialize } from './write-queue.js';

const MAX_VALUE = 500000;
const MAX_SOURCE_LEN = 500;
const MAX_NOTE_LEN = 500;
const MAX_SAMPLE_SIZE = 1000000;
const MAX_READINGS = 100;

const FORBIDDEN_CHARS_RE = /[|\r\n]/;
const VALID_BASES = new Set(['msrp', 'listing', 'listing_average', 'valuation_estimate']);

function parseAmount(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const cleaned = String(raw).replace(/[$,]/g, '').trim();
  if (cleaned === '' || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const amount = Number(cleaned);
  return Number.isFinite(amount) ? amount : null;
}

function parsePositiveIntOrNull(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const cleaned = String(raw).replace(/,/g, '').trim();
  if (!/^\d+$/.test(cleaned)) return undefined; // undefined signals "invalid", distinct from "not given"
  const n = Number.parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : undefined;
}

// yes/no/true/false, all accepted since the client sends a checkbox's
// boolean but a hand-built request might send the file's own "yes"/"no"
// vocabulary — both are treated as unambiguous rather than guessed at.
function parseConfirmed(raw) {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    if (v === 'yes' || v === 'true') return true;
    if (v === 'no' || v === 'false') return false;
  }
  return undefined;
}

function todayUtc(now) {
  return now.toISOString().slice(0, 10);
}

// Validates one row of the form. Returns `{ skip: true }` when the value is
// blank — "no reading this cycle" — before touching any other field, since
// a skipped variant's basis/source/etc. are irrelevant and must not be
// required. Otherwise returns `{ errors, clean }`, mirroring every other
// validator in this app.
function validateOneReading(raw, configurationIds) {
  const item = raw && typeof raw === 'object' ? raw : {};
  const errors = {};

  const configuration = typeof item.configuration === 'string' ? item.configuration.trim() : '';
  if (!configuration) {
    errors.configuration = 'Missing variant.';
  } else if (!configurationIds.has(configuration)) {
    errors.configuration = 'That variant was not found — reload the page and try again.';
  }

  const valueRaw = item.value;
  const valueBlank = valueRaw === undefined || valueRaw === null || String(valueRaw).trim() === '';
  if (valueBlank) {
    // A variant can only be cleanly skipped when its own id is otherwise
    // valid — an invalid/forged configuration id is still reported, never
    // silently dropped as if it were a normal skip.
    if (Object.keys(errors).length > 0) return { errors };
    return { skip: true };
  }

  const value = parseAmount(valueRaw);
  if (value === null) {
    errors.value = 'Enter a number.';
  } else if (value <= 0) {
    errors.value = 'Value must be greater than zero.';
  } else if (value > MAX_VALUE) {
    errors.value = `Value must be ${MAX_VALUE.toLocaleString()} or less.`;
  }

  const basis = typeof item.basis === 'string' ? item.basis.trim().toLowerCase() : '';
  if (!VALID_BASES.has(basis)) {
    errors.basis = 'Choose a basis.';
  }

  const source = typeof item.source === 'string' ? item.source.trim() : '';
  if (!source) {
    errors.source = 'Enter a source.';
  } else if (source.length > MAX_SOURCE_LEN) {
    errors.source = `Keep the source under ${MAX_SOURCE_LEN} characters.`;
  } else if (FORBIDDEN_CHARS_RE.test(source)) {
    errors.source = 'Source can’t contain a "|" or a line break.';
  }

  const confirmed = parseConfirmed(item.confirmed);
  if (confirmed === undefined) {
    errors.confirmed = 'Say whether this reading is confirmed.';
  }

  const sampleSize = parsePositiveIntOrNull(item.sampleSize);
  if (sampleSize === undefined) {
    errors.sampleSize = 'Sample size must be a whole number.';
  } else if (sampleSize !== null && sampleSize > MAX_SAMPLE_SIZE) {
    errors.sampleSize = 'That sample size is too large.';
  }

  const rangeLowRaw = item.rangeLow;
  const rangeHighRaw = item.rangeHigh;
  const rangeLowBlank = rangeLowRaw === undefined || rangeLowRaw === null || String(rangeLowRaw).trim() === '';
  const rangeHighBlank = rangeHighRaw === undefined || rangeHighRaw === null || String(rangeHighRaw).trim() === '';
  const rangeLow = rangeLowBlank ? null : parseAmount(rangeLowRaw);
  const rangeHigh = rangeHighBlank ? null : parseAmount(rangeHighRaw);
  if (!rangeLowBlank && rangeLow === null) errors.rangeLow = 'Enter a number.';
  if (!rangeHighBlank && rangeHigh === null) errors.rangeHigh = 'Enter a number.';
  if (rangeLow !== null && rangeHigh !== null && rangeLow > rangeHigh) {
    errors.rangeHigh = 'The high end of the range must be at least the low end.';
  }

  // "Plus sample size and range where the basis is an average" (requirement
  // 004) — an average without either is a number with no honest account of
  // where it came from, the exact failure mode this whole feature exists to
  // avoid.
  if (basis === 'listing_average') {
    if (sampleSize === null) errors.sampleSize = 'Enter a sample size for an average.';
    if (rangeLow === null) errors.rangeLow = 'Enter the low end of the range for an average.';
    if (rangeHigh === null) errors.rangeHigh = 'Enter the high end of the range for an average.';
  }

  const note = typeof item.note === 'string' ? item.note.trim() : '';
  if (note.length > MAX_NOTE_LEN) {
    errors.note = `Keep the note under ${MAX_NOTE_LEN} characters.`;
  } else if (FORBIDDEN_CHARS_RE.test(note)) {
    errors.note = 'Note can’t contain a "|" or a line break.';
  }

  if (Object.keys(errors).length > 0) return { errors };

  return {
    clean: { configuration, value, basis, source, confirmed, sampleSize, rangeLow, rangeHigh, note },
  };
}

// Pure validator — no I/O. `cars` and `configurationIds` are the file's
// actual current state, so a stale or forged carId/configuration id is
// rejected server-side rather than trusted from the client, same rule every
// other write path in this app applies.
export function validateReadingsSubmission(input, cars, configurationIds) {
  const raw = input && typeof input === 'object' ? input : {};
  const errors = {};

  const carId = typeof raw.carId === 'string' ? raw.carId.trim() : '';
  let car = null;
  if (!carId) {
    errors.form = 'Choose a car.';
  } else {
    car = (Array.isArray(cars) ? cars : []).find((c) => c.id === carId) ?? null;
    if (!car) errors.form = 'That car was not found — reload the page and try again.';
  }

  const readingsRaw = Array.isArray(raw.readings) ? raw.readings : null;
  if (!readingsRaw) {
    errors.form = errors.form ?? 'No readings were submitted.';
    return { errors, clean: null };
  }
  if (readingsRaw.length > MAX_READINGS) {
    errors.form = `Too many readings in one submission (max ${MAX_READINGS}).`;
    return { errors, clean: null };
  }

  if (Object.keys(errors).length > 0) return { errors, clean: null };

  const rowErrors = {};
  const clean = [];
  const seenConfigs = new Set();

  readingsRaw.forEach((item, i) => {
    const key = typeof item?.configuration === 'string' ? item.configuration.trim() : `#${i}`;
    const result = validateOneReading(item, configurationIds);
    if (result.skip) return;
    if (result.errors) {
      rowErrors[key] = result.errors;
      return;
    }
    if (seenConfigs.has(result.clean.configuration)) {
      rowErrors[key] = { configuration: 'That variant appears twice in this submission.' };
      return;
    }
    seenConfigs.add(result.clean.configuration);
    clean.push(result.clean);
  });

  if (Object.keys(rowErrors).length > 0) {
    return { errors: { readings: rowErrors }, clean: null };
  }

  if (clean.length === 0) {
    return { errors: { form: 'Enter at least one reading before saving this check.' }, clean: null };
  }

  return { errors: {}, clean: { carId, car, readings: clean } };
}

export function buildPricePointLine({ id, configuration, value, basis, sampleSize, rangeLow, rangeHigh, source, confirmed, observed, note }) {
  return `- id: ${id} | configuration: ${configuration} | value: ${value} | basis: ${basis} | destination: | sample_size: ${sampleSize ?? ''} | range_low: ${rangeLow ?? ''} | range_high: ${rangeHigh ?? ''} | source: ${source} | source_url: | confirmed: ${confirmed ? 'yes' : 'no'} | observed: ${observed} | note: ${note ?? ''}`;
}

// Next id following the file's existing `pp<N>` convention (see
// data/tracker.md). Returns the current max as a number so a caller writing
// several new price points in one submission can keep incrementing from it
// without re-scanning the file between each one.
export function nextPricePointNumber(existingPricePoints) {
  let max = 0;
  for (const p of existingPricePoints) {
    const match = /^pp(\d+)$/.exec(String(p.id ?? ''));
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

export function submitReadings(dataRoot, input, now = new Date()) {
  return serialize(() => submitReadingsLocked(dataRoot, input, now));
}

async function submitReadingsLocked(dataRoot, input, now) {
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

  // Configurations belonging to any car are eligible — not just the
  // requested car's — but validateReadingsSubmission is passed the file's
  // full car list, and every reading's configuration id is checked against
  // the full set below, so a reading submitted for a different car's
  // configuration than `carId` names is still refused (it can't belong to
  // this cycle).
  const configurationIds = new Set(
    parsed.configurations.filter((c) => !c.archived).map((c) => c.id)
  );

  const { errors, clean } = validateReadingsSubmission(input, parsed.cars, configurationIds);
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  // Belt and suspenders: every submitted reading's configuration must
  // actually belong to the named car, even though its id was already
  // checked against the whole file's configuration set above — a forged
  // request naming a real configuration id that belongs to a *different*
  // car must still be refused rather than silently recording a reading in
  // the wrong place.
  const configsById = new Map(parsed.configurations.map((c) => [c.id, c]));
  for (const reading of clean.readings) {
    const config = configsById.get(reading.configuration);
    if (!config || config.car !== clean.car.id) {
      return {
        ok: false,
        errors: { readings: { [reading.configuration]: { configuration: 'That variant does not belong to this watch.' } } },
      };
    }
  }

  const observed = todayUtc(now);
  let nextNum = nextPricePointNumber(parsed.pricePoints);
  const newLines = clean.readings.map((reading) => {
    nextNum += 1;
    return buildPricePointLine({
      id: `pp${nextNum}`,
      configuration: reading.configuration,
      value: reading.value,
      basis: reading.basis,
      sampleSize: reading.sampleSize,
      rangeLow: reading.rangeLow,
      rangeHigh: reading.rangeHigh,
      source: reading.source,
      confirmed: reading.confirmed,
      observed,
      note: reading.note,
    });
  });

  const updatedCar = { ...clean.car, lastCheckedAt: observed };
  const { text: afterCar, found: carFound } = replaceRecordLine(content, 'Cars', updatedCar.id, buildCarLine(updatedCar));
  if (!carFound) return { ok: false, errors: { form: 'Could not find this car’s record to update.' } };

  const updated = insertSectionLines(afterCar, 'Price points', newLines);

  await atomicWrite(target, updated);
  return { ok: true, count: clean.readings.length };
}
