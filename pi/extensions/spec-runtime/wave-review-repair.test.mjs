// Tests for the step-008 stage-replay repair (case F8-1): a stage whose own
// assignment is being replayed must pass the preceding-phase drain refusal,
// while a genuine next-phase launch is still refused and an altered replay
// identity is refused before any launch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { nextReviewAction, REVIEW_CATEGORIES } from './wave-review.mjs';
import { revoke } from './runtime.mjs';
import {
  makeWaveFixture, initializeWave, waveState, waveIdentity, launchAction, WAVE_MODELS,
  loadNativeRole, startNativeRole, SDK_LOADER, driveNeedsFix
} from './wave-review-fixture.mjs';

const LABEL1 = 'wave-w1-step-001-review-1';

test('wave seal: same-assignment stage replay passes drain while next-phase stays refused', async t => {
  const f = await makeWaveFixture(t);
  await initializeWave(f);
  const I = f.implementationHead;
  assert.equal(f.head, I, 'the private view stays at the implementation head');

  const next = nextReviewAction(await waveState(f));
  assert.equal(next.action, 'launch-review', 'the first action reviews the implementation: ' + JSON.stringify(next));

  const review = {
    verdict: 'needs-fix',
    findings: [{
      id: 'F1', severity: 'HIGH', category: 'correctness', actionable: true,
      file: 'src/a.mjs', line: 3, symbol: 'a', signature: 'correctness:a',
      explanation: 'the exported constant is wrong', correction: 'restore the correct constant', commit: I
    }],
    fix_verdicts: [], limitations: []
  };

  // Hold the reviewing stage on its barrier so the member run_id still names the
  // live stage, then replay the identical stage input.
  const held = await launchAction(f, next, { payload: review, hold: true });
  await f.waitIn('reviewer');
  const runId = held.run.run_id;
  const recorded = f.readRecord(runId);
  assert.notEqual(recorded.phase_drain?.status, 'confirmed',
    'the held reviewing stage has not drained');
  const launchesBefore = f.launches.length;

  // Replay the recorded stage verbatim (including expected_ids) with the same
  // reviewer model so Runtime.start sees the identical launch contract and
  // returns the live run instead of refusing a changed assignment.
  const replay = await f.startStage({
    ...waveIdentity(f), implementation_run_id: f.implementationRunId,
    stage_attempt: 1, phase: 'reviewing', stage: recorded.stage,
    review_model: WAVE_MODELS.reviewer
  });
  assert.equal(replay.run_id, runId, 'the replay returns the same run');
  assert.equal(replay.assignment_id, recorded.assignment_id, 'the replay returns the same assignment');
  assert.equal(f.launches.length, launchesBefore, 'the replay launches no new stage');
  assert.equal(f.wave.read().members['1'].run_id, runId, 'the durable member run_id is unchanged');

  // A different phase is a genuine next-phase launch and is still refused.
  const fixingStage = { role: 'fixer', label: next.label ?? recorded.stage.label, round: recorded.stage.round,
    base: f.base, head: f.head,
    packet: { index: 1, total: 1, ids: ['F1'], pending_after: [], ranges: [], findings: [] } };
  await assert.rejects(
    f.startStage({
      ...waveIdentity(f), implementation_run_id: f.implementationRunId,
      stage_attempt: 1, phase: 'fixing', stage: fixingStage
    }),
    error => error?.code === 'phase-not-drained',
    'a genuine next-phase launch is still refused while the reviewer phase is held'
  );
  assert.equal(f.launches.length, launchesBefore, 'the refused next-phase start launches no child');

  // An altered replay identity is refused before launch.
  await assert.rejects(
    f.startStage({
      ...waveIdentity(f), expected_generation: 2, implementation_run_id: f.implementationRunId,
      stage_attempt: 1, phase: 'reviewing', stage: recorded.stage,
      review_model: WAVE_MODELS.reviewer
    }),
    error => error?.code !== 'phase-not-drained' && error instanceof Error,
    'an altered replay identity is refused'
  );
  assert.equal(f.launches.length, launchesBefore, 'the altered replay launches no child');

  // Release the held child and await its terminal record through the existing
  // fixture convention before the fixture tears down.
  f.release('reviewer');
  await held.wait;
  assert.equal(f.readRecord(runId).run_id ?? runId, runId, 'the held stage settled under the same run');
});

test('wave seal: candidate command phase holds its own lease and refuses revoked or terminal records', async t => {
  const f = await makeWaveFixture(t);
  await initializeWave(f);

  // Obtain the live retained overlay workspace exactly as a coordinator does
  // before a candidate command phase: remount the drained implementation member.
  f.setPhase('reviewing');
  const remount = await f.runtime.remountWaveMember({ ...waveIdentity(f), phase: 'reviewing' });
  const record = await f.runtime.commandPhase({
    packageDir: f.packagePath, waveId: 'w1',
    subject: { kind: 'candidate', repair: 1, parents: [] },
    workspace: remount.workspace, purpose: 'candidate-command'
  });
  assert.equal(record.wave_bindings, undefined, 'a candidate command phase invents no wave member binding');
  assert.equal(record.command_phase.subject.kind, 'candidate');

  const launchesBefore = f.launches.length;
  const marker = `candidate-marker-${record.id}`;
  const result = await f.runtime.runPhaseCommand(record, `printf '%s' ${marker}`, 120);
  assert.equal(result.exit_code, 0, 'the candidate command succeeds through the overlay transport');
  assert.equal(result.requires_cancellation, false, 'the overlay drain confirms');
  assert.equal(f.launches.length, launchesBefore + 1, 'exactly one contained unit ran');
  assert.ok(readFileSync(result.full_output_path, 'utf8').includes(marker), 'the command wrote its marker');

  // A revoked candidate record fails its own lease before any unit is spawned.
  revoke(record);
  const refusedLaunches = f.launches.length;
  await assert.rejects(f.runtime.runPhaseCommand(record, 'true', 120), /Writer lease is absent/,
    'a revoked candidate command refuses before launch');
  assert.equal(f.launches.length, refusedLaunches, 'a revoked candidate command launches no unit');

  // With the revocation marker cleared, a terminal record still refuses before
  // any launch: the run's own state is the rest of the candidate lease.
  rmSync(join(f.packagePath, 'runtime', 'runs', `${record.id}-revoked.json`), { force: true });
  await f.runtime.endCommandPhase(record, { drained: true, confirmed: true, released: [] });
  assert.equal(record.state, 'completed', 'the candidate command phase closes its record');
  await assert.rejects(f.runtime.runPhaseCommand(record, 'true', 120), /Writer lease is absent/,
    'a terminal candidate command refuses before launch');
  assert.equal(f.launches.length, refusedLaunches, 'a terminal candidate command launches no unit');
});

// D1 regression: the reviewer tool schema and the submission validator must share
// one frozen category authority. The schema is advisory to the model and never
// reaches submitStage, so it is inspected directly; the same call then executes
// the real tool once per canonical category. The installed SDK must be present:
// the case fails rather than skipping when it is missing.
test('wave seal: reviewer tool schema exposes the shared category authority for every category', async t => {
  assert.ok(existsSync(SDK_LOADER), `installed Pi SDK loader is missing at ${SDK_LOADER}`);
  assert.equal(REVIEW_CATEGORIES.length, 7, 'the shared authority lists the seven canonical categories');

  for (const category of REVIEW_CATEGORIES) {
    const harness = await loadNativeRole(t, {
      role: 'reviewer', builtins: ['read', 'grep', 'find', 'ls', 'bash']
    });
    await startNativeRole(harness, { provider: 'fixture-provider', id: 'team/reviewer' });

    const entry = harness.extension.tools.get('spec_stage_complete');
    assert.ok(entry, 'the reviewer session registers spec_stage_complete');
    const categorySchema = entry.definition.parameters.properties.findings.items.properties.category;
    const schemaCategories = categorySchema.anyOf
      ? categorySchema.anyOf.map(branch => branch.const ?? branch)
      : categorySchema.enum ?? [];
    assert.deepStrictEqual(schemaCategories, [...REVIEW_CATEGORIES],
      `${category}: the tool schema category enum is the exported authority, not a divergent literal set`);

    // Execute the real tool: a valid needs-fix finding with this category and its
    // signature prefix against the fixture head must be accepted and persisted.
    const finding = {
      id: 'C1', severity: 'HIGH', category, actionable: true,
      file: 'src/a.mjs', line: 3, symbol: 'a', signature: `${category}:fixture`,
      explanation: `the ${category} boundary is wrong`, correction: 'restore the boundary',
      commit: harness.record.stage.head
    };
    const reply = await entry.definition.execute(`call-${category}`, {
      verdict: 'needs-fix', findings: [finding], fix_verdicts: [], limitations: []
    });
    assert.equal(reply.isError, false, `${category}: the valid finding is accepted`);
    assert.equal(reply.details.accepted, true, `${category}: the submission receipt is accepted`);
    assert.equal(reply.details.artifact_written, true, `${category}: the review artifact is persisted`);
    assert.equal(reply.details.refusal, null, `${category}: the accepted receipt records no refusal`);
  }
});

// F8-2: a fully valid, accepted confirmation that leaves an earlier fixed
// decision unresolved must be refused by the state layer as confirmation-failed
// rather than sealed. The two findings live in distinct files/anchors so planFixes
// splits them into two packets, each fixing a distinct decision id, with the
// earlier packet's decision left unresolved at confirmation time.
test('wave seal: multi-packet confirmation refuses unresolved earlier fixed decision', async t => {
  const f = await makeWaveFixture(t);
  const I = f.implementationHead;
  const finding = (id, file, symbol) => ({
    id, severity: 'MED', category: 'correctness', actionable: true,
    file, line: 3, symbol, signature: `correctness:${symbol}`,
    explanation: `the ${symbol} export is wrong`, correction: `repair ${symbol}`, commit: I
  });

  const confirmation = await driveNeedsFix(f,
    { verdict: 'needs-fix', findings: [finding('F1', 'src/a.mjs', 'a'), finding('F2', 'src/b.mjs', 'b')], fix_verdicts: [], limitations: [] },
    packet => ({ [packet.ids[0] === 'F1' ? 'src/a.mjs' : 'src/b.mjs']:
      packet.ids[0] === 'F1' ? 'export const a = 3;\n' : 'export const b = 11;\n' }));
  assert.equal(confirmation.action, 'launch-confirmation',
    `the fix cycle reaches the confirmation: ${JSON.stringify(confirmation)}`);

  const pre = await waveState(f);
  const packets = pre.fix.packets;
  assert.ok(packets.length >= 2, 'the two findings are split across distinct packets');
  assert.deepStrictEqual([...new Set(packets.flatMap(packet => packet.ids))], ['F1', 'F2'],
    'each packet fixes a distinct decision id');
  const earlierId = packets[0].ids[0];
  const finalId = packets.at(-1).ids[0];
  assert.notEqual(earlierId, finalId, 'the earlier and final packets fix different ids');

  // The confirmation payload is valid and complete: verdict pass with no
  // actionable findings and one verdict per fixed decision. The earlier fixed
  // decision stays unresolved at the state layer.
  const decided = [...new Set(pre.decided)];
  assert.deepStrictEqual([...decided].sort(), ['F1', 'F2'], 'both fixed decisions are decided');
  const verdicts = decided.map(id => ({ fix: `reviews/${LABEL1}-fix.md`, id,
    verdict: id === earlierId ? 'unresolved' : 'resolved',
    evidence: id === earlierId ? 'the earlier defect remains' : `verified ${id}` }));
  const launchesBefore = f.launches.length;
  const record = await launchAction(f, confirmation, {
    payload: { verdict: 'pass', findings: [], fix_verdicts: verdicts, limitations: [] }
  });
  assert.equal(f.launches.length, launchesBefore + 1, 'the confirmation launches exactly once');

  const receipt = JSON.parse(readFileSync(join(f.packagePath, 'runtime', 'runs', `${record.id}-stage.json`), 'utf8'));
  assert.equal(receipt.accepted, true, 'the confirmation payload is accepted, not a payload error');
  assert.equal(receipt.refusal, null, 'the confirmation is not refused as a payload error');
  const submitted = Object.fromEntries(receipt.payload.fix_verdicts.map(entry => [entry.id, entry.verdict]));
  assert.equal(submitted[finalId], 'resolved', 'the final-packet decision is resolved');
  assert.equal(submitted[earlierId], 'unresolved', 'the earlier fixed decision is unresolved');

  // The accepted-but-unresolved confirmation blocks, stably, with no seal, no
  // extra launches and no canonical retention ref.
  const blocked = nextReviewAction(await waveState(f));
  assert.deepStrictEqual(blocked, { action: 'block', reason: 'confirmation-failed' },
    `the accepted unresolved confirmation blocks: ${JSON.stringify(blocked)}`);
  assert.deepStrictEqual(nextReviewAction(await waveState(f)), blocked, 'the block action is stable on re-read');
  assert.equal(f.launches.length, launchesBefore + 1, 'the block launches no further stage');

  const state = await waveState(f);
  assert.notEqual(state.seal?.state, 'sealed', 'no sealed review state');
  assert.equal(f.wave.read().members['1'].sealed, undefined, 'no member is sealed');
  const canonicalRef = spawnSync('git', ['-C', f.repo, 'rev-parse', 'refs/waves/retained/w1/step-001'], { encoding: 'utf8' });
  assert.notEqual(canonicalRef.status, 0, 'the canonical retention ref is absent');
});
