// node --test scripts/changeset-study/context-router.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routeContext } from './context-router.mjs';
import { validateLedger } from './divergent/writer-control/support.mjs';

const op = id => ({ id, executor: 'simple', reads: [], writes: ['a.mjs'], depends_on: [],
  objective: `Update ${id}`, instruction: `Apply ${id}.`, requirements: ['Preserve surrounding code.'],
  context: [{ path: 'a.mjs', start: null, end: null }] });
const plan = { schema_version: 1, operations: [op('one'), op('two')] };
function setup(t, run, session = {}) {
  const root = mkdtempSync(join(tmpdir(), 'route-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { ledger: join(root, 'budget.json'), artifactDirectory: join(root, 'advice'),
    libraryIdentity: { revision: 'offline-fixture' }, library: {
      choice: (instruction, choices) => ({ instruction, choices }),
      createTypeSafe: config => { assert.equal(config.backend, 'typesafe'); assert.equal(config.model, 'jev-latest'); assert.equal(config.maxRequests, 1);
        return { getSpend: () => ({ usdPerMTok: 0.04, session }) }; },
      ask: async (client, request) => {
        assert.ok(existsSync(join(root, 'advice/request.json')), 'Retain request/reservation before transport');
        return run(client, request, session);
      },
    } };
  return { root, options, entry: () => JSON.parse(readFileSync(options.ledger)).entries[0],
    receipt: () => JSON.parse(readFileSync(join(options.artifactDirectory, 'receipt.json'))) };
}

test('successful choice retains pinned request and actual model, normalizes snake-case usage and input cost', async t => {
  const f = setup(t, (_client, request, session) => {
    assert.equal(request.state.pairs.length, 1);
    Object.assign(session, { requestsStarted: 1, requestsSucceeded: 1, inputTokens: 100, outputTokens: 20, estimatedUsd: 0.000004 });
    return { ok: true, model: 'jev-actual-version', usage: { input_tokens: 100, output_tokens: 20 },
      answers: { merge_0: { choice: 'separate', confidence: 0.9 } } };
  });
  const result = await routeContext(plan, { 'a.mjs': 'export const x = 1;\n' }, f.options);
  assert.deepEqual(result.mergeChoices, { 'one+two': 'separate' });
  assert.equal(result.requests_started, 1);
  assert.equal(result.actual_model, 'jev-actual-version');
  assert.equal(result.backend, 'typesafe');
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 20 });
  assert.equal(result.estimated_usd, 0.000004);
  assert.equal(result.cost_basis, 'estimated-input-tokens');
  assert.equal(f.entry().charged_usd, 0.000004);
  assert.equal(f.entry().usage.outputTokens, 20);
  assert.equal(f.receipt().reservation, f.entry().id);
  const request = JSON.parse(readFileSync(join(f.options.artifactDirectory, 'request.json')));
  assert.equal(request.library_identity.identity.revision, 'offline-fixture');
  assert.equal(request.config_hash.length, 64);
  assert.equal(request.plan_hash, result.plan_hash);
});

test('local admission failure releases only proven no-request exposure, ambiguous remote failures retain it', async t => {
  const local = setup(t, () => ({ ok: false, errorCode: 'configuration' }), { requestsStarted: 0 });
  const l = await routeContext(plan, { 'a.mjs': 'source' }, local.options);
  assert.equal(l.attempted, true, 'Legacy flag describes a reserved attempt');
  assert.equal(l.requests_started, 0);
  assert.equal(l.charge_status, 'not-sent');
  assert.equal(local.entry().charged_usd, 0);
  assert.equal(local.entry().status, 'priced');
  assert.equal(validateLedger(local.options.ledger).state.entries[0].charged_usd, 0);
  assert.equal(local.receipt().charge_status, 'not-sent');
  for (const metadata of [{ requestsStarted: 1, requestsFailed: 1 }, {}]) {
    const remote = setup(t, () => { throw new Error('Remote connection lost'); }, metadata);
    const r = await routeContext(plan, { 'a.mjs': 'source' }, remote.options);
    assert.deepEqual(r.mergeChoices, {});
    assert.equal(r.charge_status, 'unknown');
    assert.equal(r.estimated_usd, null);
    assert.equal(remote.entry().status, 'unknown');
    assert.equal(remote.entry().charged_usd, null);
    assert.ok(remote.entry().reserved_usd > 0);
    assert.equal(remote.receipt().fallback, 'Remote connection lost');
  }
});

test('failed choice result still settles known completed usage rather than retaining an unknown hold', async t => {
  const f = setup(t, (_client, _request, session) => {
    Object.assign(session, { requestsStarted: 1, requestsSucceeded: 1, inputTokens: 250, outputTokens: 7 });
    return { ok: false, errorCode: 'response' };
  });
  const result = await routeContext(plan, { 'a.mjs': 'source' }, f.options);
  assert.deepEqual(result.mergeChoices, {});
  assert.equal(result.fallback, 'response');
  assert.equal(result.estimated_usd, 0.00001);
  assert.equal(f.entry().status, 'priced');
  assert.equal(f.entry().usage.outputTokens, 7);
});

test('routing input bound falls back before reservation and budget or cancellation cannot become advice fallback', async t => {
  const f = setup(t, () => { throw new Error('Must not ask'); });
  // A uniquely owned packet can be otherwise valid while its judgment text exceeds this tighter routing bound.
  const large = { schema_version: 1, operations: [{ ...op('large'), instruction: 'x'.repeat(56000) }] };
  const bounded = await routeContext(large, { 'a.mjs': 'source' }, f.options);
  assert.equal(bounded.fallback, 'routing-input-bound');
  assert.equal(bounded.attempted, false);
  assert.equal(existsSync(f.options.ledger), false);
  for (const code of ['budget', 'aborted']) {
    const stopped = setup(t, () => ({ ok: false, errorCode: code }), { requestsStarted: 0 });
    await assert.rejects(routeContext(plan, { 'a.mjs': 'source' }, stopped.options), new RegExp(`Jev ${code}`));
    assert.equal(stopped.entry().charged_usd, 0);
    assert.ok(stopped.receipt().fallback);
  }
  const exhausted = setup(t, () => { throw new Error('Must not ask'); });
  writeFileSync(exhausted.options.ledger, JSON.stringify({ schema_version: 1, limit_usd: 50,
    entries: [{ id: 'spent', charged_usd: 50, reserved_usd: 50 }] }));
  await assert.rejects(routeContext(plan, { 'a.mjs': 'source' }, exhausted.options), error => {
    assert.match(error.message, /Campaign budget exhausted/);
    assert.equal(error.routing.reservation_attempted, true);
    assert.equal(error.routing.requests_started, null);
    return true;
  });
  assert.equal(exhausted.receipt().reservation_attempted, true);
  assert.equal(exhausted.receipt().attempted, false);
  const cancelled = setup(t, () => { throw new Error('Must not ask'); });
  await assert.rejects(routeContext(plan, { 'a.mjs': 'source' }, { ...cancelled.options, signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(existsSync(cancelled.options.ledger), false);
});


test('no eligible decisions still propagates durable artifact failure with routing evidence', async t => {
  const f = setup(t, () => { throw new Error('Must not ask'); });
  writeFileSync(f.options.artifactDirectory, 'occupied');
  await assert.rejects(routeContext({ schema_version: 1, operations: [op('only')] },
    { 'a.mjs': 'x'.repeat(8001) }, f.options), error => {
      assert.ok(error.routing.artifact_error);
      assert.equal(error.routing.fallback, 'no-eligible-decisions');
      assert.equal(error.routing.attempted, false);
      return true;
    });
  assert.equal(existsSync(f.options.ledger), false);
});
