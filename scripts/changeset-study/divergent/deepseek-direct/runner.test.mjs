// Run alone: node --test scripts/changeset-study/divergent/deepseek-direct/runner.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from '../../../changeset/workspace.mjs';
import { prepare, verifyPrepared, validateModel, validateLedger, taskIds, qualify } from './runner.mjs';
import { retryPlanningJson } from './format-retry.mjs';
import { overlayCell } from './overlay.mjs';
const json = (path, value) => writeFileSync(path, JSON.stringify(value) + '\n');
function fixture(root) {
  const codeRoot = join(root, 'checkout'), source = join(root, 'source03'), sdk = join(root, 'sdk/node_modules/@earendil-works'), deps = join(root, 'deps');
  for (const folder of ['scripts/changeset-study', 'scripts/changeset', 'scripts/changeset-research', 'skills/spec-changeset-plan']) mkdirSync(join(codeRoot, folder), { recursive: true });
  const marker = "plan = parseJson(await stage(feedback ? 'repair-planning' : 'discovery-planning', () => scout.prompt(JSON.stringify(planningInput))));";
  writeFileSync(join(codeRoot, 'scripts/changeset-study/cell.mjs'), marker);
  writeFileSync(join(codeRoot, 'scripts/changeset/engine.mjs'), 'fixture code');
  writeFileSync(join(codeRoot, 'scripts/changeset-research/cost.mjs'), 'fixture cost');
  writeFileSync(join(codeRoot, 'skills/spec-changeset-plan/SKILL.md'), 'Fixture planner contract');
  const sdk_files = {};
  for (const pkg of ['pi-agent-core', 'pi-coding-agent', 'pi-ai']) {
    mkdirSync(join(sdk, pkg, 'dist'), { recursive: true }); writeFileSync(join(sdk, pkg, 'dist/marker.mjs'), pkg);
    sdk_files[pkg] = [['marker.mjs', hash(pkg)]];
  }
  mkdirSync(deps); writeFileSync(join(deps, 'package.mjs'), 'dependency');
  const ledger = join(root, 'campaign-budget.json');
  json(ledger, { schema_version: 1, limit_usd: 50, entries: [] });
  mkdirSync(source);
  const tasks = taskIds.map(id => ({ id, context: 'discovery', spec: 'Fixture contract', files: { 'source.txt': 'source' }, protected: [],
    check: 'true', hidden: 'export {};', limits: { cell_ms: 2000, grade_ms: 1000, model_calls: 10, max_output_tokens: 1000, call_ms: 1000, command_ms: 1000 } }));
  json(join(source, 'tasks.json'), tasks);
  json(join(source, 'manifest.json'), { comparison: 'deepseek-owner-sol-query-deepseek-writer', schedule: taskIds,
    tasks_hash: hash(readFileSync(join(source, 'tasks.json'))), sdk_files, dependencies_hash: hash(JSON.stringify([['package.mjs', hash('dependency')]])) });
  for (const [index, task] of tasks.entries()) {
    const directory = join(source, `${String(index).padStart(3, '0')}-${task.id}`); mkdirSync(directory);
    json(join(directory, 'job.json'), { task, ledger, mounts: [[deps, '/node_modules']] });
    json(join(directory, 'result.json'), { task_hash: hash(JSON.stringify(task)) });
  }
  const parser = join(root, 'parser.mjs'); writeFileSync(parser, 'export const parse = () => {};');
  return { source, output: join(root, 'prepared'), ledger, parser, model: 'deepseek/deepseek-flash:off', sdk, codeRoot };
}

test('offline preparation freezes exact code, overlay, SDK, dependencies and donor tasks without initializing inference', () => {
  const root = mkdtempSync(join(tmpdir(), 'deepseek-prepare-'));
  try {
    const options = fixture(root), result = prepare(options), manifest = result.manifest;
    assert.equal(manifest.strategy, 'boundary-review');
    assert.deepEqual(Object.values(manifest.roles), [options.model, options.model, options.model]);
    assert.deepEqual(readFileSync(join(options.output, 'tasks.json')), readFileSync(join(options.source, 'tasks.json')));
    assert.equal(readFileSync(join(options.output, 'dependencies/0/package.mjs'), 'utf8'), 'dependency');
    assert.equal(readFileSync(join(options.output, 'sdk/node_modules/@earendil-works/pi-ai/dist/marker.mjs'), 'utf8'), 'pi-ai');
    const original = readFileSync(join(options.output, 'original-cell.mjs'), 'utf8');
    const overlaid = readFileSync(join(options.output, 'frozen/scripts/changeset-study/cell.mjs'), 'utf8');
    assert.equal(hash(original), manifest.overlay.original_hash);
    assert.equal(hash(overlaid), manifest.overlay.overlaid_hash);
    assert.ok(overlaid.includes('retryPlanningJson(scout, planningInput, { parseJson })'));
    assert.equal(existsSync(options.ledger), true);
    assert.equal(manifest.ledger, options.ledger);
    verifyPrepared(options.output);
    writeFileSync(join(options.codeRoot, 'scripts/changeset/engine.mjs'), 'changed original');
    writeFileSync(join(root, 'deps/package.mjs'), 'changed original dependency');
    verifyPrepared(options.output);
    writeFileSync(join(options.output, 'frozen/scripts/changeset/engine.mjs'), 'tampered frozen copy');
    assert.throws(() => verifyPrepared(options.output), /frozen bytes changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('preparation rejects unsafe output, mixed models and changed donor task identities', () => {
  const root = mkdtempSync(join(tmpdir(), 'deepseek-inputs-'));
  try {
    const options = fixture(root);
    for (const model of ['openai-codex/gpt-6.1-sol:low', 'openrouter/deepseek/deepseek-flash:off', 'deepseek/deepseek-flash:high']) assert.throws(() => validateModel(model), /mixing/);
    assert.throws(() => prepare({ ...options, output: join(options.codeRoot, 'run') }), /Output must be new/);
    assert.throws(() => prepare({ ...options, output: join(options.source, 'nested') }), /Output must be new/);
    symlinkSync(options.codeRoot, join(root, 'linked-checkout'));
    assert.throws(() => prepare({ ...options, output: join(root, 'linked-checkout/run') }), /Output must be new/);
    assert.throws(() => prepare({ ...options, ledger: join(root, 'missing-budget.json') }), /existing valid shared budget ledger/);
    const differentLedger = join(root, 'different-budget.json'); json(differentLedger, { schema_version: 1, limit_usd: 50, entries: [] });
    assert.throws(() => prepare({ ...options, ledger: differentLedger }), /same canonical shared budget ledger/);
    const directory = join(options.source, `001-${taskIds[1]}`), job = JSON.parse(readFileSync(join(directory, 'job.json')));
    job.task.spec = 'Changed donor'; json(join(directory, 'job.json'), job);
    assert.throws(() => prepare(options), /Donor task bytes differ/);
    assert.equal(existsSync(options.output), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('format adapter retries one JSON SyntaxError through the same scout and preserves non-format failures', async () => {
  const calls = [], scout = { prompt: async input => { calls.push(JSON.parse(input)); return calls.length === 1 ? 'commentary instead of JSON' : '{"schema_version":1,"operations":[]}'; } };
  const result = await retryPlanningJson(scout, { task: 'original' }, { parseJson: JSON.parse });
  assert.equal(result.schema_version, 1); assert.equal(calls.length, 2);
  assert.equal(calls[0].task, 'original'); assert.ok(calls[1].planning_format_error);
  assert.match(calls[1].previous_response_excerpt, /commentary/);
  for (const message of ['Campaign budget exhausted', 'Cell deadline exceeded', 'transport failure']) {
    let count = 0;
    await assert.rejects(retryPlanningJson({ prompt: async () => { count++; throw new Error(message); } }, {}, { parseJson: JSON.parse }), new RegExp(message));
    assert.equal(count, 1);
  }
  let invalidCalls = 0;
  await assert.rejects(retryPlanningJson({ prompt: async () => { invalidCalls++; return 'invalid'; } }, {}, { parseJson: JSON.parse }), SyntaxError);
  assert.equal(invalidCalls, 2);
  assert.throws(() => overlayCell('different backend'), /backend drift/);
});

test('audited delivery retains the outer review contract and requires candidate-bound handoff diagnostics', () => {
  const result = { task: 'hard-dependency-handoff', selector: 'deepseek/deepseek-flash:off', strategy: 'boundary-review', accepted: true,
    visible_accepted: true, review_accepted: true, executions: [{ ok: true }], candidate_hash: 'candidate' };
  const requests = [{ selector: result.selector, stage: 'discovery-planning' }, { selector: result.selector, stage: 'review' }];
  assert.equal(qualify(result, requests, result.selector).audited_delivered, false);
  assert.equal(qualify(result, requests, result.selector, { passed: true, candidate_hash: 'different' }).audited_delivered, false);
  assert.equal(qualify(result, requests, result.selector, { passed: true, candidate_hash: 'candidate' }).audited_delivered, true);
  assert.equal(qualify(result, [...requests, { selector: 'openai-codex/gpt-6.1-sol:low' }], result.selector, { passed: true, candidate_hash: 'candidate' }).audited_delivered, false);
  assert.equal(qualify({ ...result, review_accepted: false }, requests, result.selector, { passed: true, candidate_hash: 'candidate' }).audited_delivered, false);
  const wrong = 'deepseek/deepseek-other:off';
  assert.equal(qualify({ ...result, selector: wrong }, [{ selector: wrong }], result.selector, { passed: true, candidate_hash: 'candidate' }).audited_delivered, false);
});


test('shared budget validation rejects missing or malformed ledgers and permits legitimate settlements', () => {
  const root = mkdtempSync(join(tmpdir(), 'deepseek-ledger-'));
  try {
    const ledger = join(root, 'budget.json');
    assert.throws(() => validateLedger(ledger), /existing valid shared budget ledger/);
    for (const state of [{}, { schema_version: 1, limit_usd: 100, entries: [] },
      { schema_version: 1, limit_usd: 50, entries: [{ id: 'bad' }] }]) {
      json(ledger, state); assert.throws(() => validateLedger(ledger), /Shared budget ledger/);
    }
    const entry = { id: 'reservation', selector: 'openai-codex/gpt-6.1-sol:low', reserved_usd: 0.5, status: 'reserved' };
    json(ledger, { schema_version: 1, limit_usd: 50, entries: [entry] });
    assert.equal(validateLedger(ledger).state.entries[0].status, 'reserved');
    json(ledger, { schema_version: 1, limit_usd: 50, entries: [{ ...entry, charged_usd: 0.1, status: 'priced' }] });
    assert.equal(validateLedger(ledger).state.entries[0].charged_usd, 0.1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
