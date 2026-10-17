// Tests for wave review stage-payload validation, rendered-artifact round-trip, the nextReviewAction outcome table and the real Git/lease refusals (cases 1, 4, 5, 6, 7).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  validateReviewPayload, validateFixPayload, renderReviewMarkdown, nextReviewAction,
  resolveStageModel, stagePrompt, recordStageFingerprint, submitStage, sha256,
  changedPaths, attributeWrites
} from './wave-review.mjs';
import { launch, revoke, ROLE_CONTRACT } from './runtime.mjs';
import { parseReviewFindings, planFixes } from '../../../skills/spec-branch-fix/scripts/fix-packets.mjs';
import { spawnSync } from 'node:child_process';
import {
  makeStageFixture, makeWaveFixture, initializeWave, waveState, waveIdentity,
  launchAction, gateAction, sealFixture, driveNeedsFix, makeSealRow,
  loadNativeRole, startNativeRole, nativeToolBlocked, runNativeStartChild, SDK_LOADER, SPEC_RUNTIME_INDEX
} from './wave-review-fixture.mjs';

const B = 'b'.repeat(40); // member base commit
const H = 'c'.repeat(40); // implementation commit / review-1 head
const J = 'd'.repeat(40); // packet commit / confirmation head
const LABEL1 = 'wave-w1-step-001-review-1';
const LABEL2 = 'wave-w1-step-001-review-2';

function assertInvalid(fn, field) {
  assert.throws(fn, error => {
    assert.strictEqual(error.code, 'stage-payload-invalid', `code for ${field}`);
    assert.strictEqual(error.field, field, `field for ${field}`);
    return true;
  });
}

const FINDING_FIELDS = ['id', 'severity', 'category', 'actionable', 'file', 'line', 'symbol', 'signature', 'explanation', 'correction', 'commit'];

function reviewRecord(over = {}) {
  return {
    package: '/tmp/wave-review-test', id: 'run-r1',
    wave_bindings: { wave_id: 'w1', step_number: 1 },
    stage: { round: 1, label: LABEL1, base: B, head: H, packet: { index: 1, ids: ['F1'] } },
    ...over
  };
}
function fullFinding(over = {}) {
  return {
    id: 'F1', severity: 'HIGH', category: 'correctness', actionable: true,
    file: 'src/a.mjs', line: 12, symbol: '## Native stage', signature: 'correctness:boundary',
    explanation: 'The parser splits on ": " and treats " #" as a comment marker.',
    correction: 'Escape the marker before folding.', commit: H,
    ...over
  };
}
function reviewBody() {
  return { verdict: 'needs-fix', findings: [fullFinding()], fix_verdicts: [], limitations: [] };
}
function fixBody() {
  return {
    commits: [J],
    decisions: [{ id: 'F1', decision: 'fixed', signature: 'correctness:boundary', note: 'done' }],
    evidence: [], unresolved: [], triage: { summary: 'summary', fallback: false }
  };
}

test('wave seal: stage payloads validate strictly and rendered artifacts round-trip', async t => {
  await t.test('needs-fix review renders and parses back field-for-field', () => {
    const record = reviewRecord();
    const finding = fullFinding();
    const payload = { verdict: 'needs-fix', findings: [finding], fix_verdicts: [], limitations: [] };

    assert.doesNotThrow(() => validateReviewPayload(record, payload));
    const markdown = renderReviewMarkdown(record, payload);
    assert.ok(markdown.startsWith('# '), 'review Markdown starts with a level-1 heading');
    assert.match(markdown, /## Native stage/);
    assert.match(markdown, /: /);
    assert.match(markdown, / #/);

    const parsed = parseReviewFindings(markdown);
    assert.strictEqual(parsed.verdict, 'needs-fix');
    assert.strictEqual(parsed.step, LABEL1);
    assert.strictEqual(parsed.commit, H);
    assert.strictEqual(parsed.findings.length, 1);
    const pick = source => Object.fromEntries(FINDING_FIELDS.map(key => [key, source[key]]));
    assert.deepStrictEqual(pick(parsed.findings[0]), pick(finding));
  });

  await t.test('review rejections carry the exact field', () => {
    const record = reviewRecord();
    // (b) pass verdict with an actionable finding.
    assertInvalid(() => validateReviewPayload(record, { ...reviewBody(), verdict: 'pass' }), 'verdict');
    // (c) extra top-level key.
    assertInvalid(() => validateReviewPayload(record, { ...reviewBody(), checkout: '/somewhere' }), 'checkout');
    // (d) severity outside the enum.
    assertInvalid(() => validateReviewPayload(record, { ...reviewBody(), findings: [fullFinding({ severity: 'MEDIUM' })] }), 'findings[0].severity');
    // (e) duplicated finding id.
    assertInvalid(() => validateReviewPayload(record, { ...reviewBody(), findings: [fullFinding(), fullFinding({ severity: 'LOW' })] }), 'findings[1].id');
    // (f) round 1 may not carry fix_verdicts.
    const withVerdicts = { ...reviewBody(), fix_verdicts: [{ fix: 'reviews/r-fix.md', id: 'F1', verdict: 'resolved', evidence: 'checked' }] };
    assertInvalid(() => validateReviewPayload(record, withVerdicts), 'fix_verdicts');
    // (g) payload over the 48000-byte cap.
    const oversize = { verdict: 'pass', findings: [], fix_verdicts: [], limitations: ['x'.repeat(49000)] };
    assertInvalid(() => validateReviewPayload(record, oversize), 'payload');
  });

  await t.test('fix rejections carry the exact field', () => {
    const record = reviewRecord();
    // (h) decision id outside the packet.
    assertInvalid(() => validateFixPayload(record, {
      ...fixBody(), decisions: [{ id: 'F9', decision: 'fixed', signature: 'x:y', note: 'n' }]
    }), 'decisions[0].id');
    // (i) accepted-risk without approved/approval_source.
    assertInvalid(() => validateFixPayload(record, {
      ...fixBody(), decisions: [{ id: 'F1', decision: 'dismissed', signature: 'x:y', note: 'n', dismissal: 'accepted-risk' }]
    }), 'decisions[0].approved');
    // (j) commit that is not 40 lowercase hex.
    assertInvalid(() => validateFixPayload(record, { ...fixBody(), commits: ['abc'] }), 'commits[0]');
  });
});

function planFinding(id, over = {}) {
  return {
    id, severity: 'MED', category: 'correctness', actionable: true, file: 'src/a.mjs',
    line: 1, symbol: 'alpha', signature: 'correctness:x', explanation: 'failure', commit: J,
    ...over
  };
}
const passReceipt = (findings = []) => ({ payload: { verdict: 'pass', findings } });
const needsFixReceipt = findings => ({ payload: { verdict: 'needs-fix', findings } });
function attempt(over = {}) {
  return { run_id: 'run-r1', result: 'accepted', base: B, head: H, receipt: passReceipt(), ...over };
}
function reviewRound(over = {}) {
  return { round: 1, label: LABEL1, kind: 'review', attempts: [attempt()], ...over };
}
function stepState(over = {}) {
  return {
    waveId: 'w1', step: 1, member: { base_commit: B },
    implementation: { status: 'recorded', outcome: 'as-specified', remaining_work: [], commit: H },
    previous_phase: { token: 'phase-1', drain: 'confirmed' },
    rounds: [], fix: null, ...over
  };
}

// Call twice on the same state, proving determinism and that the input is not mutated.
function act(state) {
  const before = structuredClone(state);
  const first = nextReviewAction(state);
  assert.deepStrictEqual(state, before, 'nextReviewAction must not mutate its input');
  const second = nextReviewAction(state);
  assert.deepStrictEqual(second, first, 'nextReviewAction must be deterministic');
  return first;
}

test('wave seal: next review action follows the outcome table', async t => {
  // Repetitive deepStrictEqual rows are data driven so the outcome table stays
  // readable; rows asserting bespoke packet/confirmation result fields keep
  // explicit named assertions below.
  const fixReview = () => reviewRound({ attempts: [attempt({ receipt: needsFixReceipt([planFinding('F1')]) })] });
  const needsFixState = over => stepState({ rounds: [fixReview()], ...over });
  const landedPacket = over => ({
    index: 1, ids: ['F1'], result: 'landed', commits: [J], gated: true, pending: [], findings: [planFinding('F1')], ...over
  });
  const outcomes = [
    ['row 1: sealed', [{ seal: { state: 'sealed' } }, { action: 'sealed' }]],
    ['row 2: blocked seal reports the first reason',
      [{ seal: { state: 'blocked', reasons: [{ code: 'completion-missing' }] } }, { action: 'block', reason: 'completion-missing' }],
      [{ seal: { state: 'blocked' } }, { action: 'block', reason: 'seal-blocked' }]],
    ['row 3: completion is not eligible',
      [{ implementation: { status: 'running', outcome: 'as-specified', remaining_work: [] } }, { action: 'not-eligible', reason: 'completion-incomplete' }],
      [{ implementation: { status: 'recorded', outcome: 'adapted', remaining_work: ['x'] } }, { action: 'not-eligible', reason: 'completion-incomplete' }]],
    ['row 4: live drain waits', [{ previous_phase: { token: 't', drain: 'live' } }, { action: 'wait', reason: 'drain-pending' }]],
    ['row 5: unknown drain blocks', [{ previous_phase: { token: 't', drain: 'unknown' } }, { action: 'block', reason: 'drain-unknown' }]],
    ['row 6: running stage waits',
      [{ rounds: [reviewRound({ attempts: [attempt({ result: 'running' })] })] }, { action: 'wait', reason: 'stage-running' }],
      [{ rounds: [reviewRound()], fix: { round: 1, packets: [{ index: 1, ids: ['F1'], result: 'running' }] } }, { action: 'wait', reason: 'stage-running' }]],
    ['row 7: reviewer mutation blocks with its code', [{ rounds: [reviewRound({ attempts: [attempt({ result: 'rejected', receipt: { refusal: { code: 'reviewer-mutated-source' } } })] })] }, { action: 'block', reason: 'reviewer-mutated-source' }]],
    ['row 8: any other rejection is an invalid receipt', [{ rounds: [reviewRound({ attempts: [attempt({ result: 'rejected', receipt: {} })] })] }, { action: 'block', reason: 'stage-receipt-invalid' }]],
    ['row 9: one transport failure retries the same launch', [{ rounds: [reviewRound({ attempts: [attempt({ result: 'transport-failed' })] })] }, { action: 'launch-review', label: LABEL1, base: B, head: H, reason: 'transport-retry' }]],
    ['row 10: two transport failures block', [{ rounds: [reviewRound({ attempts: [attempt({ result: 'transport-failed' }), attempt({ result: 'transport-failed' })] })] }, { action: 'block', reason: 'review-transport-failed' }]],
    ['row 11: no rounds launches the member review', [{}, { action: 'launch-review', label: LABEL1, base: B, head: H }]],
    ['row 12: stale accepted round-1 base or head blocks',
      [{ rounds: [reviewRound({ attempts: [attempt({ base: 'e'.repeat(40) })] })] }, { action: 'block', reason: 'review-stale' }],
      [{ rounds: [reviewRound({ attempts: [attempt({ head: 'e'.repeat(40) })] })] }, { action: 'block', reason: 'review-stale' }]],
    ['row 13: pass-with-actionable or a premature fix is invalid',
      [{ rounds: [reviewRound({ attempts: [attempt({ receipt: passReceipt([planFinding('F1')]) })] })] }, { action: 'block', reason: 'stage-receipt-invalid' }],
      [{ rounds: [reviewRound()], fix: { round: 1, packets: [] } }, { action: 'block', reason: 'stage-receipt-invalid' }]],
    ['row 14: clean round-1 pass seals the review head', [{ rounds: [reviewRound()] }, { action: 'seal', head: H }]],
    ['row 16: a gate-failed packet blocks', [needsFixState({ fix: { round: 1, packets: [{ index: 1, ids: ['F1'], result: 'gate-failed', findings: [planFinding('F1')] }] } }), { action: 'block', reason: 'fix-gate-failed' }]],
    ['row 16a: an ungated landed packet runs gates', [needsFixState({ fix: { round: 1, packets: [{ index: 1, ids: ['F1'], result: 'landed', commits: [J], gated: false, run_id: 'run-fix-1', findings: [planFinding('F1')] }] } }), { action: 'run-gates', run_id: 'run-fix-1', head: J }]],
    ['row 18: empty single or already-split packets block',
      [needsFixState({ fix: { round: 1, packets: [{ index: 1, ids: ['F1'], result: 'empty', findings: [planFinding('F1')] }] } }), { action: 'block', reason: 'fix-packet-empty' }],
      [stepState({ rounds: [reviewRound({ attempts: [attempt({ receipt: needsFixReceipt([planFinding('F1'), planFinding('F2')]) })] })], fix: { round: 1, packets: [{ index: 1, ids: ['F1', 'F2'], result: 'empty', split: true, findings: [planFinding('F1'), planFinding('F2')] }] } }), { action: 'block', reason: 'fix-packet-empty' }]],
    ['row 20: drained pending launches the confirmation', [needsFixState({ fix: { round: 1, packets: [landedPacket()] } }), { action: 'launch-confirmation', label: LABEL2, base: H, head: J, round: 2 }]],
    ['row 21: a confirmation on a different head is stale', [needsFixState({ rounds: [fixReview(), { round: 2, label: LABEL2, kind: 'confirmation', attempts: [attempt({ head: 'e'.repeat(40), receipt: passReceipt() })] }], fix: { round: 1, packets: [landedPacket()] } }), { action: 'block', reason: 'review-stale' }]],
    ['row 22: a resolved confirmation seals the confirmation head', [needsFixState({ rounds: [fixReview(), { round: 2, label: LABEL2, kind: 'confirmation', attempts: [attempt({ head: J, receipt: { payload: { verdict: 'pass', findings: [], fix_verdicts: [{ id: 'F1', verdict: 'resolved' }] } } })] }], expected_ids: ['F1'], decided: ['F1'], fix: { round: 1, packets: [landedPacket({ decisions: [{ id: 'F1', decision: 'fixed' }] })] } }), { action: 'seal', head: J }]],
    ['row 23: an unresolved confirmation blocks without repair', [needsFixState({ rounds: [fixReview(), { round: 2, label: LABEL2, kind: 'confirmation', attempts: [attempt({ head: J, receipt: needsFixReceipt([planFinding('F1')]) })] }], fix: { round: 1, packets: [landedPacket({ decisions: [{ id: 'F1', decision: 'fixed' }] })] } }), { action: 'block', reason: 'confirmation-failed' }]],
    ['row 25: any other combination is an invalid receipt', [needsFixState({ rounds: [fixReview(), { round: 2, label: LABEL2, kind: 'confirmation', attempts: [] }], repair: { consumed: false }, fix: { round: 1, packets: [landedPacket()] } }), { action: 'block', reason: 'stage-receipt-invalid' }]]
  ];
  for (const [name, ...cases] of outcomes) {
    await t.test(name, () => {
      for (const [over, expected] of cases) assert.deepStrictEqual(act(stepState(over)), expected, name);
    });
  }

  await t.test('row 15: needs-fix round 1 launches the first planned packet', () => {
    const result = act(stepState({ rounds: [reviewRound({ attempts: [attempt({ receipt: needsFixReceipt([planFinding('F1')]) })] })] }));
    assert.strictEqual(result.action, 'launch-fix-packet');
    assert.strictEqual(result.reason, undefined);
    assert.deepStrictEqual(result.packet.ids, ['F1']);
  });

  await t.test('row 17: an empty multi-id packet splits once', () => {
    const result = act(stepState({
      rounds: [reviewRound({ attempts: [attempt({ receipt: needsFixReceipt([planFinding('F1'), planFinding('F2')]) })] })],
      fix: { round: 1, packets: [{ index: 1, ids: ['F1', 'F2'], result: 'empty', findings: [planFinding('F1'), planFinding('F2')] }] }
    }));
    assert.strictEqual(result.action, 'launch-fix-packet');
    assert.strictEqual(result.reason, 'packet-split');
    assert.deepStrictEqual(result.packet.ids, ['F1']);
    assert.strictEqual(result.packet.split, true);
  });

  await t.test('row 19: a landed packet with pending launches the next packet', () => {
    const result = act(stepState({
      rounds: [reviewRound({ attempts: [attempt({ receipt: needsFixReceipt([planFinding('F1'), planFinding('F2')]) })] })],
      findings: [planFinding('F1'), planFinding('F2')], decided: ['F1'], pending: ['F2'],
      fix: { round: 1, packets: [{ index: 1, ids: ['F1', 'F2'], result: 'landed', commits: [J], gated: true, pending: ['F2'], findings: [planFinding('F1'), planFinding('F2')] }] }
    }));
    assert.strictEqual(result.action, 'launch-fix-packet');
    assert.strictEqual(result.reason, undefined);
    assert.deepStrictEqual(result.packet.ids, ['F2']);
  });

  await t.test('row 24: an unresolved confirmation with repair relaunches', () => {
    const result = act(stepState({
      rounds: [
        reviewRound({ attempts: [attempt({ receipt: needsFixReceipt([planFinding('F1')]) })] }),
        { round: 2, label: LABEL2, kind: 'confirmation', attempts: [attempt({ head: J, receipt: needsFixReceipt([planFinding('F1')]) })] }
      ],
      repair: { consumed: false },
      fix: { round: 1, packets: [{ index: 1, ids: ['F1'], decisions: [{ id: 'F1', decision: 'fixed' }], result: 'landed', commits: [J], gated: true, pending: [], findings: [planFinding('F1')] }] }
    }));
    assert.strictEqual(result.action, 'launch-fix-packet');
    assert.strictEqual(result.round, 2);
    assert.deepStrictEqual(result.packet.ids, ['F1']);
  });

  // Candidate subjects use the first parent as base, the integration label, and accept-repair instead of seal (rows 11, 14, 22).
  function candidateState(over = {}) {
    return {
      waveId: 'w1', subject: { kind: 'candidate', repair: 1, parents: [B] },
      implementation: { status: 'recorded', outcome: 'as-specified', remaining_work: [], commit: H },
      previous_phase: { token: 'phase-1', drain: 'confirmed' },
      rounds: [], fix: null, ...over
    };
  }

  await t.test('candidate row 11: first parent is the base', () => {
    assert.deepStrictEqual(act(candidateState()), {
      action: 'launch-review', label: 'wave-w1-integration-1-review-1', base: B, head: H
    });
  });

  await t.test('candidate row 14: a clean pass accepts the repair', () => {
    assert.deepStrictEqual(
      act(candidateState({ rounds: [{ round: 1, label: 'wave-w1-integration-1-review-1', kind: 'review', attempts: [attempt()] }] })),
      { action: 'accept-repair', head: H });
  });

  await t.test('candidate row 22: a resolved confirmation accepts the repair', () => {
    const result = act(candidateState({
      rounds: [
        { round: 1, label: 'wave-w1-integration-1-review-1', kind: 'review', attempts: [attempt({ receipt: needsFixReceipt([planFinding('F1')]) })] },
        { round: 2, label: 'wave-w1-integration-1-review-2', kind: 'confirmation', attempts: [attempt({ head: J, receipt: { payload: { verdict: 'pass', findings: [], fix_verdicts: [{ id: 'F1', verdict: 'resolved' }] } } })] }
      ],
      expected_ids: ['F1'], decided: ['F1'],
      fix: { round: 1, packets: [{ index: 1, ids: ['F1'], decisions: [{ id: 'F1', decision: 'fixed' }], result: 'landed', commits: [J], gated: true, pending: [], findings: [planFinding('F1')] }] }
    }));
    assert.deepStrictEqual(result, { action: 'accept-repair', head: J });
  });
});

test('wave seal: native reviewer and fixer argv pin role, model, profile and extensions', async t => {
  const fixture = makeStageFixture(t);
  const value = args => opt => args[args.indexOf(opt) + 1];

  const reviewer = { ...fixture.record(), review_model: resolveStageModel({ role: 'reviewer', review_model: 'fixture-provider/team/reviewer:high' }) };
  const reviewerDone = await launch(reviewer, 'reviewer', stagePrompt(reviewer), { command: process.execPath, prefix: [fixture.fake] }).done;
  assert.equal(reviewerDone.error, undefined);
  assert.equal(fixture.hasMarker('reviewer'), true);
  const reviewerArgs = JSON.parse(reviewerDone.result);
  const reviewerValue = value(reviewerArgs);
  assert.equal(reviewerValue('--provider'), 'fixture-provider');
  assert.equal(reviewerValue('--model'), 'team/reviewer');
  assert.equal(reviewerValue('--thinking'), 'high');
  const reviewerExts = reviewerArgs.filter((arg, index) => reviewerArgs[index - 1] === '--extension');
  const providerAt = reviewerExts.indexOf(fixture.providerExt);
  const indexAt = reviewerExts.findIndex(ext => ext.endsWith(join('spec-runtime', 'index.ts')));
  assert.ok(providerAt >= 0 && indexAt > providerAt, 'provider extension precedes the spec-runtime extension');
  assert.ok(!reviewerArgs.some(arg => String(arg).includes('pi-subagents')), 'reviewer has no pi-subagents extension');
  assert.equal(reviewerValue('--tools'), 'read,grep,find,ls,bash,spec_stage_complete,exec_command,write_stdin');
  assert.ok(reviewerValue('--append-system-prompt').endsWith(join('pi', 'agents', 'spec-stage-reviewer.md')));
  assert.equal(reviewerValue('--session'), reviewer.reviewer_session);
  assert.notEqual(reviewerValue('--session'), reviewer.owner_session);
  assert.match(reviewerArgs.at(-1), new RegExp(`since=${fixture.base} head=${fixture.head}`));

  const fixer = { ...fixture.record({ stage: { role: 'fixer' } }), fix_model: resolveStageModel({ role: 'fixer', implementation_owner_model: 'fixture-provider/team/owner' }) };
  const fixerDone = await launch(fixer, 'fixer', stagePrompt(fixer), { command: process.execPath, prefix: [fixture.fake] }).done;
  assert.equal(fixerDone.error, undefined);
  assert.equal(fixture.hasMarker('fixer'), true);
  const fixerArgs = JSON.parse(fixerDone.result);
  const fixerValue = value(fixerArgs);
  assert.equal(fixerValue('--provider'), 'fixture-provider');
  assert.equal(fixerValue('--model'), 'team/owner');
  assert.equal(fixerValue('--tools'), 'read,grep,find,ls,bash,edit,write,spec_stage_complete,exec_command,write_stdin,apply_patch');
  assert.ok(fixerValue('--append-system-prompt').endsWith(join('pi', 'agents', 'spec-step-fixer.md')));

  const overridden = { ...fixer, fix_model: resolveStageModel({ role: 'fixer', fix_model_override: 'other/x:low', implementation_owner_model: 'fixture-provider/team/owner' }) };
  const overrideArgs = JSON.parse((await launch(overridden, 'fixer', stagePrompt(overridden), { command: process.execPath, prefix: [fixture.fake] }).done).result);
  const overrideValue = value(overrideArgs);
  assert.equal(overrideValue('--provider'), 'other');
  assert.equal(overrideValue('--model'), 'x');
  assert.equal(overrideValue('--thinking'), 'low');

  assert.throws(() => resolveStageModel({ role: 'reviewer' }), error => error.code === 'role-model-missing');
  assert.throws(() => resolveStageModel({ role: 'fixer', implementation_owner_model: '' }), error => error.code === 'role-model-missing');
  const blocked = makeStageFixture(t);
  assert.throws(() => launch({ ...blocked.record(), review_model: undefined }, 'reviewer', 'prompt'), error => error.code === 'role-model-missing');
  assert.throws(() => launch(blocked.record(), 'auditor', 'prompt'), error => error.code === 'role-unknown');
  assert.ok(!blocked.hasMarker('reviewer') && !blocked.hasMarker('auditor'), 'no marker is written when launch refuses before spawn');
});

test('wave seal: spec_stage_complete binds role, assignment and fixer commits', async t => {
  const fixShaped = makeStageFixture(t);
  assert.throws(() => submitStage(fixShaped.record(), 'reviewer', fixBody()), error => error.code === 'stage-payload-invalid');

  const mismatched = makeStageFixture(t);
  assert.throws(() => submitStage(mismatched.record({ stage: { role: 'fixer' } }), 'reviewer', reviewBody()), error => error.code === 'stage-assignment-mismatch');

  const revoked = makeStageFixture(t);
  const revokedRecord = revoked.record();
  revoke(revokedRecord);
  assert.throws(() => submitStage(revokedRecord, 'reviewer', reviewBody()), /Writer lease is absent/);
  assert.equal(existsSync(join(revoked.package, 'runtime/runs', `${revoked.id}-stage.json`)), false, 'a revoked lease writes no receipt');

  const valid = makeStageFixture(t);
  const reviewer = valid.record();
  recordStageFingerprint(reviewer);
  const accepted = submitStage(reviewer, 'reviewer', { verdict: 'pass', findings: [], fix_verdicts: [], limitations: [] });
  assert.equal(accepted.role, 'reviewer');
  assert.equal(accepted.base, valid.base);
  assert.equal(accepted.head, valid.head);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.artifact, 'reviews/wave-w1-step-001-review-1-review.md');
  assert.equal(accepted.artifact_sha256, sha256(readFileSync(join(valid.package, accepted.artifact))));
  assert.equal(JSON.parse(readFileSync(join(valid.package, 'runtime/runs', `${valid.id}-stage.json`), 'utf8')).artifact_sha256, accepted.artifact_sha256);

  const foreign = makeStageFixture(t);
  assert.throws(() => submitStage(foreign.record({ stage: { role: 'fixer' } }), 'fixer', { ...fixBody(), commits: [foreign.orphan()], decisions: [] }), error => error.code === 'fix-commit-foreign');

  const moved = makeStageFixture(t);
  assert.throws(() => submitStage(moved.record({ stage: { role: 'fixer' } }), 'fixer', { ...fixBody(), commits: [moved.childCommit()], decisions: [] }), error => error.code === 'fix-head-mismatch');

  const dirty = makeStageFixture(t);
  dirty.write('src/a.mjs', 'export const a = 3;\n');
  assert.throws(() => submitStage(dirty.record({ stage: { role: 'fixer' } }), 'fixer', { ...fixBody(), commits: [], decisions: [] }), error => error.code === 'fix-tree-dirty');
});

test('wave seal: reviewer source mutation rejects the verdict', async t => {
  const submit = async (mutate, { accepted = false } = {}) => {
    const fixture = makeStageFixture(t);
    const record = fixture.record();
    recordStageFingerprint(record);
    mutate(fixture);
    const payload = { verdict: 'pass', findings: [], fix_verdicts: [], limitations: [] };
    if (accepted) {
      const result = submitStage(record, 'reviewer', payload);
      assert.equal(result.accepted, true);
      assert.equal(existsSync(join(fixture.package, result.artifact)), true);
      return;
    }
    assert.throws(() => submitStage(record, 'reviewer', payload), error => {
      assert.equal(error.code, 'reviewer-mutated-source');
      return true;
    });
    const receipt = JSON.parse(readFileSync(join(fixture.package, 'runtime/runs', `${fixture.id}-stage.json`), 'utf8'));
    assert.equal(receipt.accepted, false);
    assert.equal(receipt.refusal.code, 'reviewer-mutated-source');
    assert.equal(existsSync(join(fixture.package, 'reviews', `${LABEL1}-review.md`)), false, 'a refused review writes no Markdown');
    const state = stepState({ rounds: [reviewRound({ attempts: [attempt({ result: 'rejected', receipt })] })] });
    assert.deepStrictEqual(nextReviewAction(state), { action: 'block', reason: 'reviewer-mutated-source' });
  };

  await submit(fixture => fixture.write('src/a.mjs', 'export const a = 9;\n'));
  await submit(fixture => { fixture.write('src/b.mjs', 'export const b = 1;\n'); fixture.git(['add', 'src/b.mjs']); });
  await submit(fixture => fixture.write('src/c.mjs', 'export const c = 1;\n'));
  await submit(fixture => fixture.write('build/out.txt', 'ignored artifact\n'), { accepted: true });
  await submit(fixture => { fixture.write('src/a.mjs', 'export const a = 7;\n'); fixture.commit('mutation'); });
});

const NATIVE_A = ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write'];
const NATIVE_B = ['read', 'grep', 'find', 'ls', 'exec_command', 'write_stdin', 'apply_patch'];
const GUARD_PROBE = ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write', 'exec_command', 'write_stdin', 'apply_patch', 'spec_scout', 'subagent', 'spec_stage_complete'];

test('wave seal: real SDK pins each role to the exact native tool intersection', async t => {
  assert.ok(existsSync(SDK_LOADER), `installed Pi SDK loader missing at ${SDK_LOADER}`);
  assert.ok(existsSync(SPEC_RUNTIME_INDEX), 'local spec-runtime index.ts missing');

  // Owner and editor keep their contract allowlist; only stage roles intersect it with the native inventory.
  for (const [role, model] of [['owner', { provider: 'fixture-provider', id: 'team/owner' }],
    ['editor', { provider: 'fixture-provider', id: 'team/editor' }]]) {
    const harness = await loadNativeRole(t, { role, builtins: NATIVE_A, record: { editor_model: 'fixture-provider/team/editor' } });
    assert.equal(harness.extension.tools.has('spec_stage_complete'), false, `${role} registers no stage tool`);
    await startNativeRole(harness, model);
    const contract = ROLE_CONTRACT[role];
    assert.deepStrictEqual(new Set(harness.active), new Set([...contract.tools, ...contract.providerTools]), `${role} active set`);
  }

  // Without SPEC_RUNTIME_ROLE the coordinator branch registers no stage tool.
  const unset = await loadNativeRole(t, { role: undefined, builtins: NATIVE_A });
  assert.equal(unset.extension.tools.has('spec_stage_complete'), false);

  const expectations = {
    reviewer: {
      A: ['read', 'grep', 'find', 'ls', 'bash', 'spec_stage_complete'],
      B: ['read', 'grep', 'find', 'ls', 'exec_command', 'write_stdin', 'spec_stage_complete']
    },
    fixer: {
      A: ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write', 'spec_stage_complete'],
      B: ['read', 'grep', 'find', 'ls', 'exec_command', 'write_stdin', 'apply_patch', 'spec_stage_complete']
    }
  };
  for (const role of ['reviewer', 'fixer']) {
    for (const [label, builtins] of [['A', NATIVE_A], ['B', NATIVE_B]]) {
      const model = role === 'reviewer' ? { provider: 'fixture-provider', id: 'team/reviewer' } : { provider: 'fixture-provider', id: 'team/owner' };
      const harness = await loadNativeRole(t, { role, builtins });
      assert.equal(harness.extension.tools.has('spec_stage_complete'), true, `${role} registers the stage tool`);
      await startNativeRole(harness, model);
      assert.deepStrictEqual(new Set(harness.active), new Set(expectations[role][label]), `${role} active set ${label}`);
      const allowed = new Set(harness.active);
      for (const name of GUARD_PROBE) assert.equal(!nativeToolBlocked(harness, name), allowed.has(name), `${role} guard for ${name} under ${label}`);
    }
  }

  // Capability and selector failures are real exit-78 process refusals.
  const missingStage = runNativeStartChild(t, { role: 'reviewer', tools: ['read', 'grep', 'find', 'ls', 'bash'],
    record: { review_model: 'fixture-provider/team/reviewer:high' }, model: { provider: 'fixture-provider', id: 'team/reviewer' } });
  assert.equal(missingStage.status, 78, missingStage.stderr);
  assert.match(missingStage.stderr, /SPEC_ROLE_CAPABILITY_MISSING: reviewer lacks check stage-complete/);

  const missingWrite = runNativeStartChild(t, { role: 'fixer', tools: ['read', 'grep', 'find', 'ls', 'bash', 'spec_stage_complete'],
    record: { fix_model: 'fixture-provider/team/owner' }, model: { provider: 'fixture-provider', id: 'team/owner' } });
  assert.equal(missingWrite.status, 78, missingWrite.stderr);
  assert.match(missingWrite.stderr, /SPEC_ROLE_CAPABILITY_MISSING: fixer lacks write/);

  const mismatch = runNativeStartChild(t, { role: 'reviewer', tools: ['read', 'grep', 'find', 'ls', 'bash', 'spec_stage_complete'],
    record: { review_model: 'fixture-provider/team/reviewer:high' }, model: { provider: 'fixture-provider', id: 'team/reviewer:batch' } });
  assert.equal(mismatch.status, 78, mismatch.stderr);
  assert.match(mismatch.stderr, /SPEC_MODEL_SELECTOR_MISMATCH/);
});

test('wave seal: reviewer and fixer install no provider-recovery or discovery hooks', async t => {
  assert.ok(existsSync(SDK_LOADER), `installed Pi SDK loader missing at ${SDK_LOADER}`);

  const startForRole = async (role, over) => {
    const harness = await loadNativeRole(t, { role, builtins: NATIVE_A, record: over });
    await startNativeRole(harness, { provider: 'primalabs', id: 'fixture' });
    return harness;
  };
  const recover = async harness => {
    const controller = new AbortController();
    const ctx = { model: { provider: 'primalabs', id: 'fixture' }, hasPendingMessages: () => false, sessionManager: { getBranch: () => [] }, signal: controller.signal, ui: { notify() {} } };
    const pending = [];
    for (const hook of harness.extension.handlers.get('message_end') || [])
      pending.push(hook({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: ' ' }] } }, ctx));
    controller.abort();
    const settled = await Promise.allSettled(pending);
    assert.deepStrictEqual(settled.filter(entry => entry.status === 'rejected'), [],
      'no provider-recovery hook rejects after the abort');
  };

  const editor = await startForRole('editor', { editor_model: 'primalabs/fixture' });
  assert.equal((editor.extension.handlers.get('session_before_compact') || []).length, 1, 'editor installs one compact guard');
  await recover(editor);
  const editorRecovery = editor.entries.filter(entry => entry.customType === 'spec-provider-recovery');
  assert.equal(editorRecovery.length, 1, 'editor records exactly one recovery scheduling');
  assert.equal(editorRecovery[0].data.event, 'retry_scheduled');

  const reviewer = await startForRole('reviewer', { review_model: 'primalabs/fixture' });
  assert.equal((reviewer.extension.handlers.get('session_before_compact') || []).length, 1, 'reviewer installs one compact guard');
  await recover(reviewer);
  assert.equal(reviewer.entries.filter(entry => entry.customType === 'spec-provider-recovery').length, 0);

  const fixer = await startForRole('fixer', { fix_model: 'primalabs/fixture' });
  assert.equal((fixer.extension.handlers.get('session_before_compact') || []).length, 1, 'fixer installs one compact guard');
  await recover(fixer);
  assert.equal(fixer.entries.filter(entry => entry.customType === 'spec-provider-recovery').length, 0);

  // Only the editor gets the bounded discovery guard: its 25th read is refused while the fixer's 25th read still passes.
  for (let i = 0; i < 25; i++) assert.equal(nativeToolBlocked(fixer, 'read'), null, `fixer read ${i + 1}`);
  for (let i = 0; i < 24; i++) assert.equal(nativeToolBlocked(editor, 'read'), null, `editor read ${i + 1}`);
  const checkpoint = nativeToolBlocked(editor, 'read');
  assert.ok(checkpoint && checkpoint.block === true, 'the 25th editor read is blocked');
  assert.match(checkpoint.reason, /^Discovery checkpoint reached/);
});

test('wave seal: needs-fix runs bounded packets then one confirmation and seals the reviewed head', async t => {
  const f = await makeWaveFixture(t);
  const implementation = await initializeWave(f);
  const I = f.implementationHead;
  assert.equal(implementation.state, 'completed', 'owner completion is recorded');
  assert.equal(f.head, I, 'the private view stays at the implementation head');

  const FILE_BY_ID = { F1: 'src/a.mjs', F2: 'src/a.mjs', F3: 'src/b.mjs', F4: 'src/a.mjs', F5: 'test/a.test.mjs' };
  const finding = (id, over = {}) => ({
    id, severity: 'MED', category: 'correctness', actionable: true,
    file: FILE_BY_ID[id], line: 3, symbol: 'alpha', signature: 'correctness:boundary',
    explanation: `defect ${id}`, correction: `repair ${id}`, commit: I, ...over
  });
  const review1 = {
    verdict: 'needs-fix',
    findings: [
      finding('F1', { severity: 'HIGH', symbol: 'alpha' }),
      finding('F2', { symbol: 'alpha' }),
      finding('F3', { file: 'src/b.mjs', symbol: 'beta' }),
      finding('F4', { severity: 'LOW', actionable: false, symbol: 'delta' }),
      finding('F5', { file: 'test/a.test.mjs', symbol: 'gamma' })
    ],
    fix_verdicts: [], limitations: []
  };
  const plan = planFixes(review1, {});
  assert.deepStrictEqual(plan.packets.map(packet => packet.ids), [['F1', 'F2'], ['F3'], ['F5']], 'packets group by file and anchor');

  const launches = [];
  const sessions = [];
  const captureSession = mark => {
    const fresh = f.launches.slice(mark);
    sessions.push((fresh.find(launch => launch.role === 'reviewer' || launch.role === 'fixer') ?? fresh[0])?.session ?? null);
  };
  let next = nextReviewAction(await waveState(f));
  assert.equal(next.action, 'launch-review', 'the first action reviews the implementation: ' + JSON.stringify(next));
  assert.equal(next.head, I, 'review-1 reviews the implementation head');

  // Hold review-1 on its barrier and prove a fixing stage is refused while the reviewer's phase claim is live.
  let mark = f.launches.length;
  const held = await launchAction(f, next, { payload: review1, hold: true });
  launches.push('review-1');
  captureSession(mark);
  await f.waitIn('reviewer');
  const launchesBefore = f.launches.length;
  await assert.rejects(
    f.startStage({
      ...waveIdentity(f), implementation_run_id: f.implementationRunId, stage_attempt: 99, phase: 'fixing',
      stage: { role: 'fixer', label: LABEL1, round: 1, base: f.base, head: f.head,
        packet: { index: 1, total: 1, ids: ['F1'], pending_after: [], ranges: [], findings: [] } }
    }),
    error => error?.code === 'phase-not-drained',
    'a fix stage before review-1 drains is refused'
  );
  assert.equal(f.launches.length, launchesBefore, 'the refused fix start launches no fixer');
  f.release('reviewer');
  await held.wait;

  const packets = [];
  let sealReceipt = null;
  for (let i = 0; i < 12; i += 1) {
    next = nextReviewAction(await waveState(f));
    if (next.action === 'sealed') break;
    if (next.action === 'launch-fix-packet') {
      const ids = next.packet.ids;
      const mutations = Object.fromEntries([...new Set(ids.map(id => FILE_BY_ID[id]))]
        .map((file, index) => [file, `export const packet${packets.length + 1} = ${index + 1};\n`]));
      mark = f.launches.length;
      await launchAction(f, next, { mutations });
      launches.push(`packet:${ids.join(',')}`);
      captureSession(mark);
      const state = await waveState(f);
      const packet = state.fix.packets.at(-1);
      assert.deepStrictEqual(packet.ids, ids, 'the launched packet is the planned packet');
      packets.push({ index: packet.index, ids, commit: packet.commits.at(-1) });
    } else if (next.action === 'run-gates') {
      await gateAction(f, next);
      const state = await waveState(f);
      const packet = state.fix.packets.at(-1);
      const expected = plan.packets[packet.index - 1];
      assert.deepStrictEqual(packet.pending, expected.pending_after, `packet ${packet.index} pending matches planFixes`);
      assert.equal(packet.gates.length, 1, `packet ${packet.index} records one gate receipt`);
      assert.equal(packet.gates[0].outcome, 'pass', `packet ${packet.index} gate passes`);
      assert.equal(packet.gates[0].command, 'node check.mjs', 'the EV-1 command ran');
      assert.equal(packet.gates[0].before.commit, packet.commits.at(-1), 'the gate observed the packet commit');
      assert.equal(packet.gates[0].after.commit, packet.commits.at(-1), 'the gate ended on the packet commit');
    } else if (next.action === 'launch-confirmation') {
      const decided = [...new Set((await waveState(f)).decided)];
      mark = f.launches.length;
      const record = await launchAction(f, next, { payload: {
        verdict: 'pass', findings: [],
        fix_verdicts: decided.map(id => ({ fix: `reviews/${LABEL1}-fix.md`, id, verdict: 'resolved', evidence: `verified ${id}` })),
        limitations: []
      } });
      launches.push('confirmation');
      captureSession(mark);
      assert.equal(record.stage.base, I, 'the confirmation base is the review-1 head');
      assert.equal(record.stage.head, packets.at(-1).commit, 'the confirmation head is the last packet commit');
    } else if (next.action === 'seal') {
      sealReceipt = await sealFixture(f);
      launches.push('seal');
    } else if (next.action === 'wait') {
      await new Promise(resolve => setTimeout(resolve, 25));
    } else {
      const state = await waveState(f);
      const compact = {
        decided: state.decided,
        pending: state.pending,
        findings: state.findings,
        fix: {
          round: state.fix.round,
          packets: state.fix.packets.map(({ index, ids, decisions, result }) => ({ index, ids, decisions, result }))
        },
        rounds: state.rounds.map(round => ({
          round: round.round,
          attempts: round.attempts.map(a => ({ result: a.result, payload: a.receipt?.payload, refusal: a.receipt?.refusal }))
        }))
      };
      assert.fail(`unexpected action ${next.action} (${next.reason ?? ''}) ${JSON.stringify(compact)}`);
    }
  }
  assert.equal(next.action, 'sealed', 'the bounded driver reaches the sealed action');
  assert.deepStrictEqual(launches, ['review-1', 'packet:F1,F2', 'packet:F3', 'packet:F5', 'confirmation', 'seal'],
    'the driver launches exactly the planned stages in order');
  assert.equal(sessions.length, 5, 'four reviewer actions plus three fixer packets span five sessions');
  assert.equal(new Set(sessions).size, sessions.length, 'every stage session is fresh');
  assert.ok(sessions.every(Boolean), 'every stage session is recorded');

  const finalState = await waveState(f);
  assert.deepStrictEqual(finalState.decided, ['F1', 'F2', 'F3', 'F5'], 'every actionable finding is decided');
  assert.deepStrictEqual(finalState.expected_ids, ['F1', 'F2', 'F3', 'F5'], 'the review expected the four actionable ids');
  assert.deepStrictEqual(finalState.pending, [], 'the final pending set is empty');

  assert.ok(sealReceipt, 'a seal receipt was produced');
  assert.equal(sealReceipt.state, 'sealed');
  const sealedHead = sealReceipt.sealed_head;
  assert.equal(sealedHead, packets.at(-1).commit, 'the sealed head is the last packet commit');
  assert.equal(sealedHead, f.git(['rev-parse', 'HEAD']).trim(), 'the sealed head is the private HEAD');
  assert.equal(sealReceipt.sealed_tree, f.git(['rev-parse', `${sealedHead}^{tree}`]).trim(), 'the sealed tree is the private tree');
  const canonicalTree = spawnSync('git', ['-C', f.repo, 'rev-parse', `${sealedHead}^{tree}`], { encoding: 'utf8' });
  assert.equal(canonicalTree.status, 0, canonicalTree.stderr);
  assert.equal(canonicalTree.stdout.trim(), sealReceipt.sealed_tree, 'the sealed tree exists in the canonical repository');
  assert.equal(sealReceipt.retention_ref, 'refs/waves/retained/w1/step-001');
  const canonicalRef = spawnSync('git', ['-C', f.repo, 'rev-parse', 'refs/waves/retained/w1/step-001'], { encoding: 'utf8' });
  assert.equal(canonicalRef.status, 0, canonicalRef.stderr);
  assert.equal(canonicalRef.stdout.trim(), sealedHead, 'the retention ref points at the sealed head in the canonical repository');
  const ancestor = spawnSync('git', ['-C', f.repo, 'merge-base', '--is-ancestor', I, sealedHead]);
  assert.equal(ancestor.status, 0, 'the implementation head is an ancestor of the sealed head');
  assert.deepStrictEqual(sealReceipt.reviews.map(entry => entry.path).sort(),
    [`reviews/${LABEL1}-review.md`, `reviews/${LABEL2}-review.md`].sort(), 'the seal lists both review artifacts');
});

test('wave seal: confirmation failure and transport failure block without another automatic round', async t => {
  // Part 1: an unresolved confirmation blocks, then a durable repair assignment reopens one fix round before a fresh confirmation.
  const f = await makeWaveFixture(t);
  const implementation = f.implementationHead;
  const confirmation = await driveNeedsFix(f,
    { verdict: 'needs-fix', findings: [fullFinding({ commit: implementation })], fix_verdicts: [], limitations: [] },
    { 'src/a.mjs': 'export const a = 3;\n' });
  assert.equal(confirmation.action, 'launch-confirmation', 'the fix cycle reaches the confirmation: ' + JSON.stringify(confirmation));
  assert.equal(confirmation.label, LABEL2, 'the confirmation is review-2');
  assert.equal(confirmation.round, 2, 'the confirmation is the second round');
  assert.ok(existsSync(join(f.packagePath, 'reviews', `${LABEL1}-fix.md`)), 'the fixer wrote its fix record');
  const fixedHead = f.head;
  assert.equal(confirmation.head, fixedHead, 'the confirmation reviews the fixed head');

  const beforeBlock = f.launches.length;
  await launchAction(f, confirmation, { payload: {
    verdict: 'needs-fix', findings: [fullFinding({ commit: fixedHead })],
    fix_verdicts: [{ fix: `reviews/${LABEL1}-fix.md`, id: 'F1', verdict: 'unresolved', evidence: 'the defect remains' }],
    limitations: []
  } });
  const blocked = nextReviewAction(await waveState(f));
  assert.deepStrictEqual(blocked, { action: 'block', reason: 'confirmation-failed' }, 'an unresolved confirmation blocks');
  assert.deepStrictEqual(nextReviewAction(await waveState(f)), blocked, 'the block is stable without another automatic round');
  assert.equal(f.launches.length, beforeBlock + 1, 'the block launches no further stage');
  const refAfterBlock = spawnSync('git', ['-C', f.repo, 'rev-parse', 'refs/waves/retained/w1/step-001'], { encoding: 'utf8' });
  assert.notEqual(refAfterBlock.status, 0, 'a failed confirmation does not retain the reviewed head');
  assert.equal(f.head, fixedHead, 'the failed confirmation leaves HEAD unchanged');
  assert.equal(f.git(['status', '--porcelain']).trim(), '', 'the failed confirmation leaves a clean tree');

  // Part 2: the durable member repair field reopens one confirmation round.
  const wave = f.wave.read();
  wave.members[String(1)].repair = { assignment_id: 'repair-1' };
  f.wave.write(wave);
  const repair = nextReviewAction(await waveState(f));
  assert.equal(repair.action, 'launch-fix-packet', 'a durable repair launches a fix packet: ' + JSON.stringify(repair));
  assert.equal(repair.round, 2, 'the repair packet is the confirmation round');
  const launchesBeforeRepair = f.launches.filter(l => l.request != null).length;
  await launchAction(f, repair, { mutations: { 'src/a.mjs': 'export const a = 4;\n' } });
  const gate = nextReviewAction(await waveState(f));
  assert.equal(gate.action, 'run-gates', 'the repair packet is gated');
  await gateAction(f, gate);
  const repaired = nextReviewAction(await waveState(f));
  assert.equal(repaired.action, 'launch-confirmation', 'the repaired head goes to a fresh confirmation');
  assert.equal(repaired.label, 'wave-w1-step-001-review-3', 'the fresh confirmation is review-3');
  assert.ok(existsSync(join(f.packagePath, 'reviews', 'wave-w1-step-001-review-2-fix.md')), 'the repair fix record is review-2');
  assert.equal(f.launches.filter(l => l.request != null).length, launchesBeforeRepair + 1, 'the repair consumed exactly one fixer launch');

  // Part 3: two transport failures on a fresh member block with no third attempt.
  const g = await makeWaveFixture(t);
  await initializeWave(g);
  let next = nextReviewAction(await waveState(g));
  assert.equal(next.action, 'launch-review');
  const first = await launchAction(g, next, { allowFailure: true, scenario: { transportExit: { reviewer: 1 } } });
  assert.equal(first.state, 'failed', 'the transport failure run is recorded as failed');
  next = nextReviewAction(await waveState(g));
  assert.equal(next.action, 'launch-review', 'one transport failure retries the same launch');
  assert.equal(next.label, LABEL1, 'the retry keeps the canonical review label');
  assert.equal(next.reason, 'transport-retry');
  const second = await launchAction(g, next, { allowFailure: true, scenario: { transportExit: { reviewer: 1 } } });
  assert.equal(second.state, 'failed', 'the retry also fails at the transport');
  assert.equal(second.review_model, first.review_model, 'the retry keeps the same --model token');
  assert.equal(second.review_model, 'fixture-provider/team/reviewer:high', 'the retry model is the reviewer selector');
  assert.deepStrictEqual(nextReviewAction(await waveState(g)), { action: 'block', reason: 'review-transport-failed' },
    'two transport failures block');
});

test('wave seal: empty or failing packets split once then block', async t => {
  // Part 1: an empty two-id packet splits once into a single-id retry, which blocks.
  const f = await makeWaveFixture(t);
  await initializeWave(f);
  const I = f.implementationHead;
  const findings = [
    fullFinding({ id: 'F1', file: 'src/a.mjs', symbol: 'alpha', line: 1, commit: I }),
    fullFinding({ id: 'F2', file: 'src/a.mjs', symbol: 'alpha', line: 2, commit: I })
  ];
  let next = nextReviewAction(await waveState(f));
  assert.equal(next.action, 'launch-review');
  await launchAction(f, next, { payload: { verdict: 'needs-fix', findings, fix_verdicts: [], limitations: [] } });
  next = nextReviewAction(await waveState(f));
  assert.equal(next.action, 'launch-fix-packet');
  assert.deepStrictEqual(next.packet.ids, ['F1', 'F2'], 'the two same-anchor findings form one packet');

  const empty = { commits: [], decisions: [], evidence: [], unresolved: [], triage: { summary: 'empty', fallback: false } };
  const emptyScenario = () => ({ fixer: { payload: empty, commit: false, autoFix: false } });
  const launchesBefore = f.launches.length;
  await launchAction(f, next, { scenario: emptyScenario() });
  const split = nextReviewAction(await waveState(f));
  assert.equal(split.action, 'launch-fix-packet', 'an empty two-id packet splits once');
  assert.equal(split.reason, 'packet-split');
  assert.deepStrictEqual(split.packet.ids, ['F1'], 'the split packet holds a single id');
  assert.equal(split.packet.split, true, 'the split packet is marked as a split');
  await launchAction(f, split, { scenario: emptyScenario() });
  assert.deepStrictEqual(nextReviewAction(await waveState(f)), { action: 'block', reason: 'fix-packet-empty' },
    'a second empty packet blocks');
  assert.equal(f.launches.length, launchesBefore + 2, 'the empty packet launched exactly twice');

  // Part 2: a failing gate blocks on the retained failing head with no seal.
  const g = await makeWaveFixture(t);
  const review = { verdict: 'needs-fix', findings: [fullFinding({ commit: g.implementationHead })], fix_verdicts: [], limitations: [] };
  const blockedByGate = await driveNeedsFix(g, review, {
    'src/a.mjs': 'export const a = 42;\n',
    'check.mjs': 'process.exit(1);\n'
  });
  assert.deepStrictEqual(blockedByGate, { action: 'block', reason: 'fix-gate-failed' }, 'a failing gate blocks');
  const failingHead = g.head;
  assert.notEqual(failingHead, g.implementationHead, 'the failing packet committed its head');
  const sealedRef = spawnSync('git', ['-C', g.repo, 'rev-parse', 'refs/waves/retained/w1/step-001'], { encoding: 'utf8' });
  assert.notEqual(sealedRef.status, 0, 'a failing gate seals nothing');
  assert.equal(nextReviewAction(await waveState(g)).action, 'block', 'the block persists without another launch');
  assert.equal(g.head, failingHead, 'the failing head is retained unchanged');
});

const SEAL_REF = 'refs/waves/retained/w1/step-001';

// Positive controls seal; each named row leaves one refusal and every blocked row must leave no retention ref and the same private head.
const SEAL_ROWS = [
  ['positive', null],
  ['completion', 'completion-missing'],
  ['stale', 'review-stale'],
  ['artifact', 'stage-receipt-invalid'],
  ['pending', 'fix-incomplete'],
  ['untracked', 'dirty-untracked'],
  ['tracked', 'dirty-tracked'],
  ['ignored', null],
  ['gate', 'gate-incomplete'],
  ['live', 'drain-live'],
  ['unknown', 'drain-unknown'],
  ['worktree', null]
];

test('wave seal: seal refuses incomplete, stale, dirty or undrained results', async t => {
  for (const [row, expected] of SEAL_ROWS) {
    // Every row gets its own fresh real fixture; `makeSealRow` never seals.
    const { f } = await makeSealRow(t, row);
    const headBefore = f.head;
    const receipt = await sealFixture(f);
    const ref = spawnSync('git', ['-C', f.repo, 'rev-parse', SEAL_REF], { encoding: 'utf8' });
    if (expected) {
      assert.equal(receipt.state, 'blocked', `${row}: the seal is blocked`);
      assert.ok(receipt.reasons.some(reason => reason.code === expected),
        `${row}: expected ${expected}, got ${JSON.stringify(receipt.reasons.map(reason => reason.code))}`);
      assert.notEqual(ref.status, 0, `${row}: a blocked seal writes no canonical retention ref`);
      assert.equal(f.head, headBefore, `${row}: a blocked seal leaves the private head unchanged`);
    } else {
      // A sealed row's retention ref must exist and point at the private head; reasons are surfaced because a worktree failure otherwise reports only a terse Git stderr.
      assert.equal(receipt.state, 'sealed',
        `${row}: the seal succeeds (${JSON.stringify(receipt.reasons)})`);
      assert.equal(ref.status, 0, `${row}: the canonical retention ref exists (${ref.stderr})`);
      assert.equal(ref.stdout.trim(), headBefore, `${row}: the retention ref points at the private head`);
    }
    // The coordinator-visible merged mountpoint is never populated by a row.
    if (f.workspace.backend === 'overlayfs') {
      assert.deepStrictEqual(readdirSync(f.workspace.merged), [], `${row}: the merged mountpoint stays empty`);
    }
    if (row === 'worktree') {
      assert.equal(receipt.backend, 'worktree', 'worktree: the sealed member records the worktree backend');
      assert.equal(receipt.fallback_reason, f.workspace.backendReason ?? f.workspace.reason ?? null,
        'worktree: the fallback reason matches the recorded workspace');
    }
  }
});

// A conflicting canonical ref must block the import, retain every private layer, leave the private head and prior receipts untouched, and a second seal must be a no-op.
test('wave seal: review completion alone cannot seal and failed import preserves layers and commits', async t => {
  const { f } = await makeSealRow(t, 'positive');
  const snap = dir => readdirSync(dir, { withFileTypes: true }).map(entry => entry.name).sort();
  const layers = [
    ['upper', f.workspace.upper, 'the upper layer identity is unchanged'],
    ['work', f.workspace.work, 'the work layer identity is unchanged'],
    ['lower', f.workspace.lower, 'the lower layer identity is unchanged'],
    ['gitDir', f.workspace.gitDir, 'the private Git dir identity is unchanged'],
  ];

  // The completed review leaves seal as the only canonical action; nothing has written the retention ref or runtime seal receipt.
  assert.equal((await waveState(f)).seal, null, 'no seal receipt exists before the seal');
  assert.deepStrictEqual(nextReviewAction(await waveState(f)), { action: 'seal', head: f.head },
    'a completed review leaves the seal as the next canonical action');
  const preSealRef = spawnSync('git', ['-C', f.repo, 'rev-parse', SEAL_REF], { encoding: 'utf8' });
  assert.notEqual(preSealRef.status, 0, 'the canonical retention ref is absent before the seal');
  assert.equal(existsSync(join(f.packagePath, 'runtime', 'waves', 'w1', 'step-001-seal.json')), false,
    'the runtime seal receipt is absent before the seal');

  const headBefore = f.head;
  const baseBefore = f.base;
  const layersBefore = Object.fromEntries(layers.map(([name, dir]) => [name, snap(dir)]));
  const runDir = join(f.packagePath, 'runtime', 'runs');
  const drainReceipts = readdirSync(runDir).filter(name => name.endsWith('-phase-drain.json')).sort();
  // The seal legitimately adds its own drain receipt, so preserve the prior
  // receipts by identity and bytes rather than comparing the whole directory.
  const drainBytes = new Map(drainReceipts.map(name => [name, readFileSync(join(runDir, name), 'utf8')]));
  const completionFile = join(runDir, `${f.implementationRunId}-completion.json`);
  const completionBefore = readFileSync(completionFile, 'utf8');
  assert.ok(drainReceipts.length > 0, 'the prior phase-drain receipts exist before the seal');

  // A conflicting canonical ref at the member base forces the import to refuse: the private head is not at that ref.
  const conflict = spawnSync('git', ['-C', f.repo, 'update-ref', SEAL_REF, baseBefore], { encoding: 'utf8' });
  assert.equal(conflict.status, 0, `establishing the conflicting canonical ref succeeds (${conflict.stderr})`);
  const receipt = await sealFixture(f);
  assert.equal(receipt.state, 'blocked', 'a conflicting canonical ref blocks the seal');
  assert.ok(receipt.reasons.some(reason => reason.code === 'import-failed'),
    `import-failed is reported: ${JSON.stringify(receipt.reasons.map(reason => reason.code))}`);

  // The private head, layer identities, ancestor base and prior receipts survive a failed import unchanged.
  assert.equal(f.head, headBefore, 'the private head is unchanged by a failed import');
  for (const [name, dir, message] of layers)
    assert.deepStrictEqual(snap(dir), layersBefore[name], message);
  assert.doesNotThrow(() => f.git(['merge-base', '--is-ancestor', baseBefore, headBefore]),
    'the ancestor base is still reachable from the private head');
  for (const [name, bytes] of drainBytes) {
    assert.ok(existsSync(join(runDir, name)), `the prior phase-drain receipt ${name} remains`);
    assert.equal(readFileSync(join(runDir, name), 'utf8'), bytes, `the prior phase-drain receipt ${name} keeps its bytes`);
  }
  assert.equal(readFileSync(completionFile, 'utf8'), completionBefore,
    'the implementation completion is preserved');

  // Delete the conflicting ref: the seal now imports and completes.
  const cleared = spawnSync('git', ['-C', f.repo, 'update-ref', '-d', SEAL_REF], { encoding: 'utf8' });
  assert.equal(cleared.status, 0, `clearing the conflicting ref succeeds (${cleared.stderr})`);
  const first = await sealFixture(f);
  const second = await sealFixture(f);
  assert.deepStrictEqual(second, first, 'a repeated seal returns the identical receipt');
  assert.equal(second.state, 'sealed', 'the seal succeeds once the conflict is cleared');
  const sealedRef = spawnSync('git', ['-C', f.repo, 'rev-parse', SEAL_REF], { encoding: 'utf8' });
  assert.equal(sealedRef.stdout.trim(), headBefore, 'the canonical ref points at the private head');
  const launchesAfterFirst = f.launches.length;
  await sealFixture(f);
  assert.equal(f.launches.length, launchesAfterFirst, 'a repeated seal launches no new phase');
  assert.equal(f.head, headBefore, 'a repeated seal leaves the private head unchanged');
});

// ---------------------------------------------------------------------------
// verification case 12: real diff attribution. Rewire the fixture's step index
// to a two-wave contract, drive an H1 private commit through a real passing
// review and a real `git diff` seal, then record an adaptation for the H2 change
// and observe the H3 future-wave write as an adaptation conflict.
test('wave seal: actual diff attribution blocks undeclared and sibling writes and records adaptations', async t => {
  const f = await makeWaveFixture(t);
  const targets = [f.targetId];
  const indexFile = join(f.packagePath, 'spec-steps.json');
  const step = (number, requires, writes) => ({ step: number, repository: f.targetId, difficulty: 'hard', requires, writes });
  writeFileSync(indexFile, JSON.stringify({
    version: 1,
    setup: { [f.targetId]: 'none' },
    steps: [step(1, [], ['src/a.mjs', 'docs/']), step(2, [], ['src/c.mjs']), step(3, [1, 2], ['lib/'])]
  }, null, 2));
  const index = JSON.parse(readFileSync(indexFile, 'utf8'));

  // H1 on the private view: modify an owned file, move a docs file into an
  // undeclared notes/ directory and delete a sibling-owned file.
  f.write('src/a.mjs', 'export const a = 3;\n');
  mkdirSync(join(f.view, 'notes'), { recursive: true });
  renameSync(join(f.view, 'docs/old.md'), join(f.view, 'notes/new.md'));
  rmSync(join(f.view, 'src/c.mjs'));
  f.git(['add', '-A']);
  f.git(['commit', '-qm', 'H1']);
  const H1 = f.git(['rev-parse', 'HEAD']).trim();

  const byPath = entries => Object.fromEntries(entries.map(entry => [entry.path, entry.attribution]));
  const sorted = entries => [...entries].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const attrsH1 = attributeWrites({ changedPaths: changedPaths({ git_dir: f.gitDir, base: f.base, head: H1 }), index, targets, step: 1 });
  assert.deepStrictEqual(sorted(attrsH1), [
    { path: 'docs/old.md', target: f.targetId, status: 'D', deleted: true, attribution: 'owned' },
    { path: 'notes/new.md', target: f.targetId, status: 'A', deleted: false, attribution: 'undeclared-write' },
    { path: 'src/a.mjs', target: f.targetId, status: 'M', deleted: false, attribution: 'owned' },
    { path: 'src/c.mjs', target: f.targetId, status: 'D', deleted: true, attribution: 'sibling-conflict' }
  ], 'the real diff attributes owned, undeclared and sibling changes with full records');

  // The owner completion runs with no further mutations so H1 stays the head.
  f.setScenario({ owner: { mutations: {}, commit: false, completeOwner: true } });
  await initializeWave(f);
  assert.equal(f.head, H1, 'the owner completion leaves H1 as the private head');
  const next = nextReviewAction(await waveState(f));
  assert.equal(next.action, 'launch-review', `review launches at H1: ${JSON.stringify(next)}`);
  assert.equal(next.head, H1, 'the review head is H1');
  await launchAction(f, next, { payload: { verdict: 'pass', findings: [], fix_verdicts: [], limitations: [] } });

  const receipt = await sealFixture(f);
  assert.equal(receipt.state, 'blocked', 'undeclared and sibling writes block the seal');
  const reason = code => receipt.reasons.find(entry => entry.code === code);
  assert.deepStrictEqual(reason('undeclared-write')?.paths, ['notes/new.md'], 'the undeclared addition is named');
  assert.deepStrictEqual(reason('sibling-conflict')?.paths, ['src/c.mjs'], 'the sibling deletion is named');
  const ref = spawnSync('git', ['-C', f.repo, 'rev-parse', SEAL_REF], { encoding: 'utf8' });
  assert.notEqual(ref.status, 0, 'a blocked seal writes no canonical retention ref');
  assert.equal(f.head, H1, 'a blocked seal leaves the private head unchanged');
  assert.doesNotThrow(() => f.git(['merge-base', '--is-ancestor', f.base, H1]), 'the base stays an ancestor of H1');

  // H2 restores the sibling file and records a coordinator adaptation for notes/.
  f.write('src/c.mjs', 'export const c = 100;\n');
  f.git(['add', '-A']);
  f.git(['commit', '-qm', 'H2']);
  const H2 = f.git(['rev-parse', 'HEAD']).trim();
  const notesAdaptation = { path: 'notes/new.md', reason: 'docs moved with coordinator approval', recorded_by: 'coordinator' };
  const attrsH2 = attributeWrites({ changedPaths: changedPaths({ git_dir: f.gitDir, base: f.base, head: H2 }), index, targets, step: 1, adaptations: [notesAdaptation] });
  assert.equal(byPath(attrsH2)['notes/new.md'], 'adapted', 'the recorded adaptation allows notes/new.md');
  assert.ok(attrsH2.every(entry => !['undeclared-write', 'sibling-conflict', 'adaptation-conflict', 'diff-unknown'].includes(entry.attribution)),
    'no blocking attribution remains once notes/new.md is adapted');

  // H3 adds an adapted future-wave file; the future write still conflicts.
  f.write('lib/x.mjs', 'export const x = 1;\n');
  f.git(['add', '-A']);
  f.git(['commit', '-qm', 'H3']);
  const H3 = f.git(['rev-parse', 'HEAD']).trim();
  const libAdaptation = { path: 'lib/x.mjs', reason: 'new library file with coordinator approval', recorded_by: 'coordinator' };
  const attrsH3 = attributeWrites({ changedPaths: changedPaths({ git_dir: f.gitDir, base: f.base, head: H3 }), index, targets, step: 1, adaptations: [notesAdaptation, libAdaptation] });
  assert.equal(byPath(attrsH3)['lib/x.mjs'], 'adaptation-conflict', 'a future-wave write conflicts even with an adaptation');

  // Every pure attribution outcome observed above, plus the two failure guards.
  const rows = [
    ['owned', attrsH1, 'src/a.mjs', 'owned'],
    ['undeclared', attrsH1, 'notes/new.md', 'undeclared-write'],
    ['sibling', attrsH1, 'src/c.mjs', 'sibling-conflict'],
    ['adapted', attrsH2, 'notes/new.md', 'adapted'],
    ['adaptation-conflict', attrsH3, 'lib/x.mjs', 'adaptation-conflict']
  ];
  for (const [name, attrs, path, expected] of rows)
    assert.equal(byPath(attrs)[path], expected, `${name}: ${path}`);
  const invalid = attributeWrites({ changedPaths: [{ path: '../escape', status: 'M', deleted: false }], index, targets, step: 1 });
  assert.equal(invalid[0].attribution, 'diff-unknown', 'a non-canonical diff path is diff-unknown');
  assert.throws(() => changedPaths({ git_dir: f.gitDir, base: f.base, head: 'invalidsha' }),
    error => error.code === 'diff-unknown', 'a failed git diff throws diff-unknown');
});
