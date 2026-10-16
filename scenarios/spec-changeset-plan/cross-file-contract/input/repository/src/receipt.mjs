import { quote } from "./quote.mjs";
export function receipt(priceCents, rawQty) { return `${quote(priceCents, rawQty)} cents`; }
