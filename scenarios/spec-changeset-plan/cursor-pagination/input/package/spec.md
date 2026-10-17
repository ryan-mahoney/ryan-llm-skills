# cursor-pagination

Implement page(records,{tenantId,after=null,limit=2}) returning {items,nextCursor}. Require nonempty string tenantId and integer limit 1..100; invalid values throw TypeError. Filter to tenant first, sort ascending by ASCII string id without mutating inputs. after=null starts at beginning; otherwise after must match an id in the filtered tenant records or throw RangeError. Return up to limit records strictly after cursor. nextCursor equals last returned id only if more filtered records remain, otherwise null. Empty result has null cursor. Inputs have unique nonempty string IDs within a tenant.
Implement summary(count): nonnegative safe integer required (RangeError otherwise), 0 -> "No records", 1 -> "1 record", all other valid counts -> "N records".
Set config pagination="cursor", preserve keep. Execution classification: page involved, summary simple, config deterministic. Keep unrelated files unchanged.
