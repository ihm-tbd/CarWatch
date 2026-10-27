// Car Watch detail screen (requirement 004). Year band -> trim heading ->
// condition row, the simplified basis line with hover/focus (i) popovers,
// the incentives toggle pill, a display-only quotes column that reuses
// the 003 write path, and — stage 3 — the used/CPO trend chart and its
// row sparklines. No left nav, no watchlist — those are a later stage.
// Source of truth for layout/copy/interaction:
// car-tracker/reference/03-car-detail.html,
// car-tracker/reference/05-trend-chart.html (read its script-block
// comment for the hover/crosshair logic this file's attachTrendChartHandlers
// reimplements against real DOM events) and
// car-tracker/reference/Car Watch — V2 change list.md, sections 3, 4, 5, 7.
//
// The chart's geometry (pixel positions, month/week layout, tooltip
// clamping) is computed server-side by lib/tracker-data.js via
// lib/trend-chart.js and arrives ready-to-draw in `data.trendChart` and
// each row's `trend.sparkline` — this file only serializes that geometry
// to SVG strings and wires up hover. lib/trend-chart.js is also imported
// directly here (dynamically, browser-only, same pattern as markdown.js
// below) for formatLongDate and tooltipPosition, which depend on which
// point the user is hovering and so can't be precomputed on the server.
//
// A failed quote submission must lose nothing the user typed (requirement
// 003/004, "Security notes"): the error path only writes error text into
// the existing form's DOM nodes, never re-renders or clears the inputs. A
// successful submission is instead picked up by the next SSE `tracker`
// push (server.js broadcasts after every write), which re-renders the
// whole page from the new data and naturally collapses the form.
//
// The pure, DOM-free functions below (formatCurrency, basisLineText,
// popoverCopy, priceDisplayText, conditionChipLabel, formatAppliesTo,
// daysParts) have no DOM dependency and are exported for direct testing
// from Node — see test/detail-view.test.js. Everything DOM-facing is
// guarded so importing this module under Node (no `document`/`window`)
// is safe.

let escapeHtml = (value) => String(value ?? '');
let formatLongDate = (value) => String(value ?? '');
let tooltipPosition = ({ x, y }) => ({ left: x, top: y });
// Fallback constants for Node (no document) — overwritten with the real,
// tested values from lib/trend-chart.js in the browser below. Kept here
// only so this module never throws if something references TREND before
// the dynamic import resolves; render() itself never runs under Node.
const TREND = {
  TOOLTIP_SIZE: { width: 210, height: 54 },
  POINT_RADIUS: 5,
  HIT_TARGET_RADIUS: 16,
};
// Requirement 004, stage 4a-finish: the watchlist's sort comparator and
// its tab list are pure and reused unchanged client-side (same dynamic
// import pattern as trend-chart.js/markdown.js above) so switching the
// sort control or a filter tab never needs another round trip — there is
// no fetcher, and the SSE push already carries every tab's rows.
let sortWatchlistRows = (rows) => rows;
let WATCHLIST_TABS = ['all', 'new', 'preowned'];
if (typeof document !== 'undefined') {
  const markdown = await import('/markdown.js');
  escapeHtml = markdown.escapeHtml;
  const trendChart = await import('/trend-chart.js');
  formatLongDate = trendChart.formatLongDate;
  tooltipPosition = trendChart.tooltipPosition;
  TREND.TOOLTIP_SIZE = trendChart.TOOLTIP_SIZE;
  TREND.POINT_RADIUS = trendChart.POINT_RADIUS;
  TREND.HIT_TARGET_RADIUS = trendChart.HIT_TARGET_RADIUS;
  const watchlist = await import('/watchlist.js');
  sortWatchlistRows = watchlist.sortRows;
  WATCHLIST_TABS = watchlist.TABS;
}

const root = typeof document !== 'undefined' ? document.getElementById('app') : null;
const navRoot = typeof document !== 'undefined' ? document.getElementById('nav-root') : null;

const CURRENCY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

// Must match server.js's CLIENT_HEADER/CLIENT_HEADER_VALUE — a header a
// cross-origin form or simple request cannot set, checked in addition to
// the Origin header the browser sets on its own. Requirement 004 grew the
// write surface from one endpoint (quotes) to four (cars, trims/add,
// trims/archive too); every write below shares this one constant rather
// than each inventing its own copy of the same header — "follow that
// pattern, don't invent a second one."
const CLIENT_HEADER = 'x-car-tracker-client';
const CLIENT_HEADER_VALUE = '1';

// --- Pure data shaping (exported for tests; no DOM, no HTML) --------------

export function formatCurrency(value) {
  return CURRENCY.format(value);
}

// Requirement 004: line 1 of the basis cell is exactly one of four
// phrases and nothing more. "An average is never shown where the sample
// size is 1" — a listing_average with sampleSize 1 (or missing) reads
// "Single listing" too, same as a plain `listing` basis.
export function basisLineText(price) {
  if (!price) return '';
  const { basis, sampleSize } = price;
  if (basis === 'msrp') return 'MSRP';
  if (basis === 'listing') return 'Single listing';
  if (basis === 'listing_average') {
    return sampleSize && sampleSize > 1 ? `Average of ${sampleSize} listings` : 'Single listing';
  }
  if (basis === 'valuation_estimate') return 'Estimate, not a listing';
  return 'Basis not recorded';
}

export function priceDisplayText(price) {
  const base = formatCurrency(price.value);
  return price.basis === 'valuation_estimate' ? `≈${base}` : base;
}

// Requirement 004: the (i) popover is generated from stored fields —
// sample size, range, note — and must never repeat what line 1 (the
// basis phrase) or line 2 (confirmed mark + source) already say. The
// sample-size fact IS line 1 for the two listing bases ("Single listing"
// / "Average of N listings"), so this never restates a count; it only
// adds what line 1 can't: MSRP's destination-charge caveat, a listing
// average's asking-price range, an estimate's range and the fact that no
// listing confirms it, and — for every basis — the free-text `note`
// field, which is exactly "anything that undercuts the number." Returns
// an array of sentences so callers can join and escape at render time;
// never returns raw unescaped HTML.
export function popoverCopy(price) {
  if (!price) return [];
  const { basis, rangeLow, rangeHigh, note, destination } = price;
  const hasRange = rangeLow != null && rangeHigh != null;
  const sentences = [];

  if (basis === 'msrp') {
    sentences.push("Manufacturer's suggested price.");
    if (destination === false) {
      sentences.push('Excludes the destination charge, so a dealer invoice will read higher.');
    } else if (destination === true) {
      sentences.push('Includes the destination charge.');
    } else {
      sentences.push('Whether this includes the destination charge is not recorded.');
    }
  } else if (basis === 'valuation_estimate') {
    if (hasRange) {
      sentences.push(`Midpoint of a ${formatCurrency(rangeLow)} to ${formatCurrency(rangeHigh)} valuation.`);
    }
    sentences.push('No listing was found to confirm it.');
  } else if (basis === 'listing_average' && hasRange) {
    sentences.push(`Asking prices ranged ${formatCurrency(rangeLow)} to ${formatCurrency(rangeHigh)}.`);
  } else if (hasRange) {
    // A single-listing basis that happens to carry a range on file.
    sentences.push(`Range on file: ${formatCurrency(rangeLow)} to ${formatCurrency(rangeHigh)}.`);
  }

  if (note && note.trim()) sentences.push(note.trim());
  if (sentences.length === 0) sentences.push('No further detail on file for this price.');
  return sentences;
}

// Requirement 008 ("make the source visible"): a source_url is untrusted,
// hand-editable, external content — a stranger's imported tracker.md in
// the web version could carry a `javascript:`/`data:` URL instead of a
// real link. This never trusts the scheme: only `http:`/`https:` is ever
// rendered as a clickable href; anything else (including a value that
// doesn't parse as a URL at all) is shown as escaped plain text, never as
// an href. Pure and DOM-free so it's directly testable without a browser.
export function isSafeHttpUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return false;
  try {
    const parsed = new URL(raw.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// Requirement 008 ("evidence for averages"): formats one sample listing
// (price/mileage/location, from lib/parse-tracker.js's `sampleListings`)
// as a single display line. Mileage is optional on file — `null` just
// omits that segment rather than printing "null mi".
export function sampleListingLine(listing) {
  if (!listing) return '';
  const parts = [formatCurrency(listing.price)];
  if (listing.mileage != null) parts.push(`${listing.mileage.toLocaleString('en-US')} mi`);
  if (listing.location) parts.push(listing.location);
  return parts.join(' · ');
}

// Only meaningful on a `listing_average` (requirement 008: "optional, not
// required — older readings don't have them and must not break"); any
// other basis, or a price with no sample listings on file, renders no
// lines at all rather than an empty section.
export function sampleListingLines(price) {
  if (!price || price.basis !== 'listing_average') return [];
  return (price.sampleListings || []).map(sampleListingLine);
}

// Short tag under a trim name for an active incentive. APR offers try to
// lead with the headline's own "<N>% APR" text; everything else gets a
// fixed, kind-based label — never invented figures.
export function incentiveTagLabel(incentive) {
  if (incentive.kind === 'apr') {
    const match = /^\s*(\d+%\s*APR)/i.exec(incentive.headline ?? '');
    return match ? match[1] : 'APR offer';
  }
  if (incentive.kind === 'customer_cash') return 'Cash offer';
  if (incentive.kind === 'lease') return 'Lease offer';
  return 'Offer';
}

// Groups {year, trim} configs by year so a shared year prints once:
// "2026 Preferred, Premium Sport" instead of repeating the year per trim.
export function formatAppliesTo(configs) {
  const byYear = new Map();
  for (const c of configs) {
    if (!byYear.has(c.year)) byYear.set(c.year, []);
    byYear.get(c.year).push(c.trim);
  }
  return [...byYear.entries()].map(([year, trims]) => `${year} ${trims.join(', ')}`).join('; ');
}

// The leftmost column's single chip — New, CPO or Used. Requirement 004:
// "nothing repeats the year", so this never carries year or trim text.
export function conditionChipLabel(condition) {
  if (condition === 'cpo') return 'CPO';
  if (condition === 'used') return 'Used';
  if (condition === 'new') return 'New';
  return 'Unknown';
}

export function daysParts(days) {
  if (days < 0) {
    const n = Math.abs(days);
    return { number: n, unit: n === 1 ? 'day ago — expired' : 'days ago — expired' };
  }
  if (days === 0) return { number: 0, unit: 'today' };
  return { number: days, unit: days === 1 ? 'day left' : 'days left' };
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// Requirement 004, "the mockup's copy is wrong and must not be copied":
// removing a trim archives it — it does not delete it, and a restore is
// byte-identical (see lib/archive.js and its round-trip test). This
// builds the remove-trim dialog's text from that fact plus the record's
// real counts (lib/tracker-data.js#buildTrimSummaries), never a generic
// warning. Pure and DOM-free so it's testable without a dialog element —
// public/app.js writes every field (including `title`, which carries the
// trim name) with .textContent, not innerHTML, so nothing returned here
// needs pre-escaping.
export function removeTrimCopy(trim, summary) {
  const s = summary || { variantCount: 0, historyMonths: 0, quoteCount: 0 };
  return {
    title: `Remove ${trim} from this watch?`,
    lede: 'Car Watch stops checking prices for this trim and hides it from every screen here. Nothing is deleted.',
    lines: [
      { count: s.variantCount, label: plural(s.variantCount, 'variant') + ' tracked' },
      { count: s.historyMonths, label: plural(s.historyMonths, 'month') + ' of price history' },
      { count: s.quoteCount, label: plural(s.quoteCount, 'quote') + ' logged' },
    ],
    note: 'Add the trim back any time — its price history and quotes return exactly as they were.',
  };
}

// Requirement 004: "Removing a whole watch follows the same
// archive-and-confirm pattern, with the car's name and totals." Same
// non-destructive framing as removeTrimCopy above, and the same reason:
// lib/archive.js#archiveCar only flips a flag, it never touches a
// Configuration, PricePoint or Quote underneath the car, so the record on
// file stays complete. Unlike a trim, there is no self-service "add it
// back" control in this UI yet, so the copy says the record is kept
// rather than promising a specific button that doesn't exist.
export function removeWatchCopy(car, summary) {
  const s = summary || { trimCount: 0, variantCount: 0, historyMonths: 0, quoteCount: 0 };
  const name = [car?.make, car?.model].filter(Boolean).join(' ') || 'this car';
  return {
    title: `Remove ${name} from your watches?`,
    lede: 'Car Watch stops checking prices for this watch and hides it, and its history, from every screen here. Nothing is deleted.',
    lines: [
      { count: s.trimCount, label: plural(s.trimCount, 'trim') + ' tracked' },
      { count: s.variantCount, label: plural(s.variantCount, 'variant') + ' tracked' },
      { count: s.historyMonths, label: plural(s.historyMonths, 'month') + ' of price history' },
      { count: s.quoteCount, label: plural(s.quoteCount, 'quote') + ' logged' },
    ],
    note: 'The record stays on file — its full history remains intact, exactly as it was.',
  };
}

// Requirement 004: "The header shows the cadence and due date, derived as
// last check + 14 days." checkIntervalDays is 14 today but not hard-coded
// here — a whole-week interval reads as weeks (matching
// reference/03-car-detail.html's "Checked every 2 weeks"), anything else
// falls back to days so the copy stays honest if the interval is ever
// something other than two weeks.
export function cadenceLabel(checkIntervalDays) {
  const days = Number(checkIntervalDays);
  if (!Number.isFinite(days) || days <= 0) return 'Checked on demand';
  if (days % 7 === 0) return `Checked every ${plural(days / 7, 'week')}`;
  return `Checked every ${plural(days, 'day')}`;
}

// Requirement 004: "The action reads Check now when a check is due, and
// Check again on <date> when it is not. Both open the same form."
// `readingsForm` is lib/tracker-data.js#buildReadingsForm's shape —
// `checkDue` and `dueDateLabel` are both derived there; this only turns
// them into the button's copy.
export function checkActionLabel(readingsForm) {
  if (!readingsForm || readingsForm.checkDue || !readingsForm.dueDateLabel) return 'Check now';
  return `Check again on ${readingsForm.dueDateLabel}`;
}

// --- HTML rendering (browser only; uses escapeHtml) ------------------------

function statusMarkHtml(confirmed) {
  return confirmed
    ? '<span class="status-mark status-confirmed"><span class="status-dot-mark"></span>Confirmed</span>'
    : '<span class="status-mark status-unconfirmed"><span class="status-ring-mark"></span>Unconfirmed</span>';
}

function conditionChipHtml(condition) {
  const label = conditionChipLabel(condition);
  const variant = ['new', 'cpo', 'used'].includes(condition) ? condition : 'new';
  return `<span class="condition-chip condition-chip-${variant}">${escapeHtml(label)}</span>`;
}

function popoverId(configurationId) {
  return `basis-popover-${configurationId}`;
}

// Requirement 008 ("make the source visible"): shown inside the (i),
// alongside the source name already visible on the source-line below it.
// `source_url` is hand-editable, external, untrusted content — see
// `isSafeHttpUrl` — so only an http(s) value ever becomes a clickable
// href; anything else (including "none on file") is plain escaped text.
function sourceUrlPopoverHtml(price) {
  const url = (price.sourceUrl || '').trim();
  const name = escapeHtml(price.source || 'source not recorded');
  if (!url) return `<span class="popover-source-url">Source: ${name} — no source URL on file.</span>`;
  const safe = isSafeHttpUrl(url);
  const escapedUrl = escapeHtml(url);
  const urlHtml = safe
    ? `<a href="${escapedUrl}" target="_blank" rel="noopener noreferrer">${escapedUrl}</a>`
    : escapedUrl;
  return `<span class="popover-source-url">Source: ${name} — ${urlHtml}</span>`;
}

// Requirement 008 ("evidence for averages") — optional, so [] renders
// nothing rather than an empty heading.
function sampleListingsPopoverHtml(price) {
  const lines = sampleListingLines(price);
  if (lines.length === 0) return '';
  const items = lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('');
  return `<div class="popover-sample-listings">Sample listings:<ul>${items}</ul></div>`;
}

function priceBasisCellHtml(row) {
  if (!row.price) {
    return `
      <div class="price-basis-cell">
        <div class="basis-line price-missing">No prices yet</div>
      </div>
    `;
  }
  const price = row.price;
  const lineText = basisLineText(price);
  const copy = popoverCopy(price).map((s) => escapeHtml(s)).join(' ');
  const pid = popoverId(row.configurationId);
  return `
    <div class="price-basis-cell">
      <div class="basis-line-row">
        <span class="basis-line">${escapeHtml(lineText)}</span>
        <button type="button" class="basis-info-btn" data-popover-target="${escapeHtml(pid)}" aria-expanded="false" aria-label="What ${escapeHtml(lineText.toLowerCase())} means here">i</button>
        <span class="basis-popover" id="${escapeHtml(pid)}" role="note" hidden>
          <span class="popover-copy">${copy}</span>
          ${sourceUrlPopoverHtml(price)}
          ${sampleListingsPopoverHtml(price)}
        </span>
      </div>
      <div class="source-line">${statusMarkHtml(price.confirmed)}${escapeHtml(price.source || 'source not recorded')}</div>
    </div>
  `;
}

// The "+ Log quote" control belongs on every condition row, including new
// ones (requirement 004, "quotes"), and is display-only otherwise: the
// count is shown, never affected by anything but a real logged quote.
function logQuoteButtonHtml(configurationId) {
  const targetId = `quote-form-${configurationId}`;
  return `<button type="button" class="log-quote-btn" data-target="${escapeHtml(targetId)}" aria-expanded="false" aria-controls="${escapeHtml(targetId)}">+ Log quote</button>`;
}

function quoteFormRowHtml(configurationId) {
  const uid = `quote-form-${configurationId}`;
  const idFor = (field) => `${uid}-${field}`;
  return `
    <div class="quote-form-row" id="${escapeHtml(uid)}" hidden>
      <form class="quote-form" data-configuration-id="${escapeHtml(configurationId)}" novalidate>
        <div class="quote-form-field" data-field="value">
          <label for="${escapeHtml(idFor('value'))}">Value ($)</label>
          <input type="text" inputmode="decimal" autocomplete="off" id="${escapeHtml(idFor('value'))}" name="value" required />
          <div class="quote-form-error" data-error-for="value"></div>
        </div>
        <div class="quote-form-field" data-field="dealer">
          <label for="${escapeHtml(idFor('dealer'))}">Dealer</label>
          <input type="text" autocomplete="off" maxlength="200" id="${escapeHtml(idFor('dealer'))}" name="dealer" required />
          <div class="quote-form-error" data-error-for="dealer"></div>
        </div>
        <div class="quote-form-field quote-form-field-wide" data-field="note">
          <label for="${escapeHtml(idFor('note'))}">Note (optional)</label>
          <input type="text" autocomplete="off" maxlength="500" id="${escapeHtml(idFor('note'))}" name="note" />
          <div class="quote-form-error" data-error-for="note"></div>
        </div>
        <div class="quote-form-actions">
          <button type="submit" class="quote-form-submit">Log quote</button>
          <button type="button" class="quote-form-cancel">Cancel</button>
        </div>
        <div class="quote-form-error quote-form-error-form" data-error-for="form"></div>
      </form>
    </div>
  `;
}

function quotesCellHtml(row) {
  const count = row.quoteCount;
  return `
    <div class="quotes-cell">
      <span class="quotes-count${count === 0 ? ' quotes-count-zero' : ''}">${count}</span>
      ${logQuoteButtonHtml(row.configurationId)}
    </div>
  `;
}

// SVG coordinates are already computed server-side (lib/trend-chart.js) —
// round for a tidier markup string only, never for correctness.
function num(n) {
  return Math.round(n * 100) / 100;
}

function svgPathD(points) {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${num(p.x)} ${num(p.y)}`).join(' ');
}

// The row sparkline (112x44, requirement 004: "the same structure in
// miniature, not a different encoding") — dotted month divider(s),
// baseline, the line itself, a point per reading (the latest slightly
// larger), and month-letter labels. `spark` is null whenever the
// configuration doesn't qualify for a trend yet (see buildRowSparklines
// in lib/tracker-data.js), so callers must check before calling this.
function rowSparklineSvgHtml(spark) {
  const dividers = spark.monthDividers
    .map(
      (x) =>
        `<line x1="${num(x)}" y1="${spark.dividerTop}" x2="${num(x)}" y2="${spark.baselineY}" stroke="#2A2F37" stroke-width="1" stroke-dasharray="2 3"/>`
    )
    .join('');
  const circles = spark.points
    .map((p, i) => {
      const r = i === spark.points.length - 1 ? 3.5 : 2.5;
      return `<circle cx="${num(p.x)}" cy="${num(p.y)}" r="${r}" fill="${spark.color}"/>`;
    })
    .join('');
  const labels = spark.monthLabels
    .map(
      (m) =>
        `<text x="${num(m.x)}" y="41" text-anchor="middle" fill="#8B929E" font-family="IBM Plex Mono, monospace" font-size="9">${escapeHtml(m.name)}</text>`
    )
    .join('');
  return `
    <svg width="112" height="44" viewBox="0 0 112 44" aria-hidden="true">
      ${dividers}
      <line x1="8" y1="${spark.baselineY}" x2="104" y2="${spark.baselineY}" stroke="#262A31" stroke-width="1"/>
      <path d="${svgPathD(spark.points)}" fill="none" stroke="${spark.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      ${circles}
      ${labels}
    </svg>
  `;
}

// Requirement 004: rows without two dated readings keep the plain trend
// text ("MSRP — no trend" / "Awaiting next reading" / "N readings
// tracked"); rows that qualify swap it for the sparkline plus the dollar
// change since the first reading.
function trendCellHtml(row) {
  const spark = row.trend.sparkline;
  if (spark) {
    return `
      <div class="row-sparkline">
        ${rowSparklineSvgHtml(spark)}
        <span class="row-sparkline-change">${escapeHtml(spark.changeLabel)}</span>
      </div>
    `;
  }
  const trendClass = row.trend.available ? 'trend-text trend-text-tracked' : 'trend-text';
  return `<div class="${trendClass}">${escapeHtml(row.trend.text)}</div>`;
}

function conditionRowHtml(row) {
  return `
    <div class="condition-row">
      <div>${conditionChipHtml(row.condition)}</div>
      <div class="price-cell${row.price?.basis === 'valuation_estimate' ? ' price-cell-estimate' : ''}">${row.price ? escapeHtml(priceDisplayText(row.price)) : '<span class="price-missing">—</span>'}</div>
      ${priceBasisCellHtml(row)}
      ${trendCellHtml(row)}
      ${quotesCellHtml(row)}
    </div>
    ${quoteFormRowHtml(row.configurationId)}
  `;
}

// Groups a group's flat, trim-sorted rows into consecutive same-trim
// clusters — the third nesting level (trim heading) the price table
// needs, drawn from data that's flat at the buildCarDetail boundary (see
// lib/tracker-data.js#buildGroups: rows are sorted by trim already, so a
// simple run-length grouping is enough; no re-sort here).
function clusterByTrim(rows) {
  const clusters = [];
  for (const row of rows) {
    const last = clusters[clusters.length - 1];
    if (last && last.trim === row.trim) last.rows.push(row);
    else clusters.push({ trim: row.trim, rows: [row] });
  }
  return clusters;
}

// Requirement 004: "A trim belongs to the watch, not to a model year —
// removing it applies across every year at once." The button therefore
// carries only carId + trim (never a year or configuration id), and
// opens the shared remove-trim dialog (#remove-trim-dialog, static in
// index.html) rather than posting directly — see
// attachRemoveTrimDialogHandlers below.
function removeTrimButtonHtml(carId, trim) {
  return `<button type="button" class="trim-remove-btn" data-car-id="${escapeHtml(carId)}" data-trim="${escapeHtml(trim)}">Remove trim</button>`;
}

function trimHeadingHtml(cluster, carId) {
  const countHtml =
    cluster.rows.length > 1 ? `<span class="trim-heading-count">${cluster.rows.length} conditions</span>` : '';
  return `
    <div class="trim-heading">
      <h3 class="trim-heading-name">${escapeHtml(cluster.trim)}</h3>
      ${countHtml}
      ${removeTrimButtonHtml(carId, cluster.trim)}
    </div>
    ${cluster.rows.map(conditionRowHtml).join('')}
  `;
}

// A group is one year+condition-category band ("2026 · New", "2025 · New
// leftover", "2025 · Pre-owned" — requirement 004, "price table"). Its
// `chip` (incentive coverage) is computed in lib/tracker-data.js but not
// rendered here: the change list removes the "Incentives apply" chip
// from the bands, since the incentives pill/panel already says it in
// more detail — the data layer still returns it in case a later screen
// (e.g. the watchlist row) wants it.
function groupHtml(group, carId) {
  return `
    <div class="year-band">
      <div class="year-band-header">
        <h2 class="year-band-year">${escapeHtml(group.heading)}</h2>
        <span class="year-band-subtitle">${escapeHtml(group.subtitle)}</span>
      </div>
      ${clusterByTrim(group.rows).map((cluster) => trimHeadingHtml(cluster, carId)).join('')}
    </div>
  `;
}

function tileHtml(label, valueHtml, subtitle, extraClass = '') {
  return `
    <div class="tile ${extraClass}">
      <div class="tile-label">${escapeHtml(label)}</div>
      <div class="tile-value">${valueHtml}</div>
      <div class="tile-subtitle">${escapeHtml(subtitle)}</div>
    </div>
  `;
}

function summaryTilesHtml(summary) {
  const lowest = summary.lowestPrice.value !== null
    ? tileHtml('Lowest price tracked', escapeHtml(formatCurrency(summary.lowestPrice.value)), summary.lowestPrice.label)
    : tileHtml('Lowest price tracked', '—', summary.lowestPrice.reason);

  const newYear = summary.newYearStart.value !== null
    ? tileHtml(`New ${escapeHtml(summary.newYearStart.year)} starts at`, escapeHtml(formatCurrency(summary.newYearStart.value)), summary.newYearStart.label)
    : tileHtml('New model year starts at', '—', summary.newYearStart.reason);

  let countdown;
  if (summary.countdown.days !== null) {
    const { number, unit } = daysParts(summary.countdown.days);
    countdown = tileHtml(
      'Incentives expire in',
      `<span class="tile-value-number">${number}</span> <span class="tile-value-unit">${escapeHtml(unit)}</span>`,
      summary.countdown.subtitle,
      summary.countdown.urgent ? 'tile-warning' : ''
    );
  } else {
    countdown = tileHtml('Incentives expire in', '—', summary.countdown.reason);
  }

  const quotes = tileHtml(
    'Dealer quotes logged',
    `<span class="${summary.quotesLogged.count === 0 ? 'tile-value-dim' : ''}">${summary.quotesLogged.count}</span>`,
    summary.quotesLogged.subtitle,
    'tile-quotes'
  );

  return `<div class="summary-tiles">${lowest}${newYear}${countdown}${quotes}</div>`;
}

// --- Incentives: header pill + toggled panel (requirement 004) ------------

// Persists across SSE re-renders the same way `activeTab` did in the 003
// screen — a module-level variable read at render time, not reset by it.
let incentivesOpen = true;

function incentivesPillHtml(incentivesData) {
  if (!incentivesData.blocks.length) return '';
  const n = incentivesData.activeCount;
  const label = incentivesData.countdown
    ? `Incentives · ${n} · ${incentivesData.countdown.days} ${incentivesData.countdown.days === 1 ? 'day' : 'days'}`
    : `Incentives · ${n}`;
  return `
    <button type="button" class="incentives-pill${incentivesOpen ? ' incentives-pill-selected' : ''}" aria-pressed="${incentivesOpen}">
      <span class="incentives-pill-dot" aria-hidden="true"></span>${escapeHtml(label)}
    </button>
  `;
}

// Requirement 004: "Removing a whole watch follows the same
// archive-and-confirm pattern." Carries only the car id — the dialog pulls
// the name and totals itself (openRemoveWatchDialog) — and opens the
// shared #remove-watch-dialog rather than posting directly.
function removeWatchButtonHtml(carId) {
  return `<button type="button" class="trim-remove-btn watch-remove-btn" data-car-id="${escapeHtml(carId)}">Remove watch</button>`;
}

// Requirement 004: "Both open the same form" — Check now and Check again
// share one button, which opens the record-readings dialog
// (readingsDialogHtml below). The cadence line sits to its left, exactly
// as reference/03-car-detail.html draws "Checked every 2 weeks / Next
// check Oct 6" beside the button, on two lines via <br>.
function checkActionHtml(readingsForm) {
  const cadence = escapeHtml(cadenceLabel(readingsForm.checkIntervalDays));
  // fix/002: "if there is a check date, it should also list the next date
  // that can be checked" — dueDateLabel and lastCheckedLabel are both set
  // or both null together (lib/tracker-data.js#buildReadingsForm derives
  // one from the other), so the presence of either is a reliable switch.
  const dueLine = readingsForm.dueDateLabel
    ? `Last checked ${escapeHtml(readingsForm.lastCheckedLabel)} &middot; Next check ${escapeHtml(readingsForm.dueDateLabel)}`
    : 'No check on file yet';
  return `
    <div class="check-cadence">${cadence}<br>${dueLine}</div>
    <button type="button" class="check-action-btn" data-open-readings-dialog>${escapeHtml(checkActionLabel(readingsForm))}</button>
  `;
}

function modelHeaderHtml(car, incentivesData, readingsForm) {
  return `
    <div class="model-header">
      <div class="model-header-text">
        <div class="model-eyebrow">${escapeHtml([car.make, car.yearsLabel].filter(Boolean).join(' · '))}</div>
        <h1 class="model-title">${escapeHtml(car.model)}</h1>
      </div>
      <div class="header-actions">
        ${incentivesPillHtml(incentivesData)}
        ${checkActionHtml(readingsForm)}
        ${removeWatchButtonHtml(car.id)}
      </div>
    </div>
  `;
}

function incentiveBlockHtml(block) {
  const termsLine = [block.terms, block.provider].filter(Boolean).join(' · ') || (block.source ? `Reported by ${block.source}` : '');
  return `
    <div class="incentive-block ${block.expired ? 'incentive-expired' : ''}">
      <div class="incentive-block-top">
        <span class="incentive-headline">${escapeHtml(block.headline)}</span>
        ${statusMarkHtml(block.confirmed)}
      </div>
      ${termsLine ? `<div class="incentive-terms">${escapeHtml(termsLine)}</div>` : ''}
      <div class="incentive-applies">${escapeHtml(formatAppliesTo(block.appliesTo))}${block.expired ? ' — expired' : ''}</div>
    </div>
  `;
}

function conflictHtml(conflict) {
  const configs = escapeHtml(formatAppliesTo(conflict.configs));
  return `
    <div class="incentive-conflict">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.5"/></svg>
      <div class="conflict-text">Sources disagree on ${configs}: ${escapeHtml(conflict.amountA)} (${escapeHtml(conflict.sourceA || 'source not recorded')}) vs ${escapeHtml(conflict.amountB)} (${escapeHtml(conflict.sourceB || 'source not recorded')}). Confirm the current amount directly before relying on either figure.</div>
    </div>
  `;
}

const CLOSE_ICON_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

function incentivesPanelHtml(incentivesData) {
  if (!incentivesData.blocks.length) return '';

  const countdownHtml = incentivesData.countdown
    ? (() => {
        const { number, unit } = daysParts(incentivesData.countdown.days);
        return `
          <div class="rail-countdown ${incentivesData.countdown.urgent ? 'rail-countdown-urgent' : ''}">
            <div class="rail-countdown-number">${number}</div>
            <div class="rail-countdown-text">
              <h2 class="rail-countdown-heading">${escapeHtml(unit)}</h2>
              <div class="rail-countdown-subtitle">${escapeHtml(incentivesData.countdown.subtitle)}</div>
            </div>
            <button type="button" class="incentives-close-btn" aria-label="Hide incentives">${CLOSE_ICON_SVG}</button>
          </div>
        `;
      })()
    : `
      <div class="rail-countdown rail-countdown-none">
        <div class="rail-countdown-text">
          <h2 class="rail-countdown-heading">No active incentive deadlines</h2>
          <div class="rail-countdown-subtitle">All offers on file have expired.</div>
        </div>
        <button type="button" class="incentives-close-btn" aria-label="Hide incentives">${CLOSE_ICON_SVG}</button>
      </div>
    `;

  const conflictsHtml = incentivesData.conflicts.map(conflictHtml).join('');
  const panelClass = incentivesData.countdown?.urgent ? 'rail-panel-warning' : '';

  return `
    <aside aria-label="Incentives" class="incentives-aside"${incentivesOpen ? '' : ' hidden'}>
      <section class="rail-panel ${panelClass}">
        ${countdownHtml}
        ${incentivesData.blocks.map(incentiveBlockHtml).join('')}
        ${conflictsHtml}
      </section>
    </aside>
  `;
}

// Requirement 004: "+ Add a trim sits at the foot of the table." A trim
// belongs to the watch, not a year, so — unlike the per-configuration
// quote form — this posts only {carId, trim} to POST /trims/add, which
// creates one Configuration per year × condition the watch already
// tracks (lib/trims.js), or restores an archived trim's history intact
// if the name matches one that was removed before. Same toggle/inline-
// error pattern as quoteFormRowHtml above.
function addTrimRowHtml(carId) {
  const uid = 'add-trim-form';
  return `
    <div class="add-trim-row">
      <button type="button" class="add-trim-toggle" data-target="${uid}" aria-expanded="false" aria-controls="${uid}">+ Add a trim</button>
      <div class="add-trim-form-wrap" id="${uid}" hidden>
        <form class="add-trim-form" data-car-id="${escapeHtml(carId)}" novalidate>
          <div class="add-trim-field">
            <label for="${uid}-input">Trim name</label>
            <input type="text" autocomplete="off" maxlength="60" id="${uid}-input" name="trim" required />
            <div class="add-trim-error" data-error-for="trim"></div>
          </div>
          <div class="add-trim-actions">
            <button type="submit" class="add-trim-submit">Add trim</button>
            <button type="button" class="add-trim-cancel">Cancel</button>
          </div>
          <div class="add-trim-error add-trim-error-form" data-error-for="form"></div>
        </form>
      </div>
    </div>
  `;
}

function pricesPanelHtml(groups, carId) {
  return `
    <section aria-label="Prices by year and trim" class="prices-panel">
      <div class="prices-columns">
        <div>Condition</div><div class="col-price-head">Price</div><div>Basis and source</div><div>Trend</div><div class="col-quotes-head">Quotes</div>
      </div>
      ${groups.map((group) => groupHtml(group, carId)).join('')}
      ${addTrimRowHtml(carId)}
      <div class="prices-footer">Quotes you log are yours alone — they never move the trend line.</div>
    </section>
  `;
}

// --- Trend chart (requirement 004, stage 3) --------------------------------
//
// `data.trendChart` (lib/tracker-data.js -> lib/trend-chart.js) already
// carries every pixel position, so this section only serializes it to SVG
// and wires up hover. When `hasSeries` is false — today's real data has
// exactly one reading per variant, so this is what actually ships — an
// honest empty state renders instead of an empty chart frame or a flat
// line through a single point (see trendChartEmptyHtml below).

function usedOrCpoRowCount(groups) {
  let n = 0;
  for (const group of groups) {
    for (const row of group.rows) {
      if (row.condition === 'used' || row.condition === 'cpo') n++;
    }
  }
  return n;
}

function trendChartEmptyHtml(groups) {
  const message =
    usedOrCpoRowCount(groups) > 0
      ? 'A trend starts at the second reading. Every used and CPO variant tracked so far has just one — check again to start the line.'
      : 'No used or CPO trims are being watched yet. New trims sit at MSRP and never carry a trend line.';
  return `
    <section aria-label="Used and CPO price trend" class="trend-chart-section">
      <div class="trend-chart-header">
        <h2 class="trend-chart-title">Used and CPO prices</h2>
      </div>
      <p class="trend-chart-empty">${escapeHtml(message)}</p>
    </section>
  `;
}

function trendYAxisHtml(ticks, plot) {
  return ticks
    .map((t) => {
      const isBaseline = Math.abs(t.y - plot.yBaseline) < 0.01;
      const stroke = isBaseline ? '#2A2F37' : '#22262C';
      return `
        <line x1="${plot.x0}" y1="${num(t.y)}" x2="${plot.x1}" y2="${num(t.y)}" stroke="${stroke}" stroke-width="1"/>
        <text x="${plot.x0 - 8}" y="${num(t.y + 4)}" text-anchor="end" fill="#8B929E" font-family="IBM Plex Mono, monospace" font-size="11">${escapeHtml(t.label)}</text>
      `;
    })
    .join('');
}

function trendMonthsHtml(chart) {
  const plot = chart.plot;
  const dividers = chart.monthDividers
    .map(
      (x) =>
        `<line x1="${num(x)}" y1="${plot.yTop}" x2="${num(x)}" y2="${plot.yBaseline + 14}" stroke="#2A2F37" stroke-width="1" stroke-dasharray="3 4"/>`
    )
    .join('');
  const labels = chart.months
    .map(
      (m) =>
        `<text x="${num(m.x)}" y="${plot.yBaseline + 32}" text-anchor="middle" fill="#B4BAC4" font-family="IBM Plex Mono, monospace" font-size="12" letter-spacing="1.5">${escapeHtml(m.name)}</text>`
    )
    .join('');
  return dividers + labels;
}

function trendWeekTicksHtml(chart) {
  const plot = chart.plot;
  return chart.weekTicks
    .map((t) => {
      const len = t.heavy ? 8 : 6;
      const stroke = t.heavy ? '#4A505A' : '#353B45';
      const width = t.heavy ? 2 : 1;
      return `<line x1="${num(t.x)}" y1="${plot.yBaseline}" x2="${num(t.x)}" y2="${plot.yBaseline + len}" stroke="${stroke}" stroke-width="${width}"/>`;
    })
    .join('');
}

function trendSeriesHtml(series) {
  return series
    .map((s) => {
      const circles = s.points
        .map((p) => `<circle cx="${num(p.x)}" cy="${num(p.y)}" r="${TREND.POINT_RADIUS}" fill="${s.color}" stroke="#181B20" stroke-width="2"/>`)
        .join('');
      return `<path d="${svgPathD(s.points)}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>${circles}`;
    })
    .join('');
}

// Requirement 004: "Only the latest value on each line is labelled
// directly." Flips to the left of the point (text-anchor end) when the
// point sits too close to the plot's right edge for a right-hand label to
// fit without clipping.
function trendLatestLabelsHtml(series, plot) {
  return series
    .map((s) => {
      const p = s.latest;
      const crowded = p.x > plot.x1 - 68;
      const x = crowded ? num(p.x - 12) : num(p.x + 12);
      const anchor = crowded ? 'end' : 'start';
      return `<text x="${x}" y="${num(p.y + 4)}" text-anchor="${anchor}" fill="#B4BAC4" font-family="IBM Plex Mono, monospace" font-size="12">${escapeHtml(formatCurrency(p.value))}</text>`;
    })
    .join('');
}

// Invisible 16px hit targets over each 5px point (requirement 004: "Hit
// target 16px against a 5px mark"). Drawn last so they sit on top of
// everything else for pointer capture, same order as the reference
// artboard's own SVG. Carries its hover payload in data-* attributes,
// pre-escaped for safe attribute embedding; attachTrendChartHandlers
// reads them back and writes them into the tooltip via textContent, which
// never interprets markup regardless of what's in the string.
function trendHitCirclesHtml(series) {
  const circles = [];
  for (const s of series) {
    s.points.forEach((p) => {
      circles.push(
        `<circle class="trend-hit" tabindex="0" cx="${num(p.x)}" cy="${num(p.y)}" r="${TREND.HIT_TARGET_RADIUS}" fill="#FFFFFF" fill-opacity="0" data-x="${num(p.x)}" data-y="${num(p.y)}" data-date="${escapeHtml(formatLongDate(p.date))}" data-label="${escapeHtml(`${s.label} · ${formatCurrency(p.value)}`)}"></circle>`
      );
    });
  }
  return circles.join('');
}

function trendChartAriaLabel(series) {
  return series
    .map((s) => {
      const first = s.points[0];
      const last = s.latest;
      const verb = last.value < first.value ? 'fell' : last.value > first.value ? 'rose' : 'held steady';
      return `${s.label} ${verb} from ${formatCurrency(first.value)} to ${formatCurrency(last.value)}`;
    })
    .join('. ');
}

function trendChartHtml(trendChart, groups) {
  if (!trendChart || !trendChart.hasSeries) return trendChartEmptyHtml(groups);

  const plot = trendChart.plot;
  const legend = trendChart.series
    .map(
      (s) =>
        `<span class="trend-chart-legend-item"><span class="trend-chart-legend-dot" style="background:${s.color}"></span>${escapeHtml(s.label)}</span>`
    )
    .join('');

  return `
    <section aria-label="Used and CPO price trend" class="trend-chart-section">
      <div class="trend-chart-header">
        <h2 class="trend-chart-title">Used and CPO prices</h2>
        <span class="trend-chart-hint">Hover a point for its exact date</span>
      </div>
      <div class="trend-chart-legend">${legend}</div>
      <svg width="100%" height="270" viewBox="0 0 700 270" role="img" class="trend-chart-svg" aria-label="${escapeHtml(trendChartAriaLabel(trendChart.series))}">
        ${trendYAxisHtml(trendChart.yAxisTicks, plot)}
        ${trendMonthsHtml(trendChart)}
        ${trendWeekTicksHtml(trendChart)}
        ${trendSeriesHtml(trendChart.series)}
        ${trendLatestLabelsHtml(trendChart.series, plot)}
        <g class="trend-crosshair" hidden>
          <line class="trend-crosshair-line" x1="0" y1="${plot.yTop}" x2="0" y2="${plot.yBaseline}" stroke="#4A505A" stroke-width="1"/>
          <circle class="trend-crosshair-ring" cx="0" cy="0" r="8" fill="none" stroke="#ECEDEF" stroke-width="2"/>
          <g class="trend-tooltip-group">
            <rect class="trend-tooltip-rect" width="${TREND.TOOLTIP_SIZE.width}" height="${TREND.TOOLTIP_SIZE.height}" rx="8" fill="#0B0C0E" stroke="#3A4450" stroke-width="1"/>
            <text class="trend-tooltip-date" x="14" y="22" fill="#ECEDEF" font-family="Archivo, sans-serif" font-size="12" font-weight="600"></text>
            <text class="trend-tooltip-value" x="14" y="41" fill="#B4BAC4" font-family="IBM Plex Mono, monospace" font-size="12"></text>
          </g>
        </g>
        ${trendHitCirclesHtml(trendChart.series)}
      </svg>
      <div class="trend-chart-footnote">Months label the axis; the exact date is on hover.</div>
    </section>
  `;
}

// Hover (mouse) and focus (keyboard) both open the same crosshair/tooltip,
// same reachability rationale as the (i) popovers just below: a
// hover-only chart would make the exact date unreachable without a mouse.
function attachTrendChartHandlers() {
  if (!root) return;
  const svg = root.querySelector('.trend-chart-svg');
  if (!svg) return;
  const crosshair = svg.querySelector('.trend-crosshair');
  const line = svg.querySelector('.trend-crosshair-line');
  const ring = svg.querySelector('.trend-crosshair-ring');
  const tooltipGroup = svg.querySelector('.trend-tooltip-group');
  const dateEl = svg.querySelector('.trend-tooltip-date');
  const valueEl = svg.querySelector('.trend-tooltip-value');
  if (!crosshair || !line || !ring || !tooltipGroup || !dateEl || !valueEl) return;

  function show(hit) {
    const x = Number(hit.dataset.x);
    const y = Number(hit.dataset.y);
    const pos = tooltipPosition({ x, y });
    line.setAttribute('x1', String(x));
    line.setAttribute('x2', String(x));
    ring.setAttribute('cx', String(x));
    ring.setAttribute('cy', String(y));
    tooltipGroup.setAttribute('transform', `translate(${pos.left}, ${pos.top})`);
    dateEl.textContent = hit.dataset.date;
    valueEl.textContent = hit.dataset.label;
    crosshair.hidden = false;
  }
  function hide() {
    crosshair.hidden = true;
  }

  svg.querySelectorAll('.trend-hit').forEach((hit) => {
    hit.addEventListener('mouseenter', () => show(hit));
    hit.addEventListener('mouseleave', hide);
    hit.addEventListener('focus', () => show(hit));
    hit.addEventListener('blur', hide);
  });
}

// --- (i) popovers: hover + keyboard focus, one at a time (requirement 004,
// 2026-09-24: Ian reversed the design's click behaviour — see
// docs/decisions.md, "(i) popovers open on hover, not click"). Hover
// alone would make the popover content (sample sizes, ranges, the
// caveats behind a number) unreachable without a mouse, so focus opens
// the same panel and blur closes it. A short delay before hiding on
// mouse-out lets a pointer cross from the button into the panel itself
// without dismissing text mid-sentence; entering either element cancels
// a pending hide. ---------------------------------------------------------

const POPOVER_HIDE_DELAY_MS = 300;
let popoverHideTimer = null;

function closeAllPopovers() {
  if (!root) return;
  root.querySelectorAll('.basis-popover').forEach((el) => {
    el.hidden = true;
  });
  root.querySelectorAll('.basis-info-btn').forEach((btn) => {
    btn.setAttribute('aria-expanded', 'false');
  });
}

function cancelPendingPopoverClose() {
  if (popoverHideTimer) {
    clearTimeout(popoverHideTimer);
    popoverHideTimer = null;
  }
}

function openPopover(button) {
  const target = document.getElementById(button.dataset.popoverTarget);
  if (!target) return;
  cancelPendingPopoverClose();
  if (target.hidden) closeAllPopovers(); // still one at a time
  target.hidden = false;
  button.setAttribute('aria-expanded', 'true');
}

function closePopoverNow(button) {
  const target = document.getElementById(button.dataset.popoverTarget);
  cancelPendingPopoverClose();
  if (target) target.hidden = true;
  button.setAttribute('aria-expanded', 'false');
}

function schedulePopoverClose(button) {
  cancelPendingPopoverClose();
  popoverHideTimer = setTimeout(() => {
    closePopoverNow(button);
    popoverHideTimer = null;
  }, POPOVER_HIDE_DELAY_MS);
}

function attachPopoverHandlers() {
  if (!root) return;
  root.querySelectorAll('.basis-info-btn').forEach((btn) => {
    const target = document.getElementById(btn.dataset.popoverTarget);
    btn.addEventListener('mouseenter', () => openPopover(btn));
    btn.addEventListener('mouseleave', () => schedulePopoverClose(btn));
    btn.addEventListener('focus', () => openPopover(btn));
    btn.addEventListener('blur', () => closePopoverNow(btn));
    if (target) {
      target.addEventListener('mouseenter', cancelPendingPopoverClose);
      target.addEventListener('mouseleave', () => schedulePopoverClose(btn));
    }
  });
}

// --- Incentives pill/panel toggle (requirement 004) ------------------------

function syncIncentivesUi() {
  if (!root) return;
  const pill = root.querySelector('.incentives-pill');
  const aside = root.querySelector('.incentives-aside');
  if (pill) {
    pill.setAttribute('aria-pressed', String(incentivesOpen));
    pill.classList.toggle('incentives-pill-selected', incentivesOpen);
  }
  if (aside) aside.hidden = !incentivesOpen;
}

function attachIncentivesHandlers() {
  if (!root) return;
  const pill = root.querySelector('.incentives-pill');
  if (pill) {
    pill.addEventListener('click', () => {
      incentivesOpen = !incentivesOpen;
      syncIncentivesUi();
    });
  }
  const closeBtn = root.querySelector('.incentives-close-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      incentivesOpen = false;
      syncIncentivesUi();
      // The panel's × returns focus to the pill it belongs to (requirement
      // 004) rather than dropping focus back to <body>.
      if (pill) pill.focus();
    });
  }
}

// --- Quote form (requirement 003, stage 3: the app's only write path) ---

function clearQuoteFormErrors(form) {
  form.querySelectorAll('.quote-form-error').forEach((el) => {
    el.textContent = '';
  });
  form.querySelectorAll('.quote-form-field').forEach((el) => el.classList.remove('has-error'));
}

// Writes server-returned error text straight into the existing form's DOM
// — no re-render, so nothing the user already typed is touched or lost.
function showQuoteFormErrors(form, errors) {
  clearQuoteFormErrors(form);
  for (const [field, message] of Object.entries(errors ?? {})) {
    const errorEl = form.querySelector(`[data-error-for="${field}"]`);
    if (errorEl) errorEl.textContent = message;
    const fieldWrap = form.querySelector(`.quote-form-field[data-field="${field}"]`);
    if (fieldWrap) fieldWrap.classList.add('has-error');
  }
}

function closeQuoteForm(formRow) {
  if (!formRow) return;
  formRow.hidden = true;
  const form = formRow.querySelector('form');
  if (form) {
    form.reset();
    clearQuoteFormErrors(form);
  }
  const toggleBtn = root.querySelector(`.log-quote-btn[data-target="${formRow.id}"]`);
  if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');
}

function toggleQuoteForm(button) {
  const target = document.getElementById(button.dataset.target);
  if (!target) return;
  const opening = target.hidden;
  target.hidden = !opening;
  button.setAttribute('aria-expanded', String(opening));
  if (opening) {
    const firstInput = target.querySelector('input');
    if (firstInput) firstInput.focus();
  }
}

async function handleQuoteSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const submitBtn = form.querySelector('.quote-form-submit');
  clearQuoteFormErrors(form);
  if (submitBtn) submitBtn.disabled = true;

  const payload = {
    configuration: form.dataset.configurationId,
    value: form.elements.value.value,
    dealer: form.elements.dealer.value,
    note: form.elements.note.value,
  };

  try {
    const response = await fetch('/quotes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [CLIENT_HEADER]: CLIENT_HEADER_VALUE,
      },
      body: JSON.stringify(payload),
    });

    let result;
    try {
      result = await response.json();
    } catch {
      result = { ok: false, errors: { form: 'Unexpected response from the server.' } };
    }

    if (!response.ok || !result.ok) {
      showQuoteFormErrors(form, result.errors ?? { form: 'Could not log the quote.' });
      if (submitBtn) submitBtn.disabled = false;
      return;
    }
    // Success collapses via the next SSE `tracker` push (server.js
    // broadcasts after every write); re-enable here too in case that
    // push is delayed, so the form isn't stuck disabled.
    if (submitBtn) submitBtn.disabled = false;
  } catch {
    showQuoteFormErrors(form, { form: 'Could not reach the server. Check your connection and try again.' });
    if (submitBtn) submitBtn.disabled = false;
  }
}

function attachQuoteFormHandlers() {
  if (!root) return;
  root.querySelectorAll('.log-quote-btn').forEach((btn) => {
    btn.addEventListener('click', () => toggleQuoteForm(btn));
  });
  root.querySelectorAll('.quote-form-cancel').forEach((btn) => {
    btn.addEventListener('click', () => closeQuoteForm(btn.closest('.quote-form-row')));
  });
  root.querySelectorAll('.quote-form').forEach((form) => {
    form.addEventListener('submit', handleQuoteSubmit);
  });
}

// --- Add/remove trim (requirement 004, stage 4b) ---------------------------
//
// "+ Add a trim" at the foot of the price table posts {carId, trim} to
// POST /trims/add (lib/trims.js#submitAddTrim), which either creates fresh
// Configurations for a genuinely new trim or restores an archived one's
// history intact if the name matches. Same toggle/inline-error pattern as
// the quote form above: a failed submission only writes into the existing
// form's DOM, never re-renders or clears what was typed.

function clearAddTrimErrors(form) {
  form.querySelectorAll('.add-trim-error').forEach((el) => {
    el.textContent = '';
  });
}

function showAddTrimErrors(form, errors) {
  clearAddTrimErrors(form);
  for (const [field, message] of Object.entries(errors ?? {})) {
    // carId errors (a stale/forged watch id) surface at the form level —
    // there's no carId input on this form to attach them to.
    const key = field === 'carId' ? 'form' : field;
    const errorEl = form.querySelector(`[data-error-for="${key}"]`) ?? form.querySelector('[data-error-for="form"]');
    if (errorEl) errorEl.textContent = message;
  }
}

function closeAddTrimForm(wrap) {
  if (!wrap) return;
  wrap.hidden = true;
  const form = wrap.querySelector('form');
  if (form) {
    form.reset();
    clearAddTrimErrors(form);
  }
  const toggleBtn = root.querySelector(`.add-trim-toggle[data-target="${wrap.id}"]`);
  if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');
}

function toggleAddTrimForm(button) {
  const target = document.getElementById(button.dataset.target);
  if (!target) return;
  const opening = target.hidden;
  target.hidden = !opening;
  button.setAttribute('aria-expanded', String(opening));
  if (opening) {
    const input = target.querySelector('input');
    if (input) input.focus();
  }
}

async function handleAddTrimSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const submitBtn = form.querySelector('.add-trim-submit');
  clearAddTrimErrors(form);
  if (submitBtn) submitBtn.disabled = true;

  const payload = { carId: form.dataset.carId, trim: form.elements.trim.value };

  try {
    const response = await fetch('/trims/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [CLIENT_HEADER]: CLIENT_HEADER_VALUE },
      body: JSON.stringify(payload),
    });

    let result;
    try {
      result = await response.json();
    } catch {
      result = { ok: false, errors: { form: 'Unexpected response from the server.' } };
    }

    if (!response.ok || !result.ok) {
      showAddTrimErrors(form, result.errors ?? { form: 'Could not add the trim.' });
      if (submitBtn) submitBtn.disabled = false;
      return;
    }
    // Success collapses via the next SSE `tracker` push, same as the quote
    // form; re-enable here too in case that push is delayed.
    if (submitBtn) submitBtn.disabled = false;
  } catch {
    showAddTrimErrors(form, { form: 'Could not reach the server. Check your connection and try again.' });
    if (submitBtn) submitBtn.disabled = false;
  }
}

function attachAddTrimFormHandlers() {
  if (!root) return;
  const toggleBtn = root.querySelector('.add-trim-toggle');
  if (toggleBtn) toggleBtn.addEventListener('click', () => toggleAddTrimForm(toggleBtn));
  const cancelBtn = root.querySelector('.add-trim-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', () => closeAddTrimForm(cancelBtn.closest('.add-trim-form-wrap')));
  const form = root.querySelector('.add-trim-form');
  if (form) form.addEventListener('submit', handleAddTrimSubmit);
}

// --- Record-readings form (requirement 004, stage 4c) -----------------------
//
// The last piece of requirement 004: "Checks are manual. There is no
// fetcher, ever" — Ian reads Stella's findings and types this cycle's
// numbers in here, one row per variant (lib/tracker-data.js#buildReadingsForm
// already built the row list, each carrying its previous reading so the
// row can default to it). Same write-endpoint pattern as every other form
// in this file: same-origin fetch with CLIENT_HEADER, inline errors written
// into the existing DOM (never a dialog, never a re-render, so a rejected
// submission loses nothing typed), and a successful write collapses the
// form itself — no separate success state to render.
//
// The dialog is rebuilt fresh on every renderCarDetail call (unlike
// #remove-trim-dialog, which is static outside #app) because its rows
// depend on this car's current variants; a native <dialog> still gets
// Escape-to-cancel for free from the platform, and the backdrop-click
// listener below matches isOutsideDialogBox's reasoning above.
//
// "A blank value means no reading this cycle, never zero" (requirement
// 004): every row's value input starts blank when the variant has no
// previous reading, and can always be cleared back to blank even when it
// defaulted from one — nothing here forces a number where Stella found
// none. The server treats a blank value as "skip" regardless of what the
// row's other fields hold (lib/readings.js#validateOneReading).

const READINGS_BASIS_OPTIONS = [
  { value: 'msrp', label: 'MSRP' },
  { value: 'listing', label: 'Single listing' },
  { value: 'listing_average', label: 'Average of listings' },
  { value: 'valuation_estimate', label: 'Estimate, not a listing' },
];

function readingsBasisOptionsHtml(previousBasis) {
  const placeholder = `<option value="" ${!previousBasis ? 'selected' : ''} disabled>Choose a basis</option>`;
  const options = READINGS_BASIS_OPTIONS.map(
    (opt) => `<option value="${opt.value}"${opt.value === previousBasis ? ' selected' : ''}>${opt.label}</option>`
  ).join('');
  return placeholder + options;
}

function readingFieldHtml({ uid, field, label, value, type = 'text', inputmode, maxlength, extraClass = '' }) {
  const id = `${uid}-${field}`;
  const attrs = [
    `type="${type}"`,
    inputmode ? `inputmode="${inputmode}"` : '',
    maxlength ? `maxlength="${maxlength}"` : '',
    'autocomplete="off"',
    `id="${escapeHtml(id)}"`,
    `class="reading-${field}-input"`,
    `value="${escapeHtml(value ?? '')}"`,
  ]
    .filter(Boolean)
    .join(' ');
  return `
    <div class="reading-field ${extraClass}" data-field="${field}">
      <label for="${escapeHtml(id)}">${label}</label>
      <input ${attrs} />
      <div class="reading-error" data-error-for="${field}"></div>
    </div>
  `;
}

function readingRowHtml(variant) {
  const uid = `reading-${variant.configurationId}`;
  const previous = variant.previous;
  const label = `${escapeHtml(variant.year)} ${escapeHtml(variant.trim)} · ${escapeHtml(conditionChipLabel(variant.condition))}`;
  const previousText = previous
    ? `Last reading: ${escapeHtml(priceDisplayText(previous))} · ${escapeHtml(basisLineText(previous))}${previous.observed ? ` on ${escapeHtml(previous.observed)}` : ''}`
    : 'No reading on file yet';
  const isAverage = previous?.basis === 'listing_average';

  return `
    <fieldset class="reading-row" data-configuration-id="${escapeHtml(variant.configurationId)}">
      <legend class="reading-row-label">${label}</legend>
      <div class="reading-row-previous">${previousText}</div>
      <div class="reading-row-fields">
        ${readingFieldHtml({ uid, field: 'value', label: 'Value ($)', value: previous?.value, inputmode: 'decimal' })}
        <div class="reading-field" data-field="basis">
          <label for="${escapeHtml(uid)}-basis">Basis</label>
          <select id="${escapeHtml(uid)}-basis" class="reading-basis-input">${readingsBasisOptionsHtml(previous?.basis)}</select>
          <div class="reading-error" data-error-for="basis"></div>
        </div>
        ${readingFieldHtml({ uid, field: 'source', label: 'Source', value: previous?.source, maxlength: 500, extraClass: 'reading-field-wide' })}
        <div class="reading-field reading-field-checkbox" data-field="confirmed">
          <label for="${escapeHtml(uid)}-confirmed"><input type="checkbox" id="${escapeHtml(uid)}-confirmed" class="reading-confirmed-input" ${previous?.confirmed ? 'checked' : ''} /> Confirmed</label>
          <div class="reading-error" data-error-for="confirmed"></div>
        </div>
      </div>
      <div class="reading-row-average"${isAverage ? '' : ' hidden'}>
        ${readingFieldHtml({ uid, field: 'sampleSize', label: 'Sample size', value: previous?.sampleSize, inputmode: 'numeric' })}
        ${readingFieldHtml({ uid, field: 'rangeLow', label: 'Range low ($)', value: previous?.rangeLow, inputmode: 'decimal' })}
        ${readingFieldHtml({ uid, field: 'rangeHigh', label: 'Range high ($)', value: previous?.rangeHigh, inputmode: 'decimal' })}
      </div>
      ${readingFieldHtml({ uid, field: 'note', label: 'Note (optional)', value: previous?.note, maxlength: 500, extraClass: 'reading-field-wide' })}
      <div class="reading-row-hint">Leave value blank to skip this variant this check.</div>
      <div class="reading-error reading-error-row" data-error-for="configuration"></div>
    </fieldset>
  `;
}

function readingsDialogHtml(readingsForm, carId) {
  const rows = readingsForm.variants.map(readingRowHtml).join('');
  return `
    <dialog class="readings-dialog" aria-labelledby="readings-dialog-title">
      <form class="readings-form" data-car-id="${escapeHtml(carId)}" novalidate>
        <div class="readings-dialog-head">
          <h1 id="readings-dialog-title" class="readings-dialog-title">Record this check</h1>
          <button type="button" class="readings-dialog-close" aria-label="Cancel and close">${CLOSE_ICON_SVG}</button>
        </div>
        <p class="readings-dialog-lede">One reading per variant, defaulted from its last check. Every field is editable — a basis can legitimately change between checks.</p>
        <div class="readings-rows">${rows || '<p class="readings-empty">This watch has no variants to record yet.</p>'}</div>
        <div class="readings-error readings-error-form" data-error-for="form"></div>
        <div class="readings-dialog-actions">
          <button type="submit" class="readings-submit">Save check</button>
          <button type="button" class="readings-cancel">Cancel</button>
        </div>
      </form>
    </dialog>
  `;
}

function clearReadingsFormErrors(form) {
  form.querySelectorAll('.reading-error').forEach((el) => {
    el.textContent = '';
  });
  form.querySelectorAll('.reading-field').forEach((el) => el.classList.remove('has-error'));
}

// Server errors come back either as `{ form: '...' }` (nothing submitted,
// unknown car) or `{ readings: { [configurationId]: { field: message } } }`
// (lib/readings.js#validateReadingsSubmission) — this walks both shapes
// and writes each message into the matching row's existing DOM node, same
// "never re-render, never lose what was typed" rule every write form here
// follows.
function showReadingsFormErrors(form, errors) {
  clearReadingsFormErrors(form);
  if (errors?.form) {
    const el = form.querySelector('[data-error-for="form"]');
    if (el) el.textContent = errors.form;
  }
  for (const [configId, fieldErrors] of Object.entries(errors?.readings ?? {})) {
    const row = form.querySelector(`.reading-row[data-configuration-id="${CSS.escape(configId)}"]`);
    if (!row) {
      const el = form.querySelector('[data-error-for="form"]');
      if (el && !el.textContent) el.textContent = 'A submitted reading could not be matched to a row on this form.';
      continue;
    }
    for (const [field, message] of Object.entries(fieldErrors)) {
      const el = row.querySelector(`[data-error-for="${field}"]`);
      if (el) el.textContent = message;
      const fieldWrap = row.querySelector(`.reading-field[data-field="${field}"]`);
      if (fieldWrap) fieldWrap.classList.add('has-error');
    }
  }
}

function getReadingsDialog() {
  return root ? root.querySelector('.readings-dialog') : null;
}

function openReadingsDialog() {
  const dialog = getReadingsDialog();
  if (!dialog) return;
  dialog.showModal();
}

function closeReadingsDialog(dialog) {
  dialog.close();
}

// One `{configuration, value, basis, source, confirmed, sampleSize,
// rangeLow, rangeHigh, note}` entry per row, read straight off each row's
// current DOM state (never off `previous` — every field is editable and
// the user may have changed any of them, including basis, since it
// defaulted). Sent for every row regardless of whether its value is
// blank: lib/readings.js treats a blank value as "skip this variant" no
// matter what the rest of that row holds, so there is no need to filter
// blank rows out client-side too.
function collectReadingsPayload(form) {
  return [...form.querySelectorAll('.reading-row')].map((row) => ({
    configuration: row.dataset.configurationId,
    value: row.querySelector('.reading-value-input').value,
    basis: row.querySelector('.reading-basis-input').value,
    source: row.querySelector('.reading-source-input').value,
    confirmed: row.querySelector('.reading-confirmed-input').checked,
    sampleSize: row.querySelector('.reading-samplesize-input').value,
    rangeLow: row.querySelector('.reading-rangelow-input').value,
    rangeHigh: row.querySelector('.reading-rangehigh-input').value,
    note: row.querySelector('.reading-note-input').value,
  }));
}

async function handleReadingsSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const submitBtn = form.querySelector('.readings-submit');
  clearReadingsFormErrors(form);
  if (submitBtn) submitBtn.disabled = true;

  const payload = { carId: form.dataset.carId, readings: collectReadingsPayload(form) };

  try {
    const response = await fetch('/readings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [CLIENT_HEADER]: CLIENT_HEADER_VALUE },
      body: JSON.stringify(payload),
    });

    let result;
    try {
      result = await response.json();
    } catch {
      result = { ok: false, errors: { form: 'Unexpected response from the server.' } };
    }

    if (!response.ok || !result.ok) {
      showReadingsFormErrors(form, result.errors ?? { form: 'Could not save this check.' });
      if (submitBtn) submitBtn.disabled = false;
      return;
    }
    // Success: close right away rather than waiting for the SSE push
    // (server.js broadcasts after every write, ~300ms debounced) to
    // re-render the whole screen out from under an open dialog.
    if (submitBtn) submitBtn.disabled = false;
    closeReadingsDialog(form.closest('dialog'));
  } catch {
    showReadingsFormErrors(form, { form: 'Could not reach the server. Check your connection and try again.' });
    if (submitBtn) submitBtn.disabled = false;
  }
}

// A click that lands outside the dialog's own box is a backdrop click —
// same reasoning and same geometry check as isOutsideDialogBox above
// (defined below, for the remove-trim dialog); duplicated rather than
// shared because the two dialogs are wired at different times (this one
// per render, that one once at module load) and the geometry check itself
// is two lines.
function isOutsideReadingsDialogBox(dialog, event) {
  const rect = dialog.getBoundingClientRect();
  return (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  );
}

function attachReadingsDialogHandlers() {
  if (!root) return;
  const openBtn = root.querySelector('[data-open-readings-dialog]');
  const dialog = getReadingsDialog();
  if (openBtn) openBtn.addEventListener('click', openReadingsDialog);
  if (!dialog) return;

  const closeBtn = dialog.querySelector('.readings-dialog-close');
  if (closeBtn) closeBtn.addEventListener('click', () => closeReadingsDialog(dialog));
  const cancelBtn = dialog.querySelector('.readings-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', () => closeReadingsDialog(dialog));

  const form = dialog.querySelector('.readings-form');
  if (form) {
    form.addEventListener('submit', handleReadingsSubmit);
    // A row's sample-size/range fields only matter for an average basis
    // (requirement 004: "plus sample size and range where the basis is
    // an average"), so they're hidden until that basis is chosen —
    // event-delegated on the form since there is one basis <select> per
    // row and the row count varies per car.
    form.addEventListener('change', (event) => {
      if (!event.target.matches('.reading-basis-input')) return;
      const row = event.target.closest('.reading-row');
      const averageWrap = row?.querySelector('.reading-row-average');
      if (averageWrap) averageWrap.hidden = event.target.value !== 'listing_average';
    });
  }

  dialog.addEventListener('click', (event) => {
    if (isOutsideReadingsDialogBox(dialog, event)) closeReadingsDialog(dialog);
  });
}

// --- Remove-trim confirmation dialog (requirement 004) ---------------------
//
// A native <dialog>, static in index.html and outside #app, so it survives
// every renderCarDetail re-render untouched — its own handlers
// (attachRemoveTrimDialogHandlers) are therefore wired once at module load,
// not per render, the same reasoning the file's header comment already
// gives. showModal()/close() get Escape-to-cancel for free from the
// platform; the backdrop click below is the one piece <dialog> doesn't
// handle itself.
//
// "The mockup's dialog copy is wrong — do not copy it... Write copy
// describing what actually happens" (requirement 004): removeTrimCopy
// above builds that copy from the real, non-destructive behaviour
// (lib/archive.js archives, never deletes) plus this trim's real counts.
// Every field is written with .textContent — never innerHTML — so nothing
// here needs pre-escaping even though trim names and counts come straight
// from server data.

function clearRemoveTrimDialogContent(dialog) {
  dialog.querySelector('.remove-trim-title').textContent = '';
  dialog.querySelector('.remove-trim-lede').textContent = '';
  dialog.querySelector('.remove-trim-counts').replaceChildren();
  dialog.querySelector('.remove-trim-note').textContent = '';
  dialog.querySelector('.remove-trim-error').textContent = '';
}

function openRemoveTrimDialog(carId, trim, summary) {
  const dialog = document.getElementById('remove-trim-dialog');
  if (!dialog) return;
  const copy = removeTrimCopy(trim, summary);
  clearRemoveTrimDialogContent(dialog);

  dialog.querySelector('.remove-trim-title').textContent = copy.title;
  dialog.querySelector('.remove-trim-lede').textContent = copy.lede;

  const countsEl = dialog.querySelector('.remove-trim-counts');
  for (const line of copy.lines) {
    const row = document.createElement('div');
    row.className = 'remove-trim-count-row';
    const num = document.createElement('span');
    num.className = 'remove-trim-count-num';
    num.textContent = String(line.count);
    row.append(num, document.createTextNode(line.label));
    countsEl.append(row);
  }

  dialog.querySelector('.remove-trim-note').textContent = copy.note;
  dialog.dataset.carId = carId;
  dialog.dataset.trim = trim;

  const confirmBtn = dialog.querySelector('.remove-trim-confirm');
  if (confirmBtn) confirmBtn.disabled = false;
  dialog.showModal();
}

async function handleRemoveTrimConfirm(dialog) {
  const carId = dialog.dataset.carId;
  const trim = dialog.dataset.trim;
  const confirmBtn = dialog.querySelector('.remove-trim-confirm');
  const errorEl = dialog.querySelector('.remove-trim-error');
  errorEl.textContent = '';
  if (confirmBtn) confirmBtn.disabled = true;

  try {
    const response = await fetch('/trims/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [CLIENT_HEADER]: CLIENT_HEADER_VALUE },
      body: JSON.stringify({ carId, trim }),
    });

    let result;
    try {
      result = await response.json();
    } catch {
      result = { ok: false, errors: { form: 'Unexpected response from the server.' } };
    }

    if (!response.ok || !result.ok) {
      const errors = result.errors ?? {};
      errorEl.textContent = errors.form ?? errors.trim ?? errors.carId ?? 'Could not remove the trim.';
      if (confirmBtn) confirmBtn.disabled = false;
      return;
    }
    // Success: the write's SSE push re-renders the detail screen without
    // this trim, so there's nothing left to update by hand here.
    dialog.close();
  } catch {
    errorEl.textContent = 'Could not reach the server. Check your connection and try again.';
    if (confirmBtn) confirmBtn.disabled = false;
  }
}

// A click that lands outside the dialog's own box is a backdrop click —
// <dialog> has no direct way to distinguish that from a click on the
// dialog element's own padding, so this checks the box geometry rather
// than relying on event.target (requirement 004: "Escape and backdrop
// both cancel").
function isOutsideDialogBox(dialog, event) {
  const rect = dialog.getBoundingClientRect();
  return (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  );
}

function attachRemoveTrimDialogHandlers() {
  const dialog = document.getElementById('remove-trim-dialog');
  if (!dialog) return;

  const keepBtn = dialog.querySelector('.remove-trim-keep');
  if (keepBtn) keepBtn.addEventListener('click', () => dialog.close());

  const confirmBtn = dialog.querySelector('.remove-trim-confirm');
  if (confirmBtn) confirmBtn.addEventListener('click', () => handleRemoveTrimConfirm(dialog));

  dialog.addEventListener('click', (event) => {
    if (isOutsideDialogBox(dialog, event)) dialog.close();
  });
}

// "Remove trim" on each trim heading opens the shared confirmation dialog
// above (attachRemoveTrimDialogHandlers is wired once at module load,
// since the dialog is a static element outside #app — see index.html).
// `trimSummaries` is this render's map of trim -> {variantCount,
// historyMonths, quoteCount} (lib/tracker-data.js#buildTrimSummaries),
// read here so the dialog gets this watch's real counts rather than a
// placeholder.
function attachTrimControls(trimSummaries) {
  if (!root) return;
  root.querySelectorAll('.trim-remove-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      openRemoveTrimDialog(btn.dataset.carId, btn.dataset.trim, trimSummaries?.[btn.dataset.trim]);
    });
  });
  attachAddTrimFormHandlers();
}

// One car's detail screen (requirement 003/004's original single-car
// view). `detail` is one entry of buildAppData's `details` map — same
// shape buildCarDetail always returned, so everything above this point
// (modelHeaderHtml, summaryTilesHtml, pricesPanelHtml, trendChartHtml,
// incentivesPanelHtml and their handlers) is unchanged by routing.
function renderCarDetail(detail) {
  if (!detail || !detail.car) {
    root.innerHTML = '<p class="placeholder">No car on file. Add one to car-tracker/data/tracker.md.</p>';
    return;
  }

  root.innerHTML = `
    ${modelHeaderHtml(detail.car, detail.incentives, detail.readingsForm)}
    ${summaryTilesHtml(detail.summary)}
    <div class="detail-body">
      <div class="detail-main">
        ${pricesPanelHtml(detail.groups, detail.car.id)}
        ${trendChartHtml(detail.trendChart, detail.groups)}
      </div>
      ${incentivesPanelHtml(detail.incentives)}
    </div>
    ${readingsDialogHtml(detail.readingsForm, detail.car.id)}
  `;

  attachPopoverHandlers();
  attachIncentivesHandlers();
  attachQuoteFormHandlers();
  attachTrendChartHandlers();
  attachTrimControls(detail.trimSummaries);
  attachReadingsDialogHandlers();
}

// --- Nav + routing (requirement 004: "Persistent 240px left nav on every
// screen" and "Routing between watchlist and car detail, and from the nav
// rows"). Routing is a plain location.hash read on every render — no
// history API, no server route — since the server always serves the same
// index.html/SSE payload and a hash change never needs another read of
// tracker.md. `#/car/<id>` opens that car's detail screen; anything else
// (including an unknown id, and the empty/default hash) is the watchlist.
// Real <a href="#/..."> elements throughout, so browser-native hash
// navigation (and the back/forward buttons) work without any click
// handlers of our own — a 'hashchange' listener below just re-renders
// from the last data this session already has. ---------------------------

function parseRoute(hash) {
  const match = /^#\/car\/(.+)$/.exec(hash || '');
  if (match) return { screen: 'car', carId: decodeURIComponent(match[1]) };
  if (hash === '#/add-car') return { screen: 'add-car', carId: null };
  return { screen: 'watchlist', carId: null };
}

const NAV_WORDMARK_ICON_SVG =
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 17h18M5 17l1.6-5.2A2 2 0 0 1 8.5 10.4h7a2 2 0 0 1 1.9 1.4L19 17"/><circle cx="7.5" cy="17.5" r="1.5"/><circle cx="16.5" cy="17.5" r="1.5"/><path d="M4 6l4 2 4-3 4 2 4-2"/></svg>';

// Requirement 004: "Add Car is reachable from the nav on every screen and
// from the watchlist footer." A real full-width <a>, styled as the
// primary button, routing to the #/add-car screen below — replaces the
// stage-4a placeholder that rendered a disabled <button> with nowhere to
// go.
function addCarLinkHtml(route) {
  const active = route.screen === 'add-car';
  return `<a href="#/add-car" class="nav-add-car${active ? ' nav-add-car-active' : ''}">+ Add Car</a>`;
}

function navHtml(cars, route) {
  const rows = cars
    .map((car) => {
      const active = route.screen === 'car' && route.carId === car.id;
      return `<a href="#/car/${encodeURIComponent(car.id)}" class="nav-row${active ? ' nav-row-active' : ''}">${escapeHtml(car.model)}</a>`;
    })
    .join('');
  const allWatchesActive = route.screen === 'watchlist';

  return `
    <div class="nav-wordmark">
      <span class="nav-wordmark-icon">${NAV_WORDMARK_ICON_SVG}</span>
      <span class="nav-wordmark-text">Car Watch</span>
    </div>
    ${addCarLinkHtml(route)}
    <div class="nav-car-list">
      <div class="nav-watching-label">Watching &middot; ${cars.length}</div>
      ${rows}
    </div>
    <a href="#/watchlist" class="nav-row nav-all-watches${allWatchesActive ? ' nav-row-active' : ''}">All watches</a>
  `;
}

// --- Watchlist screen (requirement 004: attention tiles, sort/filter,
// one row per watched car). `data.watchlist` is pre-built server-side
// (lib/watchlist.js#buildWatchlistData) with every tab's rows and shared
// axis already computed — sort is the one piece of UI state applied
// client-side, via the same pure sortWatchlistRows this module dynamically
// imports above (no server round trip; there is no fetcher). Sort and tab
// selection persist across SSE re-renders as module-level state, same
// pattern as `incentivesOpen` above. ---------------------------------------

let watchlistTab = 'all';
let watchlistSortKey = 'lowest-price';

function pluralDaysLeft(n) {
  return `${n} ${n === 1 ? 'day' : 'days'} left`;
}

function formatAxisTick(value) {
  return `$${Math.round(value / 1000)}k`;
}

function watchAxisTicksHtml(axis) {
  if (!axis) return '';
  const span = axis.max - axis.min;
  const ticks = [axis.min, axis.min + span / 3, axis.min + (span * 2) / 3, axis.max];
  return `<div class="watch-axis-ticks">${ticks.map((v) => `<span>${escapeHtml(formatAxisTick(v))}</span>`).join('')}</div>`;
}

// Requirement 004 rule: "hand-written SVG for the spread bar." Coordinates
// are plotted directly in a 0–100 (x) by 0–16 (y) viewBox — bar.leftPct/
// widthPct are already 0–100 percentages of the shared axis (see
// lib/watchlist.js#buildSpreadBar), so no further conversion is needed —
// and preserveAspectRatio="none" lets the same markup stretch to fill
// whatever width the grid column resolves to. A spread with no data
// (row.spreadBar is null) draws a flat empty track and "No prices yet" —
// never the mock's invented "First check pending" copy, since there is no
// fetcher and so no check to be "pending".
function spreadCellHtml(row) {
  if (!row.spreadBar) {
    return `
      <div class="spread-cell">
        <svg class="spread-svg" viewBox="0 0 100 16" preserveAspectRatio="none" aria-hidden="true">
          <rect x="0" y="3" width="100" height="10" fill="#1B1E23"/>
        </svg>
        <span class="spread-empty-label">No prices yet</span>
      </div>
    `;
  }
  const bar = row.spreadBar;
  const left = num(bar.leftPct);
  const width = num(Math.max(bar.widthPct, 0.8));
  const lowMarkerX = num(Math.max(left - 0.4, 0));
  const highMarkerX = num(Math.min(left + width - 0.4, 99.2));
  return `
    <div class="spread-cell">
      <svg class="spread-svg" viewBox="0 0 100 16" preserveAspectRatio="none" aria-hidden="true">
        <rect x="0" y="3" width="100" height="10" fill="#22262C"/>
        <rect x="${left}" y="3" width="${width}" height="10" fill="#3A4450"/>
        <rect x="${lowMarkerX}" y="0" width="0.8" height="16" fill="#5CC8B0"/>
        <rect x="${highMarkerX}" y="0" width="0.8" height="16" fill="#ECEDEF"/>
      </svg>
      <div class="spread-endpoints">
        <span>Cheapest ${escapeHtml(formatCurrency(bar.cheapestValue))}</span>
        <span>Dearest ${escapeHtml(formatCurrency(bar.dearestValue))}</span>
      </div>
    </div>
  `;
}

function watchlistIncentivePillHtml(summary) {
  if (summary.count > 0) {
    return `<span class="watch-row-incentive-pill watch-row-incentive-pill-active">${summary.count} &middot; ${escapeHtml(pluralDaysLeft(summary.days))}</span>`;
  }
  return `<span class="watch-row-incentive-pill">${escapeHtml(summary.reason || 'No incentives on file')}</span>`;
}

// Requirement 004: "The whole row is the link" — one real <a> per row,
// carrying every cell, routing to that car's detail screen.
function watchlistRowHtml(row) {
  const priceHtml =
    row.lowestPrice.value != null
      ? `<div class="watch-row-price">${escapeHtml(formatCurrency(row.lowestPrice.value))}</div><div class="watch-row-price-label">${escapeHtml(row.lowestPrice.label)}</div>`
      : `<div class="watch-row-price watch-row-price-missing">&mdash;</div><div class="watch-row-price-label">${escapeHtml(row.lowestPrice.reason)}</div>`;

  return `
    <a href="#/car/${encodeURIComponent(row.carId)}" class="watch-row">
      <div class="watch-row-name">
        <div class="watch-row-title">${escapeHtml(row.name)}</div>
        <div class="watch-row-subtitle">${escapeHtml(row.subtitle)}</div>
      </div>
      <div class="watch-row-price-col">${priceHtml}</div>
      ${spreadCellHtml(row)}
      <div class="watch-row-incentive-col">${watchlistIncentivePillHtml(row.incentiveSummary)}</div>
      <div class="watch-row-quotes${row.quoteCount === 0 ? ' watch-row-quotes-zero' : ''}">${row.quoteCount}</div>
      <svg class="watch-row-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>
    </a>
  `;
}

function watchlistTableHtml(tab) {
  const sorted = sortWatchlistRows(tab.rows, watchlistSortKey);
  const rowsHtml = sorted.length
    ? sorted.map(watchlistRowHtml).join('')
    : '<p class="watch-table-empty">No cars match this filter.</p>';
  return `
    <section aria-label="Watched cars" class="watch-table">
      <div class="watch-table-columns">
        <div>Car</div>
        <div class="watch-col-price-head">Lowest</div>
        <div>
          <div>Price spread across variants</div>
          ${watchAxisTicksHtml(tab.axis)}
        </div>
        <div>Offers</div>
        <div class="watch-col-quotes-head">Quotes</div>
        <div></div>
      </div>
      ${rowsHtml}
      <div class="watch-table-footer">
        <a href="#/add-car" class="watch-table-add-car">+ Add Car</a>
        <span class="watch-table-footer-note">Quotes are yours to log and never move the trend lines.</span>
      </div>
    </section>
  `;
}

const TAB_LABELS = { all: 'All', new: 'New', preowned: 'Pre-owned' };

function watchlistControlsHtml() {
  const sortOptions = [
    ['lowest-price', 'Lowest price'],
    ['deadline-soonest', 'Deadline soonest'],
    ['recently-updated', 'Recently updated'],
  ]
    .map(([value, label]) => `<option value="${value}"${watchlistSortKey === value ? ' selected' : ''}>${label}</option>`)
    .join('');
  const tabsHtml = WATCHLIST_TABS.map((t) => {
    const active = watchlistTab === t;
    return `<button type="button" role="tab" aria-selected="${active}" data-tab="${t}" class="watchlist-tab${active ? ' watchlist-tab-active' : ''}">${escapeHtml(TAB_LABELS[t] ?? t)}</button>`;
  }).join('');
  return `
    <div class="watchlist-header-controls">
      <label class="watchlist-sort">Sort by
        <select id="watchlist-sort-select">${sortOptions}</select>
      </label>
      <div role="tablist" aria-label="Condition" class="watchlist-tabs">${tabsHtml}</div>
    </div>
  `;
}

function watchlistScreenHtml(data) {
  const wl = data.watchlist;
  const tab = wl.tabs[watchlistTab] ?? wl.tabs.all;
  return `
    <div class="watchlist-header">
      <div class="watchlist-header-text">
        <div class="watchlist-eyebrow">${wl.carCount} ${wl.carCount === 1 ? 'car' : 'cars'} &middot; ${wl.variantCount} ${wl.variantCount === 1 ? 'variant' : 'variants'}</div>
        <h1 class="watchlist-title">All watches</h1>
      </div>
      ${watchlistControlsHtml()}
    </div>
    ${attentionTilesHtml(wl.tiles)}
    ${watchlistTableHtml(tab)}
  `;
}

// Reuses tileHtml (defined above for the detail screen's summary tiles) —
// same visual language, three columns instead of four. Requirement 004:
// "a tile with nothing to report shows a zero, never hides" — every
// branch below always renders, since lib/watchlist.js#buildAttentionTiles
// already guarantees a real {count/days, subtitle} for all three.
function attentionTilesHtml(tiles) {
  const expiryHasOffer = tiles.expiry.subtitle !== 'No incentives on file';
  const expiryTile = tileHtml(
    'days to an expiring offer',
    String(tiles.expiry.days),
    tiles.expiry.subtitle,
    expiryHasOffer ? 'tile-warning' : ''
  );
  const awaitingTile = tileHtml(
    'cars awaiting first prices',
    String(tiles.awaitingFirstPrice.count),
    tiles.awaitingFirstPrice.subtitle
  );
  const quotesTile = tileHtml(
    'dealer quotes logged',
    String(tiles.quotesLogged.count),
    tiles.quotesLogged.subtitle,
    'tile-quotes'
  );
  return `<div class="attention-tiles">${expiryTile}${awaitingTile}${quotesTile}</div>`;
}

function attachWatchlistHandlers() {
  if (!root) return;
  const select = root.querySelector('#watchlist-sort-select');
  if (select) {
    select.addEventListener('change', () => {
      watchlistSortKey = select.value;
      if (lastAppData) renderApp(lastAppData);
    });
  }
  root.querySelectorAll('.watchlist-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      watchlistTab = btn.dataset.tab;
      if (lastAppData) renderApp(lastAppData);
    });
  });
}

function renderWatchlistScreen(data) {
  if (!data.watchlist) {
    root.innerHTML = '<p class="placeholder">No car on file. Add one to car-tracker/data/tracker.md.</p>';
    return;
  }
  root.innerHTML = watchlistScreenHtml(data);
  attachWatchlistHandlers();
}

// --- Add Car screen (requirement 004, stage 4b) ----------------------------
//
// Make, model, model years and ZIP as plain fields; trims as removable
// chips plus a dashed "+ Add a trim" input (empty means every trim,
// reference/01-add-car.html); at least one condition checkbox. Errors are
// always written inline under the field they belong to — never a dialog
// (requirement's own words: "errors inline under the field, never a
// dialog"). On success this posts to POST /cars (lib/cars.js#submitNewCar)
// and lands on the watchlist, per the brief — the newly created watch
// shows up there via the SSE push the write triggers, same as every other
// write in this app.
//
// Trim chips are tracked directly in the DOM (appended/removed on click,
// no module-level array) rather than as separate render state — consistent
// with how the quote form's error path writes into existing DOM nodes
// instead of re-rendering, and it means a chip never disappears out from
// under a user mid-edit the way a full data-driven re-render could.

function addCarTrimChipHtml(trim) {
  return `
    <span class="add-car-trim-chip" data-trim="${escapeHtml(trim)}">
      ${escapeHtml(trim)}
      <button type="button" class="add-car-trim-remove" aria-label="Remove ${escapeHtml(trim)}">${CLOSE_ICON_SVG}</button>
    </span>
  `;
}

function addCarScreenHtml() {
  return `
    <div class="add-car-page">
      <section class="add-car-intro">
        <div class="add-car-eyebrow">Get started</div>
        <h1 class="add-car-title">Add a car</h1>
        <p class="add-car-lede">Name a car and the trims you care about. Car Watch re-checks prices every two weeks, charts used and CPO prices month by month, and warns you before an incentive expires.</p>
      </section>

      <form class="add-car-form" novalidate>
        <div class="add-car-grid">
          <label class="add-car-field" data-field="make">
            Make
            <input type="text" name="make" autocomplete="off" maxlength="80" placeholder="e.g. Mazda" />
            <div class="add-car-error" data-error-for="make"></div>
          </label>
          <label class="add-car-field" data-field="model">
            Model
            <input type="text" name="model" autocomplete="off" maxlength="80" placeholder="e.g. CX-90 Turbo" />
            <div class="add-car-error" data-error-for="model"></div>
          </label>
          <label class="add-car-field" data-field="years">
            Model years
            <input type="text" name="years" autocomplete="off" maxlength="12" placeholder="2025–2026" />
            <div class="add-car-error" data-error-for="years"></div>
          </label>
          <label class="add-car-field" data-field="zip">
            ZIP code
            <input type="text" name="zip" autocomplete="off" maxlength="12" placeholder="For local listings" />
            <div class="add-car-error" data-error-for="zip"></div>
          </label>
        </div>

        <fieldset class="add-car-fieldset">
          <legend class="add-car-legend">Trims <span class="add-car-legend-hint">— add as many as you like, remove any time</span></legend>
          <div class="add-car-trims">
            <label class="add-car-trim-input-label">
              <span class="sr-only">Add a trim</span>
              <input type="text" class="add-car-trim-input" autocomplete="off" maxlength="60" placeholder="+ Add a trim" />
            </label>
          </div>
          <div class="add-car-error" data-error-for="trims"></div>
          <div class="add-car-trims-hint">Leave empty to watch every trim.</div>
        </fieldset>

        <fieldset class="add-car-fieldset">
          <legend class="add-car-legend">Conditions</legend>
          <div class="add-car-conditions">
            <label class="add-car-condition add-car-condition-checked">
              <input type="checkbox" name="conditions" value="new" checked />New
            </label>
            <label class="add-car-condition add-car-condition-checked">
              <input type="checkbox" name="conditions" value="cpo" checked />Certified pre-owned
            </label>
            <label class="add-car-condition">
              <input type="checkbox" name="conditions" value="used" />Used
            </label>
          </div>
          <div class="add-car-error" data-error-for="conditions"></div>
        </fieldset>

        <div class="add-car-footer">
          <p class="add-car-footer-note">Prices re-check every two weeks. Used and CPO prices get one trend point a month.</p>
          <button type="submit" class="add-car-submit">Add Car</button>
        </div>
        <div class="add-car-error add-car-error-form" data-error-for="form"></div>
      </form>
    </div>
  `;
}

function addCarChipTrims(form) {
  return [...form.querySelectorAll('.add-car-trim-chip')].map((chip) => chip.dataset.trim);
}

function addTrimChip(form, rawTrim) {
  const trim = rawTrim.trim();
  if (!trim) return;
  const existing = addCarChipTrims(form).map((t) => t.toLowerCase());
  if (existing.includes(trim.toLowerCase())) return;
  const wrap = form.querySelector('.add-car-trims');
  const inputLabel = wrap.querySelector('.add-car-trim-input-label');
  inputLabel.insertAdjacentHTML('beforebegin', addCarTrimChipHtml(trim));
  const chip = inputLabel.previousElementSibling;
  chip.querySelector('.add-car-trim-remove').addEventListener('click', () => chip.remove());
}

function clearAddCarErrors(form) {
  form.querySelectorAll('.add-car-error').forEach((el) => {
    el.textContent = '';
  });
  form.querySelectorAll('.add-car-field').forEach((el) => el.classList.remove('has-error'));
}

// Server-side field names line up with this form's fields (make, model,
// years, zip, trims, conditions) with one exception: `form` covers both a
// general failure and anything the fieldset-level fields (trims,
// conditions) can't attach to a single input.
function showAddCarErrors(form, errors) {
  clearAddCarErrors(form);
  for (const [field, message] of Object.entries(errors ?? {})) {
    const errorEl = form.querySelector(`[data-error-for="${field}"]`) ?? form.querySelector('[data-error-for="form"]');
    if (errorEl) errorEl.textContent = message;
    const fieldWrap = form.querySelector(`.add-car-field[data-field="${field}"]`);
    if (fieldWrap) fieldWrap.classList.add('has-error');
  }
}

async function handleAddCarSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const submitBtn = form.querySelector('.add-car-submit');
  clearAddCarErrors(form);
  if (submitBtn) submitBtn.disabled = true;

  const conditions = [...form.querySelectorAll('input[name="conditions"]:checked')].map((el) => el.value);
  const payload = {
    make: form.elements.make.value,
    model: form.elements.model.value,
    years: form.elements.years.value,
    zip: form.elements.zip.value,
    trims: addCarChipTrims(form),
    conditions,
  };

  try {
    const response = await fetch('/cars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [CLIENT_HEADER]: CLIENT_HEADER_VALUE },
      body: JSON.stringify(payload),
    });

    let result;
    try {
      result = await response.json();
    } catch {
      result = { ok: false, errors: { form: 'Unexpected response from the server.' } };
    }

    if (!response.ok || !result.ok) {
      showAddCarErrors(form, result.errors ?? { form: 'Could not add the car.' });
      if (submitBtn) submitBtn.disabled = false;
      return;
    }
    // Success: the write already triggered an SSE push with the new watch
    // in it, so landing on the watchlist shows it without a manual reload.
    if (submitBtn) submitBtn.disabled = false;
    location.hash = '#/watchlist';
  } catch {
    showAddCarErrors(form, { form: 'Could not reach the server. Check your connection and try again.' });
    if (submitBtn) submitBtn.disabled = false;
  }
}

function attachAddCarHandlers() {
  if (!root) return;
  const form = root.querySelector('.add-car-form');
  if (!form) return;

  const trimInput = form.querySelector('.add-car-trim-input');
  if (trimInput) {
    trimInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      addTrimChip(form, trimInput.value);
      trimInput.value = '';
    });
  }

  form.querySelectorAll('input[name="conditions"]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      checkbox.closest('.add-car-condition').classList.toggle('add-car-condition-checked', checkbox.checked);
    });
  });

  form.addEventListener('submit', handleAddCarSubmit);
}

function renderAddCarScreen() {
  root.innerHTML = addCarScreenHtml();
  attachAddCarHandlers();
}

// --- Top level: dispatch nav + main content from the whole app's data and
// the current route -----------------------------------------------------

let lastAppData = null;

function renderApp(data) {
  lastAppData = data;
  const route = parseRoute(typeof location !== 'undefined' ? location.hash : '');

  if (navRoot) navRoot.innerHTML = navHtml(data.cars ?? [], route);

  if (data.error) {
    const messages = {
      missing: 'car-tracker/data/tracker.md is missing.',
      unreadable: 'car-tracker/data/tracker.md could not be read.',
      blocked: 'Refused to read a path outside car-tracker/data/.',
      malformed: 'car-tracker/data/tracker.md could not be parsed.',
    };
    root.innerHTML = `<p class="placeholder">${escapeHtml(messages[data.error] ?? 'Something went wrong reading the data file.')}</p>`;
    return;
  }

  if (route.screen === 'car' && data.details && data.details[route.carId]) {
    renderCarDetail(data.details[route.carId]);
  } else if (route.screen === 'add-car') {
    renderAddCarScreen();
  } else {
    renderWatchlistScreen(data);
  }
}

function connect() {
  const source = new EventSource('/events');

  source.addEventListener('tracker', (event) => {
    try {
      renderApp(JSON.parse(event.data));
    } catch (err) {
      console.error('Failed to parse tracker payload', err);
    }
  });

  source.onerror = () => {
    // Connection drops are silent by design (requirement fix/002) — the
    // page no longer announces live-reload status, it just re-renders
    // when the next 'tracker' event arrives.
  };
}

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    if (lastAppData) renderApp(lastAppData);
  });
  // The remove-trim dialog is static in index.html (outside #app), so its
  // handlers are wired once here rather than per renderCarDetail call.
  attachRemoveTrimDialogHandlers();
  connect();
}
