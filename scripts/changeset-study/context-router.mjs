import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Budget } from '../changeset/models.mjs';
import { mergeCandidates } from './optimizer.mjs';

// One batched judgment per plan. A judgment chooses only among mechanically
// admissible strategies; it cannot remove obligations or authorize dependencies.
export async function routeContext(plan, files, { ledger, signal, library } = {}) {
  const start = performance.now();
  const result = { mergeChoices: {}, contextChoices: {}, attempted: false, fallback: null };
  try {
    const lib = library ?? await import(pathToFileURL(process.env.JEV_TYPESAFE_MODULE || join(homedir(), '.agents/scripts/jev/node_modules/pi-typesafe/dist/index.js')));
    const pairs = mergeCandidates(plan, files).slice(0, 16);
    // Context choices apply only to uniquely owned files, whose packets cannot
    // be contracted. Grouping and context remain one independent-question batch.
    const small = plan.operations.filter(op => !plan.operations.some(other => other.id !== op.id && other.writes.some(path => [...op.reads, ...op.writes].includes(path))) && [...new Set([...op.reads, ...op.writes])].every(p => files[p] == null || files[p].length <= 8000)).slice(0, 16);
    const state = { pairs: pairs.map(p => ({ key: p.key, first: { objective: p.first.objective, instruction: p.first.instruction }, second: { objective: p.second.objective, instruction: p.second.instruction } })),
      packets: small.map(op => ({ id: op.id, objective: op.objective, instruction: op.instruction,
        files: [...new Set([...op.reads, ...op.writes])].map(path => ({ path, characters: files[path]?.length ?? 0 })) })) };
    const questions = {};
    pairs.forEach((pair, i) => { questions[`merge_${i}`] = lib.choice(`For state.pairs[${i}], do these instructions describe closely related edits that one writer can handle together? Dependency safety is already checked. Judge cognitive load only.`, { merge: 'Closely related, small combined assignment', separate: 'Distinct responsibilities or too many instructions together', unclear: 'Insufficient information; use fixed policy' }); });
    small.forEach((op, i) => { questions[`context_${i}`] = lib.choice(`For state.packets[${i}], is whole small-file context useful for the stated edit?`, { excerpts: 'Local edit with precise boundaries; selected excerpts suffice', whole: 'Cross-cutting edit or coupled helper behavior benefits from complete small files', unclear: 'Insufficient information; retain excerpts' }); });
    if (!Object.keys(questions).length) return { ...result, elapsed_ms: performance.now() - start, fallback: 'no-eligible-decisions' };
    const bytes = Buffer.byteLength(JSON.stringify({ state, questions }));
    if (bytes > 55000) throw new Error('routing-input-bound');
    const client = lib.createTypeSafe({ maxRequests: 1, timeoutMs: 5000, maxUsdPerDay: 0.25, maxInputBytes: 60000 });
    const price = client.getSpend().usdPerMTok;
    const budget = new Budget(ledger, 50);
    const reservation = budget.reserve('typesafe/jev-latest', (bytes + 8192) * price / 1e6 * 1.25);
    result.attempted = true; result.reservation = reservation;
    const answer = await lib.ask(client, { state, questions }, { timeoutMs: 5000, signal });
    const spend = client.getSpend();
    budget.settle(reservation, answer.ok ? { ...answer.usage, cost: { total: spend.session.estimatedUsd } } : null);
    Object.assign(result, { answer, spend: spend.session, price_usd_per_million_input: price, input_bytes: bytes, decision_count: Object.keys(questions).length, state });
    if (answer.ok) {
      // Confidence is a routing heuristic, not a calibrated guarantee.
      const choice = key => { const a = answer.answers[key]; return a?.confidence >= 0.7 ? a.choice : null; };
      pairs.forEach((p, i) => { if (choice(`merge_${i}`) === 'separate') result.mergeChoices[p.key] = 'separate'; });
      small.forEach((op, i) => { if (choice(`context_${i}`) === 'whole') result.contextChoices[op.id] = 'whole-small-files'; });
    } else result.fallback = answer.errorCode ?? 'unavailable';
  } catch (error) {
    if (/Campaign budget exhausted|Budget ledger locked/.test(error.message)) throw error;
    result.fallback = error.message;
  }
  return { ...result, elapsed_ms: performance.now() - start };
}
