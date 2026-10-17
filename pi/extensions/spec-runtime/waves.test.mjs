// Wave dispatch controller tests (step 10). The first case is the
// walking-skeleton proof: it drives a full two-member wave through a single
// `controller.startup` and asserts the canonical integrated record, the ordered
// per-step effects, attention-only sends, idle progression, the checkpoint
// lifecycle and the durable role counts. Every observable assertion the card
// specifies for this case is present.
//
// Only external boundaries are substituted: the contained service transport and
// hostCheck. Everything else in the proof is real: package-fixture repositories,
// spec-location storage, the real spec-steps index and evidence plan,
// validateStepIndex, ownership.mjs, Runtime, Runtime's own notify route,
// wave-review.mjs, wave-integration.mjs and sentinel.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { validateStepIndex } from '../../../scripts/spec-observe/steps.mjs';
import { inspectProcess } from '../../../scripts/spec-observe/process-identity.mjs';
import { readCheckpointRecord } from './sentinel.mjs';
import { phaseLifecycle } from './waves.mjs';
import {
  CASE4_TIMEOUT_MS,
  WAVE_ID,
  COORDINATOR_SESSION,
  isAncestor,
  makeCase4Fixture,
  waitFor
} from './waves-fixture.mjs';

test('wave dispatch: one startup drives review, fix, seal, candidate checks and promotion with zero coordinator calls',
  { timeout: CASE4_TIMEOUT_MS }, async t => {
    const f = await makeCase4Fixture(t);

    // The controller must re-check the wave precondition before startup.
    const precondition = validateStepIndex(f.index, { targets: [f.targetId], evidencePlan: f.evidencePlan });
    assert.equal(precondition.concurrency_ready, true, 'wave must be dispatchable');

    // The single controller entry for the whole case. Any later controller entry
    // would be a design regression; progression must arrive through notify.
    const startupReceipt = await f.controller.startup({
      package: f.packagePath,
      workflow_id: WAVE_ID,
      execution: 'waves',
      owner_model: 'fixture-provider/team/owner',
      strong_owner_model: 'fixture-provider/team/owner',
      editor_model: 'fixture-provider/team/owner',
      review_model: 'fixture-provider/team/reviewer:high',
      fix_model_override: 'fixture-provider/team/owner',
      scout_model: 'fixture-provider/team/scout'
    }, { session: COORDINATOR_SESSION });

    // Event-driven terminal: resolved from the promotion-result send, never polled.
    await f.terminal;

    assert.deepEqual(f.entry, { startup: 1, advance: 0, recover: 0, status: 0, cancel: 0 },
      'only startup may be called on the controller');

    // Integrated persisted record, read through the receipt's authoritative path
    // and derived wave id rather than the caller's fixed name.
    const waveFile = startupReceipt.record_path ?? join(f.packagePath, 'runtime', 'waves', `${startupReceipt.wave_id ?? WAVE_ID}.json`);
    const record = JSON.parse(readFileSync(waveFile, 'utf8'));
    assert.equal(record.state, 'integrated');
    assert.equal(record.workflow_id, WAVE_ID);
    assert.equal(record.wave_id, startupReceipt.wave_id);

    // Canonical ref is the candidate commit and both sealed heads are ancestors.
    const branch = record.target.branch ?? record.target.ref ?? record.target.integration_branch;
    const canonicalRef = f.git(['rev-parse', branch]).trim();
    assert.equal(record.target.candidate_commit, canonicalRef, 'candidate commit must be the canonical ref');
    for (const [step, member] of Object.entries(record.members ?? {})) {
      assert.ok(member.sealed_head, `step ${step} must expose a sealed head`);
      assert.equal(isAncestor(f.repo, member.sealed_head, record.target.candidate_commit), true,
        `step ${step} sealed head must be an ancestor of the candidate`);
    }
    assert.equal(isAncestor(f.repo, f.baseCommit, record.target.candidate_commit), true);

    // Ordered effects per step.
    const effectKinds = step => {
      const prefix = `/step:${String(step).padStart(3, '0')}/`;
      return Object.values(record.effects ?? {})
        .filter(effect => String(effect.assignment_id ?? '').includes(prefix))
        .sort((a, b) => (a.intent_at < b.intent_at ? -1 : a.intent_at > b.intent_at ? 1 : String(a.effect_id).localeCompare(String(b.effect_id))))
        .map(effect => effect.kind);
    };
    assert.deepEqual(effectKinds(1), ['implementing', 'reviewing']);
    assert.deepEqual(effectKinds(2), ['implementing', 'reviewing', 'fixing', 'confirming']);

    // Attention sends are exactly the barrier and the promotion result; everything
    // routine must not trigger a turn.
    const triggerKinds = [];
    for (const sent of f.sends) {
      const text = JSON.stringify(sent.message);
      if (sent.opts?.triggerTurn === true) {
        if (text.includes('barrier-reached')) triggerKinds.push('barrier-reached');
        else if (text.includes('promotion-result')) triggerKinds.push('promotion-result');
        else triggerKinds.push('other');
      } else {
        assert.equal(sent.opts?.triggerTurn, false, `routine send must not trigger a turn: ${text}`);
      }
    }
    assert.deepEqual(triggerKinds.sort(), ['barrier-reached', 'promotion-result']);

    // Idle notifications progress while work is outstanding and stop at terminal.
    const integratedAt = f.notifications.findIndex(n => /integrated/.test(JSON.stringify(n.event)));
    f.notifications.forEach((n, i) => {
      if (n.active === 0 && (integratedAt < 0 || i < integratedAt)) {
        assert.equal(n.progressing, true, `idle notification ${i} must report progress`);
      }
    });
    assert.equal(f.controller.progressing(), false, 'progressing must be false after integrated');

    // The checkpoint workbook carries a working wave worker during the wave and a
    // complete one at terminal.
    const sawWorking = f.notifications
      .map(n => n.checkpoint)
      .filter(Boolean)
      .some(cp => (cp.workers ?? []).some(w => w.kind === 'wave' && w.state === 'working'));
    assert.equal(sawWorking, true, 'wave worker must be working during the wave');
    const finalCheckpoint = readCheckpointRecord(f.packagePath, WAVE_ID);
    assert.equal((finalCheckpoint.workers ?? []).find(w => w.kind === 'wave')?.state, 'complete');

    // Every launched service is drained. Two owners, three reviewer passes (step
    // 1, step 2's first review, step 2's confirmation) and one fixer: the exact
    // durable role counts, independent of command-phase launches and ordering.
    assert.equal(f.drains.length, f.launches.length, 'every launched service must be drained');
    const bootstrapRole = argv => {
      for (const value of argv ?? []) {
        if (typeof value !== 'string' || (!value.startsWith('{') && !value.startsWith('['))) continue;
        try {
          const parsed = JSON.parse(value);
          const role = parsed?.role ?? parsed?.record?.role ?? parsed?.bootstrap?.role ?? parsed?.run?.role;
          if (typeof role === 'string') return role;
        } catch { /* not a JSON bootstrap payload */ }
      }
      const flag = (argv ?? []).indexOf('--role');
      return flag >= 0 && typeof argv[flag + 1] === 'string' ? argv[flag + 1] : null;
    };
    const roleCounts = { owner: 0, reviewer: 0, fixer: 0 };
    for (const launch of f.launches) {
      const role = typeof launch.role === 'string' ? launch.role : bootstrapRole(launch.argv);
      if (Object.hasOwn(roleCounts, role)) roleCounts[role] += 1;
    }
    assert.deepEqual(roleCounts, { owner: 2, reviewer: 3, fixer: 1 },
      `durable launches must be exactly two owners, three reviews and one fixer; saw ${JSON.stringify(roleCounts)}`);

    // Replaying every routed notification is inert: no new launches, no new sends.
    const launchesBefore = f.launches.length;
    const sendsBefore = f.sends.length;
    for (const notification of f.notifications) f.controller.routeNotification(notification.event);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.launches.length, launchesBefore, 'replay must not launch services');
    assert.equal(f.sends.length, sendsBefore, 'replay must not send');
  });


// Concern-split suites (behaviour-neutral). Every original case now lives in
// one of these same-directory files; importing them keeps this entry point the
// single `waves.test.mjs` target so every `wave dispatch:` case still runs.
import './waves-selection.test.mjs';
import './waves-admission.test.mjs';
import './waves-lifecycle.test.mjs';
import './waves-progression.test.mjs';
import './waves-recovery.test.mjs';
import './waves-retained-recovery.test.mjs';
import './waves-candidate.test.mjs';
