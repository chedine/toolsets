// Value generators for `param gen <name> as <type>` params (see replay.js).
// Backed by @faker-js/faker. Runs in a normal node process.
//
// A recording that declares generated params mints fresh values for them on
// every replay, so each run creates a distinct person (unique name/SSN) with
// no hand-editing — a --param override pins one for the run.

const { faker } = require('@faker-js/faker');

const letters = n => faker.string.alpha({ length: n, casing: 'upper' });

// Generate a value from a generator spec. Spec is `{ type, ...options }`:
//   { type: "firstName" }
//   { type: "lastName", unique: true }        // appends letters for uniqueness
//   { type: "name", unique: true }
//   { type: "ssn", area: "091" }              // digits only (Curam rejects dashes)
//   { type: "digits", length: 9 }
//   { type: "text", prefix: "X", length: 4 }
// (A `{ ref: "<field>" }` spec is resolved by the caller, not here.)
function generate(spec) {
  const t = (spec.type || '').toLowerCase();
  const uniq = spec.unique ? letters(spec.suffixLen || 4) : '';
  switch (t) {
    case 'firstname': return faker.person.firstName();
    case 'lastname':  return faker.person.lastName() + uniq;
    case 'name':      return faker.person.fullName() + uniq;
    // SSN: a valid area (091 works on this dummy data) + 6 random digits,
    // digits only — Curam's SSN field rejects dashed input.
    case 'ssn':       return String(spec.area || '091') + faker.string.numeric(6);
    case 'digits':    return faker.string.numeric(spec.length || 9);
    case 'text':      return (spec.prefix || 'X') + letters(spec.length || 4);
    default: throw new Error(`unknown generator type "${spec.type}"`);
  }
}

module.exports = { generate };
