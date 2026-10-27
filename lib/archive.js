// Archiving a trim (requirement 004, stage 1: "the single most important
// thing in this stage"). Removing a trim from a watch must archive it,
// never delete it — one mis-click can't be allowed to destroy months of
// price history. Re-adding a previously removed trim must restore that
// history intact.
//
// A trim belongs to the watch, not to a model year (requirement 004,
// "Trims are editable after the watch exists... removing it applies
// across every year at once") — archiving "Preferred" archives every
// Configuration on this car named "Preferred", across every model year,
// in one call.
//
// Pure functions only, no I/O: they take and return plain arrays, the
// same shape lib/parse-tracker.js produces. There is no write endpoint
// yet — this stage explicitly excludes new write endpoints — so nothing
// here reads or writes tracker.md. A later stage wires these to one, the
// same way lib/quotes.js's pure validate/build functions were written
// before server.js's POST /quotes existed.

// Archives every Configuration on `car` with this trim, across every
// model year. PricePoints and Quotes are untouched — their visibility
// follows their Configuration automatically (see lib/model.js) — and
// `car.trimsTracked` drops the trim so it stops being offered as
// currently watched.
export function archiveTrim(car, configurations, trim) {
  const configurationsOut = configurations.map((c) =>
    c.car === car.id && c.trim === trim ? { ...c, archived: true } : c
  );
  const trimsTracked = car.trimsTracked.filter((t) => t !== trim);
  return { car: { ...car, trimsTracked }, configurations: configurationsOut };
}

// Restores every archived Configuration on `car` with this trim. This is
// the "re-adding a previously removed trim" path — it only flips
// `archived` back to false on the matching Configurations and puts the
// trim back in `car.trimsTracked`, appended at the end (the same place
// any newly added trim would land — restore doesn't try to remember its
// old position in the list, only its data). No PricePoint or Quote
// record is ever touched by archiving or restoring a trim, so there is
// nothing for restore to lose.
export function restoreTrim(car, configurations, trim) {
  const configurationsOut = configurations.map((c) =>
    c.car === car.id && c.trim === trim ? { ...c, archived: false } : c
  );
  const trimsTracked = car.trimsTracked.includes(trim)
    ? car.trimsTracked
    : [...car.trimsTracked, trim];
  return { car: { ...car, trimsTracked }, configurations: configurationsOut };
}

// Archives a whole watch (requirement 004, "Removing a whole watch follows
// the same archive-and-confirm pattern"). Only the Car record's own flag
// changes — every Configuration, PricePoint and Quote underneath it is
// left exactly as it was, including whichever of its trims were already
// individually archived, so a restored watch (re-adding the same car —
// there is no restore-a-watch write path yet, see lib/parse-tracker.js)
// would come back to exactly the state it was in when removed. Visibility
// is handled entirely by lib/model.js#visibleCars filtering the Car out of
// every read path; nothing here touches its children.
export function archiveCar(car) {
  return { ...car, archived: true };
}
