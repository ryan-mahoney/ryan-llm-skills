import { readFileSync, realpathSync, writeFileSync } from 'node:fs';

export function readLedger(path) {
  path = realpathSync(path);
  const state = JSON.parse(readFileSync(path, 'utf8')), ids = new Set();
  if (state.schema_version !== 1 || state.limit_usd !== 50 || !Array.isArray(state.entries)) throw new Error('Canonical existing schema1/$50 ledger required');
  for (const entry of state.entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) || typeof entry.selector !== 'string' ||
      !Number.isFinite(entry.reserved_usd) || entry.reserved_usd <= 0 || !['reserved', 'unknown', 'priced'].includes(entry.status) ||
      (['reserved', 'unknown'].includes(entry.status) ? entry.charged_usd != null : !Number.isFinite(entry.charged_usd) || entry.charged_usd < 0)) throw new Error('Ledger status, charge or reservation integrity failed');
    ids.add(entry.id);
  }
  return { path, state };
}

/** One sequential campaign; guard only adds a cap, never changes global accounting. */
export function installReservationGuard({ Budget, ledger, registry, limit = 2, maxReservations, persist = writeFileSync, onPersistenceFailure = () => {} }) {
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isInteger(maxReservations) || maxReservations < 1) throw new Error('Invalid campaign reservation bounds');
  const canonical = readLedger(ledger).path, original = Budget.prototype.reserve;
  const recorded = () => {
    const entries = JSON.parse(readFileSync(registry, 'utf8'));
    if (!Array.isArray(entries) || new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('Campaign registry integrity failed');
    const state = readLedger(canonical).state;
    for (const entry of entries) {
      const row = state.entries.find(row => row.id === entry.id);
      if (!row || row.selector !== entry.selector || row.reserved_usd !== entry.reserved_usd) throw new Error('Campaign reservation does not join canonical ledger');
    }
    return { entries, exposure: entries.reduce((sum, entry) => {
      const row = state.entries.find(row => row.id === entry.id); return sum + (row.charged_usd ?? row.reserved_usd);
    }, 0) };
  };
  recorded();
  Budget.prototype.reserve = function (selector, proposed) {
    if (realpathSync(this.path) !== canonical || !Number.isFinite(proposed) || proposed <= 0) throw new Error('Campaign reservation integrity failed');
    if (selector !== 'deepseek/deepseek-flash:off' && selector !== 'typesafe/jev-latest') throw new Error('Unauthorized campaign reservation selector');
    const { entries, exposure } = recorded();
    if (entries.length >= maxReservations || exposure + proposed > limit) throw new Error('COMPARISON_BUDGET_STOP');
    const id = original.call(this, selector, proposed);
    // The held amount is already in the canonical ledger. Never release it on a
    // registry write failure, and throw before Client.begin can submit a request.
    try { persist(registry, JSON.stringify([...entries, { id, selector, reserved_usd: proposed }], null, 2) + '\n'); }
    catch (error) {
      const reservation = { id, selector, reserved_usd: proposed };
      try { onPersistenceFailure(reservation); } catch { /* Canonical hold remains; fatal error still stops dispatch. */ }
      throw Object.assign(new Error(`COMPARISON_REGISTRY_FATAL reservation=${id}: ${error.message}`), { reservation });
    }
    return id;
  };
  return () => { Budget.prototype.reserve = original; };
}
