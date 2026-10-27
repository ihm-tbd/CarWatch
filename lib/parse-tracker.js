// Parses car-tracker/data/tracker.md into five plain arrays: cars,
// configurations, pricePoints, quotes, and incentives — the entities from
// docs/requirements/003-car-tracker-v2-detail.md ("data model"). Never
// throws — garbage or empty input just produces empty arrays, so the
// caller can show a placeholder instead of crashing. This mirrors
// dashboard/lib/parse-status.js and V1's parse-tracker.js.
//
// Format (see car-tracker/README.md for the full worked example):
//
//   ## Cars
//   - id: <id> | make: <text> | model: <text> | years: <text> | trims: <csv> | conditions: <csv> | zip: <text> | created: YYYY-MM-DD | check_interval_days: <int> | last_checked: YYYY-MM-DD | archived: yes|no
//
//   ## Configurations
//   - id: <id> | car: <car id> | year: YYYY | trim: <text> | condition: new|used|cpo | archived: yes|no
//
//   ## Price points
//   - id: <id> | configuration: <configuration id> | value: <number> | basis: msrp|listing|listing_average|valuation_estimate | destination: included|excluded | sample_size: <int> | range_low: <number> | range_high: <number> | source: <text> | source_url: <text> | confirmed: yes|no | observed: YYYY-MM-DD | note: <text> | sample_listings: <optional>
//
//   `sample_listings` (requirement 007, "evidence for averages") is
//   optional and only meaningful on a `listing_average`: two or three
//   concrete listings a reader can check the average against. Format is
//   deliberately not CSV (commas appear in "City, ST") and not `|`
//   (already the top-level field separator): one listing is
//   `price/mileage/location`, multiple listings are separated by `;`, e.g.
//   `sample_listings: 30691/41972/Haverhill, MA; 32869/19815/Bountiful, UT`.
//   A listing that doesn't parse a numeric price is dropped rather than
//   guessed at; older readings simply omit this field and parse to `[]`.
//
//   ## Quotes
//   - id: <id> | configuration: <configuration id> | value: <number> | dealer: <text> | quoted: YYYY-MM-DD | note: <text>
//
//   ## Incentives
//   - id: <id> | car: <car id> | kind: apr|customer_cash|lease | headline: <text> | terms: <text> | amount: <text> | apr_terms: <text> | provider: <text> | source: <text> | confirmed: yes|no | expires: YYYY-MM-DD | applies_to: <csv of configuration ids>
//
// `confirmed` defaults to yes when omitted — Ian's own dealer quotes and
// direct lookups don't need to say so every time; only aggregator-reported
// figures need the explicit `confirmed: no`.
//
// `condition` on a Configuration works like V1's vehicle condition: a
// missing or unrecognized value still parses (so the rest of the file
// isn't punished for one bad line), but carries `condition: null` so the
// UI can show a visible warning instead of silently defaulting to "new".
//
// `basis` on a PricePoint is one of four known values, or the literal
// string `'unknown'` — used deliberately (see requirement 003: "a wrong
// basis is worse than an absent one"). A missing or unrecognized basis in
// the file is treated the same as writing `basis: unknown`.
//
// This is a breaking format change from V1 (flat Vehicles / Price
// observations / Incentives sections) — there is no backward-compatible
// fallback for the old section names or the old bare `- <vehicle name>`
// line. See docs/requirements/003-car-tracker-v2-detail.md.
//
// Requirement 004 (Car Watch V2, stage 1) additions:
//
// `Car.trimsTracked` (parsed from the `trims` field — same file key, the
// in-memory property is renamed to match the spec, since this list is
// now mutable after the watch is created: archiving a trim removes it,
// restoring one adds it back).
//
// `Car.checkIntervalDays` (from `check_interval_days`) defaults to 14
// whenever the field is missing, blank, or not a positive integer — a
// car always has *some* cadence, so this never comes back null.
// `Car.lastCheckedAt` (from `last_checked`, `YYYY-MM-DD`) is null when no
// check has been recorded yet. The next-due date is deliberately never
// stored anywhere — it's `lastCheckedAt + checkIntervalDays`, computed by
// `lib/model.js#dueDate`, so it can't drift from the values it comes
// from.
//
// `Configuration.archived` (from `archived`, `yes`/`no`) defaults to
// `false`. Removing a trim from a watch never deletes its Configuration,
// PricePoint, or Quote records — it sets this flag on the matching
// Configurations (see `lib/archive.js`). PricePoints and Quotes don't
// carry their own `archived` flag; their visibility is derived by
// joining to their Configuration's flag (`lib/model.js#visiblePricePoints`
// / `#visibleQuotes`), so restoring a trim can never leave a stray
// archived price point or quote out of sync with its parent.
//
// `Car.archived` (from `archived`, `yes`/`no`, stage 4c) defaults to
// `false`, same flag and same reasoning one level up: removing a whole
// watch sets this on the Car record alone. Its Configurations keep
// whatever `archived` value they already had — a trim that was archived
// before the watch was removed stays archived, and every one of the
// watch's live Configurations, PricePoints and Quotes are still on file,
// simply unreachable because `lib/model.js#visibleCars` drops the Car
// itself from every read path. There is currently no restore-a-watch
// write path (only restore-a-trim, via `POST /trims/add`); the flag is
// still the same non-destructive archive, not a delete.

const SECTION_RE = /^##\s+(.*)$/;
const ITEM_RE = /^-\s+(.*)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const YEAR_RE = /^\d{4}$/;
const VALID_CONDITIONS = new Set(['new', 'used', 'cpo']);
const VALID_BASES = new Set(['msrp', 'listing', 'listing_average', 'valuation_estimate']);
const VALID_KINDS = new Set(['apr', 'customer_cash', 'lease']);

// A car always has some re-check cadence, so a missing/blank/invalid
// `check_interval_days` falls back to this rather than coming back null
// (requirement 004: "Car gains a check interval (14 days)").
export const DEFAULT_CHECK_INTERVAL_DAYS = 14;

const SECTION_KEYS = {
  'cars': 'cars',
  'configurations': 'configurations',
  'price points': 'pricePoints',
  'quotes': 'quotes',
  'incentives': 'incentives',
};

function parseFields(rest) {
  const fields = {};
  for (const part of rest.split(/\s*\|\s*/)) {
    const colon = part.indexOf(':');
    if (colon === -1) continue;
    const key = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    if (key) fields[key] = value;
  }
  return fields;
}

function parseAmount(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[$,]/g, '').trim();
  if (cleaned === '') return null;
  const amount = Number(cleaned);
  return Number.isFinite(amount) ? amount : null;
}

function parseIntOrNull(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/,/g, '').trim();
  if (cleaned === '' || !/^\d+$/.test(cleaned)) return null;
  return Number.parseInt(cleaned, 10);
}

function parseCsv(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseDateOrNull(raw) {
  return typeof raw === 'string' && DATE_RE.test(raw.trim()) ? raw.trim() : null;
}

// Requirement 007, "evidence for averages": `price/mileage/location`
// listings separated by `;`. Never throws — a listing whose price doesn't
// parse is dropped rather than shown as a guess; an entirely blank or
// missing field parses to `[]` so older readings render exactly as before.
function parseSampleListings(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  const listings = [];
  for (const chunk of raw.split(';')) {
    if (chunk.trim() === '') continue;
    const [priceRaw, mileageRaw, ...locationParts] = chunk.split('/');
    const price = parseAmount(priceRaw);
    if (price === null) continue;
    const mileage = parseIntOrNull((mileageRaw ?? '').replace(/mi\b/i, ''));
    const location = locationParts.join('/').trim();
    listings.push({ price, mileage, location });
  }
  return listings;
}

function isConfirmed(raw) {
  return String(raw ?? 'yes').trim().toLowerCase() !== 'no';
}

function normalizeCondition(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return VALID_CONDITIONS.has(value) ? value : null;
}

// A wrong basis is worse than an absent one (requirement 003), so this
// never guesses — anything not exactly one of the four known values
// (including a blank field) comes back as the explicit 'unknown' string,
// never null and never a silently-assumed default.
function normalizeBasis(raw) {
  if (typeof raw !== 'string') return 'unknown';
  const value = raw.trim().toLowerCase();
  return VALID_BASES.has(value) ? value : 'unknown';
}

// true / false / null (unknown) — mirrors the spec's "bool, null when
// unknown" for PricePoint.includesDestination.
function normalizeDestination(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (value === 'included') return true;
  if (value === 'excluded') return false;
  return null;
}

function normalizeKind(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return VALID_KINDS.has(value) ? value : null;
}

// yes/no flag that defaults to false when omitted — the opposite default
// from `confirmed`, because the safe/normal state for a new field like
// `archived` is "not archived", not "archived".
function isYes(raw) {
  return String(raw ?? '').trim().toLowerCase() === 'yes';
}

function parseCheckIntervalDays(raw) {
  const n = parseIntOrNull(raw);
  return n !== null && n > 0 ? n : DEFAULT_CHECK_INTERVAL_DAYS;
}

export function parseTracker(text) {
  const result = { cars: [], configurations: [], pricePoints: [], quotes: [], incentives: [] };
  if (typeof text !== 'string' || text.trim() === '') return result;

  const lines = text.split(/\r?\n/);
  let section = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;

    const heading = line.match(SECTION_RE);
    if (heading) {
      section = SECTION_KEYS[heading[1].trim().toLowerCase()] ?? null;
      continue;
    }

    const item = line.match(ITEM_RE);
    if (!item || !section) continue;
    const fields = parseFields(item[1]);

    if (section === 'cars') {
      if (!fields.id || !fields.make || !fields.model) continue;
      result.cars.push({
        id: fields.id,
        make: fields.make,
        model: fields.model,
        years: fields.years ?? '',
        trimsTracked: parseCsv(fields.trims),
        conditions: parseCsv(fields.conditions),
        zip: fields.zip ?? '',
        created: parseDateOrNull(fields.created),
        checkIntervalDays: parseCheckIntervalDays(fields.check_interval_days),
        lastCheckedAt: parseDateOrNull(fields.last_checked),
        archived: isYes(fields.archived),
      });
      continue;
    }

    if (section === 'configurations') {
      if (!fields.id || !fields.car || !fields.year || !YEAR_RE.test(fields.year.trim()) || !fields.trim) continue;
      result.configurations.push({
        id: fields.id,
        car: fields.car,
        year: fields.year.trim(),
        trim: fields.trim,
        condition: normalizeCondition(fields.condition),
        archived: isYes(fields.archived),
      });
      continue;
    }

    if (section === 'pricePoints') {
      if (!fields.id || !fields.configuration) continue;
      const value = parseAmount(fields.value);
      if (value === null) continue;
      result.pricePoints.push({
        id: fields.id,
        configuration: fields.configuration,
        value,
        basis: normalizeBasis(fields.basis),
        destination: normalizeDestination(fields.destination),
        sampleSize: parseIntOrNull(fields.sample_size),
        rangeLow: parseAmount(fields.range_low),
        rangeHigh: parseAmount(fields.range_high),
        source: fields.source ?? '',
        sourceUrl: fields.source_url ?? '',
        confirmed: isConfirmed(fields.confirmed),
        observed: parseDateOrNull(fields.observed),
        note: fields.note ?? '',
        sampleListings: parseSampleListings(fields.sample_listings),
      });
      continue;
    }

    if (section === 'quotes') {
      if (!fields.id || !fields.configuration || !fields.dealer) continue;
      const value = parseAmount(fields.value);
      if (value === null) continue;
      result.quotes.push({
        id: fields.id,
        configuration: fields.configuration,
        value,
        dealer: fields.dealer,
        quoted: parseDateOrNull(fields.quoted),
        note: fields.note ?? '',
      });
      continue;
    }

    if (section === 'incentives') {
      if (!fields.id || !fields.car || !fields.headline || !fields.expires || !DATE_RE.test(fields.expires)) continue;
      result.incentives.push({
        id: fields.id,
        car: fields.car,
        kind: normalizeKind(fields.kind),
        headline: fields.headline,
        terms: fields.terms ?? '',
        amount: fields.amount ?? '',
        aprTerms: fields.apr_terms ?? '',
        provider: fields.provider ?? '',
        source: fields.source ?? '',
        confirmed: isConfirmed(fields.confirmed),
        expires: fields.expires,
        appliesTo: parseCsv(fields.applies_to),
      });
      continue;
    }
  }

  return result;
}
