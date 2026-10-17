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
