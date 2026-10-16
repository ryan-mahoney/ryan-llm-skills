// Wave dispatch controller tests (step 10). Case 4 is the walking-skeleton case
// and is written test-first from the canonical card. Its first boundary is the
// controller's own `startup`: the implementation does not exist yet, so the
// direct `await controller.startup(...)` rejects `not-implemented`. That is the
// red evidence for this packet; every observable assertion the card specifies is
// present after that boundary and will exercise the real controller once the
// implementation lands.
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

// ---------------------------------------------------------------------------
// Case 1: execution selection follows the Decisions outcome table. One package
// per row, the real controller entrypoint, the fake serial launchProcess and a
// substituted hostCheck. Each row asserts its real prerequisite first, then the
// refusal/selection it drives. No row may pass by observing `not-implemented`.
test('wave dispatch: execution selection follows the outcome table', { timeout: CASE4_TIMEOUT_MS }, async t => {
  const ownerInput = {
    owner_model: 'fixture-provider/team/owner',
    strong_owner_model: 'fixture-provider/team/owner',
    editor_model: 'fixture-provider/team/owner',
    review_model: 'fixture-provider/team/reviewer:high',
    fix_model_override: 'fixture-provider/team/owner',
    scout_model: 'fixture-provider/team/scout'
  };

  // A row's package is freshly created and torn down with its subtest. Every
  // refusal asserts the same invariants: no fake launch, no runtime/waves
  // directory (except a deliberately persisted record), no package claim and no
  // sent message.
  const refusalInvariants = async (f, { label, allowWaveRecord = false } = {}) => {
    assert.equal(f.serialLaunches.length, 0, `${label}: serial must not launch`);
    const waveDir = join(f.packagePath, 'runtime', 'waves');
    const hasWaveDir = (() => { try { return readdirSync(waveDir).length > 0; } catch { return false; } })();
    if (!allowWaveRecord) assert.equal(hasWaveDir, false, `${label}: no runtime/waves record may exist`);
    const { claims } = await f.ownership.inspectClaims({ packageId: f.packageRef });
    assert.equal(claims.length, 0, `${label}: no package claim may be held`);
    assert.equal(f.sends.length, 0, `${label}: no message may be sent`);
  };

  const startup = (f, execution, input = {}) => f.controller.startup({
    package: f.packagePath,
    execution,
    ...ownerInput,
    ...input
  }, { session: COORDINATOR_SESSION });

  // Row: legacy auto -> serial via Runtime.startup, reasons ['legacy-serial'].
  await t.test('auto legacy runs serial with legacy-serial reason and one owner launch', async t2 => {
    const f = await makeCase4Fixture(t2, {
      mutateIndex: index => {
        index.wave_checks = undefined;
        index.setup = undefined;
        index.steps = index.steps.map(({ requires, writes, ...rest }) => rest);
      }
    });
    // Prerequisite: legacy metadata validates ok but is not concurrency ready.
    assert.equal(f.validation.ok, true, 'legacy metadata must still validate ok');
    assert.equal(f.validation.legacy, true, 'row metadata must be legacy');
    assert.ok(f.validation.reasons.includes('legacy-serial'), 'legacy-serial must be reported');
    const result = await startup(f, 'auto');
    assert.equal(result.execution, 'serial');
    assert.ok((result.reasons ?? []).includes('legacy-serial'), 'receipt must carry legacy-serial');
    assert.equal(f.serialLaunches.length, 1, 'legacy serial must launch exactly one owner');
  });

  // Row: multi-target auto -> serial, reasons include 'multiple-targets'. Both
  // targets carry qualified writes and a setup entry, so the only blocker is the
  // two-target shape itself.
  await t.test('auto multiple targets runs serial with multiple-targets reason', async t2 => {
    const f = await makeCase4Fixture(t2, {
      repos: ['repo', 'repo-b'],
      targets: ['repo', 'repo-b'],
      mutateIndex: index => {
        index.setup = { repo: 'none', 'repo-b': 'none' };
        index.steps = index.steps.map((step, position) => ({
          ...step,
          repository: position === 0 ? 'repo' : 'repo-b',
          writes: [position === 0 ? 'repo:src/a.mjs' : 'repo-b:src/b.mjs']
        }));
      }
    });
    const validation = validateStepIndex(f.index, { targets: ['repo', 'repo-b'], evidencePlan: f.evidencePlan });
    assert.equal(validation.ok, true, `two-location metadata must validate ok: ${validation.errors.join('; ')}`);
    assert.ok(validation.reasons.includes('multiple-targets'), 'multiple-targets must be reported');
    assert.equal(validation.concurrency_ready, false, 'two targets are not concurrency ready');
    const result = await startup(f, 'auto');
    assert.equal(result.execution, 'serial');
    assert.ok((result.reasons ?? []).includes('multiple-targets'), 'receipt must carry multiple-targets');
    assert.equal(f.serialLaunches.length, 1, 'multi-target auto must still launch exactly one owner');
  });

  // Row: explicit waves on a multi-target package throws waves-multiple-targets
  // before any launch.
  await t.test('explicit waves on multiple targets throws waves-multiple-targets', async t2 => {
    const f = await makeCase4Fixture(t2, {
      repos: ['repo', 'repo-b'],
      targets: ['repo', 'repo-b'],
      mutateIndex: index => {
        index.setup = { repo: 'none', 'repo-b': 'none' };
        index.steps = index.steps.map((step, position) => ({
          ...step,
          repository: position === 0 ? 'repo' : 'repo-b',
          writes: [position === 0 ? 'repo:src/a.mjs' : 'repo-b:src/b.mjs']
        }));
      }
    });
    const validation = validateStepIndex(f.index, { targets: ['repo', 'repo-b'], evidencePlan: f.evidencePlan });
    assert.equal(validation.ok, true, `prerequisite metadata must validate ok: ${validation.errors.join('; ')}`);
    assert.ok(validation.reasons.includes('multiple-targets'), 'prerequisite: multiple-targets');
    await assert.rejects(() => startup(f, 'waves'), error => error.code === 'waves-multiple-targets');
    await refusalInvariants(f, { label: 'waves-multiple-targets' });
  });

  // Row: auto with incomplete wave_checks -> needs_preparation, no launch.
  await t.test('auto incomplete wave checks needs preparation', async t2 => {
    const f = await makeCase4Fixture(t2, { mutateIndex: index => { index.wave_checks = undefined; } });
    assert.equal(f.validation.ok, true, 'prerequisite metadata must validate ok');
    assert.ok(f.validation.reasons.includes('wave-checks-incomplete'), 'prerequisite: wave-checks-incomplete');
    const result = await startup(f, 'auto');
    assert.equal(result.state, 'needs_preparation');
    assert.deepEqual(result.reasons, ['wave-checks-incomplete']);
    await refusalInvariants(f, { label: 'needs_preparation' });
  });

  // Row: an absolute-path write is invalid metadata in either mode; the thrown
  // errors equal validateStepIndex's own errors.
  for (const execution of ['auto', 'waves', 'serial']) {
    await t.test(`${execution} absolute write throws index-invalid with real errors`, async t2 => {
      const f = await makeCase4Fixture(t2, { mutateIndex: index => { index.steps[0].writes = ['/etc/passwd']; } });
      assert.equal(f.validation.ok, false, 'absolute write must not validate ok');
      await assert.rejects(() => startup(f, execution), error => {
        if (error.code !== 'index-invalid') return false;
        assert.deepEqual(error.errors, f.validation.errors, 'thrown errors must equal validateStepIndex errors');
        return true;
      });
      await refusalInvariants(f, { label: `${execution} index-invalid` });
    });
  }

  // Row: an unparseable spec-steps.json throws index-unreadable.
  await t.test('malformed spec-steps throws index-unreadable', async t2 => {
    const f = await makeCase4Fixture(t2, { indexRaw: '{ not json' });
    assert.equal(f.validation, null, 'unparseable metadata cannot be validated');
    await assert.rejects(() => startup(f, 'auto'), error => error.code === 'index-unreadable');
    await refusalInvariants(f, { label: 'index-unreadable' });
  });

  // Row: a ready package whose hostCheck is setup-required returns setup-required
  // with that reason and remedy, before any claim or message.
  await t.test('ready host setup-required returns state with reason and remedy', async t2 => {
    const f = await makeCase4Fixture(t2, {
      hostCheck: async () => ({
        version: 1,
        status: 'setup-required',
        ok: false,
        reason: 'overlay-unsupported',
        remedy: 'run runtime-host setup',
        nativeReady: false,
        softwareCeiling: 16,
        route: 'native',
        fallback: null,
        host: { host_id: 'fixture-host', boot_id: 'fixture-boot', uid: process.getuid?.() ?? 1000 },
        admission: { status: 'setup-required', reason: 'overlay-unsupported', remedy: 'run runtime-host setup', admittedWidth: 0, binding: null, bindings: null, launchable: false, slots: null, free: null },
        policy: { admittedWidth: 0, binding: null, softwareCeiling: 16 },
        overlay: { status: 'unsupported', reason: 'overlay-unsupported', remedy: 'run runtime-host setup', fallbackEligible: false }
      })
    });
    assert.equal(f.validation.concurrency_ready, true, 'prerequisite: concurrency ready');
    const result = await startup(f, 'auto');
    assert.equal(result.state, 'setup-required');
    assert.equal(result.reason, 'overlay-unsupported');
    assert.equal(result.remedy, 'run runtime-host setup');
    await refusalInvariants(f, { label: 'setup-required' });
  });

  // Row: serial while a nonterminal wave record exists throws wave-active naming
  // its id; the deliberately persisted record is the one allowed exception.
  await t.test('serial with a nonterminal wave record throws wave-active naming its id', async t2 => {
    const f = await makeCase4Fixture(t2, {
      afterCreate: ({ packagePath }) => {
        const dir = join(packagePath, 'runtime', 'waves');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${WAVE_ID}.json`), JSON.stringify({ version: 1, wave_id: WAVE_ID, state: 'running' }, null, 2));
      }
    });
    await assert.rejects(() => startup(f, 'serial'), error => error.code === 'wave-active' && String(error.message ?? '').includes(WAVE_ID));
    await refusalInvariants(f, { label: 'wave-active', allowWaveRecord: true });
  });

  // Row: serial on incomplete metadata launches exactly 1 owner and reports
  // concurrency_ready false plus the reasons.
  await t.test('serial on incomplete metadata launches one owner and reports not ready', async t2 => {
    const f = await makeCase4Fixture(t2, { mutateIndex: index => { index.wave_checks = undefined; } });
    assert.equal(f.validation.ok, true, 'prerequisite metadata must validate ok');
    assert.equal(f.validation.concurrency_ready, false, 'incomplete checks are not concurrency ready');
    const result = await startup(f, 'serial');
    assert.equal(result.execution, 'serial');
    assert.equal(result.concurrency_ready, false);
    assert.ok((result.reasons ?? []).includes('wave-checks-incomplete'), 'reasons must be reported');
    assert.equal(f.serialLaunches.length, 1, 'serial must launch exactly one owner');
  });

  // Row: a ready package with a live serial run refuses a wave with
  // serial-run-active before any launch or claim.
  await t.test('ready package with a live serial run throws serial-run-active', async t2 => {
    let serialPid;
    const f = await makeCase4Fixture(t2, {
      afterCreate: ({ packagePath }) => {
        const identity = inspectProcess(process.pid);
        serialPid = identity.pid;
        mkdirSync(join(packagePath, 'runtime'), { recursive: true });
        writeFileSync(join(packagePath, 'runtime', 'run.json'), JSON.stringify({
          version: 1, id: 'fixture-serial-run', package: packagePath, state: 'running',
          coordinator_pid: identity.pid, pid: identity.pid,
          started_at: identity.started_at ?? new Date().toISOString(), finished_at: null
        }, null, 2));
      }
    });
    assert.equal(f.validation.concurrency_ready, true, 'prerequisite: concurrency ready');
    await assert.rejects(() => startup(f, 'auto'), error => error.code === 'serial-run-active');
    assert.equal(serialPid, process.pid, 'fixture serial coordinator must be the live test process');
    await refusalInvariants(f, { label: 'serial-run-active' });
  });

  // Row: auto with prior learnings and no wave records -> needs_reconciliation.
  await t.test('prior learnings without wave records needs reconciliation', async t2 => {
    const f = await makeCase4Fixture(t2, {
      afterCreate: ({ packagePath }) => {
        mkdirSync(join(packagePath, 'learnings'), { recursive: true });
        writeFileSync(join(packagePath, 'learnings', 'step-001-learning.md'), '# prior learning\n');
      }
    });
    assert.equal(f.validation.concurrency_ready, true, 'prerequisite: concurrency ready');
    const result = await startup(f, 'auto');
    assert.equal(result.state, 'needs_reconciliation');
    await refusalInvariants(f, { label: 'needs_reconciliation' });
  });

  // Row: a pending inbox note takes precedence and returns needs_intake even when
  // the index is malformed.
  await t.test('pending inbox note needs intake even with a malformed index', async t2 => {
    const f = await makeCase4Fixture(t2, {
      indexRaw: '{ not json',
      afterCreate: ({ packagePath }) => {
        mkdirSync(join(packagePath, 'inbox'), { recursive: true });
        writeFileSync(join(packagePath, 'inbox', 'note.md'), 'direction\n');
      }
    });
    const result = await startup(f, 'auto');
    assert.equal(result.state, 'needs_intake');
    await refusalInvariants(f, { label: 'needs_intake' });
  });

  // Row: a ready host with no review_model throws review-model-required.
  await t.test('ready host without review model throws review-model-required', async t2 => {
    const f = await makeCase4Fixture(t2);
    assert.equal(f.validation.concurrency_ready, true, 'prerequisite: concurrency ready');
    await assert.rejects(() => startup(f, 'auto', { review_model: undefined }), error => error.code === 'review-model-required');
    await refusalInvariants(f, { label: 'review-model-required' });
  });
});

// ---------------------------------------------------------------------------
