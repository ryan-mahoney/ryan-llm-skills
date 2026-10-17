import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtures } from './fixtures.mjs';
import { runCell, schedule, preflight, limits } from './runner.mjs';
import { models, reservationCeiling } from './client.mjs';
import { evaluate } from './evaluate.mjs';
import { inputContext } from './prompts.mjs';
import { aggregate } from './report.mjs';
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const plan = fixture => ({ schema_version: 1, operations: [{ id: 'apply', executor: 'deterministic', reads: Object.keys(fixture.files), writes: fixture.allowedPaths, depends_on: [], edits: fixture.referenceEdits }] });
const response = text => ({ stopReason: 'stop', content: [{ type: 'text', text }], usage: { input: 40, output: 30, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 70, cost: { input: .000012, output: .000036, cacheRead: 0, cacheWrite: 0, total: .000048 } } });

test('two complete offline cells exercise actual Client reservation/finish, raw output, exact gold and private completed behavior', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v4a-suite-smoke-')), ledger = join(root, 'budget.json');
  writeFileSync(ledger, JSON.stringify({ schema_version: 1, limit_usd: 50, entries: [] }));
  try {
    let expected, calls = 0;
    const runtime = { getModel: () => models[0].model, hasConfiguredAuth: () => true,
      async completeSimple(_model, context, options) { calls++; assert.equal(options.maxTokens, 8192); assert.equal(options.maxRetries, 0); assert.equal(options.timeoutMs, 120000);
        const input = JSON.parse(context.messages[0].content); assert.deepEqual(Object.keys(input).sort(), ['allowed_paths', 'files', 'instruction', 'protected_paths']);
        return response(JSON.stringify(plan(expected))); } };
    const selected = [fixtures.find(f => f.id === 'enc-replacement'), fixtures.find(f => f.id === 'impl-duration-helper')];
    for (const [index, fixture] of selected.entries()) {
      expected = fixture; const cell = { id: 'offline-' + index, fixture: fixture.id, track: fixture.track, format: 'json', selector: models[0].selector, repeat: 1 };
      let ceiling;
      const result = await runCell({ cell, fixture, ledger, directory: join(root, cell.id), runtime, beforeCall: proposed => { ceiling = proposed; } });
      assert.equal(result.success, true); assert.equal(result.model_calls, 1); assert.equal(result.cost_usd, .000048);
      assert.ok(ceiling > .000048); assert.deepEqual(read(join(root, cell.id, 'candidate.json')), fixture.goldFiles);
      assert.equal(readFileSync(join(root, cell.id, 'raw-output.txt'), 'utf8'), JSON.stringify(plan(fixture)));
      const request = read(join(root, cell.id, 'requests.jsonl')), receipt = read(join(root, cell.id, 'receipts.jsonl')), recorded = read(join(root, cell.id, 'responses.jsonl'));
      assert.equal(request.reservation, receipt.reservation); assert.equal(receipt.reservation, recorded.reservation);
      if (fixture.track === 'implementation') assert.equal(read(join(root, cell.id, 'evaluation.json')).behavior.completed, true);
    }
    assert.equal(calls, 2); assert.equal(read(ledger).entries.length, 2); assert.ok(read(ledger).entries.every(entry => entry.status === 'priced' && entry.charged_usd === .000048));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('application is separate from syntax and applied-but-incorrect is retained; refusal is separate', async () => {
  const fixture = fixtures.find(f => f.id === 'enc-replacement'), payload = plan(fixture);
  payload.operations[0].edits = [{ kind: 'replace', path: 'retry-policy.mjs', search: fixture.files['retry-policy.mjs'], text: 'export const = ;', count: 1 }];
  const invalid = await evaluate(fixture, 'json', JSON.stringify(payload));
  assert.equal(invalid.gates.parsed, true); assert.equal(invalid.gates.applied, true); assert.equal(invalid.gates.syntax, false); assert.equal(invalid.applied_incorrect, true);
  assert.equal(invalid.files['retry-policy.mjs'], 'export const = ;');
  const impossible = fixtures.find(f => f.expectedOutcome === 'refusal');
  const refused = await evaluate(impossible, 'v4a', 'REFUSE: The named function is absent.');
  assert.equal(refused.gates.correct, true); assert.equal(refused.gates.parsed, null); assert.equal(refused.gates.applied, false);
  assert.equal((await evaluate(fixture, 'json', 'REFUSE: No.')).gates.correct, false);
  assert.equal((await evaluate(fixture, 'json', '```json\n' + JSON.stringify(plan(fixture)) + '\n```')).gates.parsed, false);
});

test('settlement failure retains the sent call and unknown charged cost with its outstanding ledger exposure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v4a-suite-settle-')), ledger = join(root, 'budget.json');
  writeFileSync(ledger, JSON.stringify({ schema_version: 1, limit_usd: 50, entries: [] }));
  try {
    const fixture = fixtures[0], cell = schedule().find(cell => cell.format === 'json');
    const runtime = { getModel: () => models[0].model, hasConfiguredAuth: () => true,
      async completeSimple() { writeFileSync(ledger + '.lock', 'test lock'); return response(JSON.stringify(plan(fixture))); } };
    const result = await runCell({ cell, fixture, directory: join(root, 'cell'), ledger, runtime });
    assert.equal(result.model_calls, 1); assert.equal(result.cost_usd, null); assert.equal(result.evidence_integrity, false);
    assert.equal(result.error.code, 'evidence-integrity'); assert.equal(result.success, false);
    assert.ok(result.ledger_exposure_usd > 0); assert.equal(result.unresolved_reservations.length, 1);
    assert.equal(read(ledger).entries[0].status, 'reserved'); assert.equal(read(ledger).entries[0].charged_usd ?? null, null);
    const report = aggregate({ schedule: [cell] }, [result]);
    assert.equal(report.model_calls, 1); assert.equal(report.unknown_cost_cells, 1);
    assert.equal(report.ledger_exposure_usd, result.ledger_exposure_usd); assert.deepEqual(report.evidence_integrity_failures, [cell.id]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('protected mutation and early process exit cannot pass a behavioral oracle', async () => {
  const fixture = fixtures.find(f => f.id === 'impl-duration-helper');
  const protectedMutation = { ...fixture, allowedPaths: [...fixture.allowedPaths, 'untouched.mjs'] };
  const patch = fixture.referenceV4A.replace('*** End Patch', '*** Update File: untouched.mjs\n@@\n-export const projectName = \'receipt-runner\';\n+export const projectName = \'changed\';\n*** End Patch');
  const altered = await evaluate(protectedMutation, 'v4a', patch);
  assert.equal(altered.behavior.ok, true); assert.equal(altered.gates.paths, false); assert.equal(altered.gates.correct, false); assert.equal(altered.applied_incorrect, true);
  const exiting = plan(fixture); exiting.operations[0].edits = [{ kind: 'replace', path: 'index.mjs', search: fixture.files['index.mjs'], text: 'process.exit(0);\nexport function secondsToMilliseconds() {}\nexport function waitOptions() {}\nexport const waitLabel = "bounded-wait";\n', count: 1 }];
  const bypass = await evaluate(fixture, 'json', JSON.stringify(exiting));
  assert.equal(bypass.gates.applied, true); assert.equal(bypass.behavior.exitCode, 0); assert.equal(bypass.behavior.completed, false); assert.equal(bypass.gates.correct, false);
});

test('schedule has exact reversed repeats, bounded complete inputs and reservation-aware refusal before provider call', async () => {
  const cells = schedule(); assert.equal(cells.length, 88); assert.deepEqual(cells.slice(44).map(({ id, repeat, ...cell }) => cell), cells.slice(0, 44).reverse().map(({ id, repeat, ...cell }) => cell));
  assert.equal(cells.filter(cell => cell.track === 'encoding').length, 64); assert.equal(cells.filter(cell => cell.track === 'implementation').length, 24);
  assert.ok(preflight().every(cell => cell.context_bytes <= 32768));
  const root = mkdtempSync(join(tmpdir(), 'v4a-suite-cap-')), ledger = join(root, 'budget.json'); writeFileSync(ledger, JSON.stringify({ schema_version: 1, limit_usd: 50, entries: [] }));
  try {
    let called = false; const fixture = fixtures[0], runtime = { getModel: () => models[0].model, hasConfiguredAuth: () => true, completeSimple() { called = true; throw new Error('Must not call'); } };
    const result = await runCell({ cell: cells.find(cell => cell.format === 'json'), fixture, directory: join(root, 'cell'), ledger, runtime,
      beforeCall: proposed => { assert.equal(proposed, reservationCeiling(inputContext(fixture, 'json'), models[0].model, limits.output_tokens)); if (4.999 + proposed > 5) throw new Error('SUITE_BUDGET_STOP'); } });
    assert.equal(called, false); assert.equal(result.model_calls, 0); assert.match(result.error.message, /SUITE_BUDGET_STOP/); assert.equal(read(ledger).entries.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
