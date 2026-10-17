#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { fixtures, fixtureCorpusHash } from './fixtures.mjs';
import { models, oneTextCall, reservationCeiling } from './client.mjs';
import { inputContext } from './prompts.mjs';
import { evaluate } from './evaluate.mjs';
import { aggregate, markdown } from './report.mjs';
import { hash, inside, inventory, prospective, read, rows, same, validateLedger, write } from '../writer-control/support.mjs';
import { checkLedgerState } from '../model-permutations/policy.mjs';
const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const limits = { max_calls: 88, input_bytes: 32768, output_tokens: 8192, call_ms: 120000, check_ms: 5000, incremental_usd: 5 };
export function schedule() {
  const base = fixtures.flatMap(fixture => {
    const treatments = fixture.track === 'encoding' ? [{ selector: models[0].selector, format: 'v4a' }, ...models.map(model => ({ selector: model.selector, format: 'json' }))] : models.map(model => ({ selector: model.selector, format: 'json' }));
    return treatments.map(treatment => ({ fixture: fixture.id, track: fixture.track, expected_outcome: fixture.expectedOutcome, ...treatment }));
  });
  return [base, [...base].reverse()].flatMap((block, index) => block.map((cell, order) => ({ ...cell, repeat: index + 1, id: `r${index + 1}-${String(order).padStart(2, '0')}-${cell.fixture}-${cell.format}-${cell.selector.split('/')[0]}` })));
}
export function preflight() {
  if (fixtures.filter(fixture => fixture.track === 'encoding').length !== 8 || fixtures.filter(fixture => fixture.track === 'implementation').length !== 4 || schedule().length !== 88) throw new Error('Pilot corpus/schedule size differs');
  return schedule().map(cell => {
    const fixture = fixtures.find(fixture => fixture.id === cell.fixture);
    if (!fixture.files || fixture.allowedPaths.some(path => fixture.protectedPaths.includes(path)) || !['edit', 'refusal'].includes(fixture.expectedOutcome)) throw new Error('Fixture ownership/outcome invalid');
    new Workspace(fixture.files); // Existing workspace path/UTF-8 string fence.
    const context = inputContext(fixture, cell.format, 9999999999999), model = models.find(row => row.selector === cell.selector).model;
    if (limits.output_tokens > model.maxTokens || Buffer.byteLength(JSON.stringify(context)) + limits.output_tokens > model.contextWindow) throw new Error('Requested model bound is unavailable');
    return { id: cell.id, context_bytes: Buffer.byteLength(JSON.stringify(context)), prompt_hash: hash(JSON.stringify({ system: context.systemPrompt, content: context.messages[0].content })),
      reservation_ceiling_usd: reservationCeiling(context, model, limits.output_tokens) };
  });
}
// Static import kept separate from model initialization; preflight is offline.
import { Workspace } from '../../../changeset/workspace.mjs';
export function prepare({ output, ledger, sdk, codeRoot = checkout }) {
  codeRoot = realpathSync(codeRoot); sdk = realpathSync(sdk); const modules = realpathSync(resolve(sdk, '..'));
  const budget = validateLedger(ledger); checkLedgerState(budget.state); ledger = budget.path; output = prospective(output);
  if (existsSync(output) || [codeRoot, modules].some(path => inside(path, output) || inside(output, path)) || inside(output, ledger)) throw new Error('New adjacent output must be outside code/SDK/ledger');
  const measured = preflight(), code = Object.fromEntries(['changeset-study', 'changeset', 'changeset-research'].map(folder => [folder, inventory(join(codeRoot, 'scripts', folder))]));
  const sdkFiles = inventory(modules);
  mkdirSync(join(output, 'frozen/scripts'), { recursive: true });
  for (const folder of Object.keys(code)) cpSync(join(codeRoot, 'scripts', folder), join(output, 'frozen/scripts', folder), { recursive: true });
  cpSync(modules, join(output, 'sdk/node_modules'), { recursive: true, verbatimSymlinks: true });
  if (!same(inventory(modules), sdkFiles) || !same(inventory(join(output, 'sdk/node_modules')), sdkFiles) || !same(Object.fromEntries(Object.keys(code).map(folder => [folder, inventory(join(codeRoot, 'scripts', folder))])), code)) throw new Error('An input changed during freeze; retain incomplete output');
  const manifest = { schema_version: 1, protocol: 'v4a-writer-pilot-v1', status: 'prepared', created_at: new Date().toISOString(), revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: codeRoot, encoding: 'utf8' }).trim(),
    fixture_corpus_hash: fixtureCorpusHash, fixture_hashes: fixtures.map(fixture => ({ id: fixture.id, hashes: fixture.hashes })), models, limits,
    schedule: schedule(), preflight: measured, node: process.version, node_hash: hash(readFileSync(process.execPath)), ledger,
    frozen_files: inventory(join(output, 'frozen')), sdk_files: sdkFiles, sdk_root: 'sdk/node_modules/@earendil-works',
    semantics: 'Synthetic settled encoding and small implementation tracks; strict parsing primary; two fixed reversed repeats; no tools, lookup or retries.' };
  write(join(output, 'manifest.json'), manifest); return { output, status: 'prepared', cells: manifest.schedule.length, max_context_bytes: Math.max(...measured.map(cell => cell.context_bytes)), planned_reservation_ceiling_usd: measured.reduce((sum, cell) => sum + cell.reservation_ceiling_usd, 0) };
}
export function verify(output) {
  const manifest = read(join(output, 'manifest.json'));
  if (manifest.protocol !== 'v4a-writer-pilot-v1' || !same(manifest.models, models) || !same(manifest.limits, limits) || !same(manifest.schedule, schedule()) || manifest.fixture_corpus_hash !== fixtureCorpusHash ||
      !same(manifest.fixture_hashes, fixtures.map(fixture => ({ id: fixture.id, hashes: fixture.hashes }))) || !same(manifest.preflight, preflight()) ||
      manifest.node_hash !== hash(readFileSync(process.execPath)) || !same(inventory(join(output, 'frozen')), manifest.frozen_files) || !same(inventory(join(output, 'sdk/node_modules')), manifest.sdk_files)) throw new Error('Frozen suite identity changed');
  checkLedgerState(validateLedger(manifest.ledger).state); return manifest;
}
export async function runCell({ cell, fixture, directory, ledger, runtime = null, beforeCall = () => {} }) {
  mkdirSync(directory); const context = inputContext(fixture, cell.format);
  write(join(directory, 'input.json'), { cell, fixture_hash: fixture.hashes.fixture, context });
  const began = performance.now(); let generated, evaluated;
  try {
    generated = await oneTextCall({ selector: cell.selector, ledger, directory, context, runtime, maxOutputTokens: limits.output_tokens, callMs: limits.call_ms, beforeCall });
    if (generated.text !== null) writeFileSync(join(directory, 'raw-output.txt'), generated.text);
    evaluated = await evaluate(fixture, cell.format, generated.text, { stopReason: generated.stop_reason, checkMs: limits.check_ms });
  } catch (error) {
    evaluated = { gates: { stopped: false, parsed: null, paths: null, applied: false, unambiguous: null, syntax: null, correct: false }, files: fixture.files, error: { code: 'cell-error', message: error.message } };
  }
  write(join(directory, 'candidate.json'), evaluated.files); write(join(directory, 'evaluation.json'), evaluated);
  const requests = rows(join(directory, 'requests.jsonl')), receipts = rows(join(directory, 'receipts.jsonl')), responses = rows(join(directory, 'responses.jsonl'));
  const ledgerRows = validateLedger(ledger).state.entries;
  const entries = requests.map(request => ledgerRows.find(entry => entry.id === request.reservation));
  const evidenceIntegrity = requests.length <= 1 && receipts.length === requests.length && responses.length === requests.length &&
    new Set(requests.map(request => request.reservation)).size === requests.length && requests.every((request, index) => {
      const joinedReceipts = receipts.filter(receipt => receipt.reservation === request.reservation), joinedResponses = responses.filter(response => response.reservation === request.reservation);
      return entries[index]?.selector === cell.selector && request.selector === cell.selector && joinedReceipts.length === 1 && joinedResponses.length === 1 &&
        joinedReceipts[0].selector === request.selector && joinedReceipts[0].stage === request.stage && joinedResponses[0].stage === request.stage;
    });
  const cost = requests.length === 0 && evidenceIntegrity ? 0 : evidenceIntegrity && entries.every(entry => Number.isFinite(entry.charged_usd))
    ? entries.reduce((sum, entry) => sum + entry.charged_usd, 0) : null;
  const accounting = { evidence_integrity: evidenceIntegrity, request_reservations: requests.map(request => request.reservation),
    ledger_exposure_usd: entries.every(Boolean) ? entries.reduce((sum, entry) => sum + (entry.charged_usd ?? entry.reserved_usd), 0) : null,
    unresolved_reservations: entries.filter(entry => entry && entry.charged_usd == null).map(entry => entry.id) };
  const result = { ...cell, expected_outcome: fixture.expectedOutcome, fixture_hash: fixture.hashes.fixture,
    gates: evaluated.gates, refusal: evaluated.refusal ?? false, applied_incorrect: evaluated.applied_incorrect ?? false,
    error: evidenceIntegrity ? evaluated.error : { code: 'evidence-integrity', message: 'Request, receipt, response and ledger evidence do not join exactly; retain incurred exposure and stop.', original_error: evaluated.error },
    ...accounting, compile_changes: evaluated.application?.compile_changes ?? [],
    matchclass: evaluated.application?.matchclass ?? null, ambiguity: evaluated.application?.ambiguity ?? null,
    generation_ms: generated?.elapsed_ms ?? 0, total_ms: performance.now() - began, output_bytes: Buffer.byteLength(generated?.text ?? ''),
    stop_reason: generated?.stop_reason ?? null, generation_error: generated?.error ?? null, usage: evidenceIntegrity ? receipts[0]?.usage ?? null : null, cost_usd: cost, model_calls: requests.length,
    candidate_hash: hash(JSON.stringify(evaluated.files)), prompt_hash: hash(JSON.stringify({ system: context.systemPrompt, content: context.messages[0].content })),
    success: evidenceIntegrity && (fixture.expectedOutcome === 'refusal' ? evaluated.refusal === true && evaluated.gates.correct === true && evaluated.gates.stopped === true : ['stopped', 'parsed', 'paths', 'applied', 'unambiguous', 'syntax', 'correct'].every(gate => evaluated.gates[gate] === true)) };
  write(join(directory, 'result.json'), result); return result;
}
export async function run(output) {
  output = realpathSync(output); const manifest = verify(output);
  if (realpathSync(fileURLToPath(import.meta.url)) !== realpathSync(join(output, 'frozen/scripts/changeset-study/divergent/v4a-suite/runner.mjs'))) throw new Error('Run the exact frozen suite runner');
  writeFileSync(join(output, 'started.json'), JSON.stringify({ at: new Date().toISOString() }) + '\n', { flag: 'wx' });
  process.env.CHANGESET_STUDY_SDK_ROOT = join(output, manifest.sdk_root);
  process.env.CHANGESET_MODEL_RUNTIME = join(output, manifest.sdk_root, 'pi-coding-agent/dist/core/model-runtime.js');
  const observed = []; let stopped = null;
  const budgetCheck = (proposed = 0) => {
    const state = validateLedger(manifest.ledger).state; checkLedgerState(state);
    const own = new Set(manifest.schedule.flatMap(cell => rows(join(output, cell.id, 'requests.jsonl')).map(row => row.reservation)));
    const exposure = state.entries.filter(entry => own.has(entry.id)).reduce((sum, entry) => sum + (entry.charged_usd ?? entry.reserved_usd), 0);
    if (own.size >= limits.max_calls || exposure + proposed > limits.incremental_usd) throw new Error('SUITE_BUDGET_STOP');
  };
  for (const cell of manifest.schedule) {
    verify(output); try { budgetCheck(); } catch (error) { stopped = error.message; break; }
    const fixture = fixtures.find(fixture => fixture.id === cell.fixture);
    const result = await runCell({ cell, fixture, directory: join(output, cell.id), ledger: manifest.ledger, beforeCall: budgetCheck }); observed.push(result);
    const report = aggregate(manifest, observed); write(join(output, 'results.json'), { ...report, stopped }); writeFileSync(join(output, 'results.md'), markdown(report));
    if (!result.evidence_integrity || /Campaign budget exhausted|SUITE_BUDGET_STOP|Budget ledger locked/.test(result.error?.message ?? '')) { stopped = result.error.message; break; }
  }
  const report = aggregate(manifest, observed); write(join(output, 'results.json'), { ...report, stopped }); writeFileSync(join(output, 'results.md'), markdown(report));
  return { completed: observed.length, planned: manifest.schedule.length, stopped, calls: report.model_calls, known_cost_usd: report.known_receipt_cost_usd };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const [command, ...args] = process.argv.slice(2), options = {};
    for (let index = 0; index < args.length; index += 2) { const key = args[index]?.slice(2); if (!['output', 'ledger', 'sdk'].includes(key) || options[key] || !args[index + 1]) throw new Error('Unique --output/--ledger/--sdk options required'); options[key] = args[index + 1]; }
    const result = command === 'prepare' ? prepare(options) : command === 'verify' ? { verified: true, protocol: verify(realpathSync(options.output)).protocol } : command === 'run' ? await run(options.output) : (() => { throw new Error('Use prepare/verify/run'); })(); console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
