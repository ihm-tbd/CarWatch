// Reads tracker.md, parses it, and builds the view-model for the car
// detail screen (requirement 003, stage 2): grouped configurations,
// summary tiles, and the incentives rail (including conflict detection).
//
// Stage 1 left a V1-shaped compatibility layer here so the old flat page
// could keep rendering unchanged. That page is gone as of stage 2 — this
// file now reads the five entities directly and returns the shape the new
// detail screen needs. There is still no write path; every function below
// is read-only maths over parsed data.
//
// This app tracks a single car (multi-car UI is out of scope — requirement
// 003, "Out of scope"). buildCarDetail always renders the first Car in the
// file.

import fsp from 'node:fs/promises';
import { safeJoin, PathTraversalError } from './safe-path.js';
import { parseTracker } from './parse-tracker.js';
import {
  visibleCars,
  visibleConfigurations,
  visiblePricePoints,
  visibleQuotes,
  hasTrend,
  orderedReadings,
  dueDate as dueDateFor,
} from './model.js';
import { eligibleVariants, buildTrendChart, buildSparkline } from './trend-chart.js';
import { buildWatchlistData } from './watchlist.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const URGENT_THRESHOLD_DAYS = 14;
const CONDITION_LABELS = { new: 'New', used: 'Used', cpo: 'Certified pre-owned' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function toUtcDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function daysRemaining(dateStr, now) {
  const nowDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((toUtcDay(dateStr) - nowDay) / DAY_MS);
}

export function formatShortDate(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

// "2025-2026" -> "2025–2026"; anything else passes through untouched
// rather than guessing at a format we weren't given.
export function formatYearsLabel(years) {
  const match = /^(\d{4})-(\d{4})$/.exec(String(years ?? '').trim());
  return match ? `${match[1]}–${match[2]}` : (years ?? '');
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// --- Per-configuration current price -------------------------------------

// A configuration's "current" price is its most recently observed price
// point; an undated one is only used when nothing dated exists. Returns
// null when the configuration has no price point at all — callers must
// show that as "No prices yet", never a zero or a blank.
function currentPriceFor(configId, pricePoints) {
  const forConfig = pricePoints.filter((p) => p.configuration === configId);
  const dated = forConfig
    .filter((p) => p.observed)
    .sort((a, b) => toUtcDay(b.observed) - toUtcDay(a.observed));
  return dated[0] ?? forConfig[0] ?? null;
}

// --- Grouping (requirement 004, "price table": year band -> trim heading
// -> condition row — replaces V1/003's market-based grouping) ------------
//
// buildGroups splits each model year into up to two bands — New (or "New
// leftover" once it's no longer the current year) and Pre-owned (CPO and
// Used combined) — so a band's basis subtitle can name a single shared
// basis without averaging across conditions that were never comparable.
// Trim is carried on every row (row.trim) so the renderer can still draw
// the trim-heading level inside a band.

const CONDITION_RANK = { new: 0, cpo: 1, used: 2 };
// Long-form condition words for a group's basis-fallback subtitle — not
// the same vocabulary as the row chip (conditionChipLabel in app.js),
// which stays "CPO"/"Used"/"New".
const CONDITION_WORD_LONG = { new: 'new', cpo: 'Certified', used: 'used' };

function trimRankFor(car) {
  const trimOrder = Array.isArray(car.trimsTracked) ? car.trimsTracked : [];
  return (trim) => {
    const i = trimOrder.indexOf(trim);
    return i === -1 ? trimOrder.length : i;
  };
}

// Only used and CPO variants ever have a trend (lib/model.js#hasTrend) — a
// new car's price is MSRP, which the manufacturer sets, so plotting it
// would be a chart pretending to be information. The chart itself and its
// row sparklines are a later stage; this stage reports the eligibility
// rule as text only, and never derives it from quotes — quotes are
// counted separately and must never affect a trend, an average, or a
// shown price (requirement 004, "quotes").
function trendCellInfo(condition, readingCount) {
  if (condition !== 'used' && condition !== 'cpo') {
    return { available: false, text: 'MSRP — no trend' };
  }
  if (!hasTrend(condition, readingCount)) {
    return { available: false, text: 'Awaiting next reading' };
  }
  return { available: true, text: `${plural(readingCount, 'reading')} tracked` };
}

// A stable, oldest-first order for one configuration's logged quotes —
// same shape as lib/model.js#orderedReadings, but quotes aren't a
// PricePoint so it isn't reused from there directly.
function orderedQuotes(configId, quotes) {
  const forConfig = quotes.filter((q) => q.configuration === configId);
  const dated = forConfig.filter((q) => q.quoted);
  const undated = forConfig.filter((q) => !q.quoted);
  dated.sort((a, b) => toUtcDay(a.quoted) - toUtcDay(b.quoted));
  return [...dated, ...undated];
}

function buildConditionRow(config, pricePoints, quotes, now, sparklinesByConfig) {
  const price = currentPriceFor(config.id, pricePoints);
  const readingCount = orderedReadings(config.id, pricePoints).length;
  const configQuotes = orderedQuotes(config.id, quotes);
  const priceTrend = trendCellInfo(config.condition, readingCount);

  return {
    configurationId: config.id,
    condition: config.condition,
    trim: config.trim,
    price,
    noPriceReason: price ? null : 'No prices yet',
    quoteCount: configQuotes.length,
    // Quotes are surfaced on the trend cell alongside price-reading
    // eligibility so a caller can render "N quotes logged" next to "MSRP
    // — no trend" without a second lookup — but they never feed
    // `available`/`text` above, which come from price readings only.
    // `sparkline` (requirement 004, stage 3) is null whenever `available`
    // is false — a row with fewer than two dated readings gets the plain
    // "Awaiting next reading" text, never an empty or one-point chart.
    trend: {
      ...priceTrend,
      quoteCount: configQuotes.length,
      quotes: configQuotes,
      sparkline: sparklinesByConfig.get(config.id) ?? null,
    },
  };
}

// One sparkline per used/CPO configuration that qualifies for a trend
// line (lib/trend-chart.js#eligibleVariants, which itself reuses
// lib/model.js#hasTrend) — computed once per render and threaded through
// buildGroups so every row's sparkline shares the same colour as that
// variant's line on the main chart below the table.
function buildRowSparklines(car, configurations, pricePoints) {
  const map = new Map();
  for (const variant of eligibleVariants(car, configurations, pricePoints)) {
    const sparkline = buildSparkline(variant);
    if (sparkline) map.set(variant.configurationId, { ...sparkline, color: variant.color });
  }
  return map;
}

// The phrase a group's subtitle uses when every priced row in it shares
// one PricePoint.basis literally — a mismatch (e.g. one row `listing`,
// another `listing_average`) falls back to naming conditions instead of
// guessing at a combined phrase (requirement 004, change list section 4's
// "never repeats" rule extended to the group level).
function basisPhraseForGroup(pricedRows) {
  const basisSet = new Set(pricedRows.map((r) => r.price.basis));
  if (basisSet.size !== 1) return null;
  const basis = [...basisSet][0];
  if (basis === 'msrp') {
    const destSet = new Set(pricedRows.map((r) => r.price.destination));
    if (destSet.size === 1) {
      const [dest] = destSet;
      if (dest === false) return 'MSRP, excludes destination';
      if (dest === true) return 'MSRP, includes destination';
    }
    return 'MSRP';
  }
  if (basis === 'listing' || basis === 'listing_average') return 'Dealer listing prices';
  if (basis === 'valuation_estimate') return 'Valuation estimates';
  return 'Prices';
}

function conditionFallbackSubtitle(rows) {
  const present = new Set(rows.map((r) => r.condition));
  const order = ['new', 'cpo', 'used'].filter((c) => present.has(c));
  if (order.length === 0) return 'Condition not set';
  const words = order.map((c) => CONDITION_WORD_LONG[c]);
  if (words.length === 1) return `${words[0]} only`;
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

// A group's subtitle names its shared basis (or falls back to naming its
// conditions when the basis isn't uniform), then names the absence of
// incentive coverage unless the group already carries a chip for it — the
// chip and the "no incentives" phrase say the same thing, so only one
// ever shows (requirement 004, change list section 4 & 7).
function buildGroupSubtitle(rows, chip) {
  const pricedRows = rows.filter((r) => r.price);
  const phrase = (pricedRows.length && basisPhraseForGroup(pricedRows)) || conditionFallbackSubtitle(rows);
  return chip ? phrase : `${phrase} · no incentives on file`;
}

function buildGroupChip(configIds, unexpiredIncentives, now) {
  const covering = unexpiredIncentives.filter((inc) => inc.appliesTo.some((id) => configIds.includes(id)));
  if (!covering.length) return null;
  const soonestDays = Math.min(...covering.map((inc) => daysRemaining(inc.expires, now)));
  return { text: `Incentives apply · ${plural(soonestDays, 'day')} left` };
}

// Three-level nesting: model year band -> trim heading -> condition row.
// A trim belongs to the watch, not to a model year (requirement 004), so
// trim order comes from `car.trimsTracked` and is applied within every
// group the same way; conditions within a trim sort New, then CPO, then
// Used, matching the artboard's row order.
export function buildGroups(car, configurations, pricePoints, quotes, incentives, now) {
  const carConfigs = configurations.filter((c) => c.car === car.id);
  const years = [...new Set(carConfigs.map((c) => c.year))].sort((a, b) => Number(b) - Number(a));
  const trimRank = trimRankFor(car);
  const unexpiredIncentives = incentives.filter(
    (inc) => inc.car === car.id && daysRemaining(inc.expires, now) >= 0
  );
  const sparklinesByConfig = buildRowSparklines(car, configurations, pricePoints);

  function buildOneGroup(heading, configs) {
    const sorted = [...configs].sort(
      (a, b) => trimRank(a.trim) - trimRank(b.trim) || a.trim.localeCompare(b.trim) || (CONDITION_RANK[a.condition] ?? 99) - (CONDITION_RANK[b.condition] ?? 99)
    );
    const rows = sorted.map((c) => buildConditionRow(c, pricePoints, quotes, now, sparklinesByConfig));
    const configIds = configs.map((c) => c.id);
    const chip = buildGroupChip(configIds, unexpiredIncentives, now);
    return { heading, subtitle: buildGroupSubtitle(rows, chip), chip, rows };
  }

  const groups = [];
  years.forEach((year, i) => {
    const yearConfigs = carConfigs.filter((c) => c.year === year);
    const newConfigs = yearConfigs.filter((c) => c.condition === 'new');
    const preownedConfigs = yearConfigs.filter((c) => c.condition === 'cpo' || c.condition === 'used');

    if (newConfigs.length) {
      groups.push(buildOneGroup(`${year} · ${i === 0 ? 'New' : 'New leftover'}`, newConfigs));
    }
    if (preownedConfigs.length) {
      groups.push(buildOneGroup(`${year} · Pre-owned`, preownedConfigs));
    }
  });
  return groups;
}

// --- Trim summaries (requirement 004: the remove-trim confirmation dialog
// "keeps its design and its real counts, pulled from the record") --------
//
// One entry per trim currently on the watch: how many variants (year x
// condition Configurations) it has, how many distinct calendar months have
// a price-point reading across all of them, and how many quotes have been
// logged against any of them. All three come straight off the already
// visible-filtered (non-archived) configurations/pricePoints/quotes this
// function is handed — archived trims never reach this map at all, which
// is correct: only a currently-tracked trim can be offered for removal.
export function buildTrimSummaries(car, configurations, pricePoints, quotes) {
  const carConfigs = configurations.filter((c) => c.car === car.id);
  const byTrim = new Map();

  for (const config of carConfigs) {
    if (!byTrim.has(config.trim)) {
      byTrim.set(config.trim, { variantCount: 0, months: new Set(), quoteCount: 0 });
    }
    const entry = byTrim.get(config.trim);
    entry.variantCount += 1;
    for (const pp of pricePoints) {
      if (pp.configuration === config.id && pp.observed) entry.months.add(pp.observed.slice(0, 7));
    }
    for (const q of quotes) {
      if (q.configuration === config.id) entry.quoteCount += 1;
    }
  }

  const result = {};
  for (const [trim, entry] of byTrim) {
    result[trim] = {
      variantCount: entry.variantCount,
      historyMonths: entry.months.size,
      quoteCount: entry.quoteCount,
    };
  }
  return result;
}

// --- Watch summary (requirement 004: the remove-whole-watch confirmation
// dialog "follows the same archive-and-confirm pattern, with the car's
// name and totals") ---------------------------------------------------------
//
// Same shape and same reasoning as buildTrimSummaries above, but rolled up
// across every currently-tracked trim on the car rather than kept per
// trim — the whole-watch dialog needs one set of real counts covering
// everything it is about to hide, not a list of trims. `configurations`,
// `pricePoints` and `quotes` are already the visible-filtered sets, same
// as every other caller here.
export function buildWatchSummary(car, configurations, pricePoints, quotes) {
  const carConfigs = configurations.filter((c) => c.car === car.id);
  const trimCount = new Set(carConfigs.map((c) => c.trim)).size;
  const months = new Set();
  let quoteCount = 0;
  const carConfigIds = new Set(carConfigs.map((c) => c.id));
  for (const pp of pricePoints) {
    if (carConfigIds.has(pp.configuration) && pp.observed) months.add(pp.observed.slice(0, 7));
  }
  for (const q of quotes) {
    if (carConfigIds.has(q.configuration)) quoteCount += 1;
  }
  return {
    trimCount,
    variantCount: carConfigs.length,
    historyMonths: months.size,
    quoteCount,
  };
}

// --- Record-readings form (requirement 004, stage 4c) ----------------------
//
// One row per visible Configuration on this car, in the same year -> trim
// -> condition order the price table uses, each carrying its previous
// reading (if any) so the client can default every field to it — "a
// fortnightly check is mostly confirming rather than retyping" — while
// leaving every field editable. `previous: null` means this variant has
// never had a reading; the client shows it blank, not zeroed.
function buildReadingsFormVariants(car, configurations, pricePoints) {
  const carConfigs = configurations.filter((c) => c.car === car.id);
  const trimRank = trimRankFor(car);
  const sorted = [...carConfigs].sort(
    (a, b) =>
      Number(a.year) - Number(b.year) ||
      trimRank(a.trim) - trimRank(b.trim) ||
      a.trim.localeCompare(b.trim) ||
      (CONDITION_RANK[a.condition] ?? 99) - (CONDITION_RANK[b.condition] ?? 99)
  );

  return sorted.map((config) => {
    const previous = currentPriceFor(config.id, pricePoints);
    return {
      configurationId: config.id,
      year: config.year,
      trim: config.trim,
      condition: config.condition,
      previous: previous
        ? {
            value: previous.value,
            basis: previous.basis,
            source: previous.source,
            confirmed: previous.confirmed,
            sampleSize: previous.sampleSize,
            rangeLow: previous.rangeLow,
            rangeHigh: previous.rangeHigh,
            note: previous.note,
            observed: previous.observed,
          }
        : null,
    };
  });
}

// A car's `last_checked` is blank for anything migrated from V1 or seeded
// from research, since neither predates the readings form that would have
// set it — but the car can still have real price points on file. Rather
// than show the honest-but-misleading "No check on file yet" when history
// exists, fall back to the most recently observed reading's date. Returns
// null when the car has no dated reading at all, so a genuinely
// never-checked car is unaffected (fix/002).
function derivedLastCheckedAt(carConfigIds, pricePoints) {
  let latest = null;
  for (const p of pricePoints) {
    if (!carConfigIds.has(p.configuration) || !p.observed) continue;
    if (latest === null || toUtcDay(p.observed) > toUtcDay(latest)) latest = p.observed;
  }
  return latest;
}

// The "Check now" / "Check again on <date>" header action (requirement 004:
// due date is derived, never stored) plus the form's row list. `checkDue`
// is true both when the car has never been checked (`dueDate === null`)
// and when the derived due date has already passed or is today.
//
// `lastCheckedAt` is the explicit value straight off the car (possibly
// null); `effectiveLastCheckedAt` is what the due-date math and the header
// copy actually use — the explicit value if there is one, otherwise the
// derived one (fix/002: "an explicit last_checked value, once the readings
// form writes one, still wins over the derived value").
export function buildReadingsForm(car, configurations, pricePoints, now) {
  const carConfigIds = new Set(configurations.filter((c) => c.car === car.id).map((c) => c.id));
  const effectiveLastCheckedAt = car.lastCheckedAt ?? derivedLastCheckedAt(carConfigIds, pricePoints);
  const due = dueDateFor(effectiveLastCheckedAt, car.checkIntervalDays);
  const todayStr = now.toISOString().slice(0, 10);
  return {
    checkIntervalDays: car.checkIntervalDays,
    lastCheckedAt: car.lastCheckedAt,
    effectiveLastCheckedAt,
    // Same "Oct 6" shape as every other short date on this screen
    // (formatShortDate above) — computed server-side so the client only
    // ever renders ready-made text, same pattern the trend chart's month
    // labels already use.
    lastCheckedLabel: effectiveLastCheckedAt ? formatShortDate(effectiveLastCheckedAt) : null,
    dueDate: due,
    dueDateLabel: due ? formatShortDate(due) : null,
    checkDue: due === null || due <= todayStr,
    variants: buildReadingsFormVariants(car, configurations, pricePoints),
  };
}

// --- Summary tiles ---------------------------------------------------------

function configLabel(config, price) {
  const parts = [`${config.year} ${config.trim}`];
  if (config.condition && config.condition !== 'new') {
    parts.push(CONDITION_LABELS[config.condition] ?? config.condition);
  }
  if (price?.note) parts.push(price.note);
  return parts.join(' · ');
}

function basisNoun(basis) {
  if (basis === 'msrp') return 'MSRP';
  if (basis === 'listing') return 'Listing price';
  if (basis === 'listing_average') return 'Avg. listing';
  if (basis === 'valuation_estimate') return 'Estimate';
  return 'Price';
}

export function computeSummary(car, configurations, pricePoints, quotes, incentives, now) {
  const carConfigs = configurations.filter((c) => c.car === car.id);
  const priced = carConfigs
    .map((config) => ({ config, price: currentPriceFor(config.id, pricePoints) }))
    .filter((r) => r.price);

  // Tile 1: lowest price tracked, any condition, any basis.
  let lowestPrice = { value: null, label: null, reason: 'No prices yet' };
  if (priced.length) {
    const cheapest = priced.reduce((min, r) => (r.price.value < min.price.value ? r : min));
    lowestPrice = { value: cheapest.price.value, label: configLabel(cheapest.config, cheapest.price), reason: null };
  }

  // Tile 2: cheapest new configuration of the current (newest) model year.
  const newConfigs = carConfigs.filter((c) => c.condition === 'new');
  const newYears = [...new Set(newConfigs.map((c) => c.year))].sort((a, b) => Number(b) - Number(a));
  let newYearStart = { value: null, year: null, label: null, reason: 'No new configurations tracked' };
  if (newYears.length) {
    const year = newYears[0];
    const pricedThisYear = priced.filter((r) => r.config.year === year && r.config.condition === 'new');
    if (pricedThisYear.length) {
      const cheapest = pricedThisYear.reduce((min, r) => (r.price.value < min.price.value ? r : min));
      const destNote =
        cheapest.price.destination === false
          ? ' · before destination'
          : cheapest.price.destination === true
            ? ' · includes destination'
            : '';
      newYearStart = {
        value: cheapest.price.value,
        year,
        label: `${cheapest.config.trim} ${basisNoun(cheapest.price.basis)}${destNote}`,
        reason: null,
      };
    } else {
      newYearStart = { value: null, year, label: null, reason: 'No prices yet' };
    }
  }

  // Tile 3: incentive countdown, soonest unexpired deadline across the car.
  const carIncentives = incentives.filter((inc) => inc.car === car.id);
  const unexpired = carIncentives.filter((inc) => daysRemaining(inc.expires, now) >= 0);
  let countdown = { days: null, dateLabel: null, subtitle: null, urgent: false, reason: 'No incentives on file' };
  if (unexpired.length) {
    const soonestDays = Math.min(...unexpired.map((inc) => daysRemaining(inc.expires, now)));
    const soonestExpiry = unexpired.find((inc) => daysRemaining(inc.expires, now) === soonestDays).expires;
    const group = unexpired.filter((inc) => inc.expires === soonestExpiry);
    const configIds = configurations.filter((c) => c.car === car.id).map((c) => c.id);
    const yearsHit = [
      ...new Set(
        group.flatMap((inc) => inc.appliesTo.filter((id) => configIds.includes(id)))
          .map((id) => configurations.find((c) => c.id === id)?.year)
          .filter(Boolean)
      ),
    ];
    const yearLabel =
      yearsHit.length === 1
        ? yearsHit[0]
        : yearsHit.length > 1
          ? `${Math.min(...yearsHit.map(Number))}–${Math.max(...yearsHit.map(Number))}`
          : null;
    countdown = {
      days: soonestDays,
      dateLabel: formatShortDate(soonestExpiry),
      subtitle: `${formatShortDate(soonestExpiry)} · ${plural(group.length, 'offer')}${yearLabel ? ` on ${yearLabel} trims` : ''}`,
      urgent: soonestDays <= URGENT_THRESHOLD_DAYS,
      reason: null,
    };
  }

  // Tile 4: dealer quotes logged.
  const carConfigIds = new Set(carConfigs.map((c) => c.id));
  const carQuotes = quotes.filter((q) => carConfigIds.has(q.configuration));
  const configsWithQuotes = new Set(carQuotes.map((q) => q.configuration)).size;
  const quotesLogged = {
    count: carQuotes.length,
    subtitle:
      carQuotes.length === 0
        ? 'Log 2 on a trim to start its trend'
        : `${plural(carQuotes.length, 'quote')} across ${plural(configsWithQuotes, 'trim')}`,
  };

  return { lowestPrice, newYearStart, countdown, quotesLogged };
}

// --- Incentives rail --------------------------------------------------------

// The comparable "amount" for a same-kind, same-expiry pair: apr offers
// compare their apr_terms text, everything else compares the amount text.
function comparableAmount(incentive) {
  return incentive.kind === 'apr' ? incentive.aprTerms : incentive.amount;
}

// Two incentives of the same kind and expiry, both covering at least one
// shared configuration, reporting a different amount — see build spec,
// "Incentive.conflicts". Neither is dropped; this only flags the pair so
// the UI can show both and name what to verify.
export function findIncentiveConflicts(incentives) {
  const conflicts = [];
  const byKindExpiry = new Map();
  for (const inc of incentives) {
    const key = `${inc.kind}\0${inc.expires}`;
    if (!byKindExpiry.has(key)) byKindExpiry.set(key, []);
    byKindExpiry.get(key).push(inc);
  }

  for (const group of byKindExpiry.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const overlap = a.appliesTo.filter((id) => b.appliesTo.includes(id));
        const amountA = comparableAmount(a);
        const amountB = comparableAmount(b);
        if (overlap.length === 0) continue;
        if (!amountA || !amountB) continue;
        if (amountA.trim().toLowerCase() === amountB.trim().toLowerCase()) continue;
        conflicts.push({ a, b, configIds: overlap, amountA, amountB });
      }
    }
  }
  return conflicts;
}

export function buildIncentivesRail(car, configurations, incentives, now) {
  const carIncentives = incentives.filter((inc) => inc.car === car.id);
  const unexpired = carIncentives.filter((inc) => daysRemaining(inc.expires, now) >= 0);

  let countdown = null;
  if (unexpired.length) {
    const soonestDays = Math.min(...unexpired.map((inc) => daysRemaining(inc.expires, now)));
    const soonestExpiry = unexpired.find((inc) => daysRemaining(inc.expires, now) === soonestDays).expires;
    const sharing = unexpired.filter((inc) => inc.expires === soonestExpiry);
    countdown = {
      days: soonestDays,
      dateLabel: formatShortDate(soonestExpiry),
      subtitle:
        sharing.length === unexpired.length
          ? `All ${plural(sharing.length, 'offer')} expire ${formatShortDate(soonestExpiry)}`
          : `${plural(sharing.length, 'offer')} expire ${formatShortDate(soonestExpiry)}`,
      urgent: soonestDays <= URGENT_THRESHOLD_DAYS,
    };
  }

  const blocks = carIncentives.map((inc) => ({
    id: inc.id,
    headline: inc.headline,
    terms: inc.terms,
    provider: inc.provider,
    source: inc.source,
    confirmed: inc.confirmed,
    kind: inc.kind,
    expires: inc.expires,
    expired: daysRemaining(inc.expires, now) < 0,
    appliesTo: inc.appliesTo
      .map((id) => configurations.find((c) => c.id === id))
      .filter(Boolean)
      .map((c) => ({ id: c.id, year: c.year, trim: c.trim })),
  }));

  const conflicts = findIncentiveConflicts(carIncentives).map((c) => ({
    configs: c.configIds
      .map((id) => configurations.find((cf) => cf.id === id))
      .filter(Boolean)
      .map((cf) => ({ id: cf.id, year: cf.year, trim: cf.trim })),
    amountA: c.amountA,
    amountB: c.amountB,
    sourceA: c.a.source,
    sourceB: c.b.source,
  }));

  // activeCount backs the header pill's "Incentives · N · D days" label
  // (requirement 004) — unexpired offers only, so a stale expired one
  // never inflates the count next to a live countdown.
  return { countdown, activeCount: unexpired.length, blocks, conflicts };
}

// --- Top level ---------------------------------------------------------------

async function readTrackerFile(dataRoot) {
  let target;
  try {
    target = safeJoin(dataRoot, 'tracker.md');
  } catch (err) {
    if (err instanceof PathTraversalError) return { content: null, error: 'blocked' };
    throw err;
  }

  try {
    return { content: await fsp.readFile(target, 'utf8'), error: null };
  } catch (err) {
    return { content: null, error: err.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
}

const EMPTY_RESULT = {
  car: null,
  groups: [],
  tabCounts: { all: 0, new: 0, preowned: 0 },
  summary: null,
  incentives: null,
  trendChart: null,
};

// The detail-screen view-model for one car, given the whole file's
// already-parsed, already-visible-filtered entities. Shared by
// buildCarDetail (below, the single-car read path requirement 003
// established) and buildAppData (requirement 004, stage 4a — one call
// builds every watched car's detail so routing between cars never needs
// another read of tracker.md; there is no fetcher, and the SSE push
// already carries the whole file's data).
function buildCarDetailForCar(car, configurations, pricePoints, quotes, incentives, now) {
  const carConfigs = configurations.filter((c) => c.car === car.id);
  const tabCounts = {
    all: carConfigs.length,
    new: carConfigs.filter((c) => c.condition === 'new').length,
    preowned: carConfigs.filter((c) => c.condition === 'cpo' || c.condition === 'used').length,
  };

  return {
    car: {
      id: car.id,
      make: car.make,
      model: car.model,
      yearsLabel: formatYearsLabel(car.years),
    },
    groups: buildGroups(car, configurations, pricePoints, quotes, incentives, now),
    trimSummaries: buildTrimSummaries(car, configurations, pricePoints, quotes),
    watchSummary: buildWatchSummary(car, configurations, pricePoints, quotes),
    tabCounts,
    summary: computeSummary(car, configurations, pricePoints, quotes, incentives, now),
    incentives: buildIncentivesRail(car, configurations, incentives, now),
    trendChart: buildTrendChart(car, configurations, pricePoints),
    readingsForm: buildReadingsForm(car, configurations, pricePoints, now),
  };
}

// carId is optional and additive (requirement 004, stage 4a: routing to a
// specific car's detail screen) — omitting it keeps the requirement-003
// behaviour of always rendering the first car in the file, so every
// existing caller/test is unaffected. An unknown carId falls back to the
// first car the same way, rather than erroring.
export async function buildCarDetail(dataRoot, now = new Date(), carId = null) {
  const { content, error } = await readTrackerFile(dataRoot);
  if (error) return { ...EMPTY_RESULT, error };

  let parsed;
  try {
    parsed = parseTracker(content);
  } catch {
    return { ...EMPTY_RESULT, error: 'malformed' };
  }

  // An archived car (requirement 004: "removing a whole watch" hides it
  // "from every view") is filtered out here, the same visibleCars join
  // point buildAppData below uses — a direct link to an archived car's id
  // falls back to the first still-watched car exactly like an unknown id
  // already did, rather than rendering a watch that was just removed.
  const { incentives } = parsed;
  const cars = visibleCars(parsed.cars);
  const car = (carId && cars.find((c) => c.id === carId)) || cars[0] || null;
  if (!car) return { ...EMPTY_RESULT, error: null };

  // Archived trims are excluded from every view but stay in the file
  // (requirement 004) — this is the one join point (lib/model.js) that
  // every read path below goes through, so nothing here needs its own
  // archive-awareness.
  const configurations = visibleConfigurations(parsed.configurations);
  const pricePoints = visiblePricePoints(parsed.configurations, parsed.pricePoints);
  const quotes = visibleQuotes(parsed.configurations, parsed.quotes);

  return { error: null, ...buildCarDetailForCar(car, configurations, pricePoints, quotes, incentives, now) };
}

// The whole app's data in one call (requirement 004, stage 4a): the nav's
// car list, the watchlist (every tab plus attention tiles), and every
// watched car's detail view-model, keyed by id. server.js pushes this
// once over SSE and the client (public/app.js) picks what to render from
// its own hash route — routing between the watchlist and a car's detail
// screen is client-side only, so it never needs a second read of
// tracker.md. Empty-file and malformed-file errors return the same
// {error, cars: [], watchlist: null, details: {}} shape so callers never
// have to special-case which function they called.
const EMPTY_APP_DATA = { cars: [], watchlist: null, details: {} };

export async function buildAppData(dataRoot, now = new Date()) {
  const { content, error } = await readTrackerFile(dataRoot);
  if (error) return { ...EMPTY_APP_DATA, error };

  let parsed;
  try {
    parsed = parseTracker(content);
  } catch {
    return { ...EMPTY_APP_DATA, error: 'malformed' };
  }

  // Same visibleCars join as buildCarDetail above — an archived watch
  // must disappear from the nav list, the watchlist, and the per-car
  // details map all at once, since all three are built from `cars` here.
  const { incentives } = parsed;
  const cars = visibleCars(parsed.cars);
  if (cars.length === 0) return { ...EMPTY_APP_DATA, error: null };

  const configurations = visibleConfigurations(parsed.configurations);
  const pricePoints = visiblePricePoints(parsed.configurations, parsed.pricePoints);
  const quotes = visibleQuotes(parsed.configurations, parsed.quotes);

  const details = {};
  for (const car of cars) {
    details[car.id] = buildCarDetailForCar(car, configurations, pricePoints, quotes, incentives, now);
  }

  return {
    error: null,
    cars: cars.map((c) => ({ id: c.id, make: c.make, model: c.model })),
    watchlist: buildWatchlistData(cars, configurations, pricePoints, quotes, incentives, now),
    details,
  };
}
