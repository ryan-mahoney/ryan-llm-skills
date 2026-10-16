export function list(records, tenantId) { return records; }
export function remove(records, tenantId, id) { return records.filter(r => r.id !== id); }
