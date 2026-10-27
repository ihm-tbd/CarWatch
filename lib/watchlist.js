// Pure, testable watchlist data for Car Watch (requirement 004, stage 4a:
// "the watchlist screen"). No I/O, no rendering, no DOM — everything here
// operates on the plain, already-visible-filtered arrays lib/tracker-data.js
// produces (see lib/model.js#visibleConfigurations etc.), the same shape
// lib/trend-chart.js consumes. public/app.js turns this into HTML/SVG and
// also imports this module directly in the browser (dynamic import, same
// pattern as lib/trend-chart.js) to re-run sortRows client-side against
// whichever tab is currently selected — sort and filter are pure UI state,
// not further server round-trips (there is no fetcher).
//
// Deliberately duplicates a handful of tiny pure helpers already defined
// in lib/tracker-data.js (daysRemaining, formatShortDate, currentPriceFor,
// plural) rather than importing them — tracker-data.js is this module's
// caller (lib/tracker-data.js#buildAppData), so importing the other
// direction would be circular. This mirrors the existing toUtcDay
// duplication between lib/model.js and lib/tracker-data.js.
//
// Source of truth: car-tracker/reference/02-all-watches.html and
// docs/requirements/004-car-watch-v2.md's "watchlist" criteria (Lisa's
// stage-4a brief). The mock hardcodes a $25k–$55k axis and "First check
// pending" / "Checked with first prices" copy for its four placeholder
// cars — neither ships: the axis is derived from real data (see
// computeAxisBounds below) and there is no fetcher, so a car with no
// prices reads "No prices yet", never a pending-check phrase.

import { toUtcDay } from './model.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const AXIS_STEP = 5000;

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function daysRemaining(dateStr, now) {
  const nowDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((toUtcDay(dateStr) - nowDay) / DAY_MS);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatShortDate(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

// Same "most recent dated reading, undated as a last resort" rule as
// lib/tracker-data.js#currentPriceFor.
function currentPriceFor(configId, pricePoints) {
  const forConfig = pricePoints.filter((p) => p.configuration === configId);
  const dated = forConfig
    .filter((p) => p.observed)
    .sort((a, b) => toUtcDay(b.observed) - toUtcDay(a.observed));
  return dated[0] ?? forConfig[0] ?? null;
}

// The row's single leftmost chip label — same vocabulary as
// public/app.js#conditionChipLabel, duplicated here so lib/ never depends
// on public/.
function conditionChipLabel(condition) {
  if (condition === 'cpo') return 'CPO';
  if (condition === 'used') return 'Used';
  if (condition === 'new') return 'New';
  return 'Unknown';
}

// --- Filter tabs -----------------------------------------------------------

export const TABS = ['all', 'new', 'preowned'];

export function conditionCategoryOf(condition) {
  return condition === 'new' ? 'new' : 'preowned'; // cpo and used are both "pre-owned"
}

export function filterConfigsByTab(configs, tab) {
  if (tab === 'all' || !tab) return configs;
  return configs.filter((c) => conditionCategoryOf(c.condition) === tab);
}

// --- Shared price-spread axis -----------------------------------------------
//
// "All rows share one horizontal axis so bars are comparable across cars.
// Derive the bounds from the data — round the global minimum down and
// maximum up to the nearest $5,000." (requirement 004, stage 4a brief).
// Returns null when there is no priced row at all in the current tab —
// callers should render an empty track with no ticks or axis labels
// rather than a bogus 0–0 range.

export function roundDownToStep(value, step = AXIS_STEP) {
  return Math.floor(value / step) * step;
}

export function roundUpToStep(value, step = AXIS_STEP) {
  return Math.ceil(value / step) * step;
}

// `spreads` is an array of {low, high} pairs (one per priced row). Widens
// a degenerate single-value axis (every row's low/high identical, or a
// single row with low === high, rounding to the same $5k step) by one
// step on each side so the track always has a real, non-zero span to draw
// against — never a divide-by-zero when a bar's position is computed.
export function computeAxisBounds(spreads) {
  const priced = spreads.filter((s) => s && s.low != null && s.high != null);
  if (priced.length === 0) return null;
  const rawMin = Math.min(...priced.map((s) => s.low));
  const rawMax = Math.max(...priced.map((s) => s.high));
  let min = roundDownToStep(rawMin);
  let max = roundUpToStep(rawMax);
  if (min === max) {
    min = Math.max(0, min - AXIS_STEP);
    max = max + AXIS_STEP;
  }
  return { min, max };
}

function clampPct(pct) {
  return Math.min(100, Math.max(0, pct));
}

// Geometry for one row's bar against the shared axis. A spread that falls
// partly or fully outside [axisMin, axisMax] is clamped to the track
// (0–100%) rather than drawn off the edge, and the clipped end is flagged
// so the caller can mark it distinctly (requirement 004: "must not draw
// outside the track: clamp it and mark the clipped end"). With a
// correctly-derived axis (computeAxisBounds above, run over the same rows
// being drawn) this is defensive rather than reachable in practice — every
// row's own low/high is part of what widened the axis in the first place
// — but it's real protection against floating-point edge cases at the
// boundary and against an axis computed over a different row set than the
// one being drawn (e.g. a future caller that fixes the axis across tabs).
export function buildSpreadBar(low, high, axisMin, axisMax) {
  const span = axisMax - axisMin;
  const rawLeft = ((low - axisMin) / span) * 100;
  const rawRight = ((high - axisMin) / span) * 100;
  const leftPct = clampPct(rawLeft);
  const rightPct = clampPct(rawRight);
  return {
    leftPct,
    rightPct,
    widthPct: Math.max(0, rightPct - leftPct),
    clippedLeft: rawLeft < 0,
    clippedRight: rawRight > 100,
    cheapestValue: low,
    dearestValue: high,
  };
}

// --- Per-car row -------------------------------------------------------------

function buildIncentiveSummary(car, incentives, now) {
  const carIncentives = incentives.filter((inc) => inc.car === car.id);
  const unexpired = carIncentives.filter((inc) => daysRemaining(inc.expires, now) >= 0);
  if (unexpired.length === 0) return { count: 0, days: null, reason: 'No incentives on file' };
  const soonestDays = Math.min(...unexpired.map((inc) => daysRemaining(inc.expires, now)));
  const soonestExpiry = unexpired.find((inc) => daysRemaining(inc.expires, now) === soonestDays).expires;
  const group = unexpired.filter((inc) => inc.expires === soonestExpiry);
  return { count: unexpired.length, days: soonestDays, dateLabel: formatShortDate(soonestExpiry), group, reason: null };
}

function latestUpdatedDate(configIds, pricePoints) {
  const dates = pricePoints
    .filter((p) => configIds.includes(p.configuration) && p.observed)
    .map((p) => p.observed);
  if (dates.length === 0) return null;
  return dates.reduce((latest, d) => (d > latest ? d : latest));
}

// One watchlist row for one car under one filter tab. `subtitle` (trim
// count / variant count / years) always describes the whole car,
// independent of the tab — only `lowestPrice` and `spread` (the raw
// {low, high} pair the shared axis is later derived from) are restricted
// to the tab's condition (requirement 004: the filter "restrict[s] both
// the lowest-price figure and the spread bar to that condition" — nothing
// else). Quotes and the incentive summary are whole-car figures in every
// tab, matching the per-car detail header's own quotes/incentives tiles.
export function buildCarRow(car, allConfigurations, pricePoints, quotes, incentives, now, tab) {
  const carConfigs = allConfigurations.filter((c) => c.car === car.id);
  const tabConfigs = filterConfigsByTab(carConfigs, tab);

  const priced = tabConfigs
    .map((config) => ({ config, price: currentPriceFor(config.id, pricePoints) }))
    .filter((r) => r.price);

  let lowestPrice = { value: null, label: null, reason: 'No prices yet' };
  let spread = null;
  if (priced.length) {
    const cheapest = priced.reduce((min, r) => (r.price.value < min.price.value ? r : min));
    const dearest = priced.reduce((max, r) => (r.price.value > max.price.value ? r : max));
    lowestPrice = {
      value: cheapest.price.value,
      label: `${cheapest.config.year} ${conditionChipLabel(cheapest.config.condition)}`,
      reason: null,
    };
    spread = { low: cheapest.price.value, high: dearest.price.value };
  }

  const trims = new Set(carConfigs.map((c) => c.trim));
  const carConfigIds = carConfigs.map((c) => c.id);
  const quoteCount = quotes.filter((q) => carConfigIds.includes(q.configuration)).length;
  const incentiveSummary = buildIncentiveSummary(car, incentives, now);

  return {
    carId: car.id,
    name: [car.make, car.model].filter(Boolean).join(' '),
    navLabel: car.model,
    subtitle: `${plural(trims.size, 'trim')} · ${plural(carConfigIds.length, 'variant')}${car.years ? ` · ${car.years.replace(/^(\d{4})-(\d{4})$/, '$1–$2')}` : ''}`,
    lowestPrice,
    spread,
    quoteCount,
    incentiveSummary,
    deadlineDays: incentiveSummary.days,
    lastUpdatedDate: latestUpdatedDate(carConfigIds, pricePoints),
  };
}

// One tab's full row set plus the shared axis derived from exactly those
// rows' spreads (requirement 004: bars must be comparable within the view
// being shown).
export function buildWatchlistTab(cars, configurations, pricePoints, quotes, incentives, now, tab) {
  const rows = cars.map((car) => buildCarRow(car, configurations, pricePoints, quotes, incentives, now, tab));
  const axis = computeAxisBounds(rows.map((r) => r.spread));
  const rowsWithBars = rows.map((row) => ({
    ...row,
    spreadBar: row.spread && axis ? buildSpreadBar(row.spread.low, row.spread.high, axis.min, axis.max) : null,
  }));
  return { axis, rows: rowsWithBars };
}

// --- Attention tiles ---------------------------------------------------------
//
// Three tiles, always shown even when there is nothing to report — "a
// tile with nothing to report keeps its place and shows a zero" — so
// every branch below returns a real {count, subtitle} rather than being
// skipped.

function buildExpiryTile(cars, incentives, now) {
  const unexpired = incentives.filter((inc) => daysRemaining(inc.expires, now) >= 0);
  if (unexpired.length === 0) return { days: 0, subtitle: 'No incentives on file' };
  const soonestDays = Math.min(...unexpired.map((inc) => daysRemaining(inc.expires, now)));
  const soonest = unexpired.find((inc) => daysRemaining(inc.expires, now) === soonestDays);
  const car = cars.find((c) => c.id === soonest.car);
  const group = unexpired.filter((inc) => inc.car === soonest.car && inc.expires === soonest.expires);
  return {
    days: soonestDays,
    subtitle: `${car ? car.model : 'Unknown car'} · ${plural(group.length, 'offer')} end ${formatShortDate(soonest.expires)}`,
  };
}

function buildAwaitingFirstPriceTile(cars, configurations, pricePoints) {
  if (cars.length === 0) return { count: 0, subtitle: 'No cars watched yet' };
  const awaiting = cars.filter((car) => {
    const configIds = configurations.filter((c) => c.car === car.id).map((c) => c.id);
    return !pricePoints.some((p) => configIds.includes(p.configuration));
  });
  if (awaiting.length === 0) return { count: 0, subtitle: 'Every car has at least one price' };
  if (awaiting.length === 1) return { count: 1, subtitle: `${awaiting[0].model} has no prices yet` };
  return { count: awaiting.length, subtitle: `${awaiting.map((c) => c.model).join(', ')} have no prices yet` };
}

function buildQuotesTile(quotes) {
  return { count: quotes.length, subtitle: 'Yours only · not in the trend' };
}

export function buildAttentionTiles(cars, configurations, pricePoints, quotes, incentives, now) {
  return {
    expiry: buildExpiryTile(cars, incentives, now),
    awaitingFirstPrice: buildAwaitingFirstPriceTile(cars, configurations, pricePoints),
    quotesLogged: buildQuotesTile(quotes),
  };
}

// --- Sort --------------------------------------------------------------------
//
// Pure and reused unchanged in the browser (public/app.js dynamically
// imports this module, same pattern as lib/trend-chart.js) so switching
// the sort control never needs another round trip — there is no fetcher,
// and the server already pushed every tab's rows over SSE.

function compareNullableAsc(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a - b;
}

export const SORTS = ['lowest-price', 'deadline-soonest', 'recently-updated'];

export function sortRows(rows, sortKey) {
  const copy = rows.slice();
  if (sortKey === 'deadline-soonest') {
    copy.sort((a, b) => compareNullableAsc(a.deadlineDays, b.deadlineDays));
  } else if (sortKey === 'recently-updated') {
    copy.sort((a, b) => {
      if (a.lastUpdatedDate == null && b.lastUpdatedDate == null) return 0;
      if (a.lastUpdatedDate == null) return 1;
      if (b.lastUpdatedDate == null) return -1;
      return b.lastUpdatedDate.localeCompare(a.lastUpdatedDate);
    });
  } else {
    copy.sort((a, b) => compareNullableAsc(a.lowestPrice.value, b.lowestPrice.value));
  }
  return copy;
}

// --- Top level ---------------------------------------------------------------

export function buildWatchlistData(cars, configurations, pricePoints, quotes, incentives, now) {
  const tabs = {};
  for (const tab of TABS) {
    tabs[tab] = buildWatchlistTab(cars, configurations, pricePoints, quotes, incentives, now, tab);
  }
  return {
    tabs,
    tiles: buildAttentionTiles(cars, configurations, pricePoints, quotes, incentives, now),
    carCount: cars.length,
    variantCount: configurations.length,
  };
}
