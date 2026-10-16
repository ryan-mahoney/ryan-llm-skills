import { parseQty } from "./quantity.mjs";
export function quote(priceCents, rawQty) { return priceCents * parseQty(rawQty); }
