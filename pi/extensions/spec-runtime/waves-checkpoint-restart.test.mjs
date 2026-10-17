// Regression: restart checkpoint reconciliation must not be bound to the wave
// record's coordinator session.
//
// Proven defect: after a coordinator restart the wave record is owned by the
// replacement session (same package claim token/epoch, frozen inputs, sealed
// members). The barrier promotes and then reconciles the *checkpoint*, whose
// persisted record still belongs to the original session. Reconcile must be
// driven by the wave's real owner (the replacement session), preserving the
// checkpoint's own `coordinator_session`.
//
// Checkpoint authority contract: the reconcile call is issued under the
// checkpoint's retained `coordinator_session` (the original session), is
// expected at the checkpoint's own `checkout` (which equals the wave's
// integration checkout), and does not require the wave authority (which stays
// with the replacement session) to flow through the checkpoint record.
//
// Known non-assertion: `kernel_proof` is NOT exercised here (no native
// namespace is launched in this fixture), so kernel_proof=false.
//
// Fixture shape:
// - real sentinel `recordCheckpoint` / `readCheckpointRecord` /
//   `reconcileRuntimeReturn` against a temporary canonical package on disk,
// - real `createWaveBarrier().drive`,
// - only integration effects (assemble/checks/promote) and the ownership
//   transport are substituted,
// - the barrier's own tiny integration namespace reads/mutates the in-memory
//   durable record through a guarded `patchRecord`.
//
// No test files are imported and no native processes are launched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWaveBarrier } from './waves-barrier.mjs';
import {
  recordCheckpoint,
  readCheckpointRecord,
  reconcileRuntimeReturn
} from './sentinel.mjs';

const FIXED = Date.parse('2026-10-06T12:00:00Z');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const sha40 = seed => sha256(String(seed)).slice(0, 40);

// A disposable canonical package: the workspace root plus the two frozen input
// artifacts the barrier's guard hashes, and the wave gates the barrier resolves.
function canonicalPackage(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'waves-checkpoint-restart-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const packagePath = join(base, 'package');
  mkdirSync(packagePath, { recursive: true });
  const index = JSON.stringify({
    version: 1,
    steps: [{ step: 1 }, { step: 2 }],
    setup: { agents: { install: 'npm ci' } }
  });
  const gates = JSON.stringify({ version: 1, gates: [{ id: 'wave:all', command: 'node --version' }] });
  writeFileSync(join(packagePath, 'spec-steps.json'), index);
  writeFileSync(join(packagePath, 'evidence-plan.json'), gates);
  return {
    base,
    packagePath,
    indexSha: sha256(index),
    evidenceSha: sha256(gates)
  };
}

// The durable wave record, seeded by the *original* coordinator session, which
// then handed off to a replacement session without changing the package claim.
function waveRecord(fixture, { token, epoch }) {
  return {
    version: 1,
    revision: 1,
    generation: 1,
    wave_id: 'wave-1',
    package: fixture.packagePath,
    package_ref: 'specs/waves',
    agent: 'agents',
    after: 2,
    workflow_id: 'wf-1',
    state: 'open',
    claim_token: token,
    coordinator: { session: 'session-replacement', epoch, process_identity: { pid: 4321, started_at: '2026-10-06T11:00:00Z' } },
    deadline: { expires_at: FIXED + 3_600_000 },
    inputs: { index_sha256: fixture.indexSha, evidence_plan_sha256: fixture.evidenceSha },
    target: {
      id: 'agents',
      branch: 'refs/heads/main',
      base_commit: sha40('base'),
      integration_checkout: join(fixture.base, 'integration'),
      common: join(fixture.base, 'integration', '.git'),
      capability: 'full'
    },
    effective_limits: {
      memory: { per_lifecycle_bytes: 512 * 1024 * 1024 },
      tasks: { per_lifecycle: 4 }
    },
    wave_check: { gates: ['wave:all'] },
    members: {
      1: {
        phase: 'sealed',
        sealed_head: sha40('member-1'),
        retention_ref: 'refs/waves/retained/wave-1/step-1',
        attempt_id: 'attempt-1',
        workspace: { backend: 'worktree' },
        preparation_receipt: { ok: true }
      },
      2: {
        phase: 'sealed',
        sealed_head: sha40('member-2'),
        retention_ref: 'refs/waves/retained/wave-1/step-2',
        attempt_id: 'attempt-2',
        workspace: { backend: 'worktree' }
      }
    }
  };
}

// One barrier harness: real sentinel checkpoint functions, real barrier state
// machine, substituted integration effects + ownership transport only.
function harness(t, { heldToken }) {
  const fixture = canonicalPackage(t);
  const token = 'claim-token-1';
  const epoch = 7;
  const state = {
    record: waveRecord(fixture, { token, epoch }),
    releases: 0,
    assembled: 0,
    checked: 0,
    promoted: 0,
    reconciled: [],
    attention: []
  };

  // The integration namespace: a guarded patch of the in-memory durable record,
  // mirroring the controller's own record guard (a foreign session is refused).
  const patchRecord = (recordPath, session, mutate) => {
    if (recordPath !== fixture.packagePath) throw new Error(`unknown record ${recordPath}`);
    const draft = structuredClone(state.record);
    if (session !== state.record.coordinator.session) {
      throw Object.assign(new Error('record owned by a foreign session'), { reason: 'owner-conflict' });
    }
    mutate(draft);
    state.record = { ...draft, revision: state.record.revision + 1 };
    return { revision: state.record.revision };
  };

  const integration = {
    readWaveRecord: path => (path === fixture.packagePath ? structuredClone(state.record) : null),
    assembleCandidate: async () => { state.assembled += 1; return { status: 'assembled' }; },
    runCandidateChecks: async () => { state.checked += 1; return { status: 'passed' }; },
    promoteWave: async () => { state.promoted += 1; return { status: 'promoted', ref: 'refs/waves/retained/wave-1/candidate' }; }
  };

  const ownership = {
    inspectClaims: async () => ({
      claims: heldToken ? [{ kind: 'package', token: heldToken, epoch }] : []
    }),
    releaseClaim: async () => { state.releases += 1; }
  };

  // Original-session checkpoint: the wave assignment is still `working`. Its
  // checkout is the wave's integration checkout, which the reconciler expects.
  recordCheckpoint({
    package: fixture.packagePath,
    workflow_id: 'wf-1',
    expected_revision: 0,
    state: 'waiting-worker',
    obligation: { key: 'implement:wave-1', stage: 'implementation', summary: 'integrate wave 1', artifacts: [] },
    workers: [{ id: 'wave-1', kind: 'owner', state: 'working' }],
    reconciles_input_revision: 0,
    coordinator_session: 'session-original',
    checkout: join(fixture.base, 'integration'),
    now: () => FIXED
  });

  const checkpoint = {
    recordCheckpoint,
    readCheckpointRecord,
    reconcileRuntimeReturn: input => {
      state.reconciled.push({
        assignment_id: input.assignment_id, coordinator_session: input.coordinator_session
      });
      return reconcileRuntimeReturn({ ...input, now: () => FIXED });
    }
  };

  const barrier = createWaveBarrier({
    runtime: {
      indexDir: join(fixture.base, 'runtime'), commandPhase: () => ({}), runPhaseCommand: () => ({}),
      endCommandPhase: () => ({})
    },
    ownership,
    integration,
    checkpoint,
    patchRecord,
    pendingInbox: () => [],
    attentionKey: input => JSON.stringify(input),
    send: message => { state.attention.push(message); return { delivered: true }; },
    nowMs: () => FIXED
  });

  const entry = { waveId: 'wave-1', recordPath: fixture.packagePath, packagePath: fixture.packagePath, session: 'session-replacement' };
  return { fixture, state, barrier, entry, token, epoch };
}

test(
  'waves checkpoint restart: promotion reconciles the original-session checkpoint as the replacement owner',
  async t => {
    const { fixture, state, barrier, entry, token } = harness(t, { heldToken: 'claim-token-1' });

    const outcome = await barrier.drive(entry);

    // The real barrier ran all the way through promotion.
    assert.equal(outcome.status, 'integrated');
    assert.equal(state.assembled, 1);
    assert.equal(state.checked, 1);
    assert.equal(state.promoted, 1);

    // Reconciliation happened once, under the checkpoint's retained
    // coordinator_session (the original session), not the wave authority.
    assert.equal(state.reconciled.length, 1);
    assert.equal(state.reconciled[0].assignment_id, 'wave-1');
    assert.equal(state.reconciled[0].coordinator_session, 'session-original');

    // The checkpoint's own owner binding is preserved, and the assignment is done.
    const stored = readCheckpointRecord(fixture.packagePath, 'wf-1');
    assert.ok(stored, 'checkpoint record must exist');
    assert.equal(stored.coordinator_session, 'session-original');
    assert.equal(stored.checkout, join(fixture.base, 'integration'));
    assert.equal(stored.obligation.key, 'reconcile:wave-1');
    assert.equal(stored.workers.find(worker => worker.id === 'wave-1').state, 'complete');

    // Side effects happen exactly once each.
    assert.equal(state.releases, 1, 'the package claim is released exactly once');
    const promotionResult =
      state.attention.filter(message => JSON.parse(message.content).kind === 'promotion-result');
    assert.equal(promotionResult.length, 1, 'promotion-result attention is emitted exactly once');

    // The wave record itself stays owned by the replacement session.
    assert.equal(state.record.coordinator.session, 'session-replacement');
    assert.equal(state.record.claim_token, token);
    assert.equal(state.record.state, 'integrated');
  });

test(
  'waves checkpoint restart: an unmatched held claim token integrates nothing and reconciles nothing',
  async t => {
    const { fixture, state, barrier, entry } = harness(t, { heldToken: 'claim-token-other' });

    const outcome = await barrier.drive(entry);

    assert.equal(outcome.status, 'guard-refused');
    assert.equal(state.assembled, 0);
    assert.equal(state.promoted, 0);
    assert.equal(state.reconciled.length, 0);
    assert.equal(state.releases, 0);
    assert.equal(state.attention.length, 0);

    // The original-session checkpoint is untouched by a refused drive.
    const stored = readCheckpointRecord(fixture.packagePath, 'wf-1');
    assert.equal(stored.revision, 1);
    assert.equal(stored.coordinator_session, 'session-original');
    assert.equal(stored.obligation.key, 'implement:wave-1');
    assert.equal(state.record.state, 'open');
  });
