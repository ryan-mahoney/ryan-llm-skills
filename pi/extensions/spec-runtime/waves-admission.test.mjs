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

// Case 2: the admitted width is a real concurrency bound. A ready package with
// N independent worktree members and a shared owner hold barrier launches
// exactly N live owners before any completion may arrive; the test releases them
// only once the full width is observed. The final seal assertions remain RED
// until the event-path packet lands; the current first boundary is open-wave.
test('wave dispatch: admitted width fills five and nine members before any completes',
  { timeout: CASE4_TIMEOUT_MS }, async t => {
    const ownerInput = {
      owner_model: 'fixture-provider/team/owner',
      strong_owner_model: 'fixture-provider/team/owner',
      editor_model: 'fixture-provider/team/owner',
      review_model: 'fixture-provider/team/reviewer:high',
      fix_model_override: 'fixture-provider/team/owner',
      scout_model: 'fixture-provider/team/scout'
    };

    for (const width of [5, 9]) {
      await t.test(`admitted width ${width}`, { timeout: CASE4_TIMEOUT_MS }, async t2 => {
        const f = await makeCase4Fixture(t2, { memberCount: width, holdOwners: true });

        const receipt = await f.controller.startup({
          package: f.packagePath,
          workflow_id: WAVE_ID,
          execution: 'waves',
          isolation: 'worktree',
          ...ownerInput
        }, { session: COORDINATOR_SESSION });

        assert.equal(receipt.requested_width, width, 'receipt must report the requested width');
        assert.equal(receipt.admitted_width, width, 'receipt must report the admitted width');
        assert.equal(receipt.software_ceiling, 16, 'software ceiling must be 16');
        assert.equal(receipt.effective_limits?.binding, 'ready-width', 'effective limits must bind on ready-width');

        // Wait until every admitted owner has started and recorded its pid, with
        // the barrier still held and no completion routed.
        await waitFor(() => {
          const lines = readFileSync(f.startsFile, 'utf8').split('\n').map(line => line.trim()).filter(Boolean);
          return lines.length >= width ? lines : false;
        }, CASE4_TIMEOUT_MS, `owners started ${width}`);

        const pids = [...new Set(readFileSync(f.startsFile, 'utf8').split('\n').map(line => line.trim()).filter(Boolean)
          .map(line => Number(line.split(/\s+/)[0])))];
        assert.equal(pids.length, width, 'the barrier must hold exactly the admitted owners');
        assert.equal(pids.length, f.runtime.active.size, 'every held owner must be a live runtime worker');
        for (const pid of pids) assert.equal(inspectProcess(pid).state, 'alive', `owner pid ${pid} must be alive`);

        // No owner completion may have been routed while the barrier is held.
        const completionEvents = f.notifications.filter(n => /seal|complete|integrat|promot/i.test(JSON.stringify(n.event)));
        assert.deepEqual(completionEvents, [], 'no owner completion may be routed before release');

        // The launcher-limit configuration must not write agent settings files.
        assert.equal(existsSync(f.settingsPath), false, 'settings.json must not be created');
        assert.equal(existsSync(f.settingsLocalPath), false, 'settings.local.json must not be created');

        f.releaseOwners();

        // Every member reaches sealed after release.
        const waveFile = receipt.record_path ?? join(f.packagePath, 'runtime', 'waves', `${receipt.wave_id ?? WAVE_ID}.json`);
        await waitFor(() => {
          const record = JSON.parse(readFileSync(waveFile, 'utf8'));
          const members = Object.values(record.members ?? {});
          return members.length === width && members.every(member => member.phase === 'sealed') ? record : false;
        }, CASE4_TIMEOUT_MS, `all ${width} members sealed`);

        // The launch log contains only Runtime role launches plus real setup
        // services; no pi-subagents batch command may appear.
        const allowed = new Set(['owner', 'reviewer', 'fixer', 'scout']);
        for (const launch of f.launches) {
          const role = typeof launch.role === 'string' ? launch.role : null;
          if (role === 'setup') {
            assert.ok(f.drains.some(drain => drain.id === launch.unit),
              `setup service ${launch.unit ?? launch.id ?? ''} must have a recorded drain`);
          } else {
            assert.ok(role === null || allowed.has(role), `launch ${launch.id ?? ''} must be a Runtime role launch, saw ${role}`);
          }
          assert.equal(/pi-subagents/.test(JSON.stringify(launch.argv ?? [])), false, 'no pi-subagents batch call may be launched');
        }
      });
    }
  });

// ---------------------------------------------------------------------------
// Case: the software ceiling and an explicit cap are bounded, visible queues.
// 17 independent members with ample host budget admit exactly the software
// ceiling of 16 owners and queue the 17th with the software-ceiling reason; 5
// members bounded by max_parallel 3 admit exactly 3 and queue two with the
// explicit-cap reason. Held owners are released one at a time so each release
// frees one slot for the next previously queued member, which must launch once.
test('wave dispatch: the software ceiling and an explicit cap queue visibly',
  { timeout: CASE4_TIMEOUT_MS }, async t => {
    const ownerInput = {
      owner_model: 'fixture-provider/team/owner',
      strong_owner_model: 'fixture-provider/team/owner',
      editor_model: 'fixture-provider/team/owner',
      review_model: 'fixture-provider/team/reviewer:high',
      fix_model_override: 'fixture-provider/team/owner',
      scout_model: 'fixture-provider/team/scout'
    };
    const rows = [
      { label: 'memberCount17 no cap', memberCount: 17, maxParallel: null, expectedWidth: 16, queueReason: 'software-ceiling', explicitCap: null },
      { label: 'memberCount5 max_parallel3', memberCount: 5, maxParallel: 3, expectedWidth: 3, queueReason: 'explicit-cap', explicitCap: { value: 3, source: 'run' } }
    ];

    for (const row of rows) {
      await t.test(`queue ${row.label}`, { timeout: CASE4_TIMEOUT_MS }, async t2 => {
        const f = await makeCase4Fixture(t2, { memberCount: row.memberCount, holdOwners: true });

        // Bounded opt-in diagnostic for the repeated cap-queue hang. Enabled only
        // with WAVE_QUEUE_DIAGNOSTIC=1; it observes state and prints compact JSON,
        // never repairing, reordering or changing teardown. Printed once so the
        // owner can inspect only this run's files/processes if the case stalls.
        const diagnosticEnabled = process.env.WAVE_QUEUE_DIAGNOSTIC === '1';
        let diagnosticStage = 'before-startup';
        let diagnosticTimer = null;
        if (diagnosticEnabled) {
          console.error(JSON.stringify({
            label: row.label,
            diagnostic: 'fixture',
            packagePath: f.packagePath,
            repo: f.repo,
            memberCount: row.memberCount,
            maxParallel: row.maxParallel,
            expectedWidth: row.expectedWidth,
            queueReason: row.queueReason
          }));
          diagnosticTimer = setInterval(() => {
            try {
              let record = {};
              try {
                record = JSON.parse(readFileSync(recordPath, 'utf8'));
              } catch { record = {}; }
              const members = record.members ?? {};
              const memberState = Object.entries(members).map(([step, member]) => ({
                step: Number(step),
                phase: member.phase ?? null,
                queue: member.queue_reason ?? null,
                run: member.run_id ?? member.run ?? null,
                block: member.blocking_reason ?? null
              }));
              const activeIds = f.runtime.active instanceof Map ? [...f.runtime.active.keys()] : [...(f.runtime.active ?? [])];
              const launchState = f.launches.map(launch => ({
                id: launch.id ?? null,
                role: launch.role ?? null,
                unit: launch.unit ?? null,
                status: launch.status ?? null,
                stderr: typeof launch.stderr === 'string' ? launch.stderr.slice(0, 400) : null
              }));
              const drainState = f.drains.map(drain => ({ id: drain.id ?? null, status: drain.status ?? null, cancel: drain.cancel === true }));
              console.error(JSON.stringify({
                label: row.label,
                stage: diagnosticStage,
                starts: readFileSync(f.startsFile, 'utf8').split('\n').map(line => line.trim()).filter(Boolean).length,
                state: record.state ?? null,
                members: memberState,
                effects: record.effects,
                ownerLive: f.ownerLive(),
                active: activeIds,
                launches: launchState,
                drains: drainState
              }));
            } catch (error) {
              console.error(JSON.stringify({ label: row.label, stage: diagnosticStage, diagnosticError: String(error?.message ?? error) }));
            }
          }, 10000);
          diagnosticTimer.unref?.();
          t2.after(() => { if (diagnosticTimer) clearInterval(diagnosticTimer); });
        }

        const receipt = await f.controller.startup({
          package: f.packagePath,
          workflow_id: WAVE_ID,
          execution: 'waves',
          isolation: 'worktree',
          ...(row.maxParallel === null ? {} : { max_parallel: row.maxParallel }),
          ...ownerInput
        }, { session: COORDINATOR_SESSION });

        assert.equal(receipt.admitted_width, row.expectedWidth, 'admitted width must be the queue bound');
        assert.deepEqual(receipt.effective_limits?.explicit_cap ?? null, row.explicitCap, 'explicit cap must match the run input');

        const recordPath = receipt.record_path ?? join(f.packagePath, 'runtime', 'waves', `${receipt.wave_id ?? WAVE_ID}.json`);
        const readMembers = () => JSON.parse(readFileSync(recordPath, 'utf8')).members ?? {};
        const startLines = () => readFileSync(f.startsFile, 'utf8').split('\n').map(line => line.trim()).filter(Boolean);
        const startedSteps = () => startLines().map(line => Number(line.split(/\s+/)[1]));
        const stepCount = step => startedSteps().filter(value => value === step).length;

        // Wait until the full admitted width of owners is held behind the barrier.
        diagnosticStage = 'held-width-wait';
        await waitFor(() => startLines().length >= row.expectedWidth, CASE4_TIMEOUT_MS, `${row.expectedWidth} held owners`);

        // Concurrency is counted at the real owner service register/close boundary,
        // so setup and reviewer processes can never inflate the claimed peak.
        assert.equal(f.ownerLive(), row.expectedWidth, 'live owner services must equal the admitted width');
        assert.equal(f.ownerPeak(), row.expectedWidth, 'peak live owner services must equal the admitted width');

        // The remainder stays queued with the bound that queued it.
        const queuedSteps = Object.entries(readMembers())
          .filter(([, member]) => member.phase === 'queued')
          .map(([step]) => Number(step))
          .sort((a, b) => a - b);
        const expectedQueued = Array.from({ length: row.memberCount - row.expectedWidth }, (_, index) => row.expectedWidth + index + 1);
        assert.deepEqual(queuedSteps, expectedQueued, 'members beyond the admitted width must be the queued ones, in order');
        for (const step of queuedSteps) {
          assert.equal(readMembers()[String(step)].queue_reason, row.queueReason, `member ${step} must report queue_reason ${row.queueReason}`);
        }

        // Release the admitted owners one at a time. Each release must free one
        // slot for the next previously queued member, which launches exactly once.
        const order = Array.from({ length: row.memberCount }, (_, index) => index + 1);
        let queueCursor = 0;
        for (const releasedStep of order) {
          if (new Set(startedSteps()).size >= row.memberCount) break;
          diagnosticStage = `release-${releasedStep}`;
          f.releaseOwner(releasedStep);
          const nextStep = queuedSteps[queueCursor];
          if (nextStep === undefined) break;
          diagnosticStage = `wait-${nextStep}-after-${releasedStep}`;
          await waitFor(() => stepCount(nextStep) >= 1, CASE4_TIMEOUT_MS, `member ${nextStep} starts after releasing ${releasedStep}`);
          assert.equal(stepCount(nextStep), 1, `member ${nextStep} must launch exactly once`);
          queueCursor += 1;
        }

        // Release every remaining held owner and let the wave finish.
        diagnosticStage = 'release-all';
        f.releaseOwners();
        diagnosticStage = 'all-started-wait';
        await waitFor(() => startedSteps().length === row.memberCount, CASE4_TIMEOUT_MS, `all ${row.memberCount} owners started`);
        const starts = startedSteps();
        assert.equal(new Set(starts).size, row.memberCount, 'the owner start log must hold every distinct step');
        for (const step of order) assert.equal(stepCount(step), 1, `owner ${step} must start exactly once with no duplicate`);

        diagnosticStage = 'all-sealed-wait';
        await waitFor(() => {
          const members = readMembers();
          return Object.keys(members).length === row.memberCount
            && Object.values(members).every(member => member.phase === 'sealed') ? members : false;
        }, CASE4_TIMEOUT_MS, `all ${row.memberCount} members sealed`);
        diagnosticStage = 'inner-teardown';
      });
    }
  });

// ---------------------------------------------------------------------------
// Regression for the cross-step-6 repair: a `setup: none` target must prepare
// an empty dependency layer through the real Runtime. The member's workspace is
// real (never faked), the real setup service launches and drains once, and the
// runtime-owned staging dependencies directory is recursively empty. The owner
// worker is held behind the barrier so no lifecycle progression occurs; the
// fixture cleanup releases the held worker. This case is additive only.
test('wave dispatch: setup none prepares an empty dependency layer through real Runtime',
  { timeout: CASE4_TIMEOUT_MS }, async t => {
    const f = await makeCase4Fixture(t, { memberCount: 1, holdOwners: true });

    const receipt = await f.controller.startup({
      package: f.packagePath,
      workflow_id: WAVE_ID,
      execution: 'waves',
      isolation: 'worktree',
      owner_model: 'fixture-provider/team/owner',
      strong_owner_model: 'fixture-provider/team/owner',
      editor_model: 'fixture-provider/team/owner',
      review_model: 'fixture-provider/team/reviewer:high',
      fix_model_override: 'fixture-provider/team/owner',
      scout_model: 'fixture-provider/team/scout'
    }, { session: COORDINATOR_SESSION });

    const waveFile = receipt.record_path ?? join(f.packagePath, 'runtime', 'waves', `${receipt.wave_id ?? WAVE_ID}.json`);
    const record = JSON.parse(readFileSync(waveFile, 'utf8'));
    const member = record.members?.['1'];
    assert.ok(member, 'the wave record must contain member 001');
    assert.ok(member.preparation_receipt, 'member 001 must carry a real preparation receipt');
    assert.ok(member.workspace, 'member 001 must carry a real workspace');
    assert.equal(member.phase, 'implementing', 'member 001 must be implementing once its owner starts');

    // The real owner is held live behind the barrier. Runtime.start resolves
    // before the asynchronous child writes the barrier file, so wait for the
    // owner start record rather than expecting a synchronous event.
    const startsText = await waitFor(() => {
      const lines = readFileSync(f.startsFile, 'utf8').split('\n').map(line => line.trim()).filter(Boolean);
      return lines.length === 1 ? lines : false;
    }, CASE4_TIMEOUT_MS, 'one held owner started');
    const starts = startsText;
    assert.equal(starts.length, 1, 'exactly one real owner must have started before release');
    const pid = Number(starts[0].split(/\s+/)[0]);
    assert.equal(inspectProcess(pid).state, 'alive', `held owner pid ${pid} must be alive`);

    // The runtime-owned staging dependencies directory for
    // s001-a1 under wave-workspaces/<package hash>/<wave id>/staging must exist
    // and be empty: a `setup: none` target produces no dependency files.
    const waveRoot = join(f.indexDir, 'wave-workspaces');
    const waveDirs = readdirSync(waveRoot, { withFileTypes: true }).filter(entry => entry.isDirectory());
    const stagingRoots = waveDirs.map(entry => join(waveRoot, entry.name, receipt.wave_id, 'staging', 's001-a1'));
    assert.equal(stagingRoots.length, 1, 'exactly one runtime wave-workspace root must exist');
    const dependencies = join(stagingRoots[0], 'dependencies');
    assert.equal(existsSync(dependencies), true, 'the staging dependencies directory must exist');
    assert.deepEqual(readdirSync(dependencies, { recursive: true }), [], 'a setup-none dependency layer must contain no files');

    // The real setup service launched exactly once and drained with confirmation.
    // Real wave owners also flow through the service adapter (containedRoot ->
    // serviceAdapter.start), so `svc-*` entries cover both setup and owner and the
    // adapter's role field is null for both. Discriminate them by their actual
    // launch cwd: setup runs in the staging source, the owner in the member
    // worktree. The owner launch is asserted separately, not as the total count.
    const svcLaunches = f.launches.filter(launch => typeof launch.id === 'string' && launch.id.startsWith('svc-'));
    const setupLaunches = svcLaunches.filter(launch => typeof launch.cwd === 'string' && launch.cwd.endsWith('/staging/s001-a1/source'));
    assert.equal(setupLaunches.length, 1, 'the real setup service must launch exactly once as a service entry');
    const setupLaunch = setupLaunches[0];
    const setupDrains = f.drains.filter(drain => drain.id === setupLaunch.unit);
    assert.equal(setupDrains.length, 1, 'the real setup service must drain exactly once, matched by its service id');
    assert.equal(setupDrains[0].status, 'confirmed', 'the setup drain must be confirmed');
    const ownerLaunches = svcLaunches.filter(launch => launch.cwd === member.workspace.worktree);
    assert.equal(ownerLaunches.length, 1, 'the held owner launch must run in the member worktree, separately from the setup service');

    // No lifecycle progression: the barrier is never released here and cleanup
    // drains the held worker.
    assert.equal(existsSync(f.barrierFile), true, 'the owner hold barrier must still be held');
  });

// Additive coordinator-boundary regression: the durable coordinator identity
// recorded for the wave is a live process, and the seal receipt reached through
// the real notify route is a durable sealed receipt whose drained phase list
// includes seal itself. Single member, no held owner: the whole lifecycle runs.
