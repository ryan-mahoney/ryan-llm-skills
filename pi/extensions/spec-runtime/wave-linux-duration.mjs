// Shared systemd property parsing for the native Linux wave cases (step 13).
//
// systemctl presents time properties as a compound, unit-suffixed duration
// (for example "2h 29min 58.800s"), so a single term regex cannot read them.
// parseUsecProperty understands the whole systemd duration presentation and
// returns exact microseconds, while a bare numeric value stays microseconds as
// it always has.
const UNIT_USEC = {
  us: 1,
  'µs': 1,
  ms: 1000,
  s: 1000000,
  min: 60 * 1000000,
  h: 60 * 60 * 1000000,
  d: 24 * 60 * 60 * 1000000,
  w: 7 * 24 * 60 * 60 * 1000000,
};

const TERM = /(\d+(?:\.\d+)?)(us|µs|ms|min|s|h|d|w)/y;

// Parses one systemd duration string ("1h 59min 58s", "2h29.800s", "1.5s") into
// integer microseconds. Returns NaN for empty, negative, nonfinite, unsupported
// or partially consumed input so a caller's exact comparison fails loudly.
export function parseUsecProperty(value) {
  const text = String(value ?? '').trim();
  if (text === '') return Number.NaN;
  // A bare nonnegative number keeps its historical microseconds meaning, but
  // only when its value is exactly representable as a safe integer.
  if (/^\d+$/.test(text)) {
    const bare = Number(text);
    return Number.isSafeInteger(bare) ? bare : Number.NaN;
  }
  let total = 0;
  let index = 0;
  let terms = 0;
  while (index < text.length) {
    // systemd separates terms with optional whitespace; nothing else is allowed.
    if (text[index] === ' ') {
      index += 1;
      continue;
    }
    TERM.lastIndex = index;
    const match = TERM.exec(text);
    if (!match) return Number.NaN;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount < 0) return Number.NaN;
    total += amount * UNIT_USEC[match[2]];
    index = TERM.lastIndex;
    terms += 1;
  }
  if (terms === 0 || !Number.isFinite(total) || !Number.isSafeInteger(Math.round(total))) return Number.NaN;
  return Math.round(total);
}
