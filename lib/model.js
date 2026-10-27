// Pure, testable data-model functions for Car Watch V2 (requirement 004,
// stage 1: "data model only"). No I/O, no rendering — everything here
// operates on plain arrays already produced by lib/parse-tracker.js. The
// UI and write endpoints that consume these land in later stages; they
// exist now so the rules can be exhaustively unit tested ahead of any
// caller — see docs/requirements/004-car-watch-v2.md.

import { DEFAULT_CHECK_INTERVAL_DAYS } from './parse-tracker.js';

export const DAY_MS = 24 * 60 * 60 * 1000;

// Exported for lib/trend-chart.js (stage 3): the chart's date math needs
// the exact same day-boundary rules the rest of the app already uses, so
// it imports these rather than keeping its own copy.
export function toUtcDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function toDateStr(utcMs) {
  return new Date(utcMs).toISOString().slice(0, 10);
}

// --- Check cadence -----------------------------------------------------

// The due date is derived — last check plus the interval — and never
// stored, so it can't drift from the values it comes from (requirement
// 004). Returns null when there's no last-checked date on file yet: a
// car nobody has checked under this system has no due date to show, not
// a guessed one.
export function dueDate(lastCheckedAt, checkIntervalDays) {
  if (!lastCheckedAt) return null;
  const days =
    Number.isFinite(checkIntervalDays) && checkIntervalDays > 0
      ? checkIntervalDays
      : DEFAULT_CHECK_INTERVAL_DAYS;
  return toDateStr(toUtcDay(lastCheckedAt) + days * DAY_MS);
}

// --- Trend eligibility ---------------------------------------------------

// A variant has a trend when its condition is CPO or used and it has at
// least two readings. New never has one — a new car's price is MSRP,
// which the manufacturer sets, and plotting a flat line would be a chart
// pretending to be information (requirement 004).
export function hasTrend(condition, readingCount) {
  return (
    (condition === 'used' || condition === 'cpo') &&
    Number.isInteger(readingCount) &&
    readingCount >= 2
  );
}

// --- Reading order ---------------------------------------------------------

// A stable, oldest-first order for one configuration's price points, for
// the chart to plot against (requirement 004: "Price points need a
// stable order for plotting later, via observed date"). Undated price
// points can't be placed on a timeline, so they sort after every dated
// one, keeping their original relative order among themselves — Node's
// Array#sort is a guaranteed-stable sort (ECMA-262 since ES2019), so two
// readings observed on the same date also keep file order rather than
// being reshuffled between runs.
export function orderedReadings(configId, pricePoints) {
  const forConfig = pricePoints.filter((p) => p.configuration === configId);
  const dated = forConfig.filter((p) => p.observed);
  const undated = forConfig.filter((p) => !p.observed);
  dated.sort((a, b) => toUtcDay(a.observed) - toUtcDay(b.observed));
  return [...dated, ...undated];
}

// --- Archive visibility ---------------------------------------------------
//
// Both Car and Configuration carry their own `archived` flag (see
// lib/parse-tracker.js and lib/archive.js) — a whole watch can be removed
// independently of any one trim on it, and archiving a watch never touches
// its Configurations' own flags (a trim archived before the watch was
// removed stays archived if the watch is ever restored). A PricePoint or
// Quote has no flag of its own; it is considered archived exactly when the
// Configuration it belongs to is archived — derived, not stored — so
// restoring a trim can never leave a stray archived price point or quote
// out of sync with its parent. These functions are the one place that
// join happens; every read path should filter through them rather than
// re-deriving visibility inline.

export function visibleCars(cars) {
  return cars.filter((c) => !c.archived);
}

export function visibleConfigurations(configurations) {
  return configurations.filter((c) => !c.archived);
}

function archivedConfigIds(configurations) {
  return new Set(configurations.filter((c) => c.archived).map((c) => c.id));
}

export function visiblePricePoints(configurations, pricePoints) {
  const archived = archivedConfigIds(configurations);
  return pricePoints.filter((p) => !archived.has(p.configuration));
}

export function visibleQuotes(configurations, quotes) {
  const archived = archivedConfigIds(configurations);
  return quotes.filter((q) => !archived.has(q.configuration));
}
