// Requirement 007: plausibility checks over an already-*parsed*
// tracker.md — properties a line can satisfy while parsing perfectly and
// still be wrong. lib/parse-tracker.js already rejects malformed lines
// (a missing id, an unparseable value); this module runs *after* that,
// on data that is well-formed but may be internally inconsistent — the
// class of bug that shipped a KBB valuation estimate for one trim next to
// a 216-listing average for its sibling with nothing to say they came
// from different kinds of evidence.
//
// Pure and read-only: every function takes the object `parseTracker()`
// returns and a parsed tracker never mutates. No filesystem access here —
// callers (tests, and anything future reading the shipped file) do their
// own read through lib/safe-path.js and hand the parsed result in.
//
// Every check returns an array of `{ check, recordId, message }` issues.
// `message` always names the offending record's id and says what's wrong
// with it — "assertion failed" helps nobody at 11pm (requirement 007).

// The check that would have caught the original bug: the broken lookup
// built a second trim's URL by editing the first trim's, got the first
// trim's data back, and would have recorded it under the second trim's
// configuration — same source_url, same observed date, two different
// configurations. Two price points for the *same* configuration sharing
// a source_url+date (e.g. a line entered twice) aren't this bug and
// aren't flagged.
export function findDuplicateSourceUrlDates(tracker) {
  const firstSeen = new Map(); // `${sourceUrl}\u0000${observed}` -> first PricePoint with it
  const issues = [];
  for (const pp of tracker.pricePoints) {
    if (!pp.sourceUrl || !pp.observed) continue;
    const key = `${pp.sourceUrl}\u0000${pp.observed}`;
    const prior = firstSeen.get(key);
    if (prior) {
      if (prior.configuration !== pp.configuration) {
        issues.push({
          check: 'duplicate_source_url_date',
          recordId: pp.id,
          message:
            `${pp.id} (configuration "${pp.configuration}") shares source_url "${pp.sourceUrl}" and ` +
            `observed date ${pp.observed} with ${prior.id} (configuration "${prior.configuration}") — ` +
            `the exact shape of the bug that silently recorded one trim's listing data under another trim's configuration`,
        });
      }
    } else {
      firstSeen.set(key, pp);
    }
  }
  return issues;
}

// Every observed asking price needs a URL a reader can click to check it.
export function findMissingSourceUrls(tracker) {
  const issues = [];
  for (const pp of tracker.pricePoints) {
    if ((pp.basis === 'listing' || pp.basis === 'listing_average') && !pp.sourceUrl) {
      issues.push({
        check: 'missing_source_url',
        recordId: pp.id,
        message: `${pp.id} has basis "${pp.basis}" but no source_url on file`,
      });
    }
  }
  return issues;
}

// An average means nothing without knowing how many listings and how
// wide a range it came from.
export function findIncompleteListingAverages(tracker) {
  const issues = [];
  for (const pp of tracker.pricePoints) {
    if (pp.basis !== 'listing_average') continue;
    if (pp.sampleSize == null) {
      issues.push({
        check: 'incomplete_listing_average',
        recordId: pp.id,
        message: `${pp.id} has basis "listing_average" but no sample_size on file`,
      });
    }
    if (pp.rangeLow == null || pp.rangeHigh == null) {
      issues.push({
        check: 'incomplete_listing_average',
        recordId: pp.id,
        message: `${pp.id} has basis "listing_average" but no range_low/range_high on file`,
      });
    }
  }
  return issues;
}

// A recorded figure that falls outside its own stated range is internally
// contradictory — either the value or the range was mistyped.
export function findValuesOutsideRange(tracker) {
  const issues = [];
  for (const pp of tracker.pricePoints) {
    if (pp.rangeLow == null || pp.rangeHigh == null) continue;
    if (pp.value < pp.rangeLow || pp.value > pp.rangeHigh) {
      issues.push({
        check: 'value_outside_range',
        recordId: pp.id,
        message: `${pp.id} value ${pp.value} falls outside its own recorded range ${pp.rangeLow}-${pp.rangeHigh}`,
      });
    }
  }
  return issues;
}

// A valuation estimate that doesn't say, in its own source text, that it
// isn't an observed listing reads exactly like a real listing average —
// the distinction this app exists to preserve (requirement 003: "an MSRP
// and a dealer asking price are not the same kind of number").
const NOT_A_LISTING_RE = /not (?:an? )?(?:observed |live )?listing/i;
export function findValuationEstimatesClaimingToBeListings(tracker) {
  const issues = [];
  for (const pp of tracker.pricePoints) {
    if (pp.basis !== 'valuation_estimate') continue;
    if (!NOT_A_LISTING_RE.test(pp.source || '')) {
      issues.push({
        check: 'valuation_estimate_mislabeled',
        recordId: pp.id,
        message: `${pp.id} has basis "valuation_estimate" but its source text doesn't say it isn't an observed listing: "${pp.source}"`,
      });
    }
  }
  return issues;
}

// `today` is injectable so a test can pin "now" instead of racing the
// clock; callers in production should leave it at its default.
export function findFutureObservedDates(tracker, today = new Date()) {
  const todayStr = today.toISOString().slice(0, 10);
  const issues = [];
  for (const pp of tracker.pricePoints) {
    if (pp.observed && pp.observed > todayStr) {
      issues.push({
        check: 'future_observed_date',
        recordId: pp.id,
        message: `${pp.id} observed date ${pp.observed} is in the future (today is ${todayStr})`,
      });
    }
  }
  return issues;
}

// Every configuration id a price point, quote, or incentive points at
// must actually exist — a dangling reference is invisible in the UI
// (the row simply never renders) rather than producing an error, so it
// has to be checked for explicitly.
export function findDanglingConfigurationReferences(tracker) {
  const configIds = new Set(tracker.configurations.map((c) => c.id));
  const issues = [];
  for (const pp of tracker.pricePoints) {
    if (!configIds.has(pp.configuration)) {
      issues.push({
        check: 'dangling_configuration_reference',
        recordId: pp.id,
        message: `${pp.id} references configuration "${pp.configuration}", which does not exist`,
      });
    }
  }
  for (const q of tracker.quotes) {
    if (!configIds.has(q.configuration)) {
      issues.push({
        check: 'dangling_configuration_reference',
        recordId: q.id,
        message: `${q.id} references configuration "${q.configuration}", which does not exist`,
      });
    }
  }
  for (const inc of tracker.incentives) {
    for (const cfgId of inc.appliesTo) {
      if (!configIds.has(cfgId)) {
        issues.push({
          check: 'dangling_configuration_reference',
          recordId: inc.id,
          message: `${inc.id} applies_to references configuration "${cfgId}", which does not exist`,
        });
      }
    }
  }
  return issues;
}

const ALL_CHECKS = [
  findDuplicateSourceUrlDates,
  findMissingSourceUrls,
  findIncompleteListingAverages,
  findValuesOutsideRange,
  findValuationEstimatesClaimingToBeListings,
  findDanglingConfigurationReferences,
];

// Runs every check and returns one flat, ordered list of issues. Accepts
// `{ today }` so future-date detection can be pinned in a test; omit it
// in production to use the real clock.
export function checkTrackerIntegrity(tracker, { today } = {}) {
  const issues = [];
  for (const check of ALL_CHECKS) issues.push(...check(tracker));
  issues.push(...findFutureObservedDates(tracker, today));
  return issues;
}
