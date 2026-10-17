import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { arms, muse, museModel, mimoModel, validatePlan, routeLimits } from './policy.mjs';
import { planningSystem, boundedContext } from './planning.mjs';
import { sdkRoot } from '../../client.mjs';

const executable = { schema_version: 1, operations: [{ id: 'literal', executor: 'deterministic', reads: [], writes: ['out.mjs'], depends_on: [], edits: [{ kind: 'create', path: 'out.mjs', text: 'export const x = 1;\n' }] }] };
const delegated = { schema_version: 1, operations: [{ id: 'local', executor: 'simple', reads: [], writes: ['out.mjs'], depends_on: [], objective: 'Add settled value', instruction: 'Export constant x with value1.', requirements: ['Preserve unrelated files.'], context: [] }] };
test('self has executable-only ownership; arrow plans are focused, preserve common Sol prep and remaining original limits', () => {
  assert.equal(validatePlan(executable, 'executable', {}), executable);
  assert.throws(() => validatePlan(delegated, 'executable', {}), /no writer delegation/);
  assert.throws(() => validatePlan(executable, 'delegated', {}), /delegated instructions/);
  assert.equal(validatePlan(delegated, 'delegated', {}, undefined, 2), delegated);
  assert.throws(() => validatePlan(delegated, 'delegated', {}, undefined, 1), /remaining-call/);
  assert.equal(arms[2].prep, arms[3].prep); assert.match(arms[3].reasoning_effective, /no distinct medium/);
  const limits = { model_calls: 96, cell_ms: 1200000, max_output_tokens: 32000, grade_ms: 300000 };
  assert.deepEqual(routeLimits(limits, { model_calls: 3, elapsed_ms: 5000 }), { ...limits, model_calls: 93, cell_ms: 1195000 });
  assert.throws(() => routeLimits(limits, { model_calls: 96, elapsed_ms: 1 }), /exhausted/);
});
test('planning is explicit implementation-owning JSON with bounded source lookup, not a native coding-agent system', () => {
  const skill = readFileSync(new URL('../../../../skills/spec-changeset-plan/SKILL.md', import.meta.url), 'utf8');
  for (const representation of ['executable', 'delegated']) {
    const system = planningSystem(skill, representation);
    assert.match(system, /own implementation design/); assert.match(system, /plan-only model/); assert.match(system, /source_requests/); assert.equal(system.includes('impact review after execution'), false);
    assert.match(system, /no coding-agent tools/); assert.equal(system.includes('You are an expert coding assistant'), false);
    assert.ok(boundedContext(system, { task: 'original contract', file_tree: [] }));
    assert.throws(() => boundedContext(system, { source_lookup: 'x'.repeat(160 * 1024) }), /160KiB/);
  }
});
test('pinned Muse high emits OpenRouter reasoning high and max_tokens32000 without auth or real network', async () => {
  const saved = globalThis.fetch; globalThis.fetch = async () => { throw new Error('REAL_NETWORK_FORBIDDEN'); };
  try {
    const { streamSimple } = await import(pathToFileURL(join(sdkRoot(), 'pi-ai/dist/api/openai-completions.js')).href);
    let wire;
    const response = await streamSimple({ ...museModel, provider: 'openrouter' }, { systemPrompt: 'Plan-only fixture', messages: [{ role: 'user', content: '{}', timestamp: 0 }] }, {
      apiKey: 'synthetic-offline-key', reasoning: 'high', maxTokens: 32000, maxRetries: 0,
      fetch: async (url, init) => { wire = { url: String(url), body: JSON.parse(init.body) };
        return new Response('data: {"id":"offline","object":"chat.completion.chunk","created":0,"model":"meta/muse-spark-1.3-contributor","choices":[{"index":0,"delta":{"content":"{}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }); },
    }).result();
    assert.equal(response.stopReason, 'stop'); assert.equal(wire.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(wire.body.model, muse.replace('openrouter/', '').replace(':high', ''));
    assert.deepEqual(wire.body.reasoning, { effort: 'high' }); assert.equal(wire.body.max_tokens, 32000);
    assert.equal(wire.body.tools, undefined);
    let mimoWire;
    await streamSimple({ ...mimoModel, provider: 'primalabs' }, { messages: [{ role: 'user', content: '{}', timestamp: 0 }] }, { apiKey: 'synthetic-offline-key', reasoning: 'medium', maxTokens: 32000, maxRetries: 0, fetch: async (_url, init) => {
      mimoWire = JSON.parse(init.body); return new Response('data: {\"id\":\"offline\",\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"primalabs-ai/MiMo-V2.6-Pro\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"{}\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    } }).result();
    assert.deepEqual(mimoWire.chat_template_kwargs, { thinking: true }); assert.equal(mimoWire.reasoning_effort, undefined); assert.equal(mimoWire.max_tokens, 32000);
  } finally { globalThis.fetch = saved; }
});

test('audit rejects orphan responses and writer packet/operation identity mismatches', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { auditEvidence } = await import('./audit.mjs');
  const { hash } = await import('../writer-control/support.mjs');
  const root = mkdtempSync(join(tmpdir(), 'model-permutations-audit-'));
  try {
    const prep = join(root, 'prep'); mkdirSync(prep); writeFileSync(join(prep, 'plan.json'), JSON.stringify(delegated));
    const task = { id: 'fixture', files: {} }, job = { task, selector: muse, mode: 'execute', representation: 'delegated', preparation_directory: prep };
    const result = { task_hash: hash(JSON.stringify(task)), selector: muse, model_calls: 1, plan_hash: hash(JSON.stringify(delegated)), limits: { model_calls: 2 } };
    const request = { reservation: 'one', selector: muse, stage: 'editor', operation_id: 'local', writer_attempt: 0, context: { messages: [{ role: 'user', content: JSON.stringify({ objective: delegated.operations[0].objective, writes: ['out.mjs'] }) }] } };
    const receipt = { reservation: 'one', selector: muse, stage: 'editor', operation_id: 'local', writer_attempt: 0, usage: null, stop_reason: 'stop', error: null };
    const response = { reservation: 'one', stage: 'editor', response: { stopReason: 'stop', usage: null } };
    const save = (name, rows) => writeFileSync(join(root, name), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    save('requests.jsonl', [request]); save('receipts.jsonl', [receipt]); save('responses.jsonl', [response]);
    assert.equal(auditEvidence(root, job, result).valid, true);
    save('responses.jsonl', [response, { reservation: 'orphan', stage: 'review' }]);
    assert.equal(auditEvidence(root, job, result).valid, false);
    save('responses.jsonl', [response]); request.context.messages[0].content = JSON.stringify({ objective: 'different assignment', writes: ['out.mjs'] }); save('requests.jsonl', [request]);
    assert.match(auditEvidence(root, job, result).errors.join('; '), /does not belong/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('auth resume inherits exact Sol preparations without owning their paid requests or permitting new planning', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { prepare, prepareResume, verify } = await import('./runner.mjs');
  const { hash, inventory, taskIds } = await import('../writer-control/support.mjs');
  const { providerRegistration, mimoModel, sol, deepseek } = await import('./policy.mjs');
  const registered = providerRegistration({ ...mimoModel, provider: 'primalabs' }, {});
  assert.equal(Object.hasOwn(registered, 'apiKey'), false); assert.equal(registered.baseUrl, 'https://api.primalabs.ai/v1');
  assert.equal(providerRegistration({ ...mimoModel, provider: 'primalabs' }, { apiKey: 'synthetic-config-reference' }).apiKey, 'synthetic-config-reference');
  const root = mkdtempSync(join(tmpdir(), 'permutations-resume-'));
  const put = (path, data) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data)); };
  try {
    const source = join(root, '03-fixture'), sdk = join(root, 'sdk/node_modules/@earendil-works'), dependency = join(root, 'dependency');
    put(join(dependency, 'module.mjs'), 'export {};');
    const pins = {};
    for (const pkg of ['pi-ai', 'pi-agent-core', 'pi-coding-agent']) { put(join(sdk, pkg, 'dist/stub.js'), 'export {};'); pins[pkg] = inventory(join(sdk, pkg, 'dist')); }
    const ledger = join(root, 'budget.json'); put(ledger, { schema_version: 1, limit_usd: 50, entries: [] });
    const parser = join(root, 'parser.mjs'); put(parser, 'export const parse = () => ({});');
    const tasks = taskIds.map(id => ({ id, context: 'prepared', spec: 'Fixture contract', check: 'node visible.mjs', hidden: 'export {};', protected: ['visible.mjs'], files: { 'visible.mjs': 'export {};' }, limits: { cell_ms: 1200000, grade_ms: 300000, model_calls: 96, max_output_tokens: 32000, call_ms: 300000, command_ms: 180000 } }));
    const bytes = JSON.stringify(tasks); put(join(source, 'tasks.json'), bytes);
    put(join(source, 'manifest.json'), { comparison: 'deepseek-owner-sol-query-deepseek-writer', schedule: taskIds, tasks_hash: hash(bytes), sdk_files: pins, dependencies_hash: hash(JSON.stringify(inventory(dependency))), models: [sol, deepseek].map(selector => ({ selector, model: { provider: selector.split('/')[0], id: selector.split('/')[1].split(':')[0] } })) });
    for (const [index, task] of tasks.entries()) { const directory = join(source, `${String(index).padStart(3, '0')}-${task.id}`); put(join(directory, 'job.json'), { task, ledger, mounts: [[dependency, '/node_modules']] }); put(join(directory, 'result.json'), { task_hash: hash(JSON.stringify(task)) }); }
    const codeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const options = { source, ledger, parser, sdk, codeRoot };
    const original = prepare({ ...options, output: join(root, 'original') }).output;
    put(join(original, 'started.json'), {}); const records = [];
    for (const [index, task] of tasks.entries()) {
      const name = `${String(index).padStart(3, '0')}-${task.id}`;
      put(join(original, 'preparation/sol-delegated', name, 'plan.json'), delegated);
      put(join(original, 'preparation/sol-delegated', name, 'result.json'), { selector: sol, task_hash: hash(JSON.stringify(task)), plan_hash: hash(JSON.stringify(delegated)), model_calls: 2, process_elapsed_ms: 100 });
      put(join(original, 'preparation/sol-delegated', name, 'requests.jsonl'), JSON.stringify({ reservation: 'old-planning-charge', selector: sol }) + '\n');
      for (const arm of arms) records.push({ arm: arm.id, task: task.id, allocated_preparation: JSON.parse(readFileSync(join(original, 'preparation/sol-delegated', name, 'result.json'))), result: arm.id === 'sol-mimo' ? { error: 'Existing PrimaLabs credential configuration unavailable', model_calls: 0 } : {} });
    }
    put(join(original, 'results.json'), { rows: records });
    const resumed = prepareResume({ ...options, output: join(root, 'resumed'), resumeFrom: original }).output;
    const manifest = verify(resumed);
    assert.deepEqual(manifest.resume.active_arms, ['sol-mimo']);
    assert.ok(manifest.request_directories.every(directory => directory.startsWith('sol-mimo/')));
    assert.equal(manifest.resume.preparations.length, 3);
    assert.deepEqual(readFileSync(join(resumed, 'preparation/sol-delegated/000-hard-context-calibration/plan.json')), readFileSync(join(original, 'preparation/sol-delegated/000-hard-context-calibration/plan.json')));
    put(join(resumed, 'preparation/sol-delegated/000-hard-context-calibration/plan.json'), { ...delegated, extra: true });
    assert.throws(() => verify(resumed), /preparation changed/);
    const originalPrep = join(original, 'preparation/sol-delegated/000-hard-context-calibration');
    const replacement = { ...delegated, operations: delegated.operations.map(operation => ({ ...operation, instruction: 'A different unpaid plan.' })) };
    put(join(originalPrep, 'plan.json'), replacement);
    const altered = JSON.parse(readFileSync(join(originalPrep, 'result.json'))); altered.plan_hash = hash(JSON.stringify(replacement)); put(join(originalPrep, 'result.json'), altered);
    assert.throws(() => prepareResume({ ...options, output: join(root, 'drifted-resume'), resumeFrom: original }), /original retained paid plan/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
