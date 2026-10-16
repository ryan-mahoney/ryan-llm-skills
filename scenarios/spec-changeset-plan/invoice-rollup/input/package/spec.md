# invoice-rollup

Implement invoice totals. In src/invoice.mjs replace total with an exported summarize(lines, discountBps=0) that returns {subtotalCents,discountCents,totalCents}. Every line needs nonnegative safe integer priceCents and quantity; lines must be an array; discountBps is an integer in 0..10000. Reject invalid values and unsafe multiplication/sums with RangeError. Round discount to nearest cent, with half cents rounding up, without losing integer precision. Preserve exported total(lines) as summarize(lines).totalCents. Empty lines return zeros.
In src/format.mjs implement formatCents(cents): require safe integer cents, return dollars with exactly two decimal places, e.g. 123 -> "$1.23", -5 -> "-$0.05", 0 -> "$0.00"; reject other values with RangeError. Preserve exact cent precision even near MAX_SAFE_INTEGER.
Set config.json version to 2 and features.invoice to true, preserving currency.
Execution classification: the invoice algorithm uses involved; formatter uses simple; config changes use deterministic. Keep unrelated files unchanged.
