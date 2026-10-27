// Trim editing on the detail screen (requirement 004, stage 4b): the write
// path around lib/archive.js's pure archiveTrim/restoreTrim, plus adding a
// trim that never existed on this watch before. "A trim belongs to the
// watch, not to a model year" — both directions apply across every model
// year at once.
//
// Archiving is still a write, and a forged request is a real loss of
// access to data (requirement 004, "Security notes") — validated with the
// same rigor as a create: carId and trim are checked against the file's
// actual current state (never trusted from the client alone), free text
// is rejected for "|"/newline the same way lib/quotes.js and lib/cars.js
// reject it, and the write is atomic.

import fsp from 'node:fs/promises';
import { safeJoin, PathTraversalError } from './safe-path.js';
import { parseTracker } from './parse-tracker.js';
import { archiveTrim, restoreTrim } from './archive.js';
import { buildCarLine, buildConfigurationLine, slugify, parseYearsRange } from './cars.js';
import { insertSectionLines, replaceRecordLine, atomicWrite } from './tracker-sections.js';
import { serialize } from './write-queue.js';

const MAX_TRIM_LEN = 60;
const FORBIDDEN_CHARS_RE = /[|\r\n]/;

// Pure validator — no I/O. `cars` is the file's actual current Car list,
// so a stale or forged carId (a page left open across an edit, or a
// forged request) is rejected server-side rather than trusted from the
// client, same rule lib/quotes.js applies to a configuration id.
export function validateTrimAction(input, cars) {
  const raw = input && typeof input === 'object' ? input : {};
  const errors = {};

  const carId = typeof raw.carId === 'string' ? raw.carId.trim() : '';
  let car = null;
  if (!carId) {
    errors.carId = 'Choose a car.';
  } else {
    car = (Array.isArray(cars) ? cars : []).find((c) => c.id === carId) ?? null;
    if (!car) errors.carId = 'That car was not found — reload the page and try again.';
  }

  const trim = typeof raw.trim === 'string' ? raw.trim.trim() : '';
  if (!trim) {
    errors.trim = 'Enter a trim.';
  } else if (trim.length > MAX_TRIM_LEN) {
    errors.trim = `Keep the trim under ${MAX_TRIM_LEN} characters.`;
  } else if (FORBIDDEN_CHARS_RE.test(trim)) {
    errors.trim = 'Trim can’t contain a "|" or a line break.';
  }

  return { errors, clean: { carId, trim, car } };
}

async function readAndParse(dataRoot) {
  let target;
  try {
    target = safeJoin(dataRoot, 'tracker.md');
  } catch (err) {
    if (err instanceof PathTraversalError) {
      return { error: { ok: false, errors: { form: 'Refused to write outside the data directory.' } } };
    }
    throw err;
  }

  let content;
  try {
    content = await fsp.readFile(target, 'utf8');
  } catch {
    return { error: { ok: false, errors: { form: 'tracker.md could not be read.' } } };
  }

  let parsed;
  try {
    parsed = parseTracker(content);
  } catch {
    return { error: { ok: false, errors: { form: 'tracker.md could not be parsed.' } } };
  }

  return { target, content, parsed };
}

// Rewrites the Car line and every affected Configuration line for one
// trim-level change. `configurations` is the already-updated full array
// (as returned by archiveTrim/restoreTrim); only lines for `car.id` +
// `trim` are ever touched, matching what those pure functions actually
// changed.
function writeCarAndTrimConfigs(content, car, configurations, trim) {
  const { text: afterCar, found: carFound } = replaceRecordLine(content, 'Cars', car.id, buildCarLine(car));
  if (!carFound) return { error: { ok: false, errors: { form: 'Could not find this car’s record to update.' } } };

  let updated = afterCar;
  for (const config of configurations) {
    if (config.car !== car.id || config.trim !== trim) continue;
    const { text, found } = replaceRecordLine(updated, 'Configurations', config.id, buildConfigurationLine(config));
    if (!found) {
      return { error: { ok: false, errors: { form: 'Could not find every configuration to update.' } } };
    }
    updated = text;
  }
  return { updated };
}

export function submitArchiveTrim(dataRoot, input, now = new Date()) {
  return serialize(() => submitArchiveTrimLocked(dataRoot, input));
}

async function submitArchiveTrimLocked(dataRoot, input) {
  const { error, target, content, parsed } = await readAndParse(dataRoot);
  if (error) return error;

  const { errors, clean } = validateTrimAction(input, parsed.cars);
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  if (!clean.car.trimsTracked.includes(clean.trim)) {
    return { ok: false, errors: { trim: 'That trim is not on this watch — reload the page and try again.' } };
  }

  const { car: updatedCar, configurations: updatedConfigs } = archiveTrim(clean.car, parsed.configurations, clean.trim);
  const { error: writeError, updated } = writeCarAndTrimConfigs(content, updatedCar, updatedConfigs, clean.trim);
  if (writeError) return writeError;

  await atomicWrite(target, updated);
  return { ok: true };
}

export function submitAddTrim(dataRoot, input, now = new Date()) {
  return serialize(() => submitAddTrimLocked(dataRoot, input));
}

async function submitAddTrimLocked(dataRoot, input) {
  const { error, target, content, parsed } = await readAndParse(dataRoot);
  if (error) return error;

  const { errors, clean } = validateTrimAction(input, parsed.cars);
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const car = clean.car;
  if (car.trimsTracked.includes(clean.trim)) {
    return { ok: false, errors: { trim: 'That trim is already on this watch.' } };
  }

  const existingConfigs = parsed.configurations.filter((c) => c.car === car.id && c.trim === clean.trim);

  // Case 1: this trim was on the watch before and every one of its
  // Configurations is archived — re-adding it restores that history
  // intact (requirement 004: "Re-adding a previously removed trim
  // restores its history intact"), never creates fresh, empty records.
  if (existingConfigs.length > 0 && existingConfigs.every((c) => c.archived)) {
    const { car: updatedCar, configurations: updatedConfigs } = restoreTrim(car, parsed.configurations, clean.trim);
    const { error: writeError, updated } = writeCarAndTrimConfigs(content, updatedCar, updatedConfigs, clean.trim);
    if (writeError) return writeError;
    await atomicWrite(target, updated);
    return { ok: true, restored: true };
  }

  // A live (non-archived) Configuration already exists for this trim
  // without the trim being listed in trimsTracked — an inconsistent file
  // state this app never produces itself; refuse rather than guess.
  if (existingConfigs.length > 0) {
    return { ok: false, errors: { trim: 'That trim already has records on this watch — reload the page and try again.' } };
  }

  // Case 2: a brand-new trim. New cars get MSRP and context, not a
  // build-up (requirement 004) — this creates Configuration rows with no
  // PricePoint, one per year this car already tracks (or, if it has none
  // yet, per year in its model-years range) times every condition the
  // watch is set to track.
  const existingYears = [...new Set(parsed.configurations.filter((c) => c.car === car.id).map((c) => c.year))];
  const yearList = existingYears.length ? existingYears : parseYearsRange(car.years).yearList;
  const conditions = Array.isArray(car.conditions) && car.conditions.length ? car.conditions : ['new'];

  const newConfigs = [];
  for (const year of yearList) {
    for (const condition of conditions) {
      newConfigs.push({
        id: `${car.id}-${year}-${slugify(clean.trim)}-${condition}`,
        car: car.id,
        year,
        trim: clean.trim,
        condition,
        archived: false,
      });
    }
  }

  const updatedCar = { ...car, trimsTracked: [...car.trimsTracked, clean.trim] };
  const { text: afterCar, found: carFound } = replaceRecordLine(content, 'Cars', updatedCar.id, buildCarLine(updatedCar));
  if (!carFound) return { ok: false, errors: { form: 'Could not find this car’s record to update.' } };

  let updated = afterCar;
  if (newConfigs.length) {
    updated = insertSectionLines(updated, 'Configurations', newConfigs.map(buildConfigurationLine));
  }

  await atomicWrite(target, updated);
  return { ok: true };
}
