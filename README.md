# Car Watch

A local screen for tracking car price quotes over time and incentive
deadlines, backed by a hand-edited markdown data file. No external data
source, no build step, zero third-party dependencies — Node's standard
library plus hand-written HTML/CSS/JS. No outbound network calls of any
kind — see Security below.

The visual language is dark and high-contrast, built for legibility rather
than decoration — this app is for making a real spending decision, not for
browsing.

## Run it

```
npm install   # no-op today; there are no dependencies
npm start
```

The terminal prints the local URL, e.g.:

```
Car tracker running at http://127.0.0.1:5758
```

Open that URL in Chrome or Safari. The page updates itself within a few
seconds of any edit to `data/tracker.md` — no manual refresh.

Override the port with `PORT=xxxx npm start`.

The repo ships with `data/tracker.sample.md` as a starting point — copy it
to `data/tracker.md` (or edit `data/tracker.md` directly) to try the app
with fictional data before replacing it with your own.

## Test

```
npm test
```

Runs Node's built-in test runner (`node --test`) against everything in
`test/`.

## Editing your data

Most data lives in one file: `data/tracker.md`. You can also add a car, a
price reading, or a quote from the app itself (the add-car and
record-a-reading forms, and the quote-log form on a configuration's detail
screen) — those write back to the same file, so hand-editing and using the
app are always in sync. The file has five sections, in any order, each
introduced by a `##` heading: **Car** (what you're shopping for),
**Configuration** (one model year + trim + condition of it), **Price
point** (an observed or estimated figure), **Quote** (a dealer quote),
and **Incentive** (a manufacturer or dealer offer).

```markdown
## Cars
- id: cx90 | make: Mazda | model: CX-90 Turbo | years: 2025-2026 | trims: Preferred, Premium Sport | conditions: new, used | zip: | created: 2026-09-17 | check_interval_days: 14 | last_checked: 2026-09-18

## Configurations
- id: cx90-2026-preferred | car: cx90 | year: 2026 | trim: Preferred | condition: new
- id: cx90-2025-preferred-used | car: cx90 | year: 2025 | trim: Preferred | condition: used | archived: no

## Price points
- id: pp1 | configuration: cx90-2026-preferred | value: 43450 | basis: msrp | destination: excluded | sample_size: | range_low: | range_high: | source: Mazda USA 2026 pricing announcement | source_url: | confirmed: no | observed: 2026-09-17 | note:
- id: pp2 | configuration: cx90-2025-preferred-used | value: 34068 | basis: listing_average | destination: | sample_size: 219 | range_low: 24750 | range_high: 43181 | source: CarGurus — average across 219 listings | source_url: | confirmed: yes | observed: 2026-09-18 | note:

## Quotes
- id: q1 | configuration: cx90-2026-preferred | value: 42900 | dealer: Smith Mazda | quoted: 2026-09-20 | note: out-the-door quote by phone

## Incentives
- id: inc1 | car: cx90 | kind: apr | headline: 0% APR for 36 months | terms: | amount: | apr_terms: 0% APR for 36 months | provider: Mazda Financial Services | source: | confirmed: yes | expires: 2026-09-30 | applies_to: cx90-2026-preferred
```

**Cars** — one line per car, `key: value` pairs separated by ` | `:
- `id` — **required**, a short, unique, hand-picked slug (e.g. `cx90`).
  Every configuration and incentive below refers to a car by this id.
- `make`, `model` — **required** free text.
- `years`, `trims`, `conditions` — optional descriptive text; `trims` and
  `conditions` are comma-separated lists.
- `zip`, `created` (`YYYY-MM-DD`) — optional; leave blank rather than
  guessing if you don't know them.
- `check_interval_days` — optional integer; how often you re-check this
  car's prices. Defaults to `14` when blank, missing, or not a positive
  integer — a car always has some cadence.
- `last_checked` (`YYYY-MM-DD`) — optional; the date of the most recent
  check. Leave it blank until you've actually done one under this system.
  The next-due date is never stored — it's computed as `last_checked +
  check_interval_days` (`lib/model.js#dueDate`) so it can't drift from the
  values it comes from.

**Configurations** — one model year + trim + condition of a car:
- `id` — **required**, unique, referenced by price points, quotes, and
  incentives' `applies_to`.
- `car` — **required**, must match a Cars `id`.
- `year` — **required**, a 4-digit model year.
- `trim` — **required** free text.
- `condition` — `new`, `used`, or `cpo`. A missing or unrecognized
  condition still parses (so one bad line doesn't drop the rest of the
  file) but shows a visible warning rather than silently defaulting to
  new.
- `archived` — `yes` or `no`; defaults to `no`. Removing a trim from a
  watch sets this to `yes` on every Configuration with that trim, across
  every model year — it never deletes the line. Archived Configurations
  (and the Price points and Quotes that reference them) are excluded from
  every view but kept in the file; re-adding the trim later restores them
  by flipping this back to `no`. See `lib/archive.js`.

**Price points** — one line per observed or estimated figure:
- `id`, `configuration` — **required**; `configuration` must match a
  Configurations `id`.
- `value` — **required**, a number; `$` and `,` are fine.
- `basis` — **the field that stops an MSRP being read as an asking
  price.** One of `msrp`, `listing`, `listing_average`,
  `valuation_estimate`. Leave it blank (or write `unknown`) rather than
  guess when the source text doesn't make it clear — a wrong basis is
  worse than a missing one.
- `destination` — `included` or `excluded` for an MSRP; leave blank
  (unknown) for a listing or estimate, where the figure isn't decomposed
  into base + destination.
- `sample_size` — integer, only for an average (e.g. `219` for "average
  across 219 listings").
- `range_low`, `range_high` — numbers, only when the source reported a
  range.
- `source`, `source_url` — free text / a URL.
- `confirmed` — `yes` (default if omitted) or `no`, for a figure that's
  aggregator-reported rather than confirmed directly.
- `observed` — `YYYY-MM-DD`. A price point with no date still parses but
  won't appear on a price trend (there's no way to place it in time).
- `note` — free text, e.g. `Lakeland, FL` or a supply-scarcity warning.

**Quotes** — one line per dealer quote (user-entered only, never scraped;
add these from a configuration's detail screen, or add a line here
directly):
- `id`, `configuration` — **required**; `configuration` must match a
  Configurations `id`.
- `value` — **required**, a number.
- `dealer` — **required** free text.
- `quoted` — `YYYY-MM-DD`, optional.
- `note` — optional free text.

**Incentives** — one line per offer:
- `id`, `car` — **required**; `car` must match a Cars `id`.
- `headline` — **required** free text describing the offer.
- `expires` — **required**, `YYYY-MM-DD`.
- `kind` — `apr`, `customer_cash`, or `lease`; left blank/unrecognized
  becomes unset rather than guessed.
- `terms`, `amount`, `apr_terms`, `provider`, `source` — optional free
  text.
- `confirmed` — same `yes`/`no` rule as price points.
- `applies_to` — comma-separated list of Configuration ids this offer
  covers. An incentive that applies to several configurations needs only
  one line, not one per configuration.

A line that doesn't parse (missing a required field, a bad date, a
non-numeric value) is skipped rather than crashing the app or the rest of
the file.

Figures pulled from an aggregator or a search snippet rather than
confirmed directly should be marked `confirmed: no`, not silently
presented as fact — that's the whole point of recording a `source` at
all.

The left nav lists every tracked car; a configuration's row opens a
detail screen nested by year, trim, and condition, with its own price
trend chart and sparkline. Incentives that share an `expires` date and
identical text are grouped under one deadline heading, with every
configuration they cover listed underneath.

## How it's put together

- `server.js` — HTTP server (`node:http`), SSE push on file change
  (`node:fs` watcher), static asset routes, and the write endpoints below.
  No dependencies, no outbound requests.
- `lib/parse-tracker.js` — the pure parser for the five sections above:
  Cars, Configurations, Price points, Quotes, Incentives.
- `lib/tracker-data.js` — reads `data/tracker.md`, calls the parser, and
  computes derived values: days remaining/expired per incentive, the
  check-due date, and the first-to-latest price trend per configuration.
  Takes a data root directory as a parameter so tests can point it at a
  scratch directory.
- `lib/model.js` — pure data-model functions: the derived check-due date,
  the trend-eligibility rule, a stable reading order for the chart, and
  the archived/visible join between Configurations and their Price
  points and Quotes.
- `lib/archive.js` — archiving and restoring a trim: an `archived` flag,
  never a delete, cascading from a trim to every Configuration with that
  name across all model years on the same car.
- `lib/cars.js`, `lib/trims.js`, `lib/quotes.js`, `lib/readings.js` — the
  write paths: adding a car, adding/archiving a trim, logging a quote,
  and recording a price reading. Each validates its input and appends to
  `data/tracker.md` rather than rewriting it wholesale.
- `lib/write-queue.js` — serializes concurrent writes to `data/tracker.md`
  so two requests can't interleave and corrupt the file.
- `lib/tracker-sections.js`, `lib/watchlist.js`, `lib/trend-chart.js` —
  section-level parsing helpers, the watchlist view, and the pure
  (DOM-free) geometry for the trend chart and sparklines.
- `lib/safe-path.js` — the path-traversal guard every file read goes
  through.
- `lib/markdown.js` — a hand-rolled, escape-first inline renderer
  (`**bold**`, `` `code` ``).
- `public/` — the page itself: `index.html`, `style.css` (dark,
  high-contrast), `app.js` (connects to `/events`, re-renders on each
  push, and submits the write forms).

## Security properties

- **No outbound network access.** No HTTP client, no API keys, no
  requests to anything outside this machine. Every number in the data
  file is there because a person put it there.
- Binds to `127.0.0.1` only — not reachable from other machines on the
  network.
- The server only ever reads/writes one fixed, known-safe relative path,
  `data/tracker.md`, and that path still goes through `lib/safe-path.js`
  as defense in depth — see `test/safe-path.test.js` for the traversal
  cases it rejects.
- Every write endpoint (`/cars`, `/cars/archive`, `/trims/add`,
  `/trims/archive`, `/quotes`, `/readings`) checks the request's `Origin`
  and a custom client header before touching the file, and validates
  every field server-side even though the UI already validates it — see
  `test/write-endpoints.test.js`. Archiving never deletes a line; it only
  flips a flag, and restoring a trim brings back its exact history.
- All rendered text — dealer names, sources, incentive descriptions — is
  HTML-escaped before any markup is applied. See `test/markdown.test.js`.
- A missing or malformed data file produces a readable placeholder instead
  of crashing the server or blanking the page — see
  `test/tracker-data.test.js`.
