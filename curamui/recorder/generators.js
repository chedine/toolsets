// Value generators for `--generate` replay mode (see replay.js). Pure and
// dependency-free; runs in a normal node process so Math.random is fine.
//
// A recording captured with concrete identity data (a specific name/SSN) can
// be replayed repeatedly, each run minting fresh values for the fields listed
// under `generate` in config.json, so every replay creates a distinct person
// without hand-editing params.

const FIRST = ['Ambrose', 'Bram', 'Cormac', 'Dax', 'Ellery', 'Fenn', 'Gray', 'Hollis',
  'Ivo', 'Jonas', 'Kip', 'Leif', 'Mabon', 'Nash', 'Orrin', 'Perrin', 'Quill',
  'Roderick', 'Soren', 'Thaddeus', 'Ulric', 'Vance', 'Wystan', 'Yorick'];
const LAST = ['Ashby', 'Beale', 'Calloway', 'Dane', 'Ellis', 'Frost', 'Grier', 'Hale',
  'Ives', 'Kettle', 'Locke', 'Marsh', 'Nolan', 'Ondrej', 'Pryce', 'Rourke',
  'Sloane', 'Trent', 'Vance', 'Wexler'];

const pick = a => a[Math.floor(Math.random() * a.length)];
const digits = n => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
const letters = n => Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');

// Generate a value from a generator spec. Spec is `{ type, ...options }`:
//   { type: "firstName" }
//   { type: "lastName", unique: true }        // appends letters for uniqueness
//   { type: "ssn", area: "091" }              // digits only (Curam rejects dashes)
//   { type: "digits", length: 9 }
//   { type: "text", prefix: "X", length: 4 }
// (A `{ ref: "<field>" }` spec is resolved by the caller, not here.)
function generate(spec) {
  const t = (spec.type || '').toLowerCase();
  switch (t) {
    case 'firstname': return pick(FIRST);
    case 'lastname':  return pick(LAST) + (spec.unique ? letters(spec.suffixLen || 4) : '');
    case 'name':      return pick(FIRST) + ' ' + pick(LAST) + (spec.unique ? letters(spec.suffixLen || 4) : '');
    case 'ssn':       return String(spec.area || '091') + digits(6);
    case 'digits':    return digits(spec.length || 9);
    case 'text':      return (spec.prefix || 'X') + letters(spec.length || 4);
    default: throw new Error(`unknown generator type "${spec.type}"`);
  }
}

module.exports = { generate };
