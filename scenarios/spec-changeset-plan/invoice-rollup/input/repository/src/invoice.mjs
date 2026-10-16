export function total(lines) { return lines.reduce((n, x) => n + x.priceCents * x.quantity, 0); }
