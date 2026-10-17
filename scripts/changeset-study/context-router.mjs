import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Budget } from '../changeset/models.mjs';
import { mergeCandidates } from './optimizer.mjs';

// One batched judgment per plan. A judgment chooses only among mechanically
// admissible strategies; it cannot remove obligations or authorize dependencies.
const hash = value => createHash('sha256').update(value).digest('hex');
const finite = value => Number.isFinite(value) && value >= 0;
const cancelled = signal => { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Jev request aborted'); };
function moduleIdentity(entry) {
  const bytes = readFileSync(join(dirname(entry), '..', 'package.json'));
  const pkg = JSON.parse(bytes);
  return { kind: 'module', name: pkg.name, version: pkg.version, entry_sha256: hash(readFileSync(entry)), package_sha256: hash(bytes) };
}

export async function routeContext(plan, files, { ledger, signal, library, artifactDirectory, libraryIdentity, backend = 'typesafe', model = 'jev-latest' } = {}) {
  const start = performance.now();
  const result = { mergeChoices: {}, contextChoices: {}, attempted: false, fallback: null,
    requests_started: null, actual_model: null, reservation_attempted: false, cost_basis: 'estimated-input-tokens',
    plan_hash: hash(JSON.stringify(plan)), source_hash: hash(JSON.stringify(files)) };
  let client, budget, request, answer, failure;
  const save = (name, value) => {
    if (!artifactDirectory) return;
    try {
      mkdirSync(artifactDirectory, { recursive: true });
      writeFileSync(join(artifactDirectory, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    } catch (error) { result.artifact_error = error.message; throw error; }
  };
  const requestEvidence = () => ({ schema_version: 1, plan_hash: result.plan_hash, source_hash: result.source_hash,
    library_identity: result.library_identity ?? null, config, config_hash: result.config_hash ?? null,
    reservation: result.reservation ?? null, request: request ?? null });
  const config = { backend, model, maxRequests: 1, timeoutMs: 5000, maxUsdPerDay: 0.25, maxInputBytes: 60000 };
  try {
    cancelled(signal);
    if (typeof backend !== 'string' || typeof model !== 'string' || !backend || !model) throw new Error('routing-config-bound');
    const entry = process.env.JEV_TYPESAFE_MODULE || join(homedir(), '.agents/scripts/jev/node_modules/pi-typesafe/dist/index.js');
    result.library_identity = library ? { kind: 'injected', identity: libraryIdentity ?? null } : moduleIdentity(entry);
    result.config = config; result.config_hash = hash(JSON.stringify(config));
    result.backend = backend; result.requested_model = model;
    const lib = library ?? await import(pathToFileURL(entry));
    const endpoint = lib.resolveBackend?.(backend);
    result.backend_identity = endpoint ? { name: endpoint.name ?? backend, host: endpoint.host, path: endpoint.path ?? null } : { name: backend };
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
    if (!Object.keys(questions).length) result.fallback = 'no-eligible-decisions';
    else {
      const bytes = Buffer.byteLength(JSON.stringify({ state, questions }));
      if (bytes > 55000) throw new Error('routing-input-bound');
      request = { state, questions };
      Object.assign(result, { input_bytes: bytes, decision_count: Object.keys(questions).length, state });
      client = lib.createTypeSafe(config);
      const price = client.getSpend().usdPerMTok;
      let reservation;
      try {
        budget = new Budget(ledger, 50);
        result.reservation_attempted = true;
        reservation = budget.reserve(`${backend}/${model}`, (bytes + 8192) * price / 1e6 * 1.25);
      } catch (error) { result.budget_error = error.message; throw error; }
      result.attempted = true; result.reservation = reservation;
      result.price_usd_per_million_input = price;
      save('request.json', requestEvidence());
      answer = await lib.ask(client, request, { timeoutMs: 5000, signal });
      result.answer = answer; result.actual_model = answer.model ?? null;
      cancelled(signal);
      if (answer.errorCode === 'budget' || answer.errorCode === 'aborted') throw new Error(`Jev ${answer.errorCode}: ${answer.error ?? 'request stopped'}`);
      if (answer.ok) {
        // Confidence is a routing heuristic, not a calibrated guarantee.
        const choice = key => { const a = answer.answers[key]; return a?.confidence >= 0.7 ? a.choice : null; };
        pairs.forEach((p, i) => { if (choice(`merge_${i}`) === 'separate') result.mergeChoices[p.key] = 'separate'; });
        small.forEach((op, i) => { if (choice(`context_${i}`) === 'whole') result.contextChoices[op.id] = 'whole-small-files'; });
      } else result.fallback = answer.errorCode ?? 'unavailable';
    }
  } catch (error) {
    failure = error;
    result.mergeChoices = {}; result.contextChoices = {};
    result.fallback = error.message;
  } finally {
    // A reserved attempt is not proof of transport. Only explicit session counters
    // can release a no-request reservation; missing counters retain its exposure.
    let spend;
    try { spend = client?.getSpend(); } catch { /* Evidence unavailable: retain the hold. */ }
    result.spend = spend?.session ?? null;
    const session = spend?.session;
    result.requests_started = Number.isInteger(session?.requestsStarted) && session.requestsStarted >= 0 ? session.requestsStarted : null;
    const u = answer?.usage;
    const usage = finite(u?.input_tokens) && finite(u?.output_tokens)
      ? { inputTokens: u.input_tokens, outputTokens: u.output_tokens }
      : finite(session?.inputTokens) && finite(session?.outputTokens) && session.requestsSucceeded > 0
        ? { inputTokens: session.inputTokens, outputTokens: session.outputTokens } : null;
    const known = usage && finite(result.price_usd_per_million_input);
    result.usage = usage;
    result.estimated_usd = known ? usage.inputTokens * result.price_usd_per_million_input / 1e6 : result.requests_started === 0 ? 0 : null;
    result.charge_status = known ? 'estimated' : result.requests_started === 0 ? 'not-sent' : result.reservation ? 'unknown' : 'not-reserved';
    try {
      if (result.reservation) {
        if (known && result.estimated_usd > 0) budget.settle(result.reservation, { ...usage, cost: { total: result.estimated_usd }, cost_basis: result.cost_basis });
        else if (result.requests_started === 0 || (known && result.estimated_usd === 0)) {
          // Budget.settle deliberately treats zero as unknown. Here explicit transport
          // counters or completed zero-priced usage prove a genuine zero exposure.
          budget.update(state => Object.assign(state.entries.find(e => e.id === result.reservation), {
            status: 'priced', charged_usd: 0, usage,
          }));
        } else budget.settle(result.reservation, null);
      }
    } catch (error) { result.settlement_error = error.message; failure = error; }
    result.elapsed_ms = performance.now() - start;
    try {
      save('request.json', requestEvidence());
      save('answer.json', { answer: answer ?? null, error: failure?.message ?? null });
      save('receipt.json', result);
    } catch (error) { failure = error; }
  }
  if (failure && (result.artifact_error || result.settlement_error || result.budget_error || signal?.aborted || failure.name === 'AbortError' || /^(?:Campaign budget exhausted|Budget ledger locked|Budget limit|Jev budget:|Jev aborted:)/.test(failure.message))) {
    failure.routing = result;
    throw failure;
  }
  return result;
}
