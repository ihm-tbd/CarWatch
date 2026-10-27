// A single write queue shared by every module that mutates tracker.md
// (lib/quotes.js, lib/cars.js, lib/trims.js). Requirement 004 grows the
// write surface from one endpoint to four; each does its own
// read-parse-validate-write cycle with awaits in between, so two per-module
// queues would still let two different endpoints race against each other
// (e.g. a quote submission and a trim archive both reading the file before
// either writes back, one clobbering the other's change). Routing every
// write through one shared chain closes that gap the same way
// lib/quotes.js's original module-local queue closed the single-endpoint
// version of it.

let chain = Promise.resolve();

export function serialize(run) {
  const result = chain.then(run);
  chain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}
