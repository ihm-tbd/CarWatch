// Add Car (requirement 004, stage 4b): validating and writing a brand-new
// watch — a Car record plus, when the form gave both years and trims, one
// Configuration per year x trim x condition. No PricePoint is ever created
// here — "New cars get MSRP and context, not a build-up" (requirement
// 004): a freshly added watch has no price data until a reading is
// recorded (out of scope for this stage) or a trim is added later
// (lib/trims.js).
//
// Same field-injection defense as lib/quotes.js and the same reasoning:
// tracker.md is `|`-delimited with no escape syntax, so a make, model,
// trim or ZIP containing "|" or a newline could forge extra fields or a
// whole extra record (even a fake `## Configurations`/`## Incentives`
// heading) if it were allowed through. Rejected outright, never stripped.

import fsp from 'node:fs/promises';
import { safeJoin, PathTraversalError } from './safe-path.js';
import { parseTracker } from './parse-tracker.js';
import { archiveCar } from './archive.js';
import { insertSectionLines, replaceRecordLine, atomicWrite } from './tracker-sections.js';
import { serialize } from './write-queue.js';

const MAX_MAKE_LEN = 80;
const MAX_MODEL_LEN = 80;
const MAX_TRIM_LEN = 60;
const MAX_ZIP_LEN = 12;
const MAX_TRIMS = 20;
const MAX_YEAR_SPAN = 15;

const FORBIDDEN_CHARS_RE = /[|\r\n]/;
const YEAR_RANGE_RE = /^(\d{4})\s*[-–]\s*(\d{4})$/;
const YEAR_SINGLE_RE = /^(\d{4})$/;
const VALID_CONDITIONS = ['new', 'cpo', 'used'];

function todayUtc(now) {
  return now.toISOString().slice(0, 10);
}

export function slugify(text) {
  const slug = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'x';
}

// Parses the free-text "model years" field into a stored label plus the
// concrete list of years it spans. `years: null` (as opposed to `''`)
// signals an unrecognized format, distinct from "left blank" — callers
// must treat that as a validation error, not as "no years given".
export function parseYearsRange(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { years: '', yearList: [] };
  const range = YEAR_RANGE_RE.exec(value);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (start > end || end - start > MAX_YEAR_SPAN) return { years: null, yearList: [] };
    const yearList = [];
    for (let y = start; y <= end; y++) yearList.push(String(y));
    return { years: `${start}-${end}`, yearList };
  }
  const single = YEAR_SINGLE_RE.exec(value);
  if (single) return { years: single[1], yearList: [single[1]] };
  return { years: null, yearList: [] };
}

// Pure validator — no I/O. Existing car ids aren't needed here (a
// collision only affects id assignment, handled separately in
// nextCarId), so this never has to read the file to run.
export function validateNewCar(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const errors = {};

  const make = typeof raw.make === 'string' ? raw.make.trim() : '';
  if (!make) {
    errors.make = 'Enter a make.';
  } else if (make.length > MAX_MAKE_LEN) {
    errors.make = `Keep the make under ${MAX_MAKE_LEN} characters.`;
  } else if (FORBIDDEN_CHARS_RE.test(make)) {
    errors.make = 'Make can’t contain a "|" or a line break.';
  }

  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  if (!model) {
    errors.model = 'Enter a model.';
  } else if (model.length > MAX_MODEL_LEN) {
    errors.model = `Keep the model under ${MAX_MODEL_LEN} characters.`;
  } else if (FORBIDDEN_CHARS_RE.test(model)) {
    errors.model = 'Model can’t contain a "|" or a line break.';
  }

  const yearsRaw = typeof raw.years === 'string' ? raw.years.trim() : '';
  let years = '';
  let yearList = [];
  if (yearsRaw && FORBIDDEN_CHARS_RE.test(yearsRaw)) {
    errors.years = 'Model years can’t contain a "|" or a line break.';
  } else if (yearsRaw) {
    const parsed = parseYearsRange(yearsRaw);
    if (parsed.years === null) {
      errors.years = 'Enter a year or a range like 2025-2026.';
    } else {
      years = parsed.years;
      yearList = parsed.yearList;
    }
  }

  const zip = typeof raw.zip === 'string' ? raw.zip.trim() : '';
  if (zip.length > MAX_ZIP_LEN) {
    errors.zip = `Keep the ZIP under ${MAX_ZIP_LEN} characters.`;
  } else if (FORBIDDEN_CHARS_RE.test(zip)) {
    errors.zip = 'ZIP can’t contain a "|" or a line break.';
  }

  const trimsRawList = Array.isArray(raw.trims) ? raw.trims : [];
  const trims = [];
  if (trimsRawList.length > MAX_TRIMS) {
    errors.trims = `Keep it to ${MAX_TRIMS} trims or fewer.`;
  } else {
    const seen = new Set();
    for (const t of trimsRawList) {
      const trim = typeof t === 'string' ? t.trim() : '';
      if (!trim) continue;
      if (trim.length > MAX_TRIM_LEN) {
        errors.trims = `Keep each trim under ${MAX_TRIM_LEN} characters.`;
        break;
      }
      if (FORBIDDEN_CHARS_RE.test(trim)) {
        errors.trims = 'A trim name can’t contain a "|" or a line break.';
        break;
      }
      const key = trim.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        trims.push(trim);
      }
    }
  }

  const conditionsRawList = Array.isArray(raw.conditions) ? raw.conditions : [];
  const conditionsRawSet = new Set(
    conditionsRawList.map((c) => (typeof c === 'string' ? c.trim().toLowerCase() : ''))
  );
  const conditions = VALID_CONDITIONS.filter((c) => conditionsRawSet.has(c));
  if (conditions.length === 0) errors.conditions = 'Choose at least one condition.';

  return { errors, clean: { make, model, years, yearList, zip, trims, conditions } };
}

// Next car id following the file's existing slug convention (see
// data/tracker.md's `cx90`) — `make-model`, lowercased and hyphenated,
// with a numeric suffix appended only on a collision.
export function nextCarId(existingIds, make, model) {
  const base = slugify(`${make}-${model}`);
  if (!existingIds.has(base)) return base;
  let n = 2;
  while (existingIds.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// Builds the plain Car + Configuration objects for a validated submission
// — same shape lib/parse-tracker.js produces, so lib/tracker-data.js's
// read path treats a freshly added car no differently from one that was
// hand-written into the file. Configurations are only generated when both
// a year list and at least one trim were given; an empty-trims watch
// ("empty means every trim") or a blank model-years field intentionally
// gets zero Configurations until a trim is added (lib/trims.js) or a
// reading is recorded.
export function buildNewCarRecord(clean, id, now) {
  const car = {
    id,
    make: clean.make,
    model: clean.model,
    years: clean.years,
    trimsTracked: clean.trims,
    conditions: clean.conditions,
    zip: clean.zip,
    created: todayUtc(now),
    checkIntervalDays: 14,
    lastCheckedAt: null,
    archived: false,
  };

  const configurations = [];
  if (clean.trims.length && clean.yearList.length) {
    for (const year of clean.yearList) {
      for (const trim of clean.trims) {
        for (const condition of clean.conditions) {
          configurations.push({
            id: `${id}-${year}-${slugify(trim)}-${condition}`,
            car: id,
            year,
            trim,
            condition,
            archived: false,
          });
        }
      }
    }
  }

  return { car, configurations };
}

// `archived` is only ever appended when true, the same convention
// buildConfigurationLine below already uses — every existing car line on
// file predates this field, so leaving it off when false means archiving
// one watch never rewrites lines for every other watch that already
// parses to `archived: false` by default (lib/parse-tracker.js).
export function buildCarLine(car) {
  const archivedPart = car.archived ? ' | archived: yes' : '';
  return `- id: ${car.id} | make: ${car.make} | model: ${car.model} | years: ${car.years} | trims: ${car.trimsTracked.join(', ')} | conditions: ${car.conditions.join(', ')} | zip: ${car.zip} | created: ${car.created ?? ''} | check_interval_days: ${car.checkIntervalDays} | last_checked: ${car.lastCheckedAt ?? ''}${archivedPart}`;
}

export function buildConfigurationLine(config) {
  const archivedPart = config.archived ? ' | archived: yes' : '';
  return `- id: ${config.id} | car: ${config.car} | year: ${config.year} | trim: ${config.trim} | condition: ${config.condition}${archivedPart}`;
}

export function submitNewCar(dataRoot, input, now = new Date()) {
  return serialize(() => submitNewCarLocked(dataRoot, input, now));
}

async function submitNewCarLocked(dataRoot, input, now) {
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

  const { errors, clean } = validateNewCar(input);
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  const existingIds = new Set(parsed.cars.map((c) => c.id));
  const id = nextCarId(existingIds, clean.make, clean.model);
  const { car, configurations } = buildNewCarRecord(clean, id, now);

  let updated = insertSectionLines(content, 'Cars', [buildCarLine(car)]);
  if (configurations.length) {
    updated = insertSectionLines(updated, 'Configurations', configurations.map(buildConfigurationLine));
  }

  await atomicWrite(target, updated);
  return { ok: true, carId: id };
}

// --- Archive a whole watch (requirement 004: "Removing a whole watch
// follows the same archive-and-confirm pattern, with the car's name and
// totals") -------------------------------------------------------------
//
// Same validation posture as lib/trims.js#validateTrimAction: carId is
// checked against the file's real, current Car list — never trusted from
// the client alone — since a forged archive request "would be a real loss
// of access to data" (requirement 004, "Security notes"). Archiving an
// already-archived watch is refused rather than silently accepted, the
// same "reload the page and try again" treatment every other stale/forged
// id gets elsewhere in this app.

export function validateArchiveCarInput(input, cars) {
  const raw = input && typeof input === 'object' ? input : {};
  const errors = {};

  const carId = typeof raw.carId === 'string' ? raw.carId.trim() : '';
  let car = null;
  if (!carId) {
    errors.carId = 'Choose a car.';
  } else {
    car = (Array.isArray(cars) ? cars : []).find((c) => c.id === carId) ?? null;
    if (!car) errors.carId = 'That car was not found — reload the page and try again.';
    else if (car.archived) errors.carId = 'That watch has already been removed — reload the page and try again.';
  }

  return { errors, clean: { carId, car } };
}

export function submitArchiveCar(dataRoot, input) {
  return serialize(() => submitArchiveCarLocked(dataRoot, input));
}

async function submitArchiveCarLocked(dataRoot, input) {
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

  const { errors, clean } = validateArchiveCarInput(input, parsed.cars);
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const updatedCar = archiveCar(clean.car);
  const { text: updated, found } = replaceRecordLine(content, 'Cars', updatedCar.id, buildCarLine(updatedCar));
  if (!found) return { ok: false, errors: { form: 'Could not find this car’s record to update.' } };

  await atomicWrite(target, updated);
  return { ok: true };
}
